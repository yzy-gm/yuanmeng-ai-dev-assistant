import { basename } from 'node:path';

import * as vscode from 'vscode';

import { ProductError } from '../core/errors.js';
import { nodeFileIO } from '../core/fs.js';
import {
  createSceneChangeJournalEntry,
  listSceneChangeJournalWithEvidence,
  saveSceneChangeJournalEntry,
  type SceneChangeJournalEntry,
  type SceneChangeJournalEvidenceResult,
  type SceneChangeJournalListOptions,
} from '../core/scene/change-journal.js';
import {
  createScenePlacementPlan,
  type ScenePlacementPlan,
  type ScenePlacementRequest,
} from '../core/scene/placement-plan.js';
import type { SceneController, SceneProjectState } from './scene-controller.js';
import type { WorkspaceContextManager } from './workspaces.js';

export type SceneChangeViewNode =
  | { kind: 'change-project'; state: SceneProjectState }
  | { kind: 'change-entry'; root: string; entry: SceneChangeJournalEntry }
  | { kind: 'change-diagnostic'; root: string; detail: string }
  | { kind: 'change-empty'; root: string; reason: 'no-snapshot' | 'no-changes' | 'journal-error'; detail?: string };

export type ScenePlanViewNode =
  | { kind: 'plan-project'; state: SceneProjectState }
  | { kind: 'plan'; root: string; plan: ScenePlacementPlan }
  | { kind: 'plan-risk'; root: string; planId: string; message: string }
  | { kind: 'plan-empty'; root: string; reason: 'no-snapshot' | 'no-session-plan' };

export type SceneJournalLoader = (
  root: string,
  options: SceneChangeJournalListOptions,
) => Promise<SceneChangeJournalEntry[] | SceneChangeJournalEvidenceResult>;

export interface SceneJournalSaveContext {
  signal: AbortSignal;
  isCurrent(): boolean;
}

export type SceneJournalSaver = (root: string, entry: SceneChangeJournalEntry, context: SceneJournalSaveContext) => Promise<void>;

const CHANGE_LABELS: Readonly<Record<SceneChangeJournalEntry['summary'][number]['kind'], string>> = {
  removed: '删除实例',
  added: '新增实例',
  type: '类型变化',
  relation: '父级/Owner变化',
  variant: '分支变化',
  position: '位置变化',
  rotation: '旋转变化',
  scale: '缩放变化',
  feature: '功能字段变化',
  'unknown-fields': '未知字段摘要变化',
  'group-removed': '删除编组',
  'group-added': '新增编组',
  'group-members': '编组成员变化',
  'group-nested': '嵌套编组变化',
  'group-relation': '编组父级变化',
  'group-feature': '编组字段变化',
  'root-feature': '场景根字段变化',
  evidence: '证据等级变化',
};

function journalSummary(entry: SceneChangeJournalEntry): string {
  return entry.summary.map((item) => `${CHANGE_LABELS[item.kind]} ${item.count}`).join(' · ');
}

export class SceneChangesProvider implements vscode.TreeDataProvider<SceneChangeViewNode>, vscode.Disposable {
  readonly #controller: SceneController;
  readonly #load: SceneJournalLoader;
  readonly #save: SceneJournalSaver;
  readonly #previous = new Map<string, SceneProjectState['snapshot']>();
  readonly #journalErrors = new Map<string, string>();
  readonly #emitter = new vscode.EventEmitter<void>();
  readonly #controllerSubscription: vscode.Disposable;
  readonly #captureControllers = new Set<AbortController>();
  #captureTail: Promise<void> = Promise.resolve();
  #captureEpoch = 0;
  #disposed = false;
  readonly onDidChangeTreeData = this.#emitter.event;

  constructor(
    controller: SceneController,
    load: SceneJournalLoader = async (root, options) => listSceneChangeJournalWithEvidence(root, nodeFileIO, options),
    save: SceneJournalSaver = async (root, entry, saveContext) => saveSceneChangeJournalEntry(root, entry, nodeFileIO, {
      signal: saveContext.signal,
      commitGuard: () => {
        if (!saveContext.isCurrent()) {
          const error = new Error('场景变更日志捕获代际已失效。');
          error.name = 'AbortError';
          throw error;
        }
      },
    }),
  ) {
    this.#controller = controller;
    this.#load = load;
    this.#save = save;
    for (const state of controller.list()) this.#previous.set(state.root, state.snapshot);
    this.#controllerSubscription = controller.onDidChange(() => {
      const captureEpoch = this.#captureEpoch += 1;
      for (const controller of this.#captureControllers) controller.abort();
      const captureController = new AbortController();
      this.#captureControllers.add(captureController);
      this.#captureTail = this.#captureTail
        .catch(() => undefined)
        .then(async () => this.#captureChanges(captureEpoch, captureController.signal))
        .finally(() => this.#captureControllers.delete(captureController));
    });
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#captureEpoch += 1;
    for (const controller of this.#captureControllers) controller.abort();
    this.#controllerSubscription.dispose();
    this.#emitter.dispose();
  }

  getTreeItem(node: SceneChangeViewNode): vscode.TreeItem {
    if (node.kind === 'change-project') {
      const item = new vscode.TreeItem(basename(node.state.root), vscode.TreeItemCollapsibleState.Expanded);
      item.description = node.state.snapshot === null ? '无快照' : '同来源时间线';
      item.tooltip = '只列出与当前 binding、来源角色和解析适配器一致的摘要日志。';
      return item;
    }
    if (node.kind === 'change-entry') {
      const observed = new Date(node.entry.toObservedAt).toLocaleString('zh-CN');
      const item = new vscode.TreeItem(`${observed} · ${node.entry.changeCount} 项变更`);
      item.description = journalSummary(node.entry);
      item.tooltip = [
        `从：${node.entry.fromSnapshotId.slice(0, 12)}`,
        `到：${node.entry.toSnapshotId.slice(0, 12)}`,
        `摘要：${journalSummary(node.entry) || '无变化'}`,
        '隐私说明：变更日志只保存摘要，不保存原始场景二进制。',
      ].join('\n');
      item.contextValue = 'yuanmengSceneChangeEntry';
      return item;
    }
    if (node.kind === 'change-diagnostic') {
      const item = new vscode.TreeItem('证据不足：部分变更日志已隔离');
      item.description = '有效记录仍可查看';
      item.tooltip = node.detail;
      return item;
    }
    const label = node.reason === 'no-snapshot'
      ? '证据不足：尚无场景快照'
      : node.reason === 'journal-error'
        ? '证据不足：变更日志写入失败'
        : '暂无当前同源场景变更记录';
    const item = new vscode.TreeItem(label);
    item.description = node.reason === 'no-changes' ? '0 项' : 'unknown';
    item.tooltip = node.reason === 'no-snapshot'
      ? '先绑定并刷新一个保存后的场景数据源。'
      : node.reason === 'journal-error'
        ? `上一份快照仍被保留，将在后续刷新重试。${node.detail === undefined ? '' : `\n${node.detail}`}`
        : '只有同 binding、role、adapter 的连续快照才会形成可比变更。';
    return item;
  }

  async getChildren(node?: SceneChangeViewNode): Promise<SceneChangeViewNode[]> {
    if (node === undefined) return this.#controller.list().map((state) => ({ kind: 'change-project', state }));
    if (node.kind !== 'change-project') return [];
    const snapshot = node.state.snapshot;
    if (snapshot === null) return [{ kind: 'change-empty', root: node.state.root, reason: 'no-snapshot' }];
    const journalError = this.#journalErrors.get(node.state.root);
    if (journalError !== undefined) return [{ kind: 'change-empty', root: node.state.root, reason: 'journal-error', detail: journalError }];
    const loaded = await this.#load(node.state.root, {
      bindingId: snapshot.bindingId,
      role: snapshot.role,
      adapterId: snapshot.adapterId,
      currentSnapshotId: snapshot.snapshotId,
      limit: 200,
    });
    const result = Array.isArray(loaded) ? { entries: loaded, status: 'complete' as const, diagnostics: [] } : loaded;
    if (result.status === 'evidence-insufficient') {
      if (result.entries.length === 0) {
        return [{ kind: 'change-empty', root: node.state.root, reason: 'journal-error', detail: result.diagnostics.join('\n') }];
      }
    }
    const entries = result.entries;
    if (entries.length === 0) {
      return [{ kind: 'change-empty', root: node.state.root, reason: 'no-changes' }];
    }
    const nodes: SceneChangeViewNode[] = entries.map((entry) => ({ kind: 'change-entry', root: node.state.root, entry }));
    if (result.status === 'evidence-insufficient') {
      nodes.push({ kind: 'change-diagnostic', root: node.state.root, detail: result.diagnostics.join('\n') });
    }
    return nodes;
  }

  async #captureChanges(captureEpoch: number, signal: AbortSignal): Promise<void> {
    const captureIsCurrent = (): boolean => !this.#disposed && !signal.aborted && captureEpoch === this.#captureEpoch;
    if (!captureIsCurrent()) return;
    const states = this.#controller.list();
    const liveRoots = new Set(states.map((state) => state.root));
    for (const root of this.#previous.keys()) {
      if (!liveRoots.has(root)) this.#previous.delete(root);
    }
    for (const state of states) {
      if (!captureIsCurrent()) return;
      const current = state.snapshot;
      const previous = this.#previous.get(state.root) ?? null;
      if (
        previous !== null
        && current !== null
        && previous.snapshotId !== current.snapshotId
        && previous.bindingId === current.bindingId
        && previous.role === current.role
        && previous.adapterId === current.adapterId
      ) {
        try {
          const saveContext: SceneJournalSaveContext = {
            signal,
            isCurrent: () => captureIsCurrent() && this.#controller.get(state.root).snapshot?.snapshotId === current.snapshotId,
          };
          await this.#save(state.root, createSceneChangeJournalEntry(previous, current), saveContext);
          if (!saveContext.isCurrent()) return;
          this.#journalErrors.delete(state.root);
          this.#previous.set(state.root, current);
        } catch (error) {
          this.#journalErrors.set(state.root, error instanceof Error ? error.message : String(error));
        }
      } else {
        this.#previous.set(state.root, current);
        this.#journalErrors.delete(state.root);
      }
    }
    if (captureIsCurrent()) this.#emitter.fire();
  }
}

export class ScenePlansProvider implements vscode.TreeDataProvider<ScenePlanViewNode>, vscode.Disposable {
  readonly #controller: SceneController;
  readonly #plans = new Map<string, ScenePlacementPlan[]>();
  readonly #emitter = new vscode.EventEmitter<void>();
  readonly #controllerSubscription: vscode.Disposable;
  readonly onDidChangeTreeData = this.#emitter.event;

  constructor(controller: SceneController) {
    this.#controller = controller;
    this.#controllerSubscription = controller.onDidChange(() => this.#emitter.fire());
  }

  dispose(): void {
    this.#controllerSubscription.dispose();
    this.#emitter.dispose();
  }

  setPlan(root: string, plan: ScenePlacementPlan): void {
    const snapshot = this.#controller.get(root).snapshot;
    if (snapshot === null || plan.snapshotId !== snapshot.snapshotId || plan.bindingId !== snapshot.bindingId) {
      throw new ProductError('SCENE_SOURCE_CONFLICT', '空间计划不属于当前工程的当前场景快照。', ['刷新场景并重新生成计划。'], 'STATIC_LOCAL');
    }
    const existing = this.#plans.get(root) ?? [];
    this.#plans.set(root, [plan, ...existing.filter((candidate) => candidate.planId !== plan.planId)].slice(0, 50));
    this.#emitter.fire();
  }

  getTreeItem(node: ScenePlanViewNode): vscode.TreeItem {
    if (node.kind === 'plan-project') {
      const item = new vscode.TreeItem(basename(node.state.root), vscode.TreeItemCollapsibleState.Expanded);
      item.description = '当前会话 · 当前快照';
      item.tooltip = '空间计划不会写回场景二进制；刷新快照后旧计划不会继续显示。';
      return item;
    }
    if (node.kind === 'plan') {
      const item = new vscode.TreeItem(
        `${node.plan.operation} · ${node.plan.affectedInstanceIds.length} 个实例`,
        node.plan.risks.length > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
      );
      item.description = node.plan.status === 'ready' ? '仅预览 · 可审查' : `证据不足 · ${node.plan.reasonCode}`;
      item.tooltip = [
        `计划：${node.plan.planId.slice(0, 12)}`,
        `快照：${node.plan.snapshotId.slice(0, 12)}`,
        `受影响：${node.plan.affectedInstanceIds.join(', ') || '无'}`,
        '安全边界：execute=false，仅预览；任何实际修改必须另行确认。',
      ].join('\n');
      item.contextValue = 'yuanmengScenePlacementPlan';
      return item;
    }
    if (node.kind === 'plan-risk') {
      const item = new vscode.TreeItem(node.message);
      item.description = '风险/证据';
      return item;
    }
    const label = node.reason === 'no-snapshot'
      ? '证据不足：尚无场景快照'
      : '当前会话尚未生成空间计划';
    const item = new vscode.TreeItem(label);
    item.description = node.reason === 'no-snapshot' ? 'unknown' : '仅会话内';
    return item;
  }

  async getChildren(node?: ScenePlanViewNode): Promise<ScenePlanViewNode[]> {
    if (node === undefined) return this.#controller.list().map((state) => ({ kind: 'plan-project', state }));
    if (node.kind === 'plan-project') {
      const snapshot = node.state.snapshot;
      if (snapshot === null) return [{ kind: 'plan-empty', root: node.state.root, reason: 'no-snapshot' }];
      const plans = (this.#plans.get(node.state.root) ?? []).filter((plan) => (
        plan.snapshotId === snapshot.snapshotId && plan.bindingId === snapshot.bindingId
      ));
      return plans.length === 0
        ? [{ kind: 'plan-empty', root: node.state.root, reason: 'no-session-plan' }]
        : plans.map((plan) => ({ kind: 'plan', root: node.state.root, plan }));
    }
    if (node.kind === 'plan') {
      return node.plan.risks.map((risk) => ({
        kind: 'plan-risk', root: node.root, planId: node.plan.planId, message: `${risk.code}：${risk.message}`,
      }));
    }
    return [];
  }
}

export interface SceneWorkflowViews extends vscode.Disposable {
  changes: SceneChangesProvider;
  plans: ScenePlansProvider;
}

export function registerSceneWorkflowViews(
  context: vscode.ExtensionContext,
  controller: SceneController,
): SceneWorkflowViews {
  const changes = new SceneChangesProvider(controller);
  const plans = new ScenePlansProvider(controller);
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('yuanmengAi.sceneChanges', changes),
    vscode.window.registerTreeDataProvider('yuanmengAi.scenePlans', plans),
    changes,
    plans,
  );
  return { changes, plans, dispose: () => undefined };
}

function placementValidation(message: string): never {
  throw new ProductError('VALIDATION_FAILED', message, ['修正空间计划 JSON 后重试。'], 'STATIC_LOCAL');
}

function placementRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) placementValidation(`${field} 必须是对象。`);
  return value as Record<string, unknown>;
}

function decimalId(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^[1-9]\d*$/u.test(value)) placementValidation(`${field} 必须是十进制 ID。`);
  return value;
}

function axis(value: unknown, field: string): 'x' | 'y' | 'z' {
  if (value !== 'x' && value !== 'y' && value !== 'z') placementValidation(`${field} 必须是 x、y 或 z。`);
  return value;
}

function finiteNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) placementValidation(`${field} 必须是有限数值。`);
  return value;
}

function optionalVector(value: unknown, field: string): Partial<Record<'x' | 'y' | 'z', number>> | undefined {
  if (value === undefined) return undefined;
  const record = placementRecord(value, field);
  const result: Partial<Record<'x' | 'y' | 'z', number>> = {};
  for (const key of Object.keys(record)) {
    if (key !== 'x' && key !== 'y' && key !== 'z') placementValidation(`${field}.${key} 不是受支持的坐标轴。`);
    result[key] = finiteNumber(record[key], `${field}.${key}`);
  }
  return result;
}

export function parseScenePlacementRequest(value: unknown): ScenePlacementRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ProductError('VALIDATION_FAILED', '空间计划请求必须是 JSON 对象。', ['按 CLI scene-plan 的请求结构填写。'], 'STATIC_LOCAL');
  }
  const candidate = value as Record<string, unknown>;
  const targetIds = Array.isArray(candidate.targetIds)
    ? candidate.targetIds.map((id, index) => decimalId(id, `targetIds[${index}]`))
    : placementValidation('targetIds 必须是十进制 ID 数组。');
  if (targetIds.length === 0) placementValidation('targetIds 不能为空。');
  const preserve = candidate.preserveGroupRelative;
  if (preserve !== undefined && typeof preserve !== 'boolean') placementValidation('preserveGroupRelative 必须是布尔值。');
  const common = preserve === undefined ? { targetIds } : { targetIds, preserveGroupRelative: preserve };
  if (candidate.kind === 'floor-align') return { kind: candidate.kind, ...common, supportId: decimalId(candidate.supportId, 'supportId') };
  if (candidate.kind === 'axis-align') {
    const anchor = candidate.anchor;
    if (anchor !== 'position' && anchor !== 'min' && anchor !== 'center' && anchor !== 'max') placementValidation('anchor 无效。');
    return { kind: candidate.kind, ...common, referenceId: decimalId(candidate.referenceId, 'referenceId'), axis: axis(candidate.axis, 'axis'), anchor };
  }
  if (candidate.kind === 'equal-spacing') {
    const mode = candidate.mode;
    if (mode !== 'position' && mode !== 'bounds-gap') placementValidation('mode 无效。');
    return { kind: candidate.kind, ...common, axis: axis(candidate.axis, 'axis'), mode };
  }
  if (candidate.kind === 'grid') {
    const columns = candidate.columns;
    if (!Number.isInteger(columns) || (columns as number) < 1) placementValidation('columns 必须是正整数。');
    return { kind: candidate.kind, ...common, rowAxis: axis(candidate.rowAxis, 'rowAxis'), columnAxis: axis(candidate.columnAxis, 'columnAxis'), columns: columns as number, rowSpacing: finiteNumber(candidate.rowSpacing, 'rowSpacing'), columnSpacing: finiteNumber(candidate.columnSpacing, 'columnSpacing') };
  }
  if (candidate.kind === 'rows' || candidate.kind === 'columns') {
    return { kind: candidate.kind, ...common, axis: axis(candidate.axis, 'axis'), spacing: finiteNumber(candidate.spacing, 'spacing') };
  }
  if (candidate.kind === 'batch-offset') {
    const components = placementRecord(candidate.components, 'components');
    const position = optionalVector(components.position, 'components.position');
    const rotation = optionalVector(components.rotation, 'components.rotation');
    const scale = optionalVector(components.scale, 'components.scale');
    return {
      kind: candidate.kind,
      ...common,
      components: {
        ...(position === undefined ? {} : { position }),
        ...(rotation === undefined ? {} : { rotation }),
        ...(scale === undefined ? {} : { scale }),
      },
    };
  }
  return placementValidation('空间计划 kind 无效。');
}

export function registerSceneWorkflowCommands(
  context: vscode.ExtensionContext,
  manager: WorkspaceContextManager,
  controller: SceneController,
  views: SceneWorkflowViews,
): void {
  context.subscriptions.push(vscode.commands.registerCommand('yuanmengAi.previewScenePlan', async (root, suppliedRequest) => {
    try {
      const managed = await manager.choose(typeof root === 'string' ? root : undefined);
      const snapshot = controller.get(managed.project.root).snapshot;
      if (snapshot === null) throw new ProductError('NOT_FOUND', '当前工程没有场景快照。', ['先绑定并刷新场景源。'], 'STATIC_LOCAL');
      let raw: unknown = suppliedRequest;
      if (raw === undefined) {
        const input = await vscode.window.showInputBox({
          prompt: '输入空间计划 JSON；计划只预览，不执行',
          value: '{"kind":"batch-offset","targetIds":["101"],"components":{"position":{"z":1}}}',
        });
        if (input === undefined) return undefined;
        try { raw = JSON.parse(input) as unknown; } catch (error) {
          throw new ProductError('VALIDATION_FAILED', '空间计划不是有效 JSON。', ['修正 JSON 后重试。'], 'STATIC_LOCAL', error);
        }
      }
      const plan = createScenePlacementPlan(snapshot, parseScenePlacementRequest(raw));
      views.plans.setPlan(managed.project.root, plan);
      await vscode.commands.executeCommand('yuanmengAi.scenePlans.focus');
      const document = await vscode.workspace.openTextDocument({ content: `${JSON.stringify(plan, null, 2)}\n`, language: 'json' });
      await vscode.window.showTextDocument(document, { preview: true });
      if (plan.status === 'evidence-insufficient') {
        void vscode.window.showWarningMessage(`空间计划证据不足：${plan.reasonCode}。没有生成执行动作。`);
      } else {
        void vscode.window.showInformationMessage('空间计划已生成并加入当前会话视图；execute=false，仅供预览审查。');
      }
      return plan;
    } catch (error) {
      void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
      throw error;
    }
  }));
}
