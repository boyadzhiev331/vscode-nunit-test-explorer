import * as assert from 'assert';
import * as vscode from 'vscode';

suite('extension/activation', () => {
  test('activates extension and registers commands', async () => {
    const extension = vscode.extensions.getExtension('obey31.visual-studio-like-nunit-test-explorer');
    assert.ok(extension, 'Extension should be discoverable by VS Code test host');

    await extension?.activate();
    assert.ok(extension?.isActive, 'Extension should be active after activation');

    const commands = await vscode.commands.getCommands(true);
    const expected = [
      'extension.runTest',
      'extension.debugTest',
      'extension.runClass',
      'extension.debugClass',
      'extension.runCategory',
      'extension.debugCategory',
      'extension.showNodeDetails',
      'extension.clearNodeResults',
      'nunitTestsView.filter'
    ];

    for (const command of expected) {
      assert.ok(commands.includes(command), `Expected command ${command} to be registered`);
    }
  });
});
