import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { execSync, spawn } from 'child_process';

type TestExecutionStatus = 'passed' | 'failed' | 'skipped' | 'not run' | 'in progress' | 'active';

interface TestExecutionResult {
  status: TestExecutionStatus;
  errorMessage?: string;
  stackTrace?: string;
  screenshotPath?: string;
  durationMs?: number;
}

type LiveTestResultCallback = (testName: string, result: TestExecutionResult) => void;

interface LiveOutputState {
  remainder: string;
}

let failureDiagnostics: vscode.DiagnosticCollection | undefined;

interface StackFrameTarget {
  filePath: string;
  line: number;
  column?: number;
}

interface TestCaseTarget {
  filePath: string;
  line: number;
  column?: number;
}

interface TestSummaryCounts {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  notRun: number;
  inProgress: number;
  active: number;
  totalDurationMs: number;
  durationSamples: number;
}

export function activate(context: vscode.ExtensionContext) {
  failureDiagnostics = vscode.languages.createDiagnosticCollection('nunit-inline-failures');
  context.subscriptions.push(failureDiagnostics);

  const openStackFrameCommand = vscode.commands.registerCommand('nunitTestsView.openStackFrame', async (target: StackFrameTarget) => {
    await openStackFrame(target);
  });
  context.subscriptions.push(openStackFrameCommand);

  const provider = new TestTreeProvider();
  const treeView = vscode.window.createTreeView('nunitTestsView', {
    treeDataProvider: provider,
    canSelectMany: true
  });
  context.subscriptions.push(treeView);

  const filterWebviewProvider = new TestFilterWebviewProvider(context.extensionUri, provider);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      TestFilterWebviewProvider.viewType,
      filterWebviewProvider,
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  const detailsWebviewProvider = new TestDetailsWebviewProvider();
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      TestDetailsWebviewProvider.viewType,
      detailsWebviewProvider,
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  const filterCommand = vscode.commands.registerCommand('nunitTestsView.filter', async () => {
    await openFilterMenu(provider);
  });
  context.subscriptions.push(filterCommand);

  const gutterDecorator = new NUnitGutterIconDecorator(context.extensionUri);
  context.subscriptions.push(gutterDecorator);

  let selectedTargetForDetails: TestCommandTarget | undefined;

  treeView.onDidChangeSelection((event) => {
    const selected = event.selection[0];
    if (!selected || selected.contextValue !== 'test' || !selected.uri || !selected.range) {
      selectedTargetForDetails = undefined;
      detailsWebviewProvider.clear();
      return;
    }

    if (!selected.label) {
      selectedTargetForDetails = undefined;
      detailsWebviewProvider.clear();
      return;
    }

    const selectedTarget: TestCommandTarget = {
      label: selected.label,
      uri: selected.uri,
      range: selected.range
    };

    const testName = typeof selected.label === 'string' ? selected.label : selected.label.label;
    if (!testName) {
      selectedTargetForDetails = undefined;
      detailsWebviewProvider.clear();
      return;
    }

    selectedTargetForDetails = selectedTarget;
    const result = gutterDecorator.getTestResultForTarget(selectedTarget);
    detailsWebviewProvider.setSelectedTest(testName, result, selectedTarget);
  });
  context.subscriptions.push(treeView);

  context.subscriptions.push(provider.onDidChangeTreeData(() => {
    if (!selectedTargetForDetails) {
      return;
    }

    const testName = typeof selectedTargetForDetails.label === 'string'
      ? selectedTargetForDetails.label
      : selectedTargetForDetails.label.label;
    const result = gutterDecorator.getTestResultForTarget(selectedTargetForDetails);
    detailsWebviewProvider.setSelectedTest(testName, result, selectedTargetForDetails);
  }));

  const testController = new NUnitGutterTestController(provider, gutterDecorator);
  context.subscriptions.push(testController);
  void testController.refresh();
  context.subscriptions.push(vscode.workspace.onDidSaveTextDocument((document) => {
    if (document.languageId === 'csharp') {
      void testController.refresh();
    }
  }));

  // 🔹 Refresh командата
  const disposable = vscode.commands.registerCommand('nunitTestsView.refresh', () => provider.refresh());
  context.subscriptions.push(disposable);

  // 🔹 Hover бутон Run Test
  const disposableRunTest = vscode.commands.registerCommand('extension.runTest', async (item?: TestItem) => {
    const selectedTestItems = getSelectedItemsForCommand(treeView, item, 'test');
    const targets = selectedTestItems
      .map((selectedItem) => toTestCommandTarget(selectedItem))
      .filter((target): target is TestCommandTarget => !!target);

    const groupedTargets = groupTargetsByClass(targets);
    for (const group of groupedTargets) {
      if (group.targets.length > 1) {
        await executeTestTargetsInSingleSession(group.className, group.targets, false, provider, gutterDecorator);
        continue;
      }

      for (const target of group.targets) {
        provider.setStatusForTarget(target, 'active');
        gutterDecorator.updateTestResult(target, { status: 'active' });
        updateInlineFailurePopup(target, { status: 'active' });

        const result = await runTestTarget(target);
        provider.setStatusForTarget(target, result.status);
        gutterDecorator.updateTestResult(target, result);
        updateInlineFailurePopup(target, result);
      }
    }
  });
  context.subscriptions.push(disposableRunTest);

  const disposableRunClass = vscode.commands.registerCommand('extension.runClass', async (item?: TestItem) => {
    const selectedClassItems = getSelectedItemsForCommand(treeView, item, 'class');
    for (const classItem of selectedClassItems) {
      await executeClassTarget(classItem, false, provider, gutterDecorator);
    }
  });
  context.subscriptions.push(disposableRunClass);

  const disposableRunCategory = vscode.commands.registerCommand('extension.runCategory', async (item: TestItem) => {
    await executeCategoryTarget(item, false, provider, gutterDecorator);
  });
  context.subscriptions.push(disposableRunCategory);

// 🔹 Hover бутон Debug Test
const disposableDebugTest = vscode.commands.registerCommand(
  'extension.debugTest',
  async (item?: TestItem) => {
    const selectedTestItems = getSelectedItemsForCommand(treeView, item, 'test');
    const targets = selectedTestItems
      .map((selectedItem) => toTestCommandTarget(selectedItem))
      .filter((target): target is TestCommandTarget => !!target);

    const groupedTargets = groupTargetsByClass(targets);
    for (const group of groupedTargets) {
      if (group.targets.length > 1) {
        await executeTestTargetsInSingleSession(group.className, group.targets, true, provider, gutterDecorator);
        continue;
      }

      for (const target of group.targets) {
        provider.setStatusForTarget(target, 'active');
        gutterDecorator.updateTestResult(target, { status: 'active' });
        updateInlineFailurePopup(target, { status: 'active' });

        const result = await debugTestTarget(target);
        provider.setStatusForTarget(target, result.status);
        gutterDecorator.updateTestResult(target, result);
        updateInlineFailurePopup(target, result);
      }
    }
  }
);
context.subscriptions.push(disposableDebugTest);

const disposableDebugClass = vscode.commands.registerCommand(
  'extension.debugClass',
  async (item?: TestItem) => {
    const selectedClassItems = getSelectedItemsForCommand(treeView, item, 'class');
    for (const classItem of selectedClassItems) {
      await executeClassTarget(classItem, true, provider, gutterDecorator);
    }
  }
);
context.subscriptions.push(disposableDebugClass);

const disposableDebugCategory = vscode.commands.registerCommand(
  'extension.debugCategory',
  async (item: TestItem) => {
    await executeCategoryTarget(item, true, provider, gutterDecorator);
  }
);
context.subscriptions.push(disposableDebugCategory);

const disposableShowNodeDetails = vscode.commands.registerCommand(
  'extension.showNodeDetails',
  async (item: TestItem) => {
    if (!item || (item.contextValue !== 'class' && item.contextValue !== 'category')) {
      return;
    }

    const summary = buildSummaryCountsForItem(item, gutterDecorator);
    const title = typeof item.label === 'string' ? item.label : item.label?.label ?? 'Selection';
    detailsWebviewProvider.setSummary(title, summary);
  }
);
context.subscriptions.push(disposableShowNodeDetails);

const disposableClearNodeResults = vscode.commands.registerCommand(
  'extension.clearNodeResults',
  (item: TestItem) => {
    if (!item || (item.contextValue !== 'class' && item.contextValue !== 'category')) {
      return;
    }

    const targets = collectTestTargetsFromTreeItem(item);
    for (const target of targets) {
      provider.setStatusForTarget(target, 'not run');
      gutterDecorator.updateTestResult(target, { status: 'not run' });
      updateInlineFailurePopup(target, { status: 'not run' });
    }
  }
);
context.subscriptions.push(disposableClearNodeResults);
}

export function deactivate() {}

function getSelectedItemsForCommand(
  treeView: vscode.TreeView<TestItem>,
  item: TestItem | undefined,
  expectedType: 'test' | 'class' | 'category' | 'project'
): TestItem[] {
  if (item?.contextValue === expectedType) {
    const selectedItems = treeView.selection.filter((selected) => selected.contextValue === expectedType);
    const isClickedItemSelected = treeView.selection.includes(item);
    const hasOnlyExpectedTypesSelected = treeView.selection.every((selected) => selected.contextValue === expectedType);

    if (isClickedItemSelected && selectedItems.length > 1 && hasOnlyExpectedTypesSelected) {
      return selectedItems;
    }

    return [item];
  }

  return treeView.selection.filter((selected) => selected.contextValue === expectedType);
}

function toTestCommandTarget(item: TestItem): TestCommandTarget | undefined {
  if (item.contextValue !== 'test' || !item.label || !item.uri || !item.range) {
    return undefined;
  }

  return {
    label: item.label,
    uri: item.uri,
    range: item.range,
    className: item.className
  };
}

function findCsproj(filePath: string): string | undefined {
  let dir = path.dirname(filePath);
  while (dir !== path.parse(dir).root) {
    const files = fs.readdirSync(dir);
    const csproj = files.find(f => f.endsWith('.csproj'));
    if (csproj) return path.join(dir, csproj);
    dir = path.dirname(dir);
  }
  return undefined;
}

function getTargetFrameworkFromCsproj(csprojContent: string): string {
  const single = csprojContent.match(/<TargetFramework>(.+?)<\/TargetFramework>/);
  if (single?.[1]) return single[1].trim();

  const multiple = csprojContent.match(/<TargetFrameworks>(.+?)<\/TargetFrameworks>/);
  if (multiple?.[1]) return multiple[1].split(';')[0].trim();

  return 'net9.0';
}

function tryExtractProcessId(output: string): number | undefined {
  const processIdMatch = output.match(/process\s+id\s*:\s*(\d+)/i);
  if (processIdMatch?.[1]) return Number(processIdMatch[1]);

  const pidMatch = output.match(/\bpid\s*[:=]\s*(\d+)\b/i);
  if (pidMatch?.[1]) return Number(pidMatch[1]);

  return undefined;
}

async function runTestTarget(item: TestCommandTarget): Promise<TestExecutionResult> {
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

async function debugTestTarget(item: TestCommandTarget): Promise<TestExecutionResult> {
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
    if (attachStarted) return;
    const pid = tryExtractProcessId(chunk);
    if (!pid) return;

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

async function executeClassTarget(
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

async function executeCategoryTarget(
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
    // Each class execution runs as a separate dotnet test session.
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

async function executeTestTargetsInSingleSession(
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

function groupTargetsByClass(targets: TestCommandTarget[]): Array<{ className: string; targets: TestCommandTarget[] }> {
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

  // Remove test count suffix like " (5)" and .cs extension
  return trimmed.replace(/\s*\(\d+\)$/i, '').replace(/\.cs$/i, '');
}

function collectTestTargetsFromTreeItem(item: TestItem): TestCommandTarget[] {
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

async function openFilterMenu(provider: TestTreeProvider): Promise<void> {
  const items: vscode.QuickPickItem[] = [
    { label: 'Clear Filter', description: 'Remove all filters', alwaysShow: true },
    { label: 'Filter by Category', description: 'Show only selected category' },
    { label: 'Filter by Test Name', description: 'Search by class or method name' }
  ];

  const choice = await vscode.window.showQuickPick(items, {
    placeHolder: 'Select filter type'
  });

  if (!choice) {
    return;
  }

  if (choice.label === 'Clear Filter') {
    provider.setFilter('none', '');
    vscode.window.showInformationMessage('Filter cleared');
    return;
  }

  if (choice.label === 'Filter by Category') {
    const category = await vscode.window.showInputBox({
      placeHolder: 'Enter category name (partial match)',
      prompt: 'Filter categories that contain this text'
    });
    if (category !== undefined) {
      provider.setFilter('category', category);
      vscode.window.showInformationMessage(`Filtering by category: "${category}"`);
    }
    return;
  }

  if (choice.label === 'Filter by Test Name') {
    const testName = await vscode.window.showInputBox({
      placeHolder: 'Enter test class or method name',
      prompt: 'Filter tests that contain this text'
    });
    if (testName !== undefined) {
      provider.setFilter('test', testName);
      vscode.window.showInformationMessage(`Filtering by test name: "${testName}"`);
    }
  }
}

function parseTestStatus(output: string, exitCode: number): TestExecutionStatus {
  const failed = extractSummaryCount(output, 'Failed');
  const passed = extractSummaryCount(output, 'Passed');
  const skipped = extractSummaryCount(output, 'Skipped');
  if (failed !== undefined || passed !== undefined || skipped !== undefined) {
    const failedCount = failed ?? 0;
    const passedCount = passed ?? 0;
    const skippedCount = skipped ?? 0;

    if (failedCount > 0) return 'failed';
    if (passedCount > 0) return 'passed';
    if (skippedCount > 0) return 'skipped';
    return 'not run';
  }

  if (exitCode !== 0) return 'failed';
  if (/No test matches the given testcase filter/i.test(output)) return 'skipped';
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

function updateInlineFailurePopup(target: TestCommandTarget, result: TestExecutionResult): void {
  if (!failureDiagnostics) {
    return;
  }

  const key = getDiagnosticCode(target);
  const existing = failureDiagnostics.get(target.uri) ?? [];
  const filtered = existing.filter((diagnostic) => diagnostic.code !== key);

  // Keep diagnostics clean so test failures do not mark files as editor errors.
  failureDiagnostics.set(target.uri, filtered);
}

function buildInlineFailureMessage(result: TestExecutionResult): string {
  return result.errorMessage ?? 'Test failed. Hover status marker for stack trace.';
}

function getDiagnosticCode(target: TestCommandTarget): string {
  const testName = typeof target.label === 'string' ? target.label : target.label.label;
  return `nunit:${target.range.start.line}:${testName}`;
}

function escapeForMarkdown(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\*/g, '\\*')
    .replace(/_/g, '\\_')
    .replace(/`/g, '\\`')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]');
}

function extractSummaryCount(output: string, label: 'Failed' | 'Passed' | 'Skipped'): number | undefined {
  const match = output.match(new RegExp(`${label}\\s*:\\s*(\\d+)`, 'i'));
  if (!match?.[1]) return undefined;
  return Number(match[1]);
}

class TestFilterWebviewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'nunitTestsView.filterInput';

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly treeProvider: TestTreeProvider
  ) {}

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri]
    };

    webviewView.webview.html = this.getHtmlForWebview(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(data => {
      if (data.command === 'updateFilter') {
        const { mode, value } = data;
        this.treeProvider.setFilter(mode, value);
      }
    });
  }

  private getHtmlForWebview(webview: vscode.Webview): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Test Filter</title>
    <style>
        body {
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            padding: 6px;
            margin: 0;
            background-color: var(--vscode-editor-background);
            color: var(--vscode-editor-foreground);
        }
        .filter-container {
            display: flex;
            flex-direction: column;
            gap: 4px;
            max-width: 300px;
        }
        .input-row {
            display: flex;
            gap: 6px;
            align-items: center;
        }
        select {
            padding: 6px 8px;
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            border-radius: 2px;
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            cursor: pointer;
            flex-shrink: 0;
        }
        select:focus {
            outline: none;
            border-color: var(--vscode-focusBorder);
        }
        input {
            padding: 6px 8px;
            background-color: var(--vscode-input-background);
            color: var(--vscode-input-foreground);
            border: 1px solid var(--vscode-input-border);
            border-radius: 2px;
            font-family: var(--vscode-font-family);
            font-size: var(--vscode-font-size);
            flex: 1;
            min-width: 0;
        }
        input::placeholder {
            color: var(--vscode-input-placeholderForeground);
        }
        input:focus {
            outline: none;
            border-color: var(--vscode-focusBorder);
        }
        .clear-btn {
            padding: 4px 8px;
            background-color: transparent;
            color: var(--vscode-input-foreground);
            border: none;
            border-radius: 2px;
            cursor: pointer;
            font-size: 14px;
            font-family: var(--vscode-font-family);
            transition: background-color 0.2s;
            flex-shrink: 0;
        }
        .clear-btn:hover {
            background-color: var(--vscode-button-hoverBackground);
        }
        .clear-btn:active {
            opacity: 0.8;
        }
        .info-text {
            font-size: 11px;
            color: var(--vscode-descriptionForeground);
            padding: 0 2px;
            line-height: 1.3;
        }
    </style>
</head>
<body>
    <div class="filter-container">
        <div class="input-row">
            <select id="filterMode">
                <option value="category">Category</option>
                <option value="test">Test Name</option>
            </select>
            <input type="text" id="searchInput" placeholder="Search...">
            <button class="clear-btn" id="clearBtn" title="Clear">✕</button>
        </div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        const filterMode = document.getElementById('filterMode');
        const searchInput = document.getElementById('searchInput');
        const clearBtn = document.getElementById('clearBtn');
        const infoText = document.getElementById('infoText');

        let currentMode = 'category';
        let currentValue = '';

        function updateFilter(mode, value) {
            currentMode = mode;
            currentValue = value;
            filterMode.value = mode;
            searchInput.value = value;
            
            vscode.postMessage({
                command: 'updateFilter',
                mode: mode,
                value: value
            });

            updateInfo();
        }

        function updateInfo() {
            if (currentMode === 'category') {
                infoText.textContent = currentValue ? 'Filtering by category: "' + currentValue + '"' : 'Filtering by category';
            } else if (currentMode === 'test') {
                infoText.textContent = currentValue ? 'Filtering by test name: "' + currentValue + '"' : 'Filtering by test name';
            }
        }

        filterMode.addEventListener('change', (e) => {
            const mode = e.target.value;
            updateFilter(mode, '');
            searchInput.value = '';
            searchInput.focus();
        });

        searchInput.addEventListener('input', (e) => {
            updateFilter(currentMode, e.target.value);
        });

        clearBtn.addEventListener('click', () => {
            searchInput.value = '';
            updateFilter(currentMode, '');
        });

        updateInfo();
    </script>
</body>
</html>`;
  }
}

class TestDetailsWebviewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'nunitTestsView.details';
  private view: vscode.WebviewView | undefined;
  private selectedTestName: string | undefined;
  private selectedResult: TestExecutionResult | undefined;
  private selectedTestTarget: TestCaseTarget | undefined;
  private summaryTitle: string | undefined;
  private summaryCounts: TestSummaryCounts | undefined;

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this.view = webviewView;
    this.view.webview.options = {
      enableScripts: true
    };

    this.view.webview.onDidReceiveMessage((data) => {
      if (data.command === 'openTestCase' && data.target) {
        void openTestCase(data.target as TestCaseTarget);
        return;
      }
      if (data.command === 'openFrame' && data.target) {
        void openStackFrame(data.target as StackFrameTarget);
        return;
      }
      if (data.command === 'openAttachment' && typeof data.path === 'string') {
        void openAttachmentFile(data.path);
      }
    });

    this.render();
  }

  public setSelectedTest(testName: string, result: TestExecutionResult, target: TestCommandTarget): void {
    this.selectedTestName = testName;
    this.selectedResult = result;
    this.selectedTestTarget = {
      filePath: target.uri.fsPath,
      line: target.range.start.line + 1,
      column: target.range.start.character + 1
    };
    this.summaryTitle = undefined;
    this.summaryCounts = undefined;
    this.render();
  }

  public setSummary(title: string, counts: TestSummaryCounts): void {
    this.summaryTitle = title;
    this.summaryCounts = counts;
    this.selectedTestName = undefined;
    this.selectedResult = undefined;
    this.selectedTestTarget = undefined;
    this.render();
  }

  public clear(): void {
    this.selectedTestName = undefined;
    this.selectedResult = undefined;
    this.selectedTestTarget = undefined;
    this.summaryTitle = undefined;
    this.summaryCounts = undefined;
    this.render();
  }

  private render(): void {
    if (!this.view) {
      return;
    }

    const webview = this.view.webview;
    const name = this.selectedTestName;
    const result = this.selectedResult;
    const testTarget = this.selectedTestTarget;

    if (this.summaryTitle && this.summaryCounts) {
      webview.html = this.getSummaryHtml(this.summaryTitle, this.summaryCounts);
      return;
    }

    if (!name || !result) {
      webview.html = this.getEmptyHtml();
      return;
    }

    const escapedName = escapeForHtml(name);
    const hasTestTarget = !!testTarget;
    const escapedStatus = escapeForHtml(result.status);
    const durationText = formatDuration(result.durationMs);
    const escapedError = result.errorMessage ? escapeForHtml(result.errorMessage) : '';
    const screenshotPath = result.screenshotPath;
    const screenshotFileName = screenshotPath
      ? path.basename(screenshotPath.replace(/\\/g, '/'))
      : '';
    const escapedScreenshotFileName = screenshotFileName ? escapeForHtml(screenshotFileName) : '';
    const escapedScreenshotPath = screenshotPath ? escapeForHtml(screenshotPath) : '';
    const stackLines = (result.stackTrace ?? '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const stackRows = stackLines.map((line) => ({
      text: line,
      frame: parseStackFrame(line)
    }));
    const frames = stackRows.filter((row) => row.frame).map((row) => row.frame) as StackFrameTarget[];
    const framesJson = JSON.stringify(frames).replace(/</g, '\\u003c');

    const stackList = stackRows.length
      ? stackRows.map((row) => {
          const escapedLine = escapeForHtml(row.text);
          if (row.frame) {
            const frameIndex = frames.findIndex((frame) =>
              frame.filePath === row.frame!.filePath && frame.line === row.frame!.line && frame.column === row.frame!.column
            );
            return `<li>${escapedLine} <a href="#" data-open-frame="${frameIndex}">open</a></li>`;
          }
          return `<li>${escapedLine}</li>`;
        }).join('')
      : '<li>No stack trace available.</li>';

    const showFailure = result.status === 'failed';
    const hasScreenshotPath = showFailure && !!screenshotPath;

    webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-editor-foreground);
      background: var(--vscode-editor-background);
      padding: 8px;
      margin: 0;
    }
    h3 {
      margin: 0 0 8px 0;
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
      text-transform: uppercase;
      letter-spacing: 0.3px;
    }
    .row {
      margin: 0 0 6px 0;
      word-break: break-word;
    }
    .label {
      color: var(--vscode-descriptionForeground);
      margin-right: 4px;
    }
    .status {
      font-weight: 600;
    }
    .stack {
      margin-top: 8px;
      padding-top: 6px;
      border-top: 1px solid var(--vscode-editorWidget-border);
    }
    .screenshot {
      margin-top: 8px;
      padding-top: 6px;
      border-top: 1px solid var(--vscode-editorWidget-border);
    }
    .path {
      margin-top: 4px;
      word-break: break-all;
    }
    ul {
      margin: 6px 0 0 16px;
      padding: 0;
    }
    li {
      margin: 0 0 4px 0;
    }
    a {
      color: var(--vscode-textLink-foreground);
      text-decoration: underline;
      cursor: pointer;
    }
  </style>
</head>
<body>
  <h3>Test Details</h3>
  <div class="row"><span class="label">Name:</span>${hasTestTarget ? `<a href="#" data-open-test="1"><strong>${escapedName}</strong></a>` : `<strong>${escapedName}</strong>`}</div>
  <div class="row"><span class="label">Status:</span><span class="status">${escapedStatus}</span></div>
  <div class="row"><span class="label">Duration:</span><span class="status">${durationText}</span></div>
  ${showFailure ? `<div class="row"><span class="label">Error:</span>${escapedError || 'Test failed.'}</div>` : ''}
  ${showFailure ? `<div class="screenshot"><span class="label">Screenshot:</span>${hasScreenshotPath ? ` <a href="#" data-open-attachment="1">open</a><div class="path" title="${escapedScreenshotPath}">${escapedScreenshotFileName}</div>` : ' Not available'}</div>` : ''}
  ${showFailure ? `<div class="stack"><span class="label">Stack Trace:</span><ul>${stackList}</ul></div>` : ''}
  <script>
    const vscode = acquireVsCodeApi();
    const testTarget = ${JSON.stringify(testTarget ?? null)};
    const frames = ${framesJson};
    const screenshotPath = ${JSON.stringify(screenshotPath ?? null)};
    document.addEventListener('click', (event) => {
      const testLink = event.target.closest('a[data-open-test]');
      if (testLink && testTarget) {
        event.preventDefault();
        vscode.postMessage({ command: 'openTestCase', target: testTarget });
        return;
      }

      const link = event.target.closest('a[data-open-frame]');
      if (link) {
        event.preventDefault();
        const index = Number(link.getAttribute('data-open-frame'));
        const target = frames[index];
        if (!target) {
          return;
        }
        vscode.postMessage({ command: 'openFrame', target });
        return;
      }

      const attachmentLink = event.target.closest('a[data-open-attachment]');
      if (!attachmentLink || !screenshotPath) {
        return;
      }
      event.preventDefault();
      vscode.postMessage({ command: 'openAttachment', path: screenshotPath });
    });
  </script>
</body>
</html>`;
  }

  private getSummaryHtml(title: string, counts: TestSummaryCounts): string {
    const escapedTitle = escapeForHtml(title);
    const durationText = counts.durationSamples > 0 ? formatDuration(counts.totalDurationMs) : 'N/A';
    const statusRows = [
      counts.passed > 0 ? `<div class="stat"><span>Passed</span><span class="value passed">${counts.passed}</span></div>` : '',
      counts.failed > 0 ? `<div class="stat"><span>Failed</span><span class="value failed">${counts.failed}</span></div>` : '',
      counts.skipped > 0 ? `<div class="stat"><span>Skipped</span><span class="value">${counts.skipped}</span></div>` : '',
      counts.notRun > 0 ? `<div class="stat"><span>Not Run</span><span class="value">${counts.notRun}</span></div>` : '',
      counts.inProgress > 0 ? `<div class="stat"><span>In Progress</span><span class="value">${counts.inProgress}</span></div>` : '',
      counts.active > 0 ? `<div class="stat"><span>Active</span><span class="value">${counts.active}</span></div>` : ''
    ].filter(Boolean).join('');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-editor-foreground);
      background: var(--vscode-editor-background);
      padding: 8px;
      margin: 0;
    }
    h3 {
      margin: 0 0 8px 0;
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
      text-transform: uppercase;
      letter-spacing: 0.3px;
    }
    .row {
      margin: 0 0 6px 0;
      word-break: break-word;
    }
    .label {
      color: var(--vscode-descriptionForeground);
      margin-right: 4px;
    }
    .stats {
      margin-top: 8px;
      border-top: 1px solid var(--vscode-editorWidget-border);
      padding-top: 6px;
    }
    .stat {
      margin: 4px 0;
      display: flex;
      justify-content: space-between;
    }
    .value {
      font-weight: 600;
    }
    .failed {
      color: #EF4444;
    }
    .passed {
      color: #22C55E;
    }
  </style>
</head>
<body>
  <h3>Test Details</h3>
  <div class="row"><span class="label">Scope:</span>${escapedTitle}</div>
  <div class="row"><span class="label">Total Duration:</span><span class="value">${durationText}</span></div>
  <div class="stats">
    <div class="stat"><span>Total</span><span class="value">${counts.total}</span></div>
    ${statusRows}
  </div>
</body>
</html>`;
  }

  private getEmptyHtml(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-descriptionForeground);
      background: var(--vscode-editor-background);
      padding: 8px;
      margin: 0;
    }
  </style>
</head>
<body>Select a test case to see details.</body>
</html>`;
  }
}

class NUnitGutterTestController implements vscode.Disposable {
  private readonly controller: vscode.TestController;
  private readonly targetByTestId = new Map<string, TestCommandTarget>();
  private readonly treeProvider: TestTreeProvider;
  private readonly gutterDecorator: NUnitGutterIconDecorator;

  constructor(treeProvider: TestTreeProvider, gutterDecorator: NUnitGutterIconDecorator) {
    this.treeProvider = treeProvider;
    this.gutterDecorator = gutterDecorator;
    this.controller = vscode.tests.createTestController('nunitGutterTests', 'NUnit');
    this.controller.createRunProfile('Run', vscode.TestRunProfileKind.Run, (request, token) => {
      void this.execute(request, token, false);
    }, true);
    this.controller.createRunProfile('Debug', vscode.TestRunProfileKind.Debug, (request, token) => {
      void this.execute(request, token, true);
    }, true);
  }

  dispose(): void {
    this.controller.dispose();
  }

  async refresh(): Promise<void> {
    this.controller.items.replace([]);
    this.targetByTestId.clear();

    const discoveredProjects = await discoverTestsAcrossWorkspace();

    for (const project of discoveredProjects) {
      for (const test of project.tests) {
        if (!test.uri) {
          continue;
        }

        const uri = test.uri;
        const fileId = `file:${uri.toString()}`;
        let fileItem = this.controller.items.get(fileId);
        if (!fileItem) {
          fileItem = this.controller.createTestItem(fileId, path.basename(uri.fsPath), uri);
          this.controller.items.add(fileItem);
        }

        const testId = `${uri.toString()}:${test.lineNumber}:${test.name}`;
        const testItem = this.controller.createTestItem(testId, test.name, uri);
        testItem.range = new vscode.Range(test.lineNumber, 0, test.lineNumber, 0);
        fileItem.children.add(testItem);
        this.targetByTestId.set(testId, {
          label: test.name,
          uri,
          range: testItem.range
        });
      }
    }
  }

  private async execute(request: vscode.TestRunRequest, token: vscode.CancellationToken, debug: boolean): Promise<void> {
    const run = this.controller.createTestRun(request);
    const queue = this.collectRequestedTests(request);

    for (const testItem of queue) {
      if (token.isCancellationRequested) break;

      const target = this.targetByTestId.get(testItem.id);
      if (!target) continue;

      this.treeProvider.setStatusForTarget(target, 'active');
      this.gutterDecorator.updateTestResult(target, { status: 'active' });
      updateInlineFailurePopup(target, { status: 'active' });
      run.started(testItem);
      try {
        let result: TestExecutionResult = { status: 'not run' };
        if (debug) {
          result = await debugTestTarget(target);
        } else {
          result = await runTestTarget(target);
        }

        this.treeProvider.setStatusForTarget(target, result.status);
        this.gutterDecorator.updateTestResult(target, result);
        updateInlineFailurePopup(target, result);
        if (result.status === 'passed') {
          run.passed(testItem, 0);
        } else if (result.status === 'skipped') {
          run.skipped(testItem);
        } else if (result.status === 'failed') {
          run.failed(testItem, new vscode.TestMessage(buildInlineFailureMessage(result)), 0);
        } else {
          run.skipped(testItem);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown test error';
        run.failed(testItem, new vscode.TestMessage(message), 0);
        this.treeProvider.setStatusForTarget(target, 'failed');
        this.gutterDecorator.updateTestResult(target, { status: 'failed', errorMessage: message });
        updateInlineFailurePopup(target, { status: 'failed', errorMessage: message });
      }
    }

    run.end();
  }

  private collectRequestedTests(request: vscode.TestRunRequest): vscode.TestItem[] {
    const all: vscode.TestItem[] = [];
    if (request.include?.length) {
      for (const item of request.include) {
        this.collectLeafTests(item, all);
      }
      return all;
    }

    this.controller.items.forEach((item) => this.collectLeafTests(item, all));
    return all;
  }

  private collectLeafTests(item: vscode.TestItem, out: vscode.TestItem[]): void {
    if (this.targetByTestId.has(item.id)) {
      out.push(item);
    }
    item.children.forEach((child) => this.collectLeafTests(child, out));
  }
}

class NUnitGutterIconDecorator implements vscode.Disposable {
  private readonly decorationTypes: Record<TestExecutionStatus, vscode.TextEditorDecorationType>;
  private readonly inlineDecorationTypes: Record<TestExecutionStatus, vscode.TextEditorDecorationType>;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly statusByKey = new Map<string, TestExecutionStatus>();
  private readonly failureByKey = new Map<string, { errorMessage?: string; stackTrace?: string; screenshotPath?: string }>();
  private readonly durationByKey = new Map<string, number>();

  constructor(extensionUri: vscode.Uri) {
    this.decorationTypes = {
      passed: vscode.window.createTextEditorDecorationType({
        gutterIconPath: vscode.Uri.joinPath(extensionUri, 'resources', 'status-pass.svg'),
        gutterIconSize: 'contain',
        isWholeLine: true
      }),
      failed: vscode.window.createTextEditorDecorationType({
        gutterIconPath: vscode.Uri.joinPath(extensionUri, 'resources', 'status-fail.svg'),
        gutterIconSize: 'contain',
        isWholeLine: true
      }),
      skipped: vscode.window.createTextEditorDecorationType({
        gutterIconPath: vscode.Uri.joinPath(extensionUri, 'resources', 'status-skipped.svg'),
        gutterIconSize: 'contain',
        isWholeLine: true
      }),
      'not run': vscode.window.createTextEditorDecorationType({
        gutterIconPath: vscode.Uri.joinPath(extensionUri, 'resources', 'status-not-run.svg'),
        gutterIconSize: 'contain',
        isWholeLine: true
      }),
      'in progress': vscode.window.createTextEditorDecorationType({
        gutterIconPath: vscode.Uri.joinPath(extensionUri, 'resources', 'status-in-progress.svg'),
        gutterIconSize: 'contain',
        isWholeLine: true
      }),
      active: vscode.window.createTextEditorDecorationType({
        gutterIconPath: vscode.Uri.joinPath(extensionUri, 'resources', 'status-active.svg'),
        gutterIconSize: 'contain',
        isWholeLine: true
      })
    };

    this.inlineDecorationTypes = {
      passed: vscode.window.createTextEditorDecorationType({}),
      failed: vscode.window.createTextEditorDecorationType({}),
      skipped: vscode.window.createTextEditorDecorationType({}),
      'not run': vscode.window.createTextEditorDecorationType({}),
      'in progress': vscode.window.createTextEditorDecorationType({}),
      active: vscode.window.createTextEditorDecorationType({})
    };

    this.disposables.push(
      vscode.window.onDidChangeVisibleTextEditors(() => this.refreshVisibleEditors()),
      vscode.window.onDidChangeActiveTextEditor(() => this.refreshVisibleEditors()),
      vscode.workspace.onDidOpenTextDocument((document) => {
        if (document.languageId === 'csharp') {
          this.refreshVisibleEditors();
        }
      }),
      vscode.workspace.onDidSaveTextDocument((document) => {
        if (document.languageId === 'csharp') {
          this.refreshVisibleEditors();
        }
      }),
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (event.document.languageId === 'csharp') {
          this.refreshVisibleEditors();
        }
      })
    );

    this.refreshVisibleEditors();
  }

  updateTestResult(target: TestCommandTarget, result: TestExecutionResult): void {
    const key = this.getKey(target.uri, target.range.start.line, target.label);
    this.statusByKey.set(key, result.status);

    if (Number.isFinite(result.durationMs)) {
      this.durationByKey.set(key, result.durationMs as number);
    } else {
      this.durationByKey.delete(key);
    }

    if (result.status === 'failed') {
      this.failureByKey.set(key, {
        errorMessage: result.errorMessage,
        stackTrace: result.stackTrace,
        screenshotPath: result.screenshotPath
      });
    } else {
      this.failureByKey.delete(key);
    }
    this.refreshVisibleEditors();
  }

  getTestResultForTarget(target: TestCommandTarget): TestExecutionResult {
    const key = this.getKey(target.uri, target.range.start.line, target.label);
    const status = this.statusByKey.get(key) ?? 'not run';
    const failure = this.failureByKey.get(key);
    return {
      status,
      errorMessage: failure?.errorMessage,
      stackTrace: failure?.stackTrace,
      screenshotPath: failure?.screenshotPath,
      durationMs: this.durationByKey.get(key)
    };
  }

  dispose(): void {
    for (const status of Object.keys(this.decorationTypes) as TestExecutionStatus[]) {
      this.decorationTypes[status].dispose();
      this.inlineDecorationTypes[status].dispose();
    }
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }

  private refreshVisibleEditors(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document.languageId !== 'csharp') {
        for (const status of Object.keys(this.decorationTypes) as TestExecutionStatus[]) {
          editor.setDecorations(this.decorationTypes[status], []);
          editor.setDecorations(this.inlineDecorationTypes[status], []);
        }
        continue;
      }

      const className = path.basename(editor.document.fileName);
      const tests = extractTestsWithCategoryFromClass(editor.document.getText(), className);
      const optionsByStatus: Record<TestExecutionStatus, vscode.DecorationOptions[]> = {
        passed: [],
        failed: [],
        skipped: [],
        'not run': [],
        'in progress': [],
        active: []
      };
      const inlineOptionsByStatus: Record<TestExecutionStatus, vscode.DecorationOptions[]> = {
        passed: [],
        failed: [],
        skipped: [],
        'not run': [],
        'in progress': [],
        active: []
      };

      for (const test of tests) {
        const range = editor.document.lineAt(test.lineNumber).range;
        const key = this.getKey(editor.document.uri, test.lineNumber, test.name);
        const status = this.statusByKey.get(key) ?? 'not run';
        const hoverMessage = this.buildHoverMessage(status, key);
        optionsByStatus[status].push({ range, hoverMessage });
      }

      for (const status of Object.keys(this.decorationTypes) as TestExecutionStatus[]) {
        editor.setDecorations(this.decorationTypes[status], optionsByStatus[status]);
        editor.setDecorations(this.inlineDecorationTypes[status], []);
      }
    }
  }

  private getKey(uri: vscode.Uri, line: number, label: string | vscode.TreeItemLabel): string {
    const testName = typeof label === 'string' ? label : label.label;
    return `${uri.toString()}:${line}:${testName}`;
  }

  private buildHoverMessage(status: TestExecutionStatus, key: string): vscode.MarkdownString {
    const markdown = new vscode.MarkdownString();
    markdown.isTrusted = { enabledCommands: ['nunitTestsView.openStackFrame'] };
    markdown.appendMarkdown(`**Status:** ${status}`);

    if (status === 'failed') {
      const details = this.failureByKey.get(key);
      if (details?.errorMessage) {
        markdown.appendMarkdown(`\n\n**Error:**\n\n${escapeForMarkdown(details.errorMessage)}`);
      }
      if (details?.stackTrace) {
        markdown.appendMarkdown('\n\n**Stack trace:**\n\n');
        appendStackTraceWithLinks(markdown, details.stackTrace);
      }
    }

    return markdown;
  }
}

function appendStackTraceWithLinks(markdown: vscode.MarkdownString, stackTrace: string): void {
  const lines = stackTrace
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line, index, all) => Boolean(line) && all.indexOf(line) === index);
  if (!lines.length) {
    return;
  }

  for (const line of lines) {
    const frame = parseStackFrame(line);
    if (frame) {
      const link = createStackFrameLink(frame);
      if (link) {
        markdown.appendMarkdown(`- ${escapeForMarkdown(line)} ([open](${link}))\n`);
        continue;
      }
    }

    markdown.appendMarkdown(`- ${escapeForMarkdown(line)}\n`);
  }
}

function createStackFrameLink(frame: StackFrameTarget): string | undefined {
  try {
    const args = encodeURIComponent(JSON.stringify(frame));
    return `command:nunitTestsView.openStackFrame?${args}`;
  } catch {
    return undefined;
  }
}

function parseStackFrame(line: string): StackFrameTarget | undefined {
  const normalized = line.replace(/^\d+\)\s*/, '').trim();
  const match = normalized.match(/\sin\s(.+?):line\s(\d+)\b/i);
  if (!match?.[1] || !match[2]) {
    return undefined;
  }

  const filePath = match[1].trim();
  const lineNumber = Number(match[2]);
  if (!Number.isFinite(lineNumber) || lineNumber <= 0) {
    return undefined;
  }

  return { filePath, line: lineNumber };
}

async function openStackFrame(target: StackFrameTarget): Promise<void> {
  if (!target?.filePath || !target?.line) {
    return;
  }

  const uri = vscode.Uri.file(target.filePath);
  const position = new vscode.Position(Math.max(target.line - 1, 0), Math.max((target.column ?? 1) - 1, 0));
  const selection = new vscode.Selection(position, position);
  const editor = await vscode.window.showTextDocument(uri, { preview: false, selection });
  editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
}

async function openTestCase(target: TestCaseTarget): Promise<void> {
  if (!target?.filePath || !target?.line) {
    return;
  }

  const uri = vscode.Uri.file(target.filePath);
  const position = new vscode.Position(Math.max(target.line - 1, 0), Math.max((target.column ?? 1) - 1, 0));
  const selection = new vscode.Selection(position, position);
  const editor = await vscode.window.showTextDocument(uri, { preview: false, selection });
  editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
}

class TestTreeProvider implements vscode.TreeDataProvider<TestItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<TestItem | undefined | void> = new vscode.EventEmitter();
  readonly onDidChangeTreeData: vscode.Event<TestItem | undefined | void> = this._onDidChangeTreeData.event;
  private readonly statusByKey = new Map<string, TestExecutionStatus>();
  private filterMode: 'none' | 'category' | 'test' = 'none';
  private filterValue = '';

  refresh(): void { this._onDidChangeTreeData.fire(); }
  getTreeItem(element: TestItem): vscode.TreeItem { return element; }

  setFilter(mode: 'none' | 'category' | 'test', value: string): void {
    this.filterMode = mode;
    this.filterValue = value;
    this.refresh();
  }

  setStatusForTarget(target: TestCommandTarget, status: TestExecutionStatus): void {
    this.statusByKey.set(this.getStatusKey(target.uri, target.range.start.line, target.label), status);
    this.refresh();
  }

  getStatusForTarget(target: TestCommandTarget): TestExecutionStatus {
    return this.statusByKey.get(this.getStatusKey(target.uri, target.range.start.line, target.label)) ?? 'not run';
  }

  private getStatus(uri: vscode.Uri, lineNumber: number, testName: string): TestExecutionStatus {
    return this.statusByKey.get(this.getStatusKey(uri, lineNumber, testName)) ?? 'not run';
  }

  private getStatusKey(uri: vscode.Uri, lineNumber: number, testNameOrLabel: string | vscode.TreeItemLabel): string {
    const testName = typeof testNameOrLabel === 'string' ? testNameOrLabel : testNameOrLabel.label;
    return `${uri.toString()}:${lineNumber}:${testName}`;
  }

  async getChildren(element?: TestItem): Promise<TestItem[]> {
    if (!element) {
      const discoveredProjects = await discoverTestsAcrossWorkspace();
      const projectNodes: TestItem[] = [];

      for (const project of discoveredProjects) {
        let categoryMap = new Map<string, Map<string, TestWithCategory[]>>();
        project.tests.forEach((test) => {
          if (!categoryMap.has(test.category)) {
            categoryMap.set(test.category, new Map());
          }
          const classMap = categoryMap.get(test.category)!;
          if (!classMap.has(test.className)) {
            classMap.set(test.className, []);
          }
          classMap.get(test.className)!.push(test);
        });

        if (this.filterMode === 'category' && this.filterValue) {
          const filtered = new Map<string, Map<string, TestWithCategory[]>>();
          for (const [cat, classMap] of categoryMap.entries()) {
            if (cat.toLowerCase().includes(this.filterValue.toLowerCase())) {
              filtered.set(cat, classMap);
            }
          }
          categoryMap = filtered;
        }

        if (this.filterMode === 'test' && this.filterValue) {
          const filtered = new Map<string, Map<string, TestWithCategory[]>>();
          for (const [cat, classMap] of categoryMap.entries()) {
            const filteredClassMap = new Map<string, TestWithCategory[]>();
            for (const [className, tests] of classMap.entries()) {
              const filteredTests = tests.filter((test) =>
                test.name.toLowerCase().includes(this.filterValue.toLowerCase()) ||
                className.toLowerCase().includes(this.filterValue.toLowerCase())
              );
              if (filteredTests.length > 0) {
                filteredClassMap.set(className, filteredTests);
              }
            }
            if (filteredClassMap.size > 0) {
              filtered.set(cat, filteredClassMap);
            }
          }
          categoryMap = filtered;
        }

        const categoryNodes: TestItem[] = [];
        for (const [category, classMap] of categoryMap.entries()) {
          const classNodes: TestItem[] = [];
          for (const [className, tests] of classMap.entries()) {
            const testNodes = tests.map((test) => new TestItem(
              test.name,
              vscode.TreeItemCollapsibleState.None,
              undefined,
              test.uri,
              new vscode.Range(test.lineNumber, 0, test.lineNumber, 0),
              'test',
              this.getStatus(test.uri!, test.lineNumber, test.name),
              className
            ));

            const classLabelWithCount = `${className} (${tests.length})`;
            classNodes.push(new TestItem(
              classLabelWithCount,
              vscode.TreeItemCollapsibleState.Collapsed,
              testNodes,
              undefined,
              undefined,
              'class',
              this.getClassStatus(tests),
              className
            ));
          }

          const totalTestsInCategory = Array.from(classMap.values()).reduce((sum, tests) => sum + tests.length, 0);
          const categoryLabelWithCount = `${category} (${totalTestsInCategory})`;
          categoryNodes.push(new TestItem(
            categoryLabelWithCount,
            vscode.TreeItemCollapsibleState.Collapsed,
            classNodes,
            undefined,
            undefined,
            'category',
            this.getCategoryStatus(classMap)
          ));
        }

        if (!categoryNodes.length) {
          continue;
        }

        const projectStatus = this.getProjectStatus(project.tests);
        const projectLabelWithCount = `${project.displayName} (${project.tests.length})`;
        projectNodes.push(new TestItem(
          projectLabelWithCount,
          vscode.TreeItemCollapsibleState.Collapsed,
          categoryNodes,
          undefined,
          undefined,
          'project',
          projectStatus
        ));
      }

      return projectNodes;
    }
    return element.children || [];
  }

  private getProjectStatus(tests: TestWithCategory[]): TestExecutionStatus {
    return this.getClassStatus(tests);
  }

  private getClassStatus(tests: TestWithCategory[]): TestExecutionStatus {
    const statuses = tests.map((test) => this.getStatus(test.uri!, test.lineNumber, test.name));
    if (statuses.some((status) => status === 'failed')) {
      return 'failed';
    }
    if (statuses.some((status) => status === 'active')) {
      return 'active';
    }
    if (statuses.some((status) => status === 'in progress')) {
      return 'in progress';
    }
    if (statuses.length > 0 && statuses.every((status) => status === 'passed')) {
      return 'passed';
    }
    if (statuses.length > 0 && statuses.every((status) => status === 'skipped')) {
      return 'skipped';
    }
    if (statuses.some((status) => status === 'not run')) {
      return 'not run';
    }
    if (statuses.some((status) => status === 'passed')) {
      return 'passed';
    }
    return 'not run';
  }

  private getCategoryStatus(classMap: Map<string, TestWithCategory[]>): TestExecutionStatus {
    const classStatuses = Array.from(classMap.values()).map((tests) => this.getClassStatus(tests));

    if (classStatuses.some((status) => status === 'failed')) {
      return 'failed';
    }
    if (classStatuses.some((status) => status === 'active')) {
      return 'active';
    }
    if (classStatuses.some((status) => status === 'in progress')) {
      return 'in progress';
    }
    if (classStatuses.length > 0 && classStatuses.every((status) => status === 'passed')) {
      return 'passed';
    }
    if (classStatuses.length > 0 && classStatuses.every((status) => status === 'skipped')) {
      return 'skipped';
    }
    if (classStatuses.some((status) => status === 'not run')) {
      return 'not run';
    }
    if (classStatuses.some((status) => status === 'passed')) {
      return 'passed';
    }

    return 'not run';
  }
}

class TestItem extends vscode.TreeItem {
  children?: TestItem[];
  uri?: vscode.Uri;
  range?: vscode.Range;
  className?: string;

  constructor(
    label: string,
    collapsibleState: vscode.TreeItemCollapsibleState = vscode.TreeItemCollapsibleState.None,
    children?: TestItem[],
    uri?: vscode.Uri,
    range?: vscode.Range,
    type: 'project' | 'category' | 'class' | 'test' = 'test',
    status: TestExecutionStatus = 'not run',
    className?: string
  ) {
    super(label, collapsibleState);
    this.children = children;
    this.uri = uri;
    this.range = range;
    this.className = className;
    this.contextValue = type;

    if (type === 'test' && uri && range) {
      this.command = { command: 'vscode.open', title: 'Go to Test', arguments: [uri, { selection: range }] };
      this.description = status;
      this.iconPath = getStatusIcon(status);
    }

    if (type === 'project' || type === 'class' || type === 'category') {
      this.description = status;
      this.iconPath = getStatusIcon(status);
    }
  }
}

function getStatusIcon(status: TestExecutionStatus): vscode.ThemeIcon {
  switch (status) {
    case 'passed':
      return new vscode.ThemeIcon('pass', new vscode.ThemeColor('charts.green'));
    case 'failed':
      return new vscode.ThemeIcon('error', new vscode.ThemeColor('charts.red'));
    case 'skipped':
      return new vscode.ThemeIcon('debug-pause', new vscode.ThemeColor('charts.yellow'));
    case 'active':
      return new vscode.ThemeIcon('sync~spin', new vscode.ThemeColor('charts.yellow'));
    case 'in progress':
      return new vscode.ThemeIcon('sync', new vscode.ThemeColor('charts.gray'));
    default:
      return new vscode.ThemeIcon('circle-outline', new vscode.ThemeColor('charts.blue'));
  }
}

function escapeForHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function openAttachmentFile(filePath: string): Thenable<unknown> {
  return vscode.commands.executeCommand('vscode.open', vscode.Uri.file(filePath));
}

function buildSummaryCountsForItem(item: TestItem, gutterDecorator: NUnitGutterIconDecorator): TestSummaryCounts {
  const counts: TestSummaryCounts = {
    total: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
    notRun: 0,
    inProgress: 0,
    active: 0,
    totalDurationMs: 0,
    durationSamples: 0
  };

  const targets = collectTestTargetsFromTreeItem(item);
  counts.total = targets.length;

  for (const target of targets) {
    const result = gutterDecorator.getTestResultForTarget(target);
    if (Number.isFinite(result.durationMs)) {
      counts.totalDurationMs += result.durationMs as number;
      counts.durationSamples += 1;
    }

    switch (result.status) {
      case 'passed':
        counts.passed += 1;
        break;
      case 'failed':
        counts.failed += 1;
        break;
      case 'skipped':
        counts.skipped += 1;
        break;
      case 'not run':
        counts.notRun += 1;
        break;
      case 'in progress':
        counts.inProgress += 1;
        break;
      case 'active':
        counts.active += 1;
        break;
      default:
        counts.notRun += 1;
        break;
    }
  }

  return counts;
}

function formatDuration(durationMs: number | undefined): string {
  if (!Number.isFinite(durationMs)) {
    return 'N/A';
  }

  const totalMs = Math.max(0, Math.round(durationMs as number));
  if (totalMs < 1000) {
    return `${totalMs} ms`;
  }

  const totalSeconds = totalMs / 1000;
  if (totalSeconds < 60) {
    return `${totalSeconds.toFixed(2)} s`;
  }

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds.toFixed(1)}s`;
}

function fileToImageDataUri(filePath: string): string | undefined {
  try {
    if (!fs.existsSync(filePath)) {
      return undefined;
    }

    const mime = getImageMimeType(filePath);
    if (!mime) {
      return undefined;
    }

    const bytes = fs.readFileSync(filePath);
    return `data:${mime};base64,${bytes.toString('base64')}`;
  } catch {
    return undefined;
  }
}

function getImageMimeType(filePath: string): string | undefined {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.png')) {
    return 'image/png';
  }
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) {
    return 'image/jpeg';
  }
  if (lower.endsWith('.webp')) {
    return 'image/webp';
  }
  return undefined;
}

const TEST_ATTRIBUTES = ['Test', 'TestWithRetry', 'TestCase'];

function extractTestsWithCategoryFromClass(content: string, className: string): TestWithCategory[] {
  const lines = content.split(/\r?\n/);
  const results: TestWithCategory[] = [];
  let currentCategory = 'Uncategorized';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const fixtureMatch = line.match(/^\[TestFixture(?:\s*,\s*Category\("(.+?)"\))?/);
    if (fixtureMatch && fixtureMatch[1]) currentCategory = fixtureMatch[1];

    const attrMatch = line.match(/^\[(\w+)/);
    if (attrMatch && TEST_ATTRIBUTES.includes(attrMatch[1])) {
      for (let k = i + 1; k < lines.length; k++) {
        const methodMatch = lines[k].trim().match(/^public\s+(?:async\s+)?(?:Task|void)\s+(\w+)/);
        if (methodMatch) { 
          results.push({ name: methodMatch[1], className, category: currentCategory, lineNumber: k }); 
          break; 
        }
      }
    }
  }

  return results;
}

interface TestWithCategory {
  name: string;
  className: string;
  category: string;
  lineNumber: number;
  uri?: vscode.Uri;
}

interface ProjectTestsGroup {
  csprojPath: string;
  displayName: string;
  tests: TestWithCategory[];
}

async function discoverTestsAcrossWorkspace(): Promise<ProjectTestsGroup[]> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    return [];
  }

  const csprojUris = await vscode.workspace.findFiles('**/*.csproj', '**/{bin,obj}/**');
  if (!csprojUris.length) {
    return [];
  }

  const baseNameCounts = new Map<string, number>();
  for (const csprojUri of csprojUris) {
    const baseName = path.basename(csprojUri.fsPath, '.csproj');
    baseNameCounts.set(baseName, (baseNameCounts.get(baseName) ?? 0) + 1);
  }

  const projectGroups: ProjectTestsGroup[] = [];

  for (const csprojUri of csprojUris) {
    const projectDir = path.dirname(csprojUri.fsPath);
    const csprojBaseName = path.basename(csprojUri.fsPath, '.csproj');
    const isDuplicateName = (baseNameCounts.get(csprojBaseName) ?? 0) > 1;
    const relativeDir = path.relative(workspaceFolder.uri.fsPath, projectDir);
    const displayName = isDuplicateName
      ? `${csprojBaseName} (${relativeDir || '.'})`
      : csprojBaseName;

    const csFiles = await vscode.workspace.findFiles(
      new vscode.RelativePattern(projectDir, '**/*.cs'),
      '**/{bin,obj}/**'
    );

    const tests: TestWithCategory[] = [];
    for (const file of csFiles) {
      const content = Buffer.from(await vscode.workspace.fs.readFile(file)).toString('utf-8');
      const className = path.basename(file.fsPath);
      const classTests = extractTestsWithCategoryFromClass(content, className).map((test) => ({
        ...test,
        uri: file
      }));
      tests.push(...classTests);
    }

    if (tests.length === 0) {
      continue;
    }

    projectGroups.push({
      csprojPath: csprojUri.fsPath,
      displayName,
      tests
    });
  }

  return projectGroups.sort((a, b) => a.displayName.localeCompare(b.displayName));
}

interface TestCommandTarget {
  label: string | vscode.TreeItemLabel;
  uri: vscode.Uri;
  range: vscode.Range;
  className?: string;
}