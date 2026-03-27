import * as vscode from 'vscode';

export type TestExecutionStatus = 'passed' | 'failed' | 'skipped' | 'not run' | 'in progress' | 'active';

export interface TestExecutionResult {
  status: TestExecutionStatus;
  errorMessage?: string;
  stackTrace?: string;
  screenshotPath?: string;
  durationMs?: number;
}

export type LiveTestResultCallback = (testName: string, result: TestExecutionResult) => void;

export interface LiveOutputState {
  remainder: string;
}

export interface StackFrameTarget {
  filePath: string;
  line: number;
  column?: number;
}

export interface TestCaseTarget {
  filePath: string;
  line: number;
  column?: number;
}

export interface TestSummaryCounts {
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

export interface TestWithCategory {
  name: string;
  className: string;
  category: string;
  lineNumber: number;
  uri?: vscode.Uri;
}

export interface ProjectTestsGroup {
  csprojPath: string;
  displayName: string;
  tests: TestWithCategory[];
}

export interface TestCommandTarget {
  label: string | vscode.TreeItemLabel;
  uri: vscode.Uri;
  range: vscode.Range;
  className?: string;
}
