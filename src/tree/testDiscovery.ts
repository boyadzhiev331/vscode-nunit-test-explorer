import * as vscode from 'vscode';
import * as path from 'path';
import { ProjectTestsGroup, TestWithCategory } from '../core/types';

const TEST_ATTRIBUTES = ['Test', 'TestWithRetry', 'TestCase'];

export function extractTestsWithCategoryFromClass(content: string, className: string): TestWithCategory[] {
  const lines = content.split(/\r?\n/);
  const results: TestWithCategory[] = [];
  let currentCategory = 'Uncategorized';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const fixtureMatch = line.match(/^\[TestFixture(?:\s*,\s*Category\("(.+?)"\))?/);
    if (fixtureMatch && fixtureMatch[1]) {
      currentCategory = fixtureMatch[1];
    }

    const attrMatch = line.match(/^\[(\w+)/);
    if (attrMatch && TEST_ATTRIBUTES.includes(attrMatch[1])) {
      for (let k = i + 1; k < lines.length; k++) {
        const methodMatch = lines[k].trim().match(/^public\s+(?:async\s+)?(?:Task|void)\s+(\w+)/);
        if (methodMatch) {
          results.push({ name: methodMatch[1], className, category: currentCategory, lineNumber: k });
          break;
        }
      }
    }
  }

  return results;
}

export async function discoverTestsAcrossWorkspace(): Promise<ProjectTestsGroup[]> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    return [];
  }

  const csprojUris = await vscode.workspace.findFiles('**/*.csproj', '**/{bin,obj}/**');
  if (!csprojUris.length) {
    return [];
  }

  const baseNameCounts = new Map<string, number>();
  for (const csprojUri of csprojUris) {
    const baseName = path.basename(csprojUri.fsPath, '.csproj');
    baseNameCounts.set(baseName, (baseNameCounts.get(baseName) ?? 0) + 1);
  }

  const projectGroups: ProjectTestsGroup[] = [];

  for (const csprojUri of csprojUris) {
    const projectDir = path.dirname(csprojUri.fsPath);
    const csprojBaseName = path.basename(csprojUri.fsPath, '.csproj');
    const isDuplicateName = (baseNameCounts.get(csprojBaseName) ?? 0) > 1;
    const relativeDir = path.relative(workspaceFolder.uri.fsPath, projectDir);
    const displayName = isDuplicateName
      ? `${csprojBaseName} (${relativeDir || '.'})`
      : csprojBaseName;

    const csFiles = await vscode.workspace.findFiles(
      new vscode.RelativePattern(projectDir, '**/*.cs'),
      '**/{bin,obj}/**'
    );

    const tests: TestWithCategory[] = [];
    for (const file of csFiles) {
      const content = Buffer.from(await vscode.workspace.fs.readFile(file)).toString('utf-8');
      const className = path.basename(file.fsPath);
      const classTests = extractTestsWithCategoryFromClass(content, className).map((test) => ({
        ...test,
        uri: file
      }));
      tests.push(...classTests);
    }

    if (tests.length === 0) {
      continue;
    }

    projectGroups.push({
      csprojPath: csprojUri.fsPath,
      displayName,
      tests
    });
  }

  return projectGroups.sort((a, b) => a.displayName.localeCompare(b.displayName));
}
