import * as assert from 'assert';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { TestFilterWebviewProvider, TestDetailsWebviewProvider } from '../../webviews/testWebviewProviders';
import { TestExecutionResult, TestSummaryCounts } from '../../core/types';
import { TestTreeProvider } from '../../tree/testTreeProvider';

type MessageCallback = (data: any) => void;

function createWebviewViewMock(): {
  view: vscode.WebviewView;
  getHtml: () => string;
  emitMessage: (data: any) => void;
} {
  let html = '';
  let messageCallback: MessageCallback | undefined;

  const webview: Partial<vscode.Webview> = {
    options: {},
    get html() {
      return html;
    },
    set html(value: string) {
      html = value;
    },
    onDidReceiveMessage(cb: MessageCallback) {
      messageCallback = cb;
      return { dispose() {} } as vscode.Disposable;
    }
  };

  const view = {
    webview
  } as unknown as vscode.WebviewView;

  return {
    view,
    getHtml: () => html,
    emitMessage: (data: any) => messageCallback?.(data)
  };
}

suite('webviews/testWebviewProviders', () => {
  test('filter provider renders expected controls and routes update message', () => {
    const updates: Array<{ mode: 'none' | 'category' | 'test'; value: string }> = [];
    const provider = new TestFilterWebviewProvider(
      vscode.Uri.file(process.cwd()),
      {
        setFilter(mode: 'none' | 'category' | 'test', value: string) {
          updates.push({ mode, value });
        }
      } as unknown as TestTreeProvider
    );

    const mock = createWebviewViewMock();
    provider.resolveWebviewView(mock.view, {} as vscode.WebviewViewResolveContext, {} as vscode.CancellationToken);

    const html = mock.getHtml();
    assert.ok(html.includes('id="filterMode"'));
    assert.ok(html.includes('id="searchInput"'));
    assert.ok(html.includes('id="clearBtn"'));

    mock.emitMessage({ command: 'updateFilter', mode: 'test', value: 'Login' });
    assert.strictEqual(updates.length, 1);
    assert.deepStrictEqual(updates[0], { mode: 'test', value: 'Login' });
  });

  test('details provider renders empty state by default', () => {
    const provider = new TestDetailsWebviewProvider({
      openTestCase() {},
      openFrame() {},
      openAttachment() {}
    });

    const mock = createWebviewViewMock();
    provider.resolveWebviewView(mock.view, {} as vscode.WebviewViewResolveContext, {} as vscode.CancellationToken);

    const html = mock.getHtml();
    assert.ok(html.includes('Select a test case to see details.'));
  });

  test('details provider renders summary state with duration', () => {
    const provider = new TestDetailsWebviewProvider({
      openTestCase() {},
      openFrame() {},
      openAttachment() {}
    });

    const mock = createWebviewViewMock();
    provider.resolveWebviewView(mock.view, {} as vscode.WebviewViewResolveContext, {} as vscode.CancellationToken);

    const summary: TestSummaryCounts = {
      total: 3,
      passed: 2,
      failed: 1,
      skipped: 0,
      notRun: 0,
      inProgress: 0,
      active: 0,
      totalDurationMs: 1420,
      durationSamples: 3
    };

    provider.setSummary('MyClass', summary);
    const html = mock.getHtml();

    assert.ok(html.includes('Scope:</span>MyClass'));
    assert.ok(html.includes('Total</span><span class="value">3'));
    assert.ok(html.includes('1.42 s'));
  });

  test('details provider renders failed test with screenshot and stack open link', () => {
    const provider = new TestDetailsWebviewProvider({
      openTestCase() {},
      openFrame() {},
      openAttachment() {}
    });

    const mock = createWebviewViewMock();
    provider.resolveWebviewView(mock.view, {} as vscode.WebviewViewResolveContext, {} as vscode.CancellationToken);

    const result: TestExecutionResult = {
      status: 'failed',
      errorMessage: 'Assertion failed',
      stackTrace: 'at My.Namespace.Test() in C:\\repo\\Tests\\SampleTests.cs:line 42',
      screenshotPath: path.join(os.tmpdir(), 'failure screenshot.png'),
      durationMs: 50
    };

    provider.setSelectedTest('SampleTest', result, {
      label: 'SampleTest',
      uri: vscode.Uri.file(path.join(os.tmpdir(), 'SampleTests.cs')),
      range: new vscode.Range(10, 0, 10, 1)
    });

    const html = mock.getHtml();
    assert.ok(html.includes('Assertion failed'));
    assert.ok(html.includes('data-open-attachment="1"'));
    assert.ok(html.includes('failure screenshot.png'));
    assert.ok(html.includes('data-open-frame="0"'));
  });

  test('details provider routes incoming webview messages to handlers', () => {
    const calls: string[] = [];

    const provider = new TestDetailsWebviewProvider({
      openTestCase() {
        calls.push('openTestCase');
      },
      openFrame() {
        calls.push('openFrame');
      },
      openAttachment() {
        calls.push('openAttachment');
      }
    });

    const mock = createWebviewViewMock();
    provider.resolveWebviewView(mock.view, {} as vscode.WebviewViewResolveContext, {} as vscode.CancellationToken);

    mock.emitMessage({ command: 'openTestCase', target: { filePath: 'a.cs', line: 1 } });
    mock.emitMessage({ command: 'openFrame', target: { filePath: 'a.cs', line: 1 } });
    mock.emitMessage({ command: 'openAttachment', path: 'a.png' });

    assert.deepStrictEqual(calls, ['openTestCase', 'openFrame', 'openAttachment']);
  });
});
