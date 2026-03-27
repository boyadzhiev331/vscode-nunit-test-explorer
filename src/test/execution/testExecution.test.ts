import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { TestCommandTarget } from '../../core/types';
import { collectTestTargetsFromTreeItem, findCsproj, groupTargetsByClass } from '../../execution/testExecution';
import { TestItem } from '../../tree/testTreeProvider';

function makeTarget(filePath: string, label: string, className?: string): TestCommandTarget {
  return {
    label,
    uri: vscode.Uri.file(filePath),
    range: new vscode.Range(0, 0, 0, 1),
    className
  };
}

suite('execution/testExecution', () => {
  test('findCsproj walks up to nearest project file', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nunit-ext-findcsproj-'));
    const projectDir = path.join(root, 'MyTests');
    const nestedDir = path.join(projectDir, 'Nested', 'Deeper');
    fs.mkdirSync(nestedDir, { recursive: true });

    const csprojPath = path.join(projectDir, 'MyTests.csproj');
    fs.writeFileSync(csprojPath, '<Project Sdk="Microsoft.NET.Sdk"></Project>', 'utf8');

    const testFilePath = path.join(nestedDir, 'SampleTests.cs');
    fs.writeFileSync(testFilePath, 'public class SampleTests {}', 'utf8');

    const found = findCsproj(testFilePath);
    assert.strictEqual(found, csprojPath);
  });

  test('groupTargetsByClass groups by class in same project', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nunit-ext-group-'));
    const projectDir = path.join(root, 'ProjectA');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'ProjectA.csproj'), '<Project Sdk="Microsoft.NET.Sdk"></Project>', 'utf8');

    const fileA = path.join(projectDir, 'LoginTests.cs');
    const fileB = path.join(projectDir, 'CartTests.cs');
    fs.writeFileSync(fileA, 'class LoginTests {}', 'utf8');
    fs.writeFileSync(fileB, 'class CartTests {}', 'utf8');

    const targets: TestCommandTarget[] = [
      makeTarget(fileA, 'ValidLogin_Works', 'LoginTests'),
      makeTarget(fileA, 'InvalidLogin_Fails', 'LoginTests'),
      makeTarget(fileB, 'AddItem_Works', 'CartTests')
    ];

    const groups = groupTargetsByClass(targets);
    assert.strictEqual(groups.length, 2);

    const loginGroup = groups.find((group) => group.className === 'LoginTests');
    assert.ok(loginGroup);
    assert.strictEqual(loginGroup?.targets.length, 2);
  });

  test('groupTargetsByClass derives class name from fully qualified label when className is missing', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nunit-ext-group-derived-'));
    const projectDir = path.join(root, 'ProjectB');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'ProjectB.csproj'), '<Project Sdk="Microsoft.NET.Sdk"></Project>', 'utf8');

    const filePath = path.join(projectDir, 'UserTests.cs');
    fs.writeFileSync(filePath, 'class UserTests {}', 'utf8');

    const targets: TestCommandTarget[] = [
      makeTarget(filePath, 'My.Namespace.UserTests.ShouldCreateUser'),
      makeTarget(filePath, 'My.Namespace.UserTests.ShouldDeleteUser')
    ];

    const groups = groupTargetsByClass(targets);
    assert.strictEqual(groups.length, 1);
    assert.strictEqual(groups[0].className, 'My.Namespace.UserTests');
    assert.strictEqual(groups[0].targets.length, 2);
  });

  test('collectTestTargetsFromTreeItem returns recursive test nodes only', () => {
    const testUri = vscode.Uri.file(path.join(os.tmpdir(), 'TreeTests.cs'));
    const first = new TestItem(
      'FirstTest',
      vscode.TreeItemCollapsibleState.None,
      undefined,
      testUri,
      new vscode.Range(1, 0, 1, 1),
      'test'
    );
    const second = new TestItem(
      'SecondTest',
      vscode.TreeItemCollapsibleState.None,
      undefined,
      testUri,
      new vscode.Range(2, 0, 2, 1),
      'test'
    );

    const classNode = new TestItem('MyClass (2)', vscode.TreeItemCollapsibleState.Collapsed, [first, second], undefined, undefined, 'class');
    const categoryNode = new TestItem('Smoke (2)', vscode.TreeItemCollapsibleState.Collapsed, [classNode], undefined, undefined, 'category');

    const targets = collectTestTargetsFromTreeItem(categoryNode);
    assert.strictEqual(targets.length, 2);
    assert.deepStrictEqual(targets.map((target) => target.label), ['FirstTest', 'SecondTest']);
  });
});
