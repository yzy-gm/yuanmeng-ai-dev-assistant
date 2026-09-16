import { basename } from 'node:path';

import * as vscode from 'vscode';

import { buildSceneRelations, pageSceneValues, type SceneRelations } from '../core/scene/hierarchy.js';
import { buildSceneGroupIntelligence, resolveSceneInstanceIntelligence } from '../core/scene/semantic-catalog.js';
import type { SceneGroup, SceneInstance, SceneIssue } from '../core/scene/types.js';
import type { SceneController, SceneProjectState } from './scene-controller.js';

export type SceneTreeNode =
  | { kind: 'project'; state: SceneProjectState }
  | { kind: 'category'; root: string; category: 'instances' | 'groups' | 'issues'; count: number }
  | { kind: 'instance'; root: string; instance: SceneInstance }
  | { kind: 'group'; root: string; group: SceneGroup }
  | { kind: 'issue'; root: string; issue: SceneIssue }
  | { kind: 'load-more'; root: string; list: SceneTreeList; offset: number; total: number };

type SceneTreeList =
  | { kind: 'category'; category: 'instances' | 'groups' | 'issues' }
  | { kind: 'owner'; ownerId: string }
  | { kind: 'group'; groupId: string };

const PAGE_SIZE = 200;
const EVIDENCE_LABELS = {
  'confirmed-calibration': '已校准',
  'observed-repeatable': '可重复',
  'inferred-candidate': '候选',
  unknown: '未知',
} as const;

export class SceneTreeProvider implements vscode.TreeDataProvider<SceneTreeNode> {
  readonly #controller: SceneController;
  readonly #relations = new WeakMap<object, SceneRelations>();
  readonly #instanceCounts = new WeakMap<object, ReadonlyMap<string, number>>();
  readonly onDidChangeTreeData: vscode.Event<void>;

  constructor(controller: SceneController) {
    this.#controller = controller;
    this.onDidChangeTreeData = controller.onDidChange;
  }

  getTreeItem(node: SceneTreeNode): vscode.TreeItem {
    if (node.kind === 'project') {
      const item = new vscode.TreeItem(basename(node.state.root), vscode.TreeItemCollapsibleState.Expanded);
      item.description = node.state.refreshing
        ? `读取中${node.state.refreshPhase === null ? '' : ` · ${node.state.refreshPhase}`}`
        : node.state.snapshot === null
          ? (node.state.registeredSceneInstances ?? 0) > 0
            ? `已登记 ${node.state.registeredSceneInstances} 个元件（无完整快照）`
            : '尚未绑定场景源/无快照'
          : `${node.state.snapshot.instances.length} 元件`;
      item.tooltip = node.state.lastError
        ?? ((node.state.registeredSceneInstances ?? 0) > 0 && node.state.snapshot === null
          ? '已登记的实例 ID 可用于单个元件属性读取和运行时校准；完整场景树需要绑定当前地图已落盘的 LayerData。路径已明确时可由 AI 直接完成。'
          : node.state.bindings.map((binding) => `${binding.role}: ${binding.displayDirectory}`).join('\n'));
      item.contextValue = 'yuanmengSceneProject';
      return item;
    }
    if (node.kind === 'category') {
      const labels = { instances: '场景元件', groups: '编组', issues: '解析与关系问题' } as const;
      const item = new vscode.TreeItem(`${labels[node.category]} (${node.count})`, vscode.TreeItemCollapsibleState.Collapsed);
      item.contextValue = 'yuanmengSceneCategory';
      return item;
    }
    if (node.kind === 'instance') {
      const relations = this.#relationsFor(node.root);
      const runtime = this.#runtimeForUniqueInstance(node.root, node.instance.instanceId);
      const intelligence = resolveSceneInstanceIntelligence(
        node.instance,
        runtime?.state === 'unique' ? runtime.evidence : null,
      );
      const collapsible = (relations.childrenByParent.get(node.instance.instanceId)?.length ?? 0) > 0;
      const item = new vscode.TreeItem(`${intelligence.canonicalName ?? '实例'} ${node.instance.instanceId}`, collapsible ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
      item.description = `类型 ${node.instance.elementTypeId ?? '未知'} · ${intelligence.actorFamily} · owner ${node.instance.ownerId ?? '无'} · 证据 ${EVIDENCE_LABELS[node.instance.evidence.state]}`;
      item.tooltip = [
        `实例 ID：${node.instance.instanceId}`,
        `类型 ID：${node.instance.elementTypeId ?? '未知'}`,
        `Owner：${node.instance.ownerId ?? '无'}`,
        `分支：${node.instance.variant}`,
        `对象族：${intelligence.actorFamily}`,
        `官方别名：${intelligence.aliases.length === 0 ? '无已校准别名' : intelligence.aliases.join('、')}`,
        `适用事件：${intelligence.eventNames.length === 0 ? '需运行时分类' : intelligence.eventNames.join('、')}`,
        `能力：${intelligence.capabilities.map((capability) => `${capability.key}=${capability.state}`).join('；')}`,
        runtime?.state === 'conflict' ? '运行时证据：存在冲突，未合并' : `运行时证据：${runtime === null ? '未导入' : '已绑定当前快照'}`,
        ...intelligence.warnings.map((warning) => `警告：${warning}`),
        `证据：${node.instance.evidence.state}`,
        node.instance.transform.state === 'observed'
          ? `位置：${node.instance.transform.value.position.x}, ${node.instance.transform.value.position.y}, ${node.instance.transform.value.position.z}`
          : `变换：${node.instance.transform.state}`,
      ].join('\n');
      item.contextValue = 'yuanmengSceneInstance';
      return item;
    }
    if (node.kind === 'group') {
      const ownedCount = this.#relationsFor(node.root).childrenByParent.get(node.group.groupId)?.length ?? 0;
      const intelligence = buildSceneGroupIntelligence({
        directMemberCount: node.group.memberIds.length,
        nestedGroupCount: node.group.nestedGroupIds.length,
        recursiveMemberCount: null,
      });
      const item = new vscode.TreeItem(`编组 ${node.group.groupId}`, node.group.memberIds.length + node.group.nestedGroupIds.length + ownedCount > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
      item.description = `${node.group.memberIds.length} 成员 · ${intelligence.actorFamily} · 证据 ${EVIDENCE_LABELS[node.group.evidence.state]}`;
      item.tooltip = [
        `成员：${node.group.memberIds.length}`,
        `嵌套编组：${node.group.nestedGroupIds.length}`,
        `父编组：${node.group.parentGroupId ?? '无/旧快照未记录'}`,
        `Owner 子项：${ownedCount}`,
        `变换：${node.group.transform?.state ?? '旧快照未记录'}`,
        `来源候选：${node.group.metadata?.state ?? '旧快照未记录'}`,
        ...intelligence.warnings.map((warning) => `说明：${warning}`),
        `证据：${node.group.evidence.state}`,
      ].join('\n');
      item.contextValue = 'yuanmengSceneGroup';
      return item;
    }
    if (node.kind === 'load-more') {
      const item = new vscode.TreeItem(`加载更多 (${node.offset}/${node.total})`, vscode.TreeItemCollapsibleState.Collapsed);
      item.contextValue = 'yuanmengSceneLoadMore';
      return item;
    }
    const item = new vscode.TreeItem(node.issue.message);
    item.description = node.issue.code;
    item.contextValue = 'yuanmengSceneIssue';
    return item;
  }

  getChildren(node?: SceneTreeNode): SceneTreeNode[] {
    if (node === undefined) return this.#controller.list().map((state) => ({ kind: 'project', state }));
    if (node.kind === 'project') {
      const snapshot = node.state.snapshot;
      if (snapshot === null) return [];
      return [
        { kind: 'category', root: node.state.root, category: 'instances', count: snapshot.instances.length },
        { kind: 'category', root: node.state.root, category: 'groups', count: snapshot.groups.length },
        { kind: 'category', root: node.state.root, category: 'issues', count: this.#issuesFor(node.state.root).length },
      ];
    }
    if (node.kind === 'category') {
      const snapshot = this.#controller.get(node.root).snapshot;
      if (snapshot === null) return [];
      return this.#page(node.root, { kind: 'category', category: node.category }, 0);
    }
    if (node.kind === 'load-more') return this.#page(node.root, node.list, node.offset);
    if (node.kind === 'instance') return this.#page(node.root, { kind: 'owner', ownerId: node.instance.instanceId }, 0);
    if (node.kind === 'group') {
      return this.#page(node.root, { kind: 'group', groupId: node.group.groupId }, 0);
    }
    return [];
  }

  #relationsFor(root: string): SceneRelations {
    const snapshot = this.#controller.get(root).snapshot;
    if (snapshot === null) throw new Error('Scene snapshot is not available.');
    const cached = this.#relations.get(snapshot);
    if (cached !== undefined) return cached;
    const relations = buildSceneRelations(snapshot);
    this.#relations.set(snapshot, relations);
    return relations;
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

  #issuesFor(root: string): SceneIssue[] {
    const snapshot = this.#controller.get(root).snapshot;
    if (snapshot === null) return [];
    const unique = new Map<string, SceneIssue>();
    for (const issue of [...snapshot.issues, ...this.#relationsFor(root).issues]) {
      unique.set(`${issue.code}\0${issue.instanceId ?? ''}\0${issue.message}`, issue);
    }
    return [...unique.values()];
  }

  #page(root: string, list: SceneTreeList, offset: number): SceneTreeNode[] {
    const snapshot = this.#controller.get(root).snapshot;
    if (snapshot === null) return [];
    const relations = this.#relationsFor(root);
    const instanceById = new Map<string, SceneInstance[]>();
    const groupById = new Map<string, SceneGroup[]>();
    for (const instance of snapshot.instances) instanceById.set(instance.instanceId, [...(instanceById.get(instance.instanceId) ?? []), instance]);
    for (const group of snapshot.groups) groupById.set(group.groupId, [...(groupById.get(group.groupId) ?? []), group]);
    const uniqueInstance = (id: string): SceneInstance | undefined => {
      const matches = instanceById.get(id) ?? [];
      return matches.length === 1 ? matches[0] : undefined;
    };
    const uniqueGroup = (id: string): SceneGroup | undefined => {
      const matches = groupById.get(id) ?? [];
      return matches.length === 1 ? matches[0] : undefined;
    };
    let values: Array<SceneInstance | SceneGroup | SceneIssue>;
    if (list.kind === 'category' && list.category === 'instances') {
      values = snapshot.instances.filter((instance) => (
        instance.ownerId === null
        || instance.ownerId === instance.instanceId
        || (!instanceById.has(instance.ownerId) && !groupById.has(instance.ownerId))
      ));
    } else if (list.kind === 'category' && list.category === 'groups') {
      const nested = new Set(snapshot.groups.flatMap((group) => group.nestedGroupIds));
      values = snapshot.groups.filter((group) => !nested.has(group.groupId));
    } else if (list.kind === 'category') {
      values = this.#issuesFor(root);
    } else if (list.kind === 'owner') {
      values = (relations.childrenByParent.get(list.ownerId) ?? []).flatMap((id) => {
        const instance = uniqueInstance(id);
        return instance === undefined ? [] : [instance];
      });
    } else {
      const groupMatches = groupById.get(list.groupId) ?? [];
      if (groupMatches.length > 1) {
        values = [{ code: 'DUPLICATE_GROUP', message: `编组 ID ${list.groupId} 重复，当前节点保持 AMBIGUOUS。`, instanceId: list.groupId }];
        const page = pageSceneValues(values, offset, PAGE_SIZE);
        return page.values.map((value) => ({ kind: 'issue', root, issue: value as SceneIssue }));
      }
      const group = groupMatches[0];
      if (group === undefined) return [];
      const memberKeys = [
        ...group.nestedGroupIds.map((id) => `group\0${id}`),
        ...group.memberIds.map((id) => `instance\0${id}`),
        ...(relations.childrenByParent.get(group.groupId) ?? []).map((id) => `instance\0${id}`),
      ];
      values = [...new Set(memberKeys)].flatMap((key) => {
        const separator = key.indexOf('\0');
        const kind = key.slice(0, separator);
        const id = key.slice(separator + 1);
        const value = kind === 'group' ? uniqueGroup(id) : uniqueInstance(id);
        return value === undefined ? [] : [value];
      });
    }
    const page = pageSceneValues(values, offset, PAGE_SIZE);
    const nodes = page.values.map((value): SceneTreeNode => {
      if ('instanceId' in value && 'ownerId' in value) return { kind: 'instance', root, instance: value };
      if ('groupId' in value) return { kind: 'group', root, group: value };
      return { kind: 'issue', root, issue: value };
    });
    if (page.nextOffset !== null) nodes.push({ kind: 'load-more', root, list, offset: page.nextOffset, total: page.total });
    return nodes;
  }
}

export function registerSceneViews(context: vscode.ExtensionContext, controller: SceneController): void {
  context.subscriptions.push(vscode.window.registerTreeDataProvider('yuanmengAi.scene', new SceneTreeProvider(controller)));
}
