import * as vscode from 'vscode';

import {
  gameplayClassificationLabel,
  gameplayGateLabel,
  gameplayModeLabel,
  gameplayPopulationStatusLabel,
} from '../core/gameplay/display.js';
import { inspectGameplayWorkspace, type GameplayViewSummary } from './gameplay-commands.js';
import type { SceneController } from './scene-controller.js';
import type { WorkspaceContextManager } from './workspaces.js';

type GameplayViewNode =
  | { kind: 'project'; root: string; ordinal: number }
  | {
    kind: 'detail';
    label: string;
    description: string;
    tooltip?: string;
    command?: { command: string; title: string; arguments: unknown[] };
  };

const SPEC_LABEL: Record<GameplayViewSummary['specStatus'], string> = {
  missing: '未创建',
  'draft-only': '只有待确认草案',
  invalid: '规格无效',
  fresh: '当前且已确认',
  stale: '知识输入已变化',
  blocked: '静态门阻断',
};

export class GameplayStatusProvider implements vscode.TreeDataProvider<GameplayViewNode>, vscode.Disposable {
  readonly #manager: WorkspaceContextManager;
  readonly #sceneController: SceneController;
  readonly #emitter = new vscode.EventEmitter<void>();
  readonly #subscriptions: vscode.Disposable[];
  readonly onDidChangeTreeData = this.#emitter.event;

  constructor(manager: WorkspaceContextManager, sceneController: SceneController) {
    this.#manager = manager;
    this.#sceneController = sceneController;
    this.#subscriptions = [
      manager.onDidChange(() => this.refresh()),
      sceneController.onDidChange(() => this.refresh()),
    ];
    for (const pattern of [
      '**/src/**/*.lua',
      '**/.yuanmeng-inspector/gameplay/**/*.json',
      '**/.yuanmeng-inspector/registry/registry.json',
      '**/.yuanmeng-inspector/ui/current.json',
      '**/.yuanmeng-inspector/scene/heads.json',
    ]) {
      const watcher = vscode.workspace.createFileSystemWatcher(pattern);
      this.#subscriptions.push(
        watcher,
        watcher.onDidCreate(() => this.refresh()),
        watcher.onDidChange(() => this.refresh()),
        watcher.onDidDelete(() => this.refresh()),
      );
    }
  }

  refresh(): void {
    this.#emitter.fire();
  }

  dispose(): void {
    for (const subscription of this.#subscriptions) subscription.dispose();
    this.#emitter.dispose();
  }

  getTreeItem(node: GameplayViewNode): vscode.TreeItem {
    if (node.kind === 'project') {
      const item = new vscode.TreeItem(`元梦工程 ${node.ordinal}`, vscode.TreeItemCollapsibleState.Expanded);
      item.tooltip = '仅显示聚合玩法测试状态；不显示工程路径、实例 ID、知识指纹或原始数据。';
      return item;
    }
    const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
    item.description = node.description;
    item.tooltip = node.tooltip;
    if (node.command !== undefined) item.command = node.command;
    return item;
  }

  async getChildren(node?: GameplayViewNode): Promise<GameplayViewNode[]> {
    if (node === undefined) return this.#manager.list().map((context, index) => ({
      kind: 'project', root: context.project.root, ordinal: index + 1,
    }));
    if (node.kind !== 'project') return [];
    try {
      return this.#details(node.root, await inspectGameplayWorkspace(this.#manager, this.#sceneController, node.root));
    } catch {
      return [{
        kind: 'detail', label: '玩法状态读取失败', description: '已阻断',
        tooltip: '请运行“刷新状态视图”；错误详情仅进入受控命令提示，不在树中显示路径或原始内容。',
      }];
    }
  }

  #details(root: string, summary: GameplayViewSummary): GameplayViewNode[] {
    const nodes: GameplayViewNode[] = [
      { kind: 'detail', label: '最近运行模式', description: gameplayModeLabel(summary.mode) },
      { kind: 'detail', label: '运行分类', description: gameplayClassificationLabel(summary.classification) },
      {
        kind: 'detail',
        label: 'latest 当前性',
        description: summary.latestState === 'current'
          ? '当前且完整'
          : summary.latestState === 'stale'
            ? '旧报告，需重新模拟'
            : '尚未运行',
        ...(summary.latestState === 'stale'
          ? { tooltip: '当前工程的 Lua、UI、场景或 API 证据已经变化；旧报告不会替代新的模拟结果。' }
          : {}),
      },
      { kind: 'detail', label: '玩法规格', description: SPEC_LABEL[summary.specStatus] },
      {
        kind: 'detail', label: '知识指纹新鲜度',
        description: summary.knowledgeFresh === null ? '未计算' : summary.knowledgeFresh ? '当前' : '已过期',
      },
      { kind: 'detail', label: '本地严格静态门', description: gameplayGateLabel(summary.strictStaticGate) },
      { kind: 'detail', label: '模型模拟准入门', description: gameplayGateLabel(summary.simulationGate) },
      { kind: 'detail', label: '运行历史', description: `${summary.history.count} 次 / ${summary.history.bytes} 字节` },
      ...summary.populations.map((entry): GameplayViewNode => ({
        kind: 'detail', label: `${entry.playerCount} 人模型模拟`, description: gameplayPopulationStatusLabel(entry.status),
      })),
      {
        kind: 'detail', label: '声明分支覆盖率',
        description: summary.coverageRatio === null ? '未运行' : `${(summary.coverageRatio * 100).toFixed(1)}%`,
      },
      { kind: 'detail', label: '时序探索截断', description: summary.truncated ? '有，不能视为通过' : '无已知截断' },
      {
        kind: 'detail', label: '首个多人失败',
        description: summary.firstMultiplayerFailure === null
          ? '无已记录失败'
          : `${summary.firstMultiplayerFailure.playerCount} 人 / ${summary.firstMultiplayerFailure.code} / step ${summary.firstMultiplayerFailure.stepIndex}`,
      },
      {
        kind: 'detail', label: '官方编辑器必测项',
        description: summary.officialEditorRequirementKinds.length === 0
          ? '真实多人仍需复测'
          : summary.officialEditorRequirementKinds.join('、'),
        tooltip: '本地静态检查和模型模拟不替代官方编辑器物理、NPC 可达、镜头或真实多人网络验证。',
      },
    ];
    nodes.push({
      kind: 'detail', label: '自动准备并模拟', description: '默认模式',
      command: { command: 'yuanmengAi.runGameplayTests', title: '自动准备并模拟', arguments: [root] },
    });
    if (summary.specStatus === 'missing' || summary.specStatus === 'draft-only' || summary.specStatus === 'invalid' || summary.specStatus === 'stale') {
      nodes.push({
        kind: 'detail', label: '生成/刷新待确认草案', description: '打开草案',
        command: { command: 'yuanmengAi.generateGameplayDraft', title: '生成待确认玩法草案', arguments: [root] },
      });
    }
    if (summary.reportAvailable) nodes.push({
      kind: 'detail', label: '打开最近玩法报告', description: 'JSON + Markdown',
      command: { command: 'yuanmengAi.openGameplayReport', title: '打开最近玩法报告', arguments: [root] },
    });
    if (summary.specStatus === 'fresh' || summary.specStatus === 'blocked') nodes.push({
      kind: 'detail', label: '运行已确认人工规格', description: '高级模式',
      command: { command: 'yuanmengAi.runConfirmedGameplayTests', title: '运行已确认人工规格', arguments: [root] },
    });
    return nodes;
  }
}

export function registerGameplayView(
  context: vscode.ExtensionContext,
  manager: WorkspaceContextManager,
  sceneController: SceneController,
): GameplayStatusProvider {
  const provider = new GameplayStatusProvider(manager, sceneController);
  context.subscriptions.push(
    provider,
    vscode.window.registerTreeDataProvider('yuanmengAi.gameplay', provider),
    vscode.commands.registerCommand('yuanmengAi.refreshGameplayView', () => provider.refresh()),
  );
  return provider;
}
