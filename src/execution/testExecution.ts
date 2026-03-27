import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync, spawn } from 'child_process';
import * as vscode from 'vscode';
import { TestCommandTarget, TestExecutionResult, TestExecutionStatus, LiveOutputState, LiveTestResultCallback } from '../core/types';
import { TestItem, TestTreeProvider } from '../tree/testTreeProvider';
import { NUnitGutterIconDecorator } from '../testing/nunitRuntime';

let failureDiagnostics: vscode.DiagnosticCollection | undefined;

export function setFailureDiagnostics(collection: vscode.DiagnosticCollection | undefined): void {
  failureDiagnostics = collection;
}

export function findCsproj(filePath: string): string | undefined {
  let dir = path.dirname(filePath);
  while (dir !== path.parse(dir).root) {
    const files = fs.readdirSync(dir);
    const csproj = files.find((f) => f.endsWith('.csproj'));
    if (csproj) {
      return path.join(dir, csproj);
    }
    dir = path.dirname(dir);
  }
  return undefined;
}

function getTargetFrameworkFromCsproj(csprojContent: string): string {
  const single = csprojContent.match(/<TargetFramework>(.+?)<\/TargetFramework>/);
  if (single?.[1]) {
    return single[1].trim();
  }

  const multiple = csprojContent.match(/<TargetFrameworks>(.+?)<\/TargetFrameworks>/);
  if (multiple?.[1]) {
    return multiple[1].split(';')[0].trim();
  }

  return 'net9.0';
}

function tryExtractProcessId(output: string): number | undefined {
  const processIdMatch = output.match(/process\s+id\s*:\s*(\d+)/i);
  if (processIdMatch?.[1]) {
    return Number(processIdMatch[1]);
  }

  const pidMatch = output.match(/\bpid\s*[:=]\s*(\d+)\b/i);
  if (pidMatch?.[1]) {
    return Number(pidMatch[1]);
  }

  return undefined;
}

export async function runTestTarget(item: TestCommandTarget): Promise<TestExecutionResult> {
  if (!item?.uri || !item?.range) {
    return { status: 'failed', errorMessage: 'Invalid test target.' };
  }

  const testFile = item.uri.fsPath;
  const testMethod = typeof item.label === 'string' ? item.label : item.label?.label;
  if (!testMethod) {
    vscode.window.showErrorMessage('Cannot determine test name to run.');
    return { status: 'failed', errorMessage: 'Cannot determine test name to run.' };
  }

  const csproj = findCsproj(testFile);
  if (!csproj) {
    vscode.window.showErrorMessage('Cannot find .csproj for this test.');
    return { status: 'failed', errorMessage: 'Cannot find .csproj for this test.' };
  }

  const output = vscode.window.createOutputChannel(`Run Test: ${testMethod}`);
  output.show(true);

  const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nunit-single-run-'));
  const trxFileName = `test-${sanitizeFileSegment(testMethod)}-${Date.now()}.trx`;
  const trxPath = path.join(resultsDir, trxFileName);

  const args = [
    'test', csproj,
    '--filter', `FullyQualifiedName~${testMethod}`,
    '--logger', 'console;verbosity=detailed',
    '--logger', `trx;LogFileName=${trxFileName}`,
    '--results-directory', resultsDir
  ];
  output.appendLine(`Running: dotnet ${args.join(' ')}`);

  const { outputText, exitCode } = await runDotnetCommand(args, path.dirname(csproj), output);

  const parsedFromTrx = parseTrxResults(trxPath);
  const trxResult = parsedFromTrx.get(testMethod) ?? findTrxMatchForTarget(parsedFromTrx, testMethod);
  if (trxResult) {
    return trxResult;
  }

  return parseTestExecutionResult(outputText, exitCode);
}

export async function debugTestTarget(item: TestCommandTarget): Promise<TestExecutionResult> {
  if (!item?.uri || !item?.range) {
    return { status: 'failed', errorMessage: 'Invalid test target.' };
  }

  const testFile = item.uri.fsPath;
  const csproj = findCsproj(testFile);
  if (!csproj) {
    vscode.window.showErrorMessage('Cannot find .csproj for this test.');
    return { status: 'failed', errorMessage: 'Cannot find .csproj for this test.' };
  }

  const testName = typeof item.label === 'string' ? item.label : item.label?.label;
  if (!testName) {
    vscode.window.showErrorMessage('Cannot determine test name for debugging.');
    return { status: 'failed', errorMessage: 'Cannot determine test name for debugging.' };
  }

  const csprojContent = fs.readFileSync(csproj, 'utf-8');
  const targetFramework = getTargetFrameworkFromCsproj(csprojContent);

  vscode.window.showInformationMessage(`Building ${csproj} before debugging...`);
  try {
    execSync(`dotnet build "${csproj}" -c Debug -f ${targetFramework}`, { stdio: 'ignore' });
  } catch {
    vscode.window.showErrorMessage(`Build failed for ${csproj}`);
    return { status: 'failed', errorMessage: `Build failed for ${csproj}` };
  }

  const output = vscode.window.createOutputChannel(`Debug Test: ${testName}`);
  output.show(true);

  const debugResultsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nunit-single-debug-'));
  const debugTrxFileName = `test-${sanitizeFileSegment(testName)}-${Date.now()}.trx`;
  const debugTrxPath = path.join(debugResultsDir, debugTrxFileName);

  const debugArgs = [
    'test',
    csproj,
    '--no-build',
    '--configuration',
    'Debug',
    '--framework',
    targetFramework,
    '--filter',
    `FullyQualifiedName~${testName}`,
    '--logger',
    'console;verbosity=detailed',
    '--logger',
    `trx;LogFileName=${debugTrxFileName}`,
    '--results-directory',
    debugResultsDir
  ];

  output.appendLine(`Running: dotnet ${debugArgs.join(' ')}`);

  const child = spawn('dotnet', debugArgs, {
    cwd: path.dirname(csproj),
    env: { ...process.env, VSTEST_HOST_DEBUG: '1' }
  });

  let attachStarted = false;
  let combinedOutput = '';

  const tryAttachFromChunk = async (chunk: string) => {
    if (attachStarted) {
      return;
    }
    const pid = tryExtractProcessId(chunk);
    if (!pid) {
      return;
    }

    attachStarted = true;
    output.appendLine(`Attaching debugger to test host PID ${pid}...`);

    const attachConfig: vscode.DebugConfiguration = {
      name: `Attach Test Host: ${testName}`,
      type: 'coreclr',
      request: 'attach',
      processId: pid.toString(),
      justMyCode: false
    };

    const started = await vscode.debug.startDebugging(undefined, attachConfig);
    if (!started) {
      output.appendLine('Failed to attach debugger to test host process.');
      vscode.window.showErrorMessage(`Failed to attach debugger for ${testName}`);
    }
  };

  child.stdout.on('data', (data: Buffer) => {
    const text = data.toString();
    combinedOutput += text;
    output.append(text);
    void tryAttachFromChunk(text);
  });

  child.stderr.on('data', (data: Buffer) => {
    const text = data.toString();
    combinedOutput += text;
    output.append(text);
    void tryAttachFromChunk(text);
  });

  const exitCode = await new Promise<number>((resolve) => {
    child.on('close', (code) => {
      output.appendLine(`dotnet test exited with code ${code ?? 0}`);
      resolve(code ?? 0);
    });
  });

  if (!attachStarted) {
    vscode.window.showWarningMessage(
      `Test host PID was not detected for ${testName}. Breakpoints may not be hit.`
    );
  }

  const debugParsedFromTrx = parseTrxResults(debugTrxPath);
  const debugTrxResult = debugParsedFromTrx.get(testName) ?? findTrxMatchForTarget(debugParsedFromTrx, testName);
  if (debugTrxResult) {
    return debugTrxResult;
  }

  return parseTestExecutionResult(combinedOutput, exitCode);
}

export async function executeClassTarget(
  classItem: TestItem,
  debug: boolean,
  provider: TestTreeProvider,
  gutterDecorator: NUnitGutterIconDecorator
): Promise<void> {
  const testTargets = collectTestTargetsFromTreeItem(classItem);
  if (!testTargets.length) {
    vscode.window.showWarningMessage('No tests found in this class.');
    return;
  }

  for (const target of testTargets) {
    provider.setStatusForTarget(target, 'in progress');
    gutterDecorator.updateTestResult(target, { status: 'in progress' });
    updateInlineFailurePopup(target, { status: 'in progress' });
  }

  const getTargetName = (target: TestCommandTarget): string =>
    typeof target.label === 'string' ? target.label : target.label.label;
  const pendingTargetNames = new Set(testTargets.map(getTargetName));
  let activeTarget: TestCommandTarget | undefined = testTargets[0];

  if (activeTarget) {
    provider.setStatusForTarget(activeTarget, 'active');
    gutterDecorator.updateTestResult(activeTarget, { status: 'active' });
    updateInlineFailurePopup(activeTarget, { status: 'active' });
  }

  const classLabel = typeof classItem.label === 'string' ? classItem.label : classItem.label?.label;

  const perTestResults = await runClassTargetInSingleSession(
    classLabel,
    testTargets,
    debug,
    (updatedTestName, result) => {
      const target = findTargetByTestName(testTargets, updatedTestName);
      if (!target) {
        return;
      }

      const completedTargetName = getTargetName(target);
      pendingTargetNames.delete(completedTargetName);

      provider.setStatusForTarget(target, result.status);
      gutterDecorator.updateTestResult(target, result);
      updateInlineFailurePopup(target, result);

      if (activeTarget && getTargetName(activeTarget) === completedTargetName) {
        const nextTarget = testTargets.find((candidate) => pendingTargetNames.has(getTargetName(candidate)));
        activeTarget = nextTarget;
        if (nextTarget) {
          provider.setStatusForTarget(nextTarget, 'active');
          gutterDecorator.updateTestResult(nextTarget, { status: 'active' });
          updateInlineFailurePopup(nextTarget, { status: 'active' });
        }
      }
    }
  );

  for (const target of testTargets) {
    const testName = typeof target.label === 'string' ? target.label : target.label.label;
    const result = perTestResults.get(testName) ?? { status: 'not run' as TestExecutionStatus };
    provider.setStatusForTarget(target, result.status);
    gutterDecorator.updateTestResult(target, result);
    updateInlineFailurePopup(target, result);
  }
}

export async function executeCategoryTarget(
  categoryItem: TestItem,
  debug: boolean,
  provider: TestTreeProvider,
  gutterDecorator: NUnitGutterIconDecorator
): Promise<void> {
  const classItems = collectClassItemsFromTreeItem(categoryItem);
  if (!classItems.length) {
    vscode.window.showWarningMessage('No test classes found in this category.');
    return;
  }

  for (const classItem of classItems) {
    await executeClassTarget(classItem, debug, provider, gutterDecorator);
  }
}

function collectClassItemsFromTreeItem(item: TestItem): TestItem[] {
  const classItems: TestItem[] = [];

  const walk = (node: TestItem): void => {
    if (node.contextValue === 'class') {
      classItems.push(node);
      return;
    }

    for (const child of node.children ?? []) {
      walk(child);
    }
  };

  walk(item);
  return classItems;
}

export async function executeTestTargetsInSingleSession(
  className: string,
  testTargets: TestCommandTarget[],
  debug: boolean,
  provider: TestTreeProvider,
  gutterDecorator: NUnitGutterIconDecorator
): Promise<void> {
  if (!testTargets.length) {
    return;
  }

  for (const target of testTargets) {
    provider.setStatusForTarget(target, 'in progress');
    gutterDecorator.updateTestResult(target, { status: 'in progress' });
    updateInlineFailurePopup(target, { status: 'in progress' });
  }

  const getTargetName = (target: TestCommandTarget): string =>
    typeof target.label === 'string' ? target.label : target.label.label;
  const pendingTargetNames = new Set(testTargets.map(getTargetName));
  let activeTarget: TestCommandTarget | undefined = testTargets[0];

  if (activeTarget) {
    provider.setStatusForTarget(activeTarget, 'active');
    gutterDecorator.updateTestResult(activeTarget, { status: 'active' });
    updateInlineFailurePopup(activeTarget, { status: 'active' });
  }

  const perTestResults = await runClassTargetInSingleSession(
    className,
    testTargets,
    debug,
    (updatedTestName, result) => {
      const target = findTargetByTestName(testTargets, updatedTestName);
      if (!target) {
        return;
      }

      const completedTargetName = getTargetName(target);
      pendingTargetNames.delete(completedTargetName);

      provider.setStatusForTarget(target, result.status);
      gutterDecorator.updateTestResult(target, result);
      updateInlineFailurePopup(target, result);

      if (activeTarget && getTargetName(activeTarget) === completedTargetName) {
        const nextTarget = testTargets.find((candidate) => pendingTargetNames.has(getTargetName(candidate)));
        activeTarget = nextTarget;
        if (nextTarget) {
          provider.setStatusForTarget(nextTarget, 'active');
          gutterDecorator.updateTestResult(nextTarget, { status: 'active' });
          updateInlineFailurePopup(nextTarget, { status: 'active' });
        }
      }
    }
  );

  for (const target of testTargets) {
    const testName = typeof target.label === 'string' ? target.label : target.label.label;
    const result = perTestResults.get(testName) ?? { status: 'not run' as TestExecutionStatus };
    provider.setStatusForTarget(target, result.status);
    gutterDecorator.updateTestResult(target, result);
    updateInlineFailurePopup(target, result);
  }
}

export function groupTargetsByClass(targets: TestCommandTarget[]): Array<{ className: string; targets: TestCommandTarget[] }> {
  const grouped = new Map<string, { className: string; targets: TestCommandTarget[] }>();

  for (const target of targets) {
    const csproj = findCsproj(target.uri.fsPath) ?? target.uri.fsPath;
    const className = target.className?.trim() || getTestClassFromTargetLabel(target.label) || path.basename(target.uri.fsPath);
    const key = `${csproj}::${className}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.targets.push(target);
      continue;
    }

    grouped.set(key, { className, targets: [target] });
  }

  return Array.from(grouped.values());
}

function getTestClassFromTargetLabel(label: string | vscode.TreeItemLabel): string | undefined {
  const value = typeof label === 'string' ? label : label.label;
  const withoutParameters = value.replace(/\(.*\)$/, '');
  const lastDotIndex = withoutParameters.lastIndexOf('.');
  if (lastDotIndex <= 0) {
    return undefined;
  }

  return withoutParameters.slice(0, lastDotIndex);
}

async function runClassTargetInSingleSession(
  className: string | undefined,
  testTargets: TestCommandTarget[],
  debug: boolean,
  onLiveResult?: LiveTestResultCallback
): Promise<Map<string, TestExecutionResult>> {
  const firstTarget = testTargets[0];
  const csproj = findCsproj(firstTarget.uri.fsPath);
  const classFilterToken = getClassFilterToken(className);

  if (!csproj || !classFilterToken) {
    const fallback = new Map<string, TestExecutionResult>();
    for (const target of testTargets) {
      const name = typeof target.label === 'string' ? target.label : target.label.label;
      fallback.set(name, { status: 'failed', errorMessage: 'Unable to resolve class or project for run.' });
    }
    return fallback;
  }

  const output = vscode.window.createOutputChannel(`${debug ? 'Debug' : 'Run'} Class: ${classFilterToken}`);
  output.show(true);
  const liveOutputState: LiveOutputState = { remainder: '' };

  const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nunit-class-run-'));
  const trxFileName = `class-${sanitizeFileSegment(classFilterToken)}-${Date.now()}.trx`;
  const trxPath = path.join(resultsDir, trxFileName);

  if (debug) {
    const csprojContent = fs.readFileSync(csproj, 'utf-8');
    const targetFramework = getTargetFrameworkFromCsproj(csprojContent);

    vscode.window.showInformationMessage(`Building ${csproj} before debugging class...`);
    try {
      execSync(`dotnet build "${csproj}" -c Debug -f ${targetFramework}`, { stdio: 'ignore' });
    } catch {
      const failed = new Map<string, TestExecutionResult>();
      for (const target of testTargets) {
        const name = typeof target.label === 'string' ? target.label : target.label.label;
        failed.set(name, { status: 'failed', errorMessage: `Build failed for ${csproj}` });
      }
      return failed;
    }
  }

  const args = debug
    ? [
      'test',
      csproj,
      '--no-build',
      '--configuration',
      'Debug',
      '--framework',
      getTargetFrameworkFromCsproj(fs.readFileSync(csproj, 'utf-8')),
      '--filter',
      `FullyQualifiedName~${classFilterToken}`,
      '--logger',
      'console;verbosity=detailed',
      '--logger',
      `trx;LogFileName=${trxFileName}`,
      '--results-directory',
      resultsDir
    ]
    : [
      'test',
      csproj,
      '--filter',
      `FullyQualifiedName~${classFilterToken}`,
      '--logger',
      'console;verbosity=detailed',
      '--logger',
      `trx;LogFileName=${trxFileName}`,
      '--results-directory',
      resultsDir
    ];

  output.appendLine(`Running: dotnet ${args.join(' ')}`);

  if (debug) {
    const debugOutcome = await runDebugClassCommand(
      args,
      path.dirname(csproj),
      output,
      (chunk) => processLiveTestOutputChunk(chunk, testTargets, onLiveResult, liveOutputState)
    );
    return mapPerTestResultsFromRun(testTargets, trxPath, debugOutcome.outputText, debugOutcome.exitCode);
  }

  const runOutcome = await runDotnetCommand(
    args,
    path.dirname(csproj),
    output,
    undefined,
    (chunk) => processLiveTestOutputChunk(chunk, testTargets, onLiveResult, liveOutputState)
  );
  return mapPerTestResultsFromRun(testTargets, trxPath, runOutcome.outputText, runOutcome.exitCode);
}

async function runDebugClassCommand(
  args: string[],
  cwd: string,
  output: vscode.OutputChannel,
  onOutputChunk?: (chunk: string) => void
): Promise<{ outputText: string; exitCode: number }> {
  const child = spawn('dotnet', args, {
    cwd,
    env: { ...process.env, VSTEST_HOST_DEBUG: '1' }
  });
  let outputText = '';
  let attachStarted = false;

  const tryAttachFromChunk = async (chunk: string) => {
    if (attachStarted) {
      return;
    }
    const pid = tryExtractProcessId(chunk);
    if (!pid) {
      return;
    }

    attachStarted = true;
    output.appendLine(`Attaching debugger to test host PID ${pid}...`);
    const attachConfig: vscode.DebugConfiguration = {
      name: 'Attach Test Host: Class Run',
      type: 'coreclr',
      request: 'attach',
      processId: pid.toString(),
      justMyCode: false
    };

    const started = await vscode.debug.startDebugging(undefined, attachConfig);
    if (!started) {
      output.appendLine('Failed to attach debugger to test host process.');
    }
  };

  child.stdout.on('data', (data: Buffer) => {
    const text = data.toString();
    outputText += text;
    output.append(text);
    onOutputChunk?.(text);
    void tryAttachFromChunk(text);
  });

  child.stderr.on('data', (data: Buffer) => {
    const text = data.toString();
    outputText += text;
    output.append(text);
    onOutputChunk?.(text);
    void tryAttachFromChunk(text);
  });

  const exitCode = await new Promise<number>((resolve) => {
    child.on('close', (code) => {
      const normalizedCode = code ?? 0;
      output.appendLine(`dotnet test exited with code ${normalizedCode}`);
      resolve(normalizedCode);
    });
  });

  return { outputText, exitCode };
}

function mapPerTestResultsFromRun(
  testTargets: TestCommandTarget[],
  trxPath: string,
  outputText: string,
  exitCode: number
): Map<string, TestExecutionResult> {
  const parsedFromTrx = parseTrxResults(trxPath);
  const overallStatus = parseTestStatus(outputText, exitCode);
  const results = new Map<string, TestExecutionResult>();

  for (const target of testTargets) {
    const targetName = typeof target.label === 'string' ? target.label : target.label.label;
    const direct = parsedFromTrx.get(targetName);
    if (direct) {
      results.set(targetName, direct);
      continue;
    }

    const fuzzy = findTrxMatchForTarget(parsedFromTrx, targetName);
    if (fuzzy) {
      results.set(targetName, fuzzy);
      continue;
    }

    if (overallStatus === 'failed') {
      results.set(targetName, { status: 'failed', errorMessage: 'Class run failed. No detailed result found for this test.' });
    } else if (overallStatus === 'skipped') {
      results.set(targetName, { status: 'skipped' });
    } else {
      results.set(targetName, { status: 'passed' });
    }
  }

  return results;
}

function parseTrxResults(trxPath: string): Map<string, TestExecutionResult> {
  const results = new Map<string, TestExecutionResult>();
  if (!fs.existsSync(trxPath)) {
    return results;
  }

  const content = fs.readFileSync(trxPath, 'utf-8');
  const blocks = content.match(/<UnitTestResult\b[\s\S]*?<\/UnitTestResult>|<UnitTestResult\b[^>]*\/>/g) ?? [];

  for (const block of blocks) {
    const testName = decodeXmlEntities(getXmlAttr(block, 'testName') ?? '');
    if (!testName) {
      continue;
    }

    const outcome = (getXmlAttr(block, 'outcome') ?? '').toLowerCase();
    const status = mapTrxOutcomeToStatus(outcome);
    const durationMs = parseTrxDurationToMs(getXmlAttr(block, 'duration'));
    const errorMessage = decodeXmlEntities(extractXmlTag(block, 'Message') ?? '');
    const stackTrace = decodeXmlEntities(extractXmlTag(block, 'StackTrace') ?? '');
    const screenshotPath = extractScreenshotPathFromTrxBlock(block, path.dirname(trxPath));

    results.set(testName, {
      status,
      errorMessage: errorMessage || undefined,
      stackTrace: stackTrace || undefined,
      screenshotPath,
      durationMs
    });
  }

  return results;
}

function parseTrxDurationToMs(duration: string | undefined): number | undefined {
  if (!duration) {
    return undefined;
  }

  const trimmed = duration.trim();
  const timeMatch = trimmed.match(/^(\d+):(\d+):(\d+)(?:\.(\d+))?$/);
  if (timeMatch) {
    const hours = Number(timeMatch[1]);
    const minutes = Number(timeMatch[2]);
    const seconds = Number(timeMatch[3]);
    const fraction = timeMatch[4] ?? '0';
    const ms = Number((fraction + '000').slice(0, 3));
    return ((hours * 60 + minutes) * 60 + seconds) * 1000 + ms;
  }

  const numeric = Number(trimmed.replace(',', '.'));
  if (Number.isFinite(numeric)) {
    return Math.round(numeric * 1000);
  }

  return undefined;
}

function extractScreenshotPathFromTrxBlock(block: string, baseDir: string): string | undefined {
  const resultFilesSection = block.match(/<ResultFiles>[\s\S]*?<\/ResultFiles>/i)?.[0] ?? block;
  const relativeResultsDirectory = decodeXmlEntities(getXmlAttr(block, 'relativeResultsDirectory') ?? '').trim();
  const resultFileMatches = resultFilesSection.matchAll(/<ResultFile\b[^>]*\bpath="([^"]+)"[^>]*\/?>(?:<\/ResultFile>)?/gi);

  for (const match of resultFileMatches) {
    const rawPath = decodeXmlEntities(match[1] ?? '').trim();
    if (!rawPath) {
      continue;
    }

    const normalizedPath = rawPath.replace(/\\/g, path.sep);
    const directCandidate = path.isAbsolute(rawPath) ? rawPath : path.resolve(baseDir, rawPath);
    const normalizedCandidate = path.isAbsolute(normalizedPath) ? normalizedPath : path.resolve(baseDir, normalizedPath);

    const candidates = [directCandidate, normalizedCandidate];

    if (relativeResultsDirectory) {
      const runFolders = fs.existsSync(baseDir)
        ? fs.readdirSync(baseDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
        : [];

      for (const folder of runFolders) {
        candidates.push(path.join(baseDir, folder, 'In', relativeResultsDirectory, rawPath));
        candidates.push(path.join(baseDir, folder, 'In', relativeResultsDirectory, normalizedPath));
      }
    }

    const existingCandidate = candidates.find((candidate) =>
      /\.(png|jpe?g|webp)$/i.test(candidate) && fs.existsSync(candidate)
    );
    if (existingCandidate) {
      return existingCandidate;
    }

    const fileName = path.basename(normalizedPath);
    const discovered = findFileByNameRecursive(baseDir, fileName, 8);
    if (discovered) {
      return discovered;
    }

    if (!/\.(png|jpe?g|webp)$/i.test(directCandidate)) {
      continue;
    }

    return directCandidate;
  }

  return undefined;
}

function findFileByNameRecursive(rootDir: string, fileName: string, maxDepth: number): string | undefined {
  if (!rootDir || !fileName || maxDepth < 0 || !fs.existsSync(rootDir)) {
    return undefined;
  }

  const stack: Array<{ dir: string; depth: number }> = [{ dir: rootDir, depth: 0 }];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }

    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(current.dir, entry.name);
      if (entry.isFile() && entry.name === fileName) {
        return fullPath;
      }

      if (entry.isDirectory() && current.depth < maxDepth) {
        stack.push({ dir: fullPath, depth: current.depth + 1 });
      }
    }
  }

  return undefined;
}

function getXmlAttr(xml: string, attrName: string): string | undefined {
  const match = xml.match(new RegExp(`${attrName}="([^"]*)"`, 'i'));
  return match?.[1];
}

function extractXmlTag(xml: string, tagName: string): string | undefined {
  const match = xml.match(new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`, 'i'));
  return match?.[1]?.trim();
}

function mapTrxOutcomeToStatus(outcome: string): TestExecutionStatus {
  if (outcome === 'passed') {
    return 'passed';
  }
  if (outcome === 'failed') {
    return 'failed';
  }
  if (outcome === 'notexecuted' || outcome === 'skipped') {
    return 'skipped';
  }
  return 'failed';
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function findTrxMatchForTarget(
  parsedFromTrx: Map<string, TestExecutionResult>,
  targetName: string
): TestExecutionResult | undefined {
  for (const [trxName, result] of parsedFromTrx.entries()) {
    if (trxName === targetName) {
      return result;
    }
    if (trxName.endsWith(`.${targetName}`) || trxName.startsWith(`${targetName}(`)) {
      return result;
    }
  }

  return undefined;
}

function sanitizeFileSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, '_');
}

function getClassFilterToken(classLabel?: string): string | undefined {
  if (!classLabel) {
    return undefined;
  }

  const trimmed = classLabel.trim();
  if (!trimmed) {
    return undefined;
  }

  return trimmed.replace(/\s*\(\d+\)$/i, '').replace(/\.cs$/i, '');
}

export function collectTestTargetsFromTreeItem(item: TestItem): TestCommandTarget[] {
  const targets: TestCommandTarget[] = [];

  const walk = (node: TestItem): void => {
    if (node.contextValue === 'test' && node.uri && node.range) {
      const label = node.label ?? 'UnknownTest';
      targets.push({ label, uri: node.uri, range: node.range });
    }

    for (const child of node.children ?? []) {
      walk(child);
    }
  };

  walk(item);
  return targets;
}

async function runDotnetCommand(
  args: string[],
  cwd: string,
  output: vscode.OutputChannel,
  env?: NodeJS.ProcessEnv,
  onOutputChunk?: (chunk: string) => void
): Promise<{ outputText: string; exitCode: number }> {
  const child = spawn('dotnet', args, { cwd, env: env ?? process.env });
  let outputText = '';

  child.stdout.on('data', (data: Buffer) => {
    const text = data.toString();
    outputText += text;
    output.append(text);
    onOutputChunk?.(text);
  });

  child.stderr.on('data', (data: Buffer) => {
    const text = data.toString();
    outputText += text;
    output.append(text);
    onOutputChunk?.(text);
  });

  const exitCode = await new Promise<number>((resolve) => {
    child.on('close', (code) => {
      const normalizedCode = code ?? 0;
      output.appendLine(`dotnet test exited with code ${normalizedCode}`);
      resolve(normalizedCode);
    });
  });

  return { outputText, exitCode };
}

function processLiveTestOutputChunk(
  chunk: string,
  testTargets: TestCommandTarget[],
  onLiveResult: LiveTestResultCallback | undefined,
  state: LiveOutputState
): void {
  if (!onLiveResult) {
    return;
  }

  const combined = state.remainder + chunk;
  const lines = combined.split(/\r?\n/);
  state.remainder = lines.pop() ?? '';

  for (const line of lines) {
    const parsed = tryParseLiveResultLine(line);
    if (!parsed) {
      continue;
    }

    const targetName = resolveTargetNameForLiveResult(testTargets, parsed.testName);
    if (!targetName) {
      continue;
    }

    onLiveResult(targetName, { status: parsed.status, errorMessage: parsed.status === 'failed' ? 'Test failed.' : undefined });
  }
}

function tryParseLiveResultLine(line: string): { status: TestExecutionStatus; testName: string } | undefined {
  const trimmed = line.trim();
  if (!trimmed) {
    return undefined;
  }

  const match = trimmed.match(/^(Passed|Failed|Skipped)\s+(.+?)(?:\s+\[[^\]]*\])?\.?$/i);
  if (!match?.[1] || !match[2]) {
    return undefined;
  }

  const state = match[1].toLowerCase();
  const testName = match[2].trim();
  if (!testName || /^[-:]/.test(testName)) {
    return undefined;
  }

  if (state === 'passed') {
    return { status: 'passed', testName };
  }
  if (state === 'failed') {
    return { status: 'failed', testName };
  }
  return { status: 'skipped', testName };
}

function resolveTargetNameForLiveResult(testTargets: TestCommandTarget[], rawName: string): string | undefined {
  const direct = findTargetByTestName(testTargets, rawName);
  if (direct) {
    return typeof direct.label === 'string' ? direct.label : direct.label.label;
  }

  const withoutNamespace = rawName.split('.').pop() ?? rawName;
  const withoutParams = withoutNamespace.replace(/\(.*\)$/, '');
  const relaxed = findTargetByTestName(testTargets, withoutParams);
  if (relaxed) {
    return typeof relaxed.label === 'string' ? relaxed.label : relaxed.label.label;
  }

  return undefined;
}

function findTargetByTestName(testTargets: TestCommandTarget[], name: string): TestCommandTarget | undefined {
  return testTargets.find((target) => {
    const targetName = typeof target.label === 'string' ? target.label : target.label.label;
    return targetName === name || targetName.endsWith(`.${name}`) || name.endsWith(`.${targetName}`);
  });
}

function parseTestStatus(output: string, exitCode: number): TestExecutionStatus {
  const failed = extractSummaryCount(output, 'Failed');
  const passed = extractSummaryCount(output, 'Passed');
  const skipped = extractSummaryCount(output, 'Skipped');
  if (failed !== undefined || passed !== undefined || skipped !== undefined) {
    const failedCount = failed ?? 0;
    const passedCount = passed ?? 0;
    const skippedCount = skipped ?? 0;

    if (failedCount > 0) {
      return 'failed';
    }
    if (passedCount > 0) {
      return 'passed';
    }
    if (skippedCount > 0) {
      return 'skipped';
    }
    return 'not run';
  }

  if (exitCode !== 0) {
    return 'failed';
  }
  if (/No test matches the given testcase filter/i.test(output)) {
    return 'skipped';
  }
  return 'passed';
}

function parseTestExecutionResult(output: string, exitCode: number): TestExecutionResult {
  const status = parseTestStatus(output, exitCode);
  const durationMs = extractDurationFromOutput(output);
  if (status !== 'failed') {
    return { status, durationMs };
  }

  const details = extractFailureDetails(output);
  return {
    status,
    errorMessage: details.errorMessage ?? 'Test failed.',
    stackTrace: details.stackTrace,
    screenshotPath: details.screenshotPath,
    durationMs
  };
}

function extractDurationFromOutput(output: string): number | undefined {
  const normalized = output.replace(/\r\n/g, '\n');
  const patterns = [
    /\[\s*(\d+(?:[\.,]\d+)?)\s*(ms|s|sec|m|min)\s*\]/gi,
    /Duration\s*:\s*(\d+(?:[\.,]\d+)?)\s*(ms|s|sec|m|min)\b/gi
  ];

  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    let lastMs: number | undefined;
    while ((match = pattern.exec(normalized)) !== null) {
      const value = Number((match[1] ?? '').replace(',', '.'));
      const unit = (match[2] ?? '').toLowerCase();
      if (!Number.isFinite(value)) {
        continue;
      }

      if (unit === 'ms') {
        lastMs = Math.round(value);
      } else if (unit === 's' || unit === 'sec') {
        lastMs = Math.round(value * 1000);
      } else if (unit === 'm' || unit === 'min') {
        lastMs = Math.round(value * 60_000);
      }
    }

    if (lastMs !== undefined) {
      return lastMs;
    }
  }

  return undefined;
}

function extractFailureDetails(output: string): { errorMessage?: string; stackTrace?: string; screenshotPath?: string } {
  const normalizedOutput = output.replace(/\r\n/g, '\n');
  const errorMatch = normalizedOutput.match(/(?:Error Message|Message):\s*([\s\S]*?)(?:\n\s*Stack Trace:|\n\s*Standard Output Messages:|\n\s*Failed\s+\S+\s*\[|\n\s*Total tests:|$)/i);
  const stackStart = normalizedOutput.search(/\bStack Trace:\s*/i);

  const errorMessage = errorMatch?.[1]
    ? errorMatch[1].split('\n').map((line) => line.trim()).filter(Boolean).join('\n')
    : undefined;

  let stackTrace: string | undefined;
  if (stackStart >= 0) {
    const rawStack = normalizedOutput.slice(stackStart).replace(/^.*?Stack Trace:\s*/i, '');
    const stackLines: string[] = [];
    const seen = new Set<string>();

    for (const line of rawStack.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      if (/^(Standard Output Messages:|Failed!?\b|Total tests:|Test Run Failed\.)/i.test(trimmed)) {
        break;
      }

      const normalizedFrame = trimmed.replace(/^\d+\)\s*/, '');
      if (!/^(at\s+)/i.test(normalizedFrame)) {
        continue;
      }
      if (seen.has(normalizedFrame)) {
        continue;
      }

      seen.add(normalizedFrame);
      stackLines.push(normalizedFrame);
    }

    if (stackLines.length > 0) {
      stackTrace = stackLines.join('\n');
    }
  }

  return {
    errorMessage,
    stackTrace,
    screenshotPath: extractScreenshotPathFromOutput(normalizedOutput)
  };
}

function extractScreenshotPathFromOutput(output: string): string | undefined {
  const lines = output.split(/\r?\n/);
  for (const line of lines) {
    const normalized = line.replace(/^[\s\-]+/, '').trim();
    const pathMatch = normalized.match(/([A-Za-z]:\\[^\s<>"']+\.(png|jpe?g|webp)|\/[^\s<>"']+\.(png|jpe?g|webp))/i);
    const candidate = pathMatch?.[1];
    if (!candidate) {
      continue;
    }
    return candidate;
  }
  return undefined;
}

export function updateInlineFailurePopup(target: TestCommandTarget, _result: TestExecutionResult): void {
  if (!failureDiagnostics) {
    return;
  }

  const key = getDiagnosticCode(target);
  const existing = failureDiagnostics.get(target.uri) ?? [];
  const filtered = existing.filter((diagnostic) => diagnostic.code !== key);

  failureDiagnostics.set(target.uri, filtered);
}

export function buildInlineFailureMessage(result: TestExecutionResult): string {
  return result.errorMessage ?? 'Test failed. Hover status marker for stack trace.';
}

function getDiagnosticCode(target: TestCommandTarget): string {
  const testName = typeof target.label === 'string' ? target.label : target.label.label;
  return `nunit:${target.range.start.line}:${testName}`;
}

function extractSummaryCount(output: string, label: 'Failed' | 'Passed' | 'Skipped'): number | undefined {
  const match = output.match(new RegExp(`${label}:\\s*(\\d+)`, 'i'));
  if (!match?.[1]) {
    return undefined;
  }
  return Number(match[1]);
}
