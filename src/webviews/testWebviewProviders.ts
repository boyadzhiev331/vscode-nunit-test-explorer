import * as vscode from 'vscode';
import * as path from 'path';
import {
  StackFrameTarget,
  TestCaseTarget,
  TestCommandTarget,
  TestExecutionResult,
  TestSummaryCounts
} from '../core/types';
import { TestTreeProvider } from '../tree/testTreeProvider';

export class TestFilterWebviewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'nunitTestsView.filterInput';

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly treeProvider: TestTreeProvider
  ) {}

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri]
    };

    webviewView.webview.html = this.getHtmlForWebview();

    webviewView.webview.onDidReceiveMessage((data) => {
      if (data.command === 'updateFilter') {
        const { mode, value } = data;
        this.treeProvider.setFilter(mode, value);
      }
    });
  }

  private getHtmlForWebview(): string {
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

        let currentMode = 'category';

        function updateFilter(mode, value) {
            currentMode = mode;
            filterMode.value = mode;
            searchInput.value = value;
            vscode.postMessage({ command: 'updateFilter', mode: mode, value: value });
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
    </script>
</body>
</html>`;
  }
}

interface DetailsProviderHandlers {
  openTestCase(target: TestCaseTarget): void | Promise<void>;
  openFrame(target: StackFrameTarget): void | Promise<void>;
  openAttachment(path: string): void | Promise<void> | Thenable<unknown>;
}

export class TestDetailsWebviewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'nunitTestsView.details';
  private view: vscode.WebviewView | undefined;
  private selectedTestName: string | undefined;
  private selectedResult: TestExecutionResult | undefined;
  private selectedTestTarget: TestCaseTarget | undefined;
  private summaryTitle: string | undefined;
  private summaryCounts: TestSummaryCounts | undefined;

  constructor(private readonly handlers: DetailsProviderHandlers) {}

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
        void this.handlers.openTestCase(data.target as TestCaseTarget);
        return;
      }
      if (data.command === 'openFrame' && data.target) {
        void this.handlers.openFrame(data.target as StackFrameTarget);
        return;
      }
      if (data.command === 'openAttachment' && typeof data.path === 'string') {
        void this.handlers.openAttachment(data.path);
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

function escapeForHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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
