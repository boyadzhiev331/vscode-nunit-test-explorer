import * as path from 'path';
import * as vscode from 'vscode';
import { TestCommandTarget, TestExecutionResult, TestExecutionStatus } from '../core/types';
import { discoverTestsAcrossWorkspace, extractTestsWithCategoryFromClass } from '../tree/testDiscovery';
import { TestTreeProvider } from '../tree/testTreeProvider';

interface ExecutionHandlers {
  runTestTarget(target: TestCommandTarget): Promise<TestExecutionResult>;
  debugTestTarget(target: TestCommandTarget): Promise<TestExecutionResult>;
  updateInlineFailurePopup(target: TestCommandTarget, result: TestExecutionResult): void;
  buildInlineFailureMessage(result: TestExecutionResult): string;
}

export class NUnitGutterTestController implements vscode.Disposable {
  private readonly controller: vscode.TestController;
  private readonly targetByTestId = new Map<string, TestCommandTarget>();

  constructor(
    private readonly treeProvider: TestTreeProvider,
    private readonly gutterDecorator: NUnitGutterIconDecorator,
    private readonly handlers: ExecutionHandlers
  ) {
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
      if (token.isCancellationRequested) {
        break;
      }

      const target = this.targetByTestId.get(testItem.id);
      if (!target) {
        continue;
      }

      this.treeProvider.setStatusForTarget(target, 'active');
      this.gutterDecorator.updateTestResult(target, { status: 'active' });
      this.handlers.updateInlineFailurePopup(target, { status: 'active' });
      run.started(testItem);

      try {
        const result = debug
          ? await this.handlers.debugTestTarget(target)
          : await this.handlers.runTestTarget(target);

        this.treeProvider.setStatusForTarget(target, result.status);
        this.gutterDecorator.updateTestResult(target, result);
        this.handlers.updateInlineFailurePopup(target, result);

        if (result.status === 'passed') {
          run.passed(testItem, 0);
        } else if (result.status === 'skipped') {
          run.skipped(testItem);
        } else if (result.status === 'failed') {
          run.failed(testItem, new vscode.TestMessage(this.handlers.buildInlineFailureMessage(result)), 0);
        } else {
          run.skipped(testItem);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown test error';
        run.failed(testItem, new vscode.TestMessage(message), 0);
        this.treeProvider.setStatusForTarget(target, 'failed');
        this.gutterDecorator.updateTestResult(target, { status: 'failed', errorMessage: message });
        this.handlers.updateInlineFailurePopup(target, { status: 'failed', errorMessage: message });
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

export class NUnitGutterIconDecorator implements vscode.Disposable {
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

function createStackFrameLink(frame: { filePath: string; line: number; column?: number }): string | undefined {
  try {
    const args = encodeURIComponent(JSON.stringify(frame));
    return `command:nunitTestsView.openStackFrame?${args}`;
  } catch {
    return undefined;
  }
}

function parseStackFrame(line: string): { filePath: string; line: number } | undefined {
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

function escapeForMarkdown(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/([`*_{}\[\]()#+\-.!|>])/g, '\\$1')
    .replace(/\n/g, '  \n');
}
