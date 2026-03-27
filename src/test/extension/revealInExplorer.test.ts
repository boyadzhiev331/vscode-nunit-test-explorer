import * as assert from 'assert';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { findTestItemInTree, isSamePath, pickTestForCursorLine } from '../../extension';
import { TestItem } from '../../tree/testTreeProvider';

suite('extension/revealInExplorer', () => {
  test('pickTestForCursorLine picks the closest test at or before cursor', () => {
    const tests = [
      { name: 'First', lineNumber: 4 },
      { name: 'Second', lineNumber: 10 },
      { name: 'Third', lineNumber: 20 }
    ];

    assert.strictEqual(pickTestForCursorLine(tests, 0).name, 'First');
    assert.strictEqual(pickTestForCursorLine(tests, 10).name, 'Second');
    assert.strictEqual(pickTestForCursorLine(tests, 15).name, 'Second');
    assert.strictEqual(pickTestForCursorLine(tests, 99).name, 'Third');
  });

  test('findTestItemInTree finds a nested test item by file and line', async () => {
    const filePath = path.join(os.tmpdir(), 'RevealFeatureTests.cs');
    const testNode = new TestItem(
      'ShouldReveal',
      vscode.TreeItemCollapsibleState.None,
      undefined,
      vscode.Uri.file(filePath),
      new vscode.Range(7, 0, 7, 1),
      'test'
    );
    const classNode = new TestItem('RevealFeatureTests (1)', vscode.TreeItemCollapsibleState.Collapsed, [testNode], undefined, undefined, 'class');
    const categoryNode = new TestItem('Smoke (1)', vscode.TreeItemCollapsibleState.Collapsed, [classNode], undefined, undefined, 'category');
    const projectNode = new TestItem('Project (1)', vscode.TreeItemCollapsibleState.Collapsed, [categoryNode], undefined, undefined, 'project');

    const provider = {
      async getChildren(item?: TestItem): Promise<TestItem[]> {
        if (!item) {
          return [projectNode];
        }
        return item.children ?? [];
      }
    };

    const found = await findTestItemInTree(provider as any, filePath, 'ShouldReveal', 7);
    assert.strictEqual(found, testNode);
  });

  test('isSamePath returns true for identical paths', () => {
    const filePath = path.join(os.tmpdir(), 'SamePathTests.cs');
    assert.strictEqual(isSamePath(filePath, filePath), true);
  });
});
