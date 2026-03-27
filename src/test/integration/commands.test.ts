import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { TestItem } from '../../tree/testTreeProvider';

suite('integration/commands', () => {
  test('runTest and debugTest handle missing csproj gracefully', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nunit-ext-cmd-'));
    const testFile = path.join(root, 'MissingProjectTests.cs');
    fs.writeFileSync(testFile, 'public class MissingProjectTests {}', 'utf8');

    const testItem = new TestItem(
      'ShouldFailWithoutProject',
      vscode.TreeItemCollapsibleState.None,
      undefined,
      vscode.Uri.file(testFile),
      new vscode.Range(0, 0, 0, 1),
      'test'
    );

    await vscode.commands.executeCommand('extension.runTest', testItem);
    await vscode.commands.executeCommand('extension.debugTest', testItem);

    assert.ok(true, 'Commands should not throw when csproj is missing');
  });

  test('runClass/runCategory/debugClass/debugCategory handle empty nodes', async () => {
    const emptyClass = new TestItem('EmptyClass (0)', vscode.TreeItemCollapsibleState.Collapsed, [], undefined, undefined, 'class');
    const emptyCategory = new TestItem('EmptyCategory (0)', vscode.TreeItemCollapsibleState.Collapsed, [], undefined, undefined, 'category');

    await vscode.commands.executeCommand('extension.runClass', emptyClass);
    await vscode.commands.executeCommand('extension.debugClass', emptyClass);
    await vscode.commands.executeCommand('extension.runCategory', emptyCategory);
    await vscode.commands.executeCommand('extension.debugCategory', emptyCategory);

    assert.ok(true, 'Class and category commands should not throw for empty nodes');
  });

  test('showNodeDetails and clearNodeResults execute on class node', async () => {
    const testUri = vscode.Uri.file(path.join(os.tmpdir(), 'DetailsNodeTests.cs'));
    const testChild = new TestItem(
      'NodeChildTest',
      vscode.TreeItemCollapsibleState.None,
      undefined,
      testUri,
      new vscode.Range(1, 0, 1, 1),
      'test'
    );
    const classNode = new TestItem('NodeClass (1)', vscode.TreeItemCollapsibleState.Collapsed, [testChild], undefined, undefined, 'class');

    await vscode.commands.executeCommand('extension.showNodeDetails', classNode);
    await vscode.commands.executeCommand('extension.clearNodeResults', classNode);

    assert.ok(true, 'Details and clear commands should execute without throwing');
  });
});
