import { basename } from 'node:path';

import * as vscode from 'vscode';

import type { RegistryRecord, UiNode } from '../core/model.js';
import type { WorkspaceContextManager } from './workspaces.js';

class EnvironmentProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  readonly #manager: WorkspaceContextManager;
  readonly onDidChangeTreeData: vscode.Event<void>;

  constructor(manager: WorkspaceContextManager) {
    this.#manager = manager;
    this.onDidChangeTreeData = manager.onDidChange;
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(): vscode.TreeItem[] {
    return this.#manager.list().map((context) => {
      const item = new vscode.TreeItem(basename(context.project.root));
      item.description = context.status.link.state;
      item.tooltip = context.project.root;
      return item;
    });
  }
}

class UiProvider implements vscode.TreeDataProvider<UiNode> {
  readonly #manager: WorkspaceContextManager;
  readonly onDidChangeTreeData: vscode.Event<void>;

  constructor(manager: WorkspaceContextManager) {
    this.#manager = manager;
    this.onDidChangeTreeData = manager.onDidChange;
  }

  getTreeItem(node: UiNode): vscode.TreeItem {
    const item = new vscode.TreeItem(node.name);
    item.description = `${node.type} · ${node.id}`;
    item.tooltip = `${node.path}\nID: ${node.id}\n来源: ${node.sourceFile}`;
    item.contextValue = 'yuanmengUiNode';
    return item;
  }

  getChildren(): UiNode[] {
    return this.#manager.list().flatMap((context) => context.snapshot?.nodes ?? []);
  }
}

class RegistryProvider implements vscode.TreeDataProvider<RegistryRecord> {
  readonly #manager: WorkspaceContextManager;
  readonly onDidChangeTreeData: vscode.Event<void>;

  constructor(manager: WorkspaceContextManager) {
    this.#manager = manager;
    this.onDidChangeTreeData = manager.onDidChange;
  }

  getTreeItem(record: RegistryRecord): vscode.TreeItem {
    const item = new vscode.TreeItem(`${record.name} · ${record.value}`);
    item.description = `${record.kind} · ${record.environment}/${record.validity}`;
    item.tooltip = [
      `作用域：${record.scope}`,
      `来源：${record.source.kind} · ${record.source.evidence}`,
      `最后确认：${record.lastConfirmedAt ?? '未确认'}`,
      record.notes,
      record.mapFingerprint === null && (record.kind === 'scene-layer' || record.kind === 'scene-instance')
        ? '地图身份未由官方确认；属性操作仅允许同工程单个非正式用户登记目标。'
        : '',
    ].filter((line) => line !== '').join('\n');
    item.contextValue = 'yuanmengRegistryRecord';
    return item;
  }

  async getChildren(): Promise<RegistryRecord[]> {
    const records = await Promise.all(this.#manager.list().map((context) => (
      this.#manager.listRegistry(context.project.root)
    )));
    return records.flat();
  }
}

export class SearchResultsProvider implements vscode.TreeDataProvider<UiNode> {
  readonly #emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.#emitter.event;
  #results: UiNode[] = [];

  dispose(): void {
    this.#emitter.dispose();
  }

  setResults(results: readonly UiNode[]): void {
    this.#results = [...results];
    this.#emitter.fire();
  }

  getTreeItem(node: UiNode): vscode.TreeItem {
    const item = new vscode.TreeItem(`${node.name} · ${node.id}`);
    item.description = node.path;
    item.tooltip = `${node.type}\n${node.path}`;
    item.contextValue = 'yuanmengUiNode';
    return item;
  }

  getChildren(): UiNode[] {
    return this.#results;
  }
}

class ProblemsProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  readonly #manager: WorkspaceContextManager;
  readonly onDidChangeTreeData: vscode.Event<void>;

  constructor(manager: WorkspaceContextManager) {
    this.#manager = manager;
    this.onDidChangeTreeData = manager.onDidChange;
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(): vscode.TreeItem[] {
    const counts = this.#manager.list().reduce((total, context) => ({
      error: total.error + context.status.issueCounts.error,
      warning: total.warning + context.status.issueCounts.warning,
      info: total.info + context.status.issueCounts.info,
    }), { error: 0, warning: 0, info: 0 });
    return [
      new vscode.TreeItem(`错误 ${counts.error}`),
      new vscode.TreeItem(`警告 ${counts.warning}`),
      new vscode.TreeItem(`提示 ${counts.info}`),
    ];
  }
}

export function registerViews(
  context: vscode.ExtensionContext,
  manager: WorkspaceContextManager,
  searchResults: SearchResultsProvider,
): void {
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('yuanmengAi.environment', new EnvironmentProvider(manager)),
    vscode.window.registerTreeDataProvider('yuanmengAi.ui', new UiProvider(manager)),
    vscode.window.registerTreeDataProvider('yuanmengAi.registry', new RegistryProvider(manager)),
    vscode.window.registerTreeDataProvider('yuanmengAi.search', searchResults),
    vscode.window.registerTreeDataProvider('yuanmengAi.problems', new ProblemsProvider(manager)),
    searchResults,
  );
}
