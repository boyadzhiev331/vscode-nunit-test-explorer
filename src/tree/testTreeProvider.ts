import * as vscode from 'vscode';
import { discoverTestsAcrossWorkspace } from './testDiscovery';
import { TestCommandTarget, TestExecutionStatus, TestWithCategory } from '../core/types';

export class TestTreeProvider implements vscode.TreeDataProvider<TestItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<TestItem | undefined | void> = new vscode.EventEmitter();
  readonly onDidChangeTreeData: vscode.Event<TestItem | undefined | void> = this._onDidChangeTreeData.event;
  private readonly statusByKey = new Map<string, TestExecutionStatus>();
  private filterMode: 'none' | 'category' | 'test' = 'none';
  private filterValue = '';

  refresh(): void { this._onDidChangeTreeData.fire(); }
  getTreeItem(element: TestItem): vscode.TreeItem { return element; }

  setFilter(mode: 'none' | 'category' | 'test', value: string): void {
    this.filterMode = mode;
    this.filterValue = value;
    this.refresh();
  }

  setStatusForTarget(target: TestCommandTarget, status: TestExecutionStatus): void {
    this.statusByKey.set(this.getStatusKey(target.uri, target.range.start.line, target.label), status);
    this.refresh();
  }

  getStatusForTarget(target: TestCommandTarget): TestExecutionStatus {
    return this.statusByKey.get(this.getStatusKey(target.uri, target.range.start.line, target.label)) ?? 'not run';
  }

  private getStatus(uri: vscode.Uri, lineNumber: number, testName: string): TestExecutionStatus {
    return this.statusByKey.get(this.getStatusKey(uri, lineNumber, testName)) ?? 'not run';
  }

  private getStatusKey(uri: vscode.Uri, lineNumber: number, testNameOrLabel: string | vscode.TreeItemLabel): string {
    const testName = typeof testNameOrLabel === 'string' ? testNameOrLabel : testNameOrLabel.label;
    return `${uri.toString()}:${lineNumber}:${testName}`;
  }

  async getChildren(element?: TestItem): Promise<TestItem[]> {
    if (!element) {
      const discoveredProjects = await discoverTestsAcrossWorkspace();
      const projectNodes: TestItem[] = [];

      for (const project of discoveredProjects) {
        let categoryMap = new Map<string, Map<string, TestWithCategory[]>>();
        project.tests.forEach((test) => {
          if (!categoryMap.has(test.category)) {
            categoryMap.set(test.category, new Map());
          }
          const classMap = categoryMap.get(test.category)!;
          if (!classMap.has(test.className)) {
            classMap.set(test.className, []);
          }
          classMap.get(test.className)!.push(test);
        });

        if (this.filterMode === 'category' && this.filterValue) {
          const filtered = new Map<string, Map<string, TestWithCategory[]>>();
          for (const [cat, classMap] of categoryMap.entries()) {
            if (cat.toLowerCase().includes(this.filterValue.toLowerCase())) {
              filtered.set(cat, classMap);
            }
          }
          categoryMap = filtered;
        }

        if (this.filterMode === 'test' && this.filterValue) {
          const filtered = new Map<string, Map<string, TestWithCategory[]>>();
          for (const [cat, classMap] of categoryMap.entries()) {
            const filteredClassMap = new Map<string, TestWithCategory[]>();
            for (const [className, tests] of classMap.entries()) {
              const filteredTests = tests.filter((test) =>
                test.name.toLowerCase().includes(this.filterValue.toLowerCase()) ||
                className.toLowerCase().includes(this.filterValue.toLowerCase())
              );
              if (filteredTests.length > 0) {
                filteredClassMap.set(className, filteredTests);
              }
            }
            if (filteredClassMap.size > 0) {
              filtered.set(cat, filteredClassMap);
            }
          }
          categoryMap = filtered;
        }

        const categoryNodes: TestItem[] = [];
        for (const [category, classMap] of categoryMap.entries()) {
          const classNodes: TestItem[] = [];
          for (const [className, tests] of classMap.entries()) {
            const testNodes = tests.map((test) => new TestItem(
              test.name,
              vscode.TreeItemCollapsibleState.None,
              undefined,
              test.uri,
              new vscode.Range(test.lineNumber, 0, test.lineNumber, 0),
              'test',
              this.getStatus(test.uri!, test.lineNumber, test.name),
              className
            ));

            const classLabelWithCount = `${className} (${tests.length})`;
            classNodes.push(new TestItem(
              classLabelWithCount,
              vscode.TreeItemCollapsibleState.Collapsed,
              testNodes,
              undefined,
              undefined,
              'class',
              this.getClassStatus(tests),
              className
            ));
          }

          const totalTestsInCategory = Array.from(classMap.values()).reduce((sum, tests) => sum + tests.length, 0);
          const categoryLabelWithCount = `${category} (${totalTestsInCategory})`;
          categoryNodes.push(new TestItem(
            categoryLabelWithCount,
            vscode.TreeItemCollapsibleState.Collapsed,
            classNodes,
            undefined,
            undefined,
            'category',
            this.getCategoryStatus(classMap)
          ));
        }

        if (!categoryNodes.length) {
          continue;
        }

        const projectStatus = this.getProjectStatus(project.tests);
        const projectLabelWithCount = `${project.displayName} (${project.tests.length})`;
        projectNodes.push(new TestItem(
          projectLabelWithCount,
          vscode.TreeItemCollapsibleState.Collapsed,
          categoryNodes,
          undefined,
          undefined,
          'project',
          projectStatus
        ));
      }

      return projectNodes;
    }

    return element.children || [];
  }

  private getProjectStatus(tests: TestWithCategory[]): TestExecutionStatus {
    return this.getClassStatus(tests);
  }

  private getClassStatus(tests: TestWithCategory[]): TestExecutionStatus {
    const statuses = tests.map((test) => this.getStatus(test.uri!, test.lineNumber, test.name));
    if (statuses.some((status) => status === 'failed')) {
      return 'failed';
    }
    if (statuses.some((status) => status === 'active')) {
      return 'active';
    }
    if (statuses.some((status) => status === 'in progress')) {
      return 'in progress';
    }
    if (statuses.length > 0 && statuses.every((status) => status === 'passed')) {
      return 'passed';
    }
    if (statuses.length > 0 && statuses.every((status) => status === 'skipped')) {
      return 'skipped';
    }
    if (statuses.some((status) => status === 'not run')) {
      return 'not run';
    }
    if (statuses.some((status) => status === 'passed')) {
      return 'passed';
    }
    return 'not run';
  }

  private getCategoryStatus(classMap: Map<string, TestWithCategory[]>): TestExecutionStatus {
    const classStatuses = Array.from(classMap.values()).map((tests) => this.getClassStatus(tests));

    if (classStatuses.some((status) => status === 'failed')) {
      return 'failed';
    }
    if (classStatuses.some((status) => status === 'active')) {
      return 'active';
    }
    if (classStatuses.some((status) => status === 'in progress')) {
      return 'in progress';
    }
    if (classStatuses.length > 0 && classStatuses.every((status) => status === 'passed')) {
      return 'passed';
    }
    if (classStatuses.length > 0 && classStatuses.every((status) => status === 'skipped')) {
      return 'skipped';
    }
    if (classStatuses.some((status) => status === 'not run')) {
      return 'not run';
    }
    if (classStatuses.some((status) => status === 'passed')) {
      return 'passed';
    }

    return 'not run';
  }
}

export class TestItem extends vscode.TreeItem {
  children?: TestItem[];
  uri?: vscode.Uri;
  range?: vscode.Range;
  className?: string;

  constructor(
    label: string,
    collapsibleState: vscode.TreeItemCollapsibleState = vscode.TreeItemCollapsibleState.None,
    children?: TestItem[],
    uri?: vscode.Uri,
    range?: vscode.Range,
    type: 'project' | 'category' | 'class' | 'test' = 'test',
    status: TestExecutionStatus = 'not run',
    className?: string
  ) {
    super(label, collapsibleState);
    this.children = children;
    this.uri = uri;
    this.range = range;
    this.className = className;
    this.contextValue = type;

    if (type === 'test' && uri && range) {
      this.command = { command: 'vscode.open', title: 'Go to Test', arguments: [uri, { selection: range }] };
      this.description = status;
      this.iconPath = getStatusIcon(status);
    }

    if (type === 'project' || type === 'class' || type === 'category') {
      this.description = status;
      this.iconPath = getStatusIcon(status);
    }
  }
}

function getStatusIcon(status: TestExecutionStatus): vscode.ThemeIcon {
  switch (status) {
    case 'passed':
      return new vscode.ThemeIcon('pass', new vscode.ThemeColor('charts.green'));
    case 'failed':
      return new vscode.ThemeIcon('error', new vscode.ThemeColor('charts.red'));
    case 'skipped':
      return new vscode.ThemeIcon('debug-pause', new vscode.ThemeColor('charts.yellow'));
    case 'active':
      return new vscode.ThemeIcon('sync~spin', new vscode.ThemeColor('charts.yellow'));
    case 'in progress':
      return new vscode.ThemeIcon('sync', new vscode.ThemeColor('charts.gray'));
    default:
      return new vscode.ThemeIcon('circle-outline', new vscode.ThemeColor('charts.blue'));
  }
}
