import { basename } from 'node:path';

import * as vscode from 'vscode';

import {
  analyzeSceneSpatialProblems,
  auditSceneSnapshot,
  inspectSceneInstanceFields,
  type SceneAuditFinding,
  type SceneFieldInspection,
  type SceneSpatialProblem,
} from '../core/scene/diagnostics.js';
import type { SceneFieldProbeName, SceneFieldProbeValue } from '../core/scene/probe-evidence.js';
import { resolveSceneInstanceIntelligence, summarizeSceneTypeCoverage } from '../core/scene/semantic-catalog.js';
import type { SceneInstance, UnknownFieldSummary } from '../core/scene/types.js';
import type { SceneController, SceneProjectState } from './scene-controller.js';
import type { WorkspaceContextManager } from './workspaces.js';

const PAGE_SIZE = 200;
const EVIDENCE_LABEL = {
  'confirmed-calibration': '已校准',
  'observed-repeatable': '可重复观测',
  'inferred-candidate': '候选',
  unknown: '未知',
} as const;

export type SceneFieldViewNode =
  | { kind: 'field-project'; state: SceneProjectState }
  | { kind: 'root-info'; root: string; label: string; description: string; tooltip: string }
  | { kind: 'field-instance'; root: string; instance: SceneInstance }
  | { kind: 'field'; root: string; instanceId: string; inspection: SceneFieldInspection }
  | { kind: 'runtime-family'; root: string; instanceId: string; family: 'character' | 'creature' | 'element' | 'logic-element' | 'player' | 'trigger-box'; state: 'present' | 'absent' | 'error' }
  | { kind: 'runtime-field'; root: string; instanceId: string; field: SceneFieldProbeName; status: 'ok' | 'error' | 'not-applicable'; value: SceneFieldProbeValue | null }
  | { kind: 'runtime-conflict'; root: string; instanceId: string }
  | { kind: 'unknown-field'; root: string; instanceId: string | null; field: UnknownFieldSummary }
  | { kind: 'field-load-more'; root: string; offset: number }
  | { kind: 'field-empty'; root: string; reason: 'no-snapshot' | 'no-instances' };

export type SceneProblemViewNode =
  | { kind: 'problem-project'; state: SceneProjectState }
  | { kind: 'audit-problem'; root: string; finding: SceneAuditFinding }
  | { kind: 'spatial-problem'; root: string; problem: SceneSpatialProblem }
  | { kind: 'problem-empty'; root: string; reason: 'no-snapshot' | 'no-findings' | 'load-error'; detail?: string };

export class SceneFieldsProvider implements vscode.TreeDataProvider<SceneFieldViewNode>, vscode.Disposable {
  readonly #controller: SceneController;
  readonly #instanceCounts = new WeakMap<object, ReadonlyMap<string, number>>();
  readonly #emitter = new vscode.EventEmitter<void>();
  readonly #subscription: vscode.Disposable;
  readonly onDidChangeTreeData = this.#emitter.event;

  constructor(controller: SceneController) {
    this.#controller = controller;
    this.#subscription = controller.onDidChange(() => this.#emitter.fire());
  }

  dispose(): void {
    this.#subscription.dispose();
    this.#emitter.dispose();
  }

  getTreeItem(node: SceneFieldViewNode): vscode.TreeItem {
    if (node.kind === 'field-project') {
      const item = new vscode.TreeItem(basename(node.state.root), vscode.TreeItemCollapsibleState.Expanded);
      item.description = node.state.snapshot === null ? '无快照' : `${node.state.snapshot.instances.length} 个实例`;
      item.tooltip = '字段检查器只展示规范化值、证据等级和未知字段摘要；不保存原始场景 bytes。';
      return item;
    }
    if (node.kind === 'root-info') {
      const item = new vscode.TreeItem(node.label);
      item.description = node.description;
      item.tooltip = node.tooltip;
      return item;
    }
    if (node.kind === 'field-instance') {
      const item = new vscode.TreeItem(`实例 ${node.instance.instanceId}`, vscode.TreeItemCollapsibleState.Collapsed);
      const runtime = this.#runtimeForUniqueInstance(node.root, node.instance.instanceId);
      const intelligence = resolveSceneInstanceIntelligence(
        node.instance,
        runtime?.state === 'unique' ? runtime.evidence : null,
      );
      item.description = `类型 ${node.instance.elementTypeId ?? '未知'} · ${intelligence.actorFamily} · ${EVIDENCE_LABEL[node.instance.evidence.state]}`;
      item.contextValue = 'yuanmengSceneFieldInstance';
      return item;
    }
    if (node.kind === 'field') {
      const item = new vscode.TreeItem(node.inspection.field);
      item.description = node.inspection.state === 'observed'
        ? `已观测 · ${node.inspection.evidence === null ? '未知证据' : EVIDENCE_LABEL[node.inspection.evidence.state]}`
        : node.inspection.state === 'candidate' ? '候选 · 需探针' : node.inspection.state === 'unsupported' ? '不支持' : '明确 absent';
      item.tooltip = [
        node.inspection.reason,
        node.inspection.nextAction === null ? null : `下一步：${node.inspection.nextAction}`,
        node.inspection.wirePaths === undefined ? null : `候选 wire：${node.inspection.wirePaths.join(', ')}`,
      ].filter((value): value is string => value !== null).join('\n');
      return item;
    }
    if (node.kind === 'runtime-family') {
      const item = new vscode.TreeItem(`运行时对象族 ${node.family}`);
      item.description = node.state === 'present' ? '已确认存在' : node.state === 'absent' ? '已确认不存在' : '调用失败 · 保持未知';
      item.tooltip = '当前工程、当前 binding、当前快照和当前场景源哈希绑定的无副作用对象族探针。';
      return item;
    }
    if (node.kind === 'runtime-field') {
      const item = new vscode.TreeItem(`运行时字段 ${node.field}`);
      item.description = node.status === 'ok' ? '已观测' : node.status === 'not-applicable' ? '不适用' : '调用失败 · 保持未知';
      item.tooltip = node.status !== 'ok' || node.value === null
        ? '该字段没有可提升为事实的值；其他字段的成功证据仍保留。'
        : `结构化值：${JSON.stringify(node.value.value)}`;
      return item;
    }
    if (node.kind === 'runtime-conflict') {
      const item = new vscode.TreeItem('运行时证据冲突');
      item.description = '未合并';
      item.tooltip = '同一实例和精确快照存在互相冲突的探针结果；重新运行并只保留可信证据。';
      return item;
    }
    if (node.kind === 'unknown-field') {
      const item = new vscode.TreeItem(`未知字段 ${node.field.path}`);
      item.description = `wire ${node.field.wireType} · ${node.field.length} bytes`;
      item.tooltip = `仅保存摘要 SHA-256：${node.field.sha256}\n不显示或导出原始 bytes/hex。`;
      return item;
    }
    if (node.kind === 'field-load-more') {
      return new vscode.TreeItem(`加载更多（从 ${node.offset} 开始）`, vscode.TreeItemCollapsibleState.Collapsed);
    }
    const item = new vscode.TreeItem(node.reason === 'no-snapshot' ? '证据不足：尚无场景快照' : '当前快照没有实例');
    item.description = node.reason === 'no-snapshot' ? 'unknown' : '0 项';
    return item;
  }

  getChildren(node?: SceneFieldViewNode): SceneFieldViewNode[] {
    if (node === undefined) return this.#controller.list().map((state) => ({ kind: 'field-project', state }));
    if (node.kind === 'field-project') {
      if (node.state.snapshot === null) return [{ kind: 'field-empty', root: node.state.root, reason: 'no-snapshot' }];
      const snapshot = node.state.snapshot;
      const rootInfo: SceneFieldViewNode[] = [];
      const typeCoverage = summarizeSceneTypeCoverage(snapshot);
      rootInfo.push({
        kind: 'root-info', root: node.state.root,
        label: '类型识别覆盖',
        description: `${typeCoverage.calibratedTypeCount}/${typeCoverage.encounteredTypeCount} 种 · ${typeCoverage.calibratedInstanceCount}/${snapshot.instances.length} 个实例`,
        tooltip: [
          `静态目录：${typeCoverage.catalog.sourceId}`,
          `校准日期：${typeCoverage.catalog.calibratedAt}；核对 API 版本：${typeCoverage.catalog.verifiedOfficialApiVersion}`,
          `目录条目：${typeCoverage.catalog.entryCount}；未识别实例：${typeCoverage.unknownInstanceCount}`,
          typeCoverage.unknownTypeIds.length === 0 ? '当前快照没有未收录的非空类型 ID。' : `未收录类型 ID（最多显示 20 个）：${typeCoverage.unknownTypeIds.slice(0, 20).join('、')}`,
          ...typeCoverage.warnings,
        ].join('\n'),
      });
      if (snapshot.signalRegistry?.state === 'observed') {
        for (const signal of snapshot.signalRegistry.value.slice(0, PAGE_SIZE)) rootInfo.push({
          kind: 'root-info', root: node.state.root,
          label: `根信号：${signal.name}`,
          description: `${signal.unknownRefCount} 个不透明引用`,
          tooltip: '信号名称来自场景根注册表；引用方向尚未校准，不能据此断言发送者或接收者。',
        });
        if (snapshot.signalRegistry.value.length > PAGE_SIZE) rootInfo.push({
          kind: 'root-info', root: node.state.root,
          label: '根信号列表已截断',
          description: `${PAGE_SIZE}/${snapshot.signalRegistry.value.length}`,
          tooltip: '使用 JSON 场景导出查看全部结构化信号条目。',
        });
      } else if (snapshot.signalRegistry !== undefined) rootInfo.push({
        kind: 'root-info', root: node.state.root,
        label: '根信号注册表', description: snapshot.signalRegistry.state,
        tooltip: '当前字段没有可提升为已观测事实的信号名称。',
      });
      const metadata = snapshot.sceneMetadata;
      if (metadata !== undefined) {
        rootInfo.push({
          kind: 'root-info', root: node.state.root,
          label: '图层名称',
          description: metadata.layerName.state === 'observed' ? metadata.layerName.value : metadata.layerName.state,
          tooltip: '这是场景元数据中的图层名称候选，不是图层 ID。',
        });
        rootInfo.push({
          kind: 'root-info', root: node.state.root,
          label: '场景版本文本',
          description: metadata.editorVersionCandidate.state === 'observed' ? metadata.editorVersionCandidate.value : metadata.editorVersionCandidate.state,
          tooltip: '该文本的具体版本域尚未校准，不直接等同于官方 VS Code 扩展/API 版本。',
        });
        rootInfo.push({
          kind: 'root-info', root: node.state.root,
          label: '实例索引',
          description: metadata.instanceIndex.state === 'observed'
            ? `${metadata.instanceIndex.value.entryCount} 条 · 重复 ${metadata.instanceIndex.value.duplicateIds.length}`
            : metadata.instanceIndex.state,
          tooltip: '只显示规范化计数和差异，不显示原始二进制。',
        });
      }
      const rootUnknown = snapshot.unknownFields.map((field): SceneFieldViewNode => ({
        kind: 'unknown-field', root: node.state.root, instanceId: null, field,
      }));
      if (snapshot.instances.length === 0) {
        return rootInfo.length + rootUnknown.length > 0 ? [...rootInfo, ...rootUnknown] : [{ kind: 'field-empty', root: node.state.root, reason: 'no-instances' }];
      }
      return [...rootInfo, ...rootUnknown, ...this.#instancePage(node.state.root, 0)];
    }
    if (node.kind === 'field-load-more') return this.#instancePage(node.root, node.offset);
    if (node.kind === 'field-instance') {
      const runtime = this.#runtimeForUniqueInstance(node.root, node.instance.instanceId);
      const runtimeNodes: SceneFieldViewNode[] = runtime === null ? [] : runtime.state === 'conflict'
        ? [{ kind: 'runtime-conflict', root: node.root, instanceId: node.instance.instanceId }]
        : [
          { kind: 'runtime-family', root: node.root, instanceId: node.instance.instanceId, family: 'character', state: runtime.evidence.characterState ?? 'error' },
          { kind: 'runtime-family', root: node.root, instanceId: node.instance.instanceId, family: 'creature', state: runtime.evidence.creatureState ?? 'error' },
          { kind: 'runtime-family', root: node.root, instanceId: node.instance.instanceId, family: 'element', state: runtime.evidence.elementState },
          { kind: 'runtime-family', root: node.root, instanceId: node.instance.instanceId, family: 'logic-element', state: runtime.evidence.logicElementState },
          { kind: 'runtime-family', root: node.root, instanceId: node.instance.instanceId, family: 'player', state: runtime.evidence.playerState ?? 'error' },
          { kind: 'runtime-family', root: node.root, instanceId: node.instance.instanceId, family: 'trigger-box', state: runtime.evidence.triggerBoxState },
          ...Object.entries(runtime.evidence.fields)
            .sort(([left], [right]) => left.localeCompare(right, 'en'))
            .map(([field, observation]): SceneFieldViewNode => ({
              kind: 'runtime-field', root: node.root, instanceId: node.instance.instanceId,
              field: field as SceneFieldProbeName, status: observation!.status, value: observation!.value,
            })),
        ];
      return [
        ...runtimeNodes,
        ...inspectSceneInstanceFields(node.instance).map((inspection): SceneFieldViewNode => ({
          kind: 'field', root: node.root, instanceId: node.instance.instanceId, inspection,
        })),
        ...node.instance.unknownFields.map((field): SceneFieldViewNode => ({
          kind: 'unknown-field', root: node.root, instanceId: node.instance.instanceId, field,
        })),
      ];
    }
    return [];
  }

  #instancePage(root: string, offset: number): SceneFieldViewNode[] {
    const instances = this.#controller.get(root).snapshot?.instances ?? [];
    const values = instances.slice(offset, offset + PAGE_SIZE).map((instance): SceneFieldViewNode => ({ kind: 'field-instance', root, instance }));
    const next = offset + values.length;
    if (next < instances.length) values.push({ kind: 'field-load-more', root, offset: next });
    return values;
  }

  #runtimeForUniqueInstance(root: string, instanceId: string) {
    const snapshot = this.#controller.get(root).snapshot;
    if (snapshot === null) return null;
    let counts = this.#instanceCounts.get(snapshot);
    if (counts === undefined) {
      const mutable = new Map<string, number>();
      for (const instance of snapshot.instances) mutable.set(instance.instanceId, (mutable.get(instance.instanceId) ?? 0) + 1);
      counts = mutable;
      this.#instanceCounts.set(snapshot, counts);
    }
    return counts.get(instanceId) === 1 ? this.#controller.runtimeCapability(root, instanceId) : null;
  }
}

export class SceneProblemsProvider implements vscode.TreeDataProvider<SceneProblemViewNode>, vscode.Disposable {
  readonly #controller: SceneController;
  readonly #manager: Pick<WorkspaceContextManager, 'listRegistry'>;
  readonly #emitter = new vscode.EventEmitter<void>();
  readonly #subscription: vscode.Disposable;
  readonly onDidChangeTreeData = this.#emitter.event;

  constructor(controller: SceneController, manager: Pick<WorkspaceContextManager, 'listRegistry'>) {
    this.#controller = controller;
    this.#manager = manager;
    this.#subscription = controller.onDidChange(() => this.#emitter.fire());
  }

  dispose(): void {
    this.#subscription.dispose();
    this.#emitter.dispose();
  }

  getTreeItem(node: SceneProblemViewNode): vscode.TreeItem {
    if (node.kind === 'problem-project') {
      const item = new vscode.TreeItem(basename(node.state.root), vscode.TreeItemCollapsibleState.Expanded);
      item.description = node.state.snapshot === null ? '无快照' : '已确认 + 需探针';
      item.tooltip = '空间结论只使用可信边界/变换；缺证据时明确显示需探针，不猜测。';
      return item;
    }
    if (node.kind === 'audit-problem') {
      const item = new vscode.TreeItem(node.finding.message);
      item.description = `${node.finding.severity} · ${node.finding.reasonCode}`;
      item.tooltip = node.finding.nextAction ?? node.finding.message;
      return item;
    }
    if (node.kind === 'spatial-problem') {
      const item = new vscode.TreeItem(node.problem.message);
      item.description = `${node.problem.certainty === 'confirmed' ? '已确认' : '需探针'} · ${node.problem.severity}`;
      item.tooltip = node.problem.nextAction ?? node.problem.message;
      item.contextValue = node.problem.certainty === 'confirmed' ? 'yuanmengSceneConfirmedProblem' : 'yuanmengSceneProbeProblem';
      return item;
    }
    const label = node.reason === 'no-snapshot'
      ? '证据不足：尚无场景快照'
      : node.reason === 'load-error' ? '证据不足：问题视图读取失败' : '当前快照未发现可报告问题';
    const item = new vscode.TreeItem(label);
    item.description = node.reason === 'no-findings' ? '0 项' : 'unknown';
    item.tooltip = node.detail;
    return item;
  }

  async getChildren(node?: SceneProblemViewNode): Promise<SceneProblemViewNode[]> {
    if (node === undefined) return this.#controller.list().map((state) => ({ kind: 'problem-project', state }));
    if (node.kind !== 'problem-project') return [];
    const snapshot = node.state.snapshot;
    if (snapshot === null) return [{ kind: 'problem-empty', root: node.state.root, reason: 'no-snapshot' }];
    try {
      const records = await this.#manager.listRegistry(node.state.root);
      // 视图每次都绑定当前 snapshotId；异步读台账结束后若快照已切换，拒绝显示旧代结果。
      if (this.#controller.get(node.state.root).snapshot?.snapshotId !== snapshot.snapshotId) {
        return [{ kind: 'problem-empty', root: node.state.root, reason: 'load-error', detail: '场景快照已更新，请重新展开。' }];
      }
      const audit = auditSceneSnapshot(snapshot, { registryRecords: records });
      const spatial = analyzeSceneSpatialProblems(snapshot, { maxFindings: 1_000, maxPairChecks: 200_000 });
      const values: SceneProblemViewNode[] = [
        ...audit.findings.slice(0, 1_000).map((finding): SceneProblemViewNode => ({ kind: 'audit-problem', root: node.state.root, finding })),
        ...spatial.findings.map((problem): SceneProblemViewNode => ({ kind: 'spatial-problem', root: node.state.root, problem })),
      ];
      return values.length === 0 ? [{ kind: 'problem-empty', root: node.state.root, reason: 'no-findings' }] : values;
    } catch (error) {
      return [{ kind: 'problem-empty', root: node.state.root, reason: 'load-error', detail: error instanceof Error ? error.message : String(error) }];
    }
  }
}

export interface SceneInspectionViews extends vscode.Disposable {
  fields: SceneFieldsProvider;
  problems: SceneProblemsProvider;
}

export function createSceneInspectionViews(
  controller: SceneController,
  manager: WorkspaceContextManager,
): SceneInspectionViews {
  const fields = new SceneFieldsProvider(controller);
  const problems = new SceneProblemsProvider(controller, manager);
  return {
    fields,
    problems,
    dispose: () => {
      fields.dispose();
      problems.dispose();
    },
  };
}
