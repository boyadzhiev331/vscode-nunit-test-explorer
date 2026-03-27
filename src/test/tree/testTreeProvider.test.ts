import * as assert from 'assert';
import * as vscode from 'vscode';
import { TestItem, TestTreeProvider } from '../../tree/testTreeProvider';

suite('tree/testTreeProvider', () => {
  test('assigns parent references for nested children', () => {
    const testNode = new TestItem('SampleTest', vscode.TreeItemCollapsibleState.None, undefined, undefined, undefined, 'test');
    const classNode = new TestItem('SampleClass (1)', vscode.TreeItemCollapsibleState.Collapsed, [testNode], undefined, undefined, 'class');
    const categoryNode = new TestItem('Smoke (1)', vscode.TreeItemCollapsibleState.Collapsed, [classNode], undefined, undefined, 'category');
    const projectNode = new TestItem('Project (1)', vscode.TreeItemCollapsibleState.Collapsed, [categoryNode], undefined, undefined, 'project');

    assert.strictEqual(testNode.parent, classNode);
    assert.strictEqual(classNode.parent, categoryNode);
    assert.strictEqual(categoryNode.parent, projectNode);
    assert.strictEqual(projectNode.parent, undefined);
  });

  test('getParent returns linked parent item', () => {
    const provider = new TestTreeProvider();
    const child = new TestItem('ChildTest', vscode.TreeItemCollapsibleState.None, undefined, undefined, undefined, 'test');
    const parent = new TestItem('ParentClass (1)', vscode.TreeItemCollapsibleState.Collapsed, [child], undefined, undefined, 'class');

    assert.strictEqual(provider.getParent(child), parent);
    assert.strictEqual(provider.getParent(parent), undefined);
  });
});
