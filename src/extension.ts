import * as vscode from 'vscode';
import * as path from 'path';
import {
  StackFrameTarget,
  TestCaseTarget,
  TestCommandTarget,
  TestSummaryCounts
} from './core/types';
import { extractTestsWithCategoryFromClass } from './tree/testDiscovery';
import { TestItem, TestTreeProvider } from './tree/testTreeProvider';
import { TestDetailsWebviewProvider, TestFilterWebviewProvider } from './webviews/testWebviewProviders';
import { NUnitGutterIconDecorator, NUnitGutterTestController } from './testing/nunitRuntime';
import {
  buildInlineFailureMessage,
  collectTestTargetsFromTreeItem,
  debugTestTarget,
  executeCategoryTarget,
  executeClassTarget,
  executeTestTargetsInSingleSession,
  groupTargetsByClass,
  runTestTarget,
  setFailureDiagnostics,
  updateInlineFailurePopup
} from './execution/testExecution';

let failureDiagnostics: vscode.DiagnosticCollection | undefined;

export function activate(context: vscode.ExtensionContext) {
  failureDiagnostics = vscode.languages.createDiagnosticCollection('nunit-inline-failures');
  setFailureDiagnostics(failureDiagnostics);
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

  const detailsWebviewProvider = new TestDetailsWebviewProvider({
    openTestCase,
    openFrame: openStackFrame,
    openAttachment: openAttachmentFile
  });
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

  const revealInExplorerCommand = vscode.commands.registerCommand('extension.revealInNUnitTestExplorer', async (uri?: vscode.Uri) => {
    await revealInNUnitTestExplorer(treeView, provider, uri);
  });
  context.subscriptions.push(revealInExplorerCommand);

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

  const testController = new NUnitGutterTestController(provider, gutterDecorator, {
    runTestTarget,
    debugTestTarget,
    updateInlineFailurePopup,
    buildInlineFailureMessage
  });
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

async function openAttachmentFile(attachmentPath: string): Promise<void> {
  if (!attachmentPath) {
    return;
  }

  const uri = vscode.Uri.file(attachmentPath);
  await vscode.commands.executeCommand('vscode.open', uri);
}

function buildSummaryCountsForItem(item: TestItem, gutterDecorator: NUnitGutterIconDecorator): TestSummaryCounts {
  const targets = collectTestTargetsFromTreeItem(item);
  const counts: TestSummaryCounts = {
    total: targets.length,
    passed: 0,
    failed: 0,
    skipped: 0,
    notRun: 0,
    inProgress: 0,
    active: 0,
    totalDurationMs: 0,
    durationSamples: 0
  };

  for (const target of targets) {
    const result = gutterDecorator.getTestResultForTarget(target);
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

    if (Number.isFinite(result.durationMs)) {
      counts.totalDurationMs += result.durationMs as number;
      counts.durationSamples += 1;
    }
  }

  return counts;
}

async function revealInNUnitTestExplorer(
  treeView: vscode.TreeView<TestItem>,
  provider: TestTreeProvider,
  uriFromContext?: vscode.Uri
): Promise<void> {
  const activeEditor = vscode.window.activeTextEditor;
  const uri = uriFromContext ?? activeEditor?.document.uri;
  if (!uri) {
    return;
  }

  const document = activeEditor && activeEditor.document.uri.toString() === uri.toString()
    ? activeEditor.document
    : await vscode.workspace.openTextDocument(uri);

  const cursorLine = activeEditor && activeEditor.document.uri.toString() === uri.toString()
    ? activeEditor.selection.active.line
    : 0;

  const tests = extractTestsWithCategoryFromClass(document.getText(), path.basename(document.fileName));
  if (!tests.length) {
    vscode.window.showInformationMessage('No NUnit tests found in this file.');
    return;
  }

  const testAtCursor = pickTestForCursorLine(tests, cursorLine);
  const treeItem = await findTestItemInTree(provider, uri.fsPath, testAtCursor.name, testAtCursor.lineNumber);
  if (!treeItem) {
    vscode.window.showWarningMessage(`Could not reveal test "${testAtCursor.name}" in NUnit Test Explorer.`);
    return;
  }

  await treeView.reveal(treeItem, {
    select: true,
    focus: true,
    expand: 3
  });
}

export function pickTestForCursorLine(
  tests: Array<{ name: string; lineNumber: number }>,
  cursorLine: number
): { name: string; lineNumber: number } {
  const ordered = [...tests].sort((a, b) => a.lineNumber - b.lineNumber);
  if (!ordered.length) {
    return { name: '', lineNumber: 0 };
  }

  if (cursorLine <= ordered[0].lineNumber) {
    return ordered[0];
  }

  for (let i = 0; i < ordered.length; i++) {
    const current = ordered[i];
    const next = ordered[i + 1];
    if (!next || (cursorLine >= current.lineNumber && cursorLine < next.lineNumber)) {
      return current;
    }
  }

  return ordered[ordered.length - 1];
}

export async function findTestItemInTree(
  provider: TestTreeProvider,
  filePath: string,
  testName: string,
  lineNumber: number
): Promise<TestItem | undefined> {
  const roots = await provider.getChildren();
  for (const root of roots) {
    const found = await findTestItemRecursive(provider, root, filePath, testName, lineNumber);
    if (found) {
      return found;
    }
  }

  return undefined;
}

async function findTestItemRecursive(
  provider: TestTreeProvider,
  item: TestItem,
  filePath: string,
  testName: string,
  lineNumber: number
): Promise<TestItem | undefined> {
  if (item.contextValue === 'test' && item.uri && item.range) {
    const labelValue = item.label;
    const label = typeof labelValue === 'string' ? labelValue : labelValue?.label ?? '';
    const isSameFile = isSamePath(item.uri.fsPath, filePath);
    const sameLine = item.range.start.line === lineNumber;
    const sameName = label === testName;

    if (isSameFile && (sameLine || sameName)) {
      return item;
    }
  }

  const children = await provider.getChildren(item);
  for (const child of children) {
    const found = await findTestItemRecursive(provider, child, filePath, testName, lineNumber);
    if (found) {
      return found;
    }
  }

  return undefined;
}

export function isSamePath(left: string, right: string): boolean {
  if (process.platform === 'win32') {
    return left.toLowerCase() === right.toLowerCase();
  }

  return left === right;
}
