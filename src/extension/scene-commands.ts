import { basename, join, relative } from 'node:path';

import * as vscode from 'vscode';

import { ProductError } from '../core/errors.js';
import { nodeFileIO } from '../core/fs.js';
import { createRuntimeOnlyProbeContext } from '../core/scene/probe-evidence.js';
import { buildLuaSourceIndex, whereUsed, type LuaSourceLocation } from '../core/lua/source-index.js';
import { applySceneCachePrune, previewSceneCachePrune } from '../core/scene/cache.js';
import { renderSceneExport, type SceneExportFormat } from '../core/scene/export.js';
import { createSceneIndex, summarizeSceneSignalGroups } from '../core/scene/index.js';
import {
  CUSTOM_PROPERTY_TYPES,
  generateCustomPropertyLookupProbe,
  generateFloorAlignmentLua,
  generateSceneGroupStructureProbe,
  generateSceneMeasurementProbe,
  type CustomPropertyType,
} from '../core/scene/lua-probe.js';
import type { SceneSourceRole } from '../core/scene/container.js';
import { resolveSceneGroupMemberIds, type ScenePlacementRequest, type SceneAxis } from '../core/scene/placement-plan.js';
import {
  findStoredAlignmentPlanEvidence,
  type CapabilityEvidenceResolution,
  type SceneProbeContext,
} from '../core/scene/probe-evidence.js';
import type { SceneSnapshot } from '../core/scene/types.js';
import {
  buildSceneGroupIntelligence,
  resolveSceneInstanceIntelligence,
} from '../core/scene/semantic-catalog.js';
import type { SceneController } from './scene-controller.js';
import type { SceneTreeNode } from './scene-views.js';
import type { WorkspaceContextManager } from './workspaces.js';

function roleForFilename(filename: string): SceneSourceRole | null {
  if (filename === 'LayerData.dat') return 'manual-dat';
  if (filename === 'LayerData-Auto.dat') return 'auto-dat';
  if (filename === 'LayerData.pbin') return 'raw-pbin';
  return null;
}

function textFor(error: unknown): string {
  if (error instanceof ProductError) return `${error.message}${error.nextActions[0] === undefined ? '' : `\n下一步：${error.nextActions[0]}`}`;
  return error instanceof Error ? error.message : '未知错误';
}

function probeContext(projectInstanceId: string, snapshot: NonNullable<ReturnType<SceneController['get']>['snapshot']>): SceneProbeContext {
  return {
    projectInstanceId,
    bindingId: snapshot.bindingId,
    snapshotId: snapshot.snapshotId,
    sceneSourceSha256: snapshot.sourceSha256,
  };
}

type SceneSelectionNode = Extract<SceneTreeNode, { kind: 'instance' | 'group' }>;

function selectionId(node: SceneSelectionNode): string {
  return node.kind === 'instance' ? node.instance.instanceId : node.group.groupId;
}

function ambiguous(message: string): never {
  throw new ProductError('SCENE_EVIDENCE_INSUFFICIENT', `${message}，层级路径为 AMBIGUOUS。`, ['刷新场景并消除重复或多父关系后重试。'], 'STATIC_LOCAL');
}

/** 生成只基于当前快照的稳定层级路径；重复 ID、多父或循环一律拒绝猜测。 */
export function sceneHierarchyPath(snapshot: SceneSnapshot, node: SceneSelectionNode): string {
  const instances = new Map<string, typeof snapshot.instances>();
  const groups = new Map<string, typeof snapshot.groups>();
  for (const instance of snapshot.instances) instances.set(instance.instanceId, [...(instances.get(instance.instanceId) ?? []), instance]);
  for (const group of snapshot.groups) groups.set(group.groupId, [...(groups.get(group.groupId) ?? []), group]);
  const groupParents = new Map<string, string[]>();
  const membershipParents = new Map<string, string[]>();
  for (const group of snapshot.groups) for (const childId of group.nestedGroupIds) {
    groupParents.set(childId, [...(groupParents.get(childId) ?? []), group.groupId]);
  }
  for (const group of snapshot.groups) for (const memberId of group.memberIds) {
    membershipParents.set(memberId, [...(membershipParents.get(memberId) ?? []), group.groupId]);
  }

  const tokens: string[] = [];
  const visited = new Set<string>();
  let current: { kind: 'instance' | 'group'; id: string } = node.kind === 'instance'
    ? { kind: 'instance', id: node.instance.instanceId }
    : { kind: 'group', id: node.group.groupId };
  while (true) {
    const identity = `${current.kind}\0${current.id}`;
    if (visited.has(identity)) ambiguous(`关系链在 ${current.id} 形成循环`);
    visited.add(identity);
    tokens.unshift(`${current.kind}:${current.id}`);
    if (current.kind === 'instance') {
      const instanceMatches = instances.get(current.id) ?? [];
      if (instanceMatches.length !== 1) ambiguous(`实例 ID ${current.id} 重复或缺失`);
      const ownerId = instanceMatches[0]!.ownerId;
      const memberships = [...new Set(membershipParents.get(current.id) ?? [])];
      const parentIds = new Set(memberships);
      if (ownerId !== null && ownerId !== current.id) parentIds.add(ownerId);
      if (parentIds.size === 0) break;
      if (parentIds.size !== 1) ambiguous(`实例 ${current.id} 同时存在多个 Owner/编组父级`);
      const parentId = [...parentIds][0]!;
      const ownerGroups = groups.get(parentId) ?? [];
      const ownerInstances = instances.get(parentId) ?? [];
      if (ownerGroups.length + ownerInstances.length !== 1) ambiguous(`Owner ${parentId} 重复或缺失`);
      current = ownerGroups.length === 1 ? { kind: 'group', id: parentId } : { kind: 'instance', id: parentId };
      continue;
    }
    const groupMatches = groups.get(current.id) ?? [];
    if (groupMatches.length !== 1) ambiguous(`编组 ID ${current.id} 重复或缺失`);
    const parents = [...new Set(groupParents.get(current.id) ?? [])];
    if (parents.length === 0) break;
    if (parents.length !== 1) ambiguous(`编组 ${current.id} 存在多个父编组`);
    current = { kind: 'group', id: parents[0]! };
  }
  return tokens.join('/');
}

function luaIdLiteral(value: string): string {
  return /^(?:0|[1-9]\d*)$/u.test(value) ? value : JSON.stringify(value);
}

export function sceneLuaConstant(node: SceneSelectionNode): string {
  return node.kind === 'instance'
    ? `local SCENE_INSTANCE_ID = ${luaIdLiteral(node.instance.instanceId)}`
    : `local SCENE_GROUP_ID = ${luaIdLiteral(node.group.groupId)}`;
}

export function sceneJsonSnippet(
  node: SceneSelectionNode,
  runtime: CapabilityEvidenceResolution | null = null,
): string {
  return JSON.stringify(node.kind === 'instance'
    ? {
      kind: 'scene-instance',
      ...node.instance,
      intelligence: resolveSceneInstanceIntelligence(
        node.instance,
        runtime?.state === 'unique' ? runtime.evidence : null,
      ),
    }
    : {
      kind: 'scene-group',
      ...node.group,
      intelligence: buildSceneGroupIntelligence({
        directMemberCount: node.group.memberIds.length,
        nestedGroupCount: node.group.nestedGroupIds.length,
        recursiveMemberCount: null,
      }),
    }, null, 2);
}

function requireSelection(node: unknown): SceneSelectionNode {
  const value = node as SceneTreeNode | undefined;
  if (value?.kind !== 'instance' && value?.kind !== 'group') {
    throw new ProductError('VALIDATION_FAILED', '请选择一个场景元件或编组。', ['在场景树右键目标。'], 'STATIC_LOCAL');
  }
  return value;
}

function runtimeForUniqueSelection(
  controller: SceneController,
  node: SceneSelectionNode,
): CapabilityEvidenceResolution | null {
  if (node.kind !== 'instance') return null;
  const snapshot = controller.get(node.root).snapshot;
  if (snapshot === null || snapshot.instances.filter((instance) => instance.instanceId === node.instance.instanceId).length !== 1) return null;
  return controller.runtimeCapability(node.root, node.instance.instanceId);
}

async function workspaceLuaReferences(
  manager: WorkspaceContextManager,
  root: string,
  value: string,
): Promise<{ locations: LuaSourceLocation[]; skippedFiles: number }> {
  const uris = await vscode.workspace.findFiles(
    new vscode.RelativePattern(root, '**/*.lua'),
    '**/{.git,node_modules,.yuanmeng-inspector}/**',
    10_000,
  );
  const records = await manager.listRegistry(root);
  const locations = new Map<string, LuaSourceLocation>();
  let skippedFiles = 0;
  for (const uri of uris) {
    const path = relative(root, uri.fsPath).replace(/\\/gu, '/');
    try {
      const source = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
      const index = buildLuaSourceIndex([{ path, source }], { schemaVersion: 1, records }, { calls: [], configuredIdFields: [] });
      const classified = whereUsed(index, value);
      const candidates = classified.length > 0
        ? classified
        : [...index.numericLiterals, ...index.stringLiterals].filter((reference) => reference.value === value);
      for (const location of candidates) {
        locations.set(`${location.path}\0${location.line}\0${location.column}\0${location.endLine}\0${location.endColumn}`, location);
      }
    } catch {
      skippedFiles += 1;
    }
  }
  return {
    locations: [...locations.values()].sort((left, right) => left.path.localeCompare(right.path, 'en') || left.line - right.line || left.column - right.column),
    skippedFiles,
  };
}

async function promptTargetIds(defaultId: string, minimum: number): Promise<string[] | undefined> {
  const input = await vscode.window.showInputBox({
    prompt: minimum > 1 ? `输入至少 ${minimum} 个目标实例/编组 ID，用逗号分隔` : '输入目标实例/编组 ID，用逗号分隔',
    value: defaultId,
    validateInput: (raw) => {
      const ids = raw.split(/[,，\s]+/u).filter(Boolean);
      if (ids.length < minimum) return `至少需要 ${minimum} 个目标 ID`;
      return ids.every((id) => /^[1-9]\d*$/u.test(id)) ? null : '所有 ID 必须是十进制正整数';
    },
  });
  return input === undefined ? undefined : [...new Set(input.split(/[,，\s]+/u).filter(Boolean))];
}

async function promptAxis(placeHolder: string, excluded?: SceneAxis): Promise<SceneAxis | undefined> {
  const values = (['x', 'y', 'z'] as const).filter((axis) => axis !== excluded);
  const picked = await vscode.window.showQuickPick(values.map((value) => ({ label: value.toUpperCase(), value })), { placeHolder });
  return picked?.value;
}

async function promptNumber(prompt: string, value = '1'): Promise<number | undefined> {
  const input = await vscode.window.showInputBox({
    prompt,
    value,
    validateInput: (raw) => raw.trim() !== '' && Number.isFinite(Number(raw)) ? null : '必须是有限数值',
  });
  return input === undefined ? undefined : Number(input);
}

async function guidedPlacementRequest(defaultId: string): Promise<ScenePlacementRequest | undefined> {
  const operation = await vscode.window.showQuickPick([
    { label: '贴地对齐', description: '目标最低点对齐承载面最高点', operation: 'floor-align' as const },
    { label: '坐标轴对齐', description: '按位置或边界对齐参考目标', operation: 'axis-align' as const },
    { label: '等间距', description: '至少三个目标', operation: 'equal-spacing' as const },
    { label: '网格排列', description: '按行列轴与间距排列', operation: 'grid' as const },
    { label: '行排列', description: '沿指定轴等距排列', operation: 'rows' as const },
    { label: '列排列', description: '沿指定轴等距排列', operation: 'columns' as const },
    { label: '批量偏移', description: '位置、旋转或缩放偏移', operation: 'batch-offset' as const },
  ], { placeHolder: '选择通用空间计划；所有结果仅预览，execute=false' });
  if (operation === undefined) return undefined;
  const targetIds = await promptTargetIds(defaultId, operation.operation === 'equal-spacing' ? 3 : 1);
  if (targetIds === undefined) return undefined;
  if (operation.operation === 'floor-align') {
    const supportId = await vscode.window.showInputBox({ prompt: '输入承载面/地板实例 ID', validateInput: (value) => /^[1-9]\d*$/u.test(value) ? null : '必须是十进制正整数' });
    return supportId === undefined ? undefined : { kind: operation.operation, targetIds, supportId };
  }
  if (operation.operation === 'axis-align') {
    const referenceId = await vscode.window.showInputBox({ prompt: '输入参考实例/编组 ID', validateInput: (value) => /^[1-9]\d*$/u.test(value) ? null : '必须是十进制正整数' });
    if (referenceId === undefined) return undefined;
    const selectedAxis = await promptAxis('选择对齐坐标轴');
    if (selectedAxis === undefined) return undefined;
    const anchor = await vscode.window.showQuickPick((['position', 'min', 'center', 'max'] as const).map((value) => ({ label: value, value })), { placeHolder: '选择位置/边界锚点' });
    return anchor === undefined ? undefined : { kind: operation.operation, targetIds, referenceId, axis: selectedAxis, anchor: anchor.value };
  }
  if (operation.operation === 'equal-spacing') {
    const selectedAxis = await promptAxis('选择等间距坐标轴');
    if (selectedAxis === undefined) return undefined;
    const mode = await vscode.window.showQuickPick((['position', 'bounds-gap'] as const).map((value) => ({ label: value, value })), { placeHolder: '按中心位置或边界空隙计算' });
    return mode === undefined ? undefined : { kind: operation.operation, targetIds, axis: selectedAxis, mode: mode.value };
  }
  if (operation.operation === 'grid') {
    const rowAxis = await promptAxis('选择行轴');
    if (rowAxis === undefined) return undefined;
    const columnAxis = await promptAxis('选择列轴', rowAxis);
    if (columnAxis === undefined) return undefined;
    const columns = await promptNumber('输入每行列数（正整数）', '4');
    const rowSpacing = columns === undefined ? undefined : await promptNumber('输入行间距', '2');
    const columnSpacing = rowSpacing === undefined ? undefined : await promptNumber('输入列间距', '2');
    if (columns === undefined || !Number.isInteger(columns) || columns < 1 || rowSpacing === undefined || columnSpacing === undefined) {
      if (columns !== undefined) void vscode.window.showWarningMessage('网格列数必须是正整数。');
      return undefined;
    }
    return { kind: operation.operation, targetIds, rowAxis, columnAxis, columns, rowSpacing, columnSpacing };
  }
  if (operation.operation === 'rows' || operation.operation === 'columns') {
    const selectedAxis = await promptAxis('选择排列坐标轴');
    const spacing = selectedAxis === undefined ? undefined : await promptNumber('输入间距', '2');
    return selectedAxis === undefined || spacing === undefined ? undefined : { kind: operation.operation, targetIds, axis: selectedAxis, spacing };
  }
  const component = await vscode.window.showQuickPick((['position', 'rotation', 'scale'] as const).map((value) => ({ label: value, value })), { placeHolder: '选择偏移分量' });
  if (component === undefined) return undefined;
  const selectedAxis = await promptAxis('选择偏移坐标轴');
  const delta = selectedAxis === undefined ? undefined : await promptNumber('输入偏移量', '1');
  if (selectedAxis === undefined || delta === undefined) return undefined;
  return { kind: operation.operation, targetIds, components: { [component.value]: { [selectedAxis]: delta } } };
}

export function registerSceneCommands(
  context: vscode.ExtensionContext,
  manager: WorkspaceContextManager,
  controller: SceneController,
): void {
  const register = (command: string, callback: (...args: unknown[]) => unknown): void => {
    context.subscriptions.push(vscode.commands.registerCommand(command, async (...args) => {
      try {
        return await callback(...args);
      } catch (error) {
        void vscode.window.showErrorMessage(textFor(error));
        throw error;
      }
    }));
  };
  register('yuanmengAi.bindSceneSource', async (root, suppliedSourcePath) => {
    const managed = await manager.choose(typeof root === 'string' ? root : undefined);
    const source = typeof suppliedSourcePath === 'string'
      ? vscode.Uri.file(suppliedSourcePath)
      : (await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        title: '选择已存在的 LayerData.dat、LayerData-Auto.dat 或 LayerData.pbin（可选）',
        filters: { '元梦场景数据': ['dat', 'pbin'] },
      }))?.[0];
    if (source === undefined) return undefined;
    const role = roleForFilename(basename(source.fsPath));
    if (role === null) throw new ProductError('VALIDATION_FAILED', '文件名不在场景源白名单中。', ['选择精确的 LayerData 文件。'], 'STATIC_LOCAL');
    const snapshot = await controller.bind(managed.project.root, role, source.fsPath);
    void vscode.window.showInformationMessage(`场景源已绑定并读取：${snapshot.instances.length} 个元件，${snapshot.groups.length} 个编组。`);
    return snapshot;
  });
  register('yuanmengAi.refreshScene', async (root) => {
    const managed = await manager.choose(typeof root === 'string' ? root : undefined);
    const snapshot = await controller.refresh(managed.project.root);
    void vscode.window.showInformationMessage(`场景已刷新：${snapshot.instances.length} 个元件，${snapshot.groups.length} 个编组。`);
    return snapshot;
  });
  register('yuanmengAi.findScene', async (root, suppliedQuery) => {
    const managed = await manager.choose(typeof root === 'string' ? root : undefined);
    const query = typeof suppliedQuery === 'string' ? suppliedQuery : await vscode.window.showInputBox({ prompt: '输入实例 ID、type:类型ID、owner:OwnerID 或 signal:信号名' });
    if (query === undefined || query.trim() === '') return undefined;
    const normalized = query.trim();
    const signalName = normalized.startsWith('signal:') ? normalized.slice(7) : null;
    const result = normalized.startsWith('type:')
      ? controller.find(managed.project.root, { elementTypeId: normalized.slice(5) })
      : normalized.startsWith('owner:')
        ? controller.find(managed.project.root, { ownerId: normalized.slice(6) })
        : normalized.startsWith('signal:')
          ? controller.find(managed.project.root, { signalName: normalized.slice(7) })
        : controller.find(managed.project.root, { instanceId: normalized });
    const snapshot = controller.get(managed.project.root).snapshot;
    const signalGroupSummary = signalName === null || snapshot === null
      ? null
      : summarizeSceneSignalGroups(createSceneIndex(snapshot), signalName);
    if (result.kind === 'not-found') {
      void vscode.window.showWarningMessage('没有找到匹配的场景元件。');
      return result;
    }
    if (result.kind === 'ambiguous') {
      const counts = new Map<string, number>();
      for (const instance of result.matches) counts.set(instance.instanceId, (counts.get(instance.instanceId) ?? 0) + 1);
      await vscode.window.showQuickPick([
        ...(signalGroupSummary?.candidateGroups.map((group) => ({
          label: `候选编组 ${group.groupId}`,
          description: `${group.matchedMemberIds.length}/${group.recursiveMemberCount} 个递归成员匹配 · 仅结构候选`,
        })) ?? []),
        ...result.matches.map((instance) => {
          const runtime = counts.get(instance.instanceId) === 1
            ? controller.runtimeCapability(managed.project.root, instance.instanceId)
            : null;
          const intelligence = resolveSceneInstanceIntelligence(instance, runtime?.state === 'unique' ? runtime.evidence : null);
          return {
            label: `${intelligence.canonicalName ?? '实例'} ${instance.instanceId}`,
            description: `类型 ${instance.elementTypeId ?? '未知'} · ${intelligence.actorFamily} · owner ${instance.ownerId ?? '无'}`,
          };
        }),
      ], { placeHolder: '存在多个候选；编组项只是结构聚合，不等于已确认的玩家自制物品。' });
    } else {
      const instance = result.matches[0]!;
      const runtime = controller.runtimeCapability(managed.project.root, instance.instanceId);
      const intelligence = resolveSceneInstanceIntelligence(instance, runtime?.state === 'unique' ? runtime.evidence : null);
      void vscode.window.showInformationMessage(`${intelligence.canonicalName ?? '实例'} ${instance.instanceId} · 类型 ${instance.elementTypeId ?? '未知'} · ${intelligence.actorFamily} · owner ${instance.ownerId ?? '无'}`);
    }
    return signalGroupSummary === null ? result : { ...result, signalGroupSummary };
  });
  register('yuanmengAi.copySceneId', async (node) => {
    const value = node as SceneTreeNode | undefined;
    if (value?.kind !== 'instance') throw new ProductError('VALIDATION_FAILED', '请选择一个场景元件。', ['在场景树右键元件。'], 'STATIC_LOCAL');
    await vscode.env.clipboard.writeText(value.instance.instanceId);
    return value.instance.instanceId;
  });
  register('yuanmengAi.copySceneTypeId', async (node) => {
    const value = node as SceneTreeNode | undefined;
    if (value?.kind !== 'instance' || value.instance.elementTypeId === null) throw new ProductError('VALIDATION_FAILED', '所选元件没有已读取的类型 ID。', ['选择其他元件或重新校准。'], 'STATIC_LOCAL');
    await vscode.env.clipboard.writeText(value.instance.elementTypeId);
    return value.instance.elementTypeId;
  });
  register('yuanmengAi.copySceneHierarchyPath', async (node) => {
    const value = requireSelection(node);
    const snapshot = controller.get(value.root).snapshot;
    if (snapshot === null) throw new ProductError('NOT_FOUND', '当前工程没有场景快照。', ['先绑定并刷新场景源。'], 'STATIC_LOCAL');
    const path = sceneHierarchyPath(snapshot, value);
    await vscode.env.clipboard.writeText(path);
    return path;
  });
  register('yuanmengAi.copySceneLuaConstant', async (node) => {
    const value = requireSelection(node);
    const source = sceneLuaConstant(value);
    await vscode.env.clipboard.writeText(source);
    return source;
  });
  register('yuanmengAi.copySceneJsonSnippet', async (node) => {
    const value = requireSelection(node);
    const source = sceneJsonSnippet(
      value,
      runtimeForUniqueSelection(controller, value),
    );
    await vscode.env.clipboard.writeText(source);
    return source;
  });
  register('yuanmengAi.findSceneLuaReferences', async (node) => {
    const value = requireSelection(node);
    manager.get(value.root); // 拒绝已经从工作区移除的旧树节点。
    const result = await workspaceLuaReferences(manager, value.root, selectionId(value));
    if (result.locations.length === 0) {
      void vscode.window.showWarningMessage(`Lua 工程中没有找到该 ID 的可验证引用。${result.skippedFiles === 0 ? '' : ` ${result.skippedFiles} 个语法无效文件已隔离。`}`);
      return result;
    }
    const picked = await vscode.window.showQuickPick(result.locations.map((location) => ({
      label: `${location.path}:${location.line}`,
      description: location.context.trim(),
      location,
    })), {
      placeHolder: `找到 ${result.locations.length} 处引用；选择一处跳转${result.skippedFiles === 0 ? '' : `（${result.skippedFiles} 个文件已隔离）`}`,
    });
    if (picked !== undefined) {
      const uri = vscode.Uri.file(join(value.root, ...picked.location.path.split('/')));
      const document = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(document, { preview: true });
      const range = new vscode.Range(
        Math.max(0, picked.location.line - 1), Math.max(0, picked.location.column - 1),
        Math.max(0, picked.location.endLine - 1), Math.max(0, picked.location.endColumn - 1),
      );
      editor.selection = new vscode.Selection(range.start, range.end);
      editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    }
    return result;
  });
  register('yuanmengAi.planSceneSelection', async (node) => {
    const value = requireSelection(node);
    manager.get(value.root); // 拒绝已经从工作区移除的旧树节点。
    const request = await guidedPlacementRequest(selectionId(value));
    if (request === undefined) return undefined;
    return vscode.commands.executeCommand('yuanmengAi.previewScenePlan', value.root, request);
  });
  register('yuanmengAi.generateSceneProbe', async (node) => {
    const value = node as SceneTreeNode | undefined;
    const managed = value === undefined
      ? await manager.choose()
      : manager.get(value.kind === 'project' ? value.state.root : value.root);
    const snapshot = controller.get(managed.project.root).snapshot;
    let source: string;
    if (snapshot !== null && value !== undefined && (value.kind === 'instance' || value.kind === 'group')) {
      const currentContext = probeContext(managed.project.projectInstanceId, snapshot);
      source = value.kind === 'instance'
        ? generateSceneMeasurementProbe([value.instance.instanceId], currentContext)
        : generateSceneGroupStructureProbe(
          value.group.groupId,
          value.group.memberIds,
          value.group.nestedGroupIds,
          currentContext,
        );
    } else {
      if (value?.kind === 'group') throw new ProductError('NOT_FOUND', '没有完整场景快照时不能推导编组成员。', ['先显式登记单个场景实例 ID，或提供 LayerData 场景源。'], 'STATIC_LOCAL');
      const candidates = (await manager.listRegistry(managed.project.root)).filter((record) => record.kind === 'scene-instance');
      if (candidates.length === 0) throw new ProductError('NOT_FOUND', '当前工程没有已登记的场景实例 ID。', ['在官方编辑器复制选中元件 ID，再运行“从剪贴板显式导入当前场景实例 ID”。'], 'STATIC_LOCAL');
      let selected = value?.kind === 'instance'
        ? candidates.find((record) => record.value === value.instance.instanceId)
        : candidates.length === 1 ? candidates[0] : undefined;
      if (selected === undefined && value?.kind !== 'instance' && candidates.length > 1) {
        selected = (await vscode.window.showQuickPick(
          candidates.map((record) => ({ label: `${record.name} · ${record.value}`, record })),
          { placeHolder: '选择已显式登记的场景实例（runtime-only）' },
        ))?.record;
      }
      if (selected === undefined) return undefined;
      const currentContext = createRuntimeOnlyProbeContext(
        managed.project.projectInstanceId,
        selected.recordId,
        selected.source.sha256,
      );
      source = generateSceneMeasurementProbe([selected.value], currentContext);
      void vscode.window.showInformationMessage('已生成 runtime-only 单实例探针；它只绑定用户显式登记的 ID，不代表完整场景快照。');
    }
    const document = await vscode.workspace.openTextDocument({ content: source, language: 'lua' });
    await vscode.window.showTextDocument(document, { preview: true });
    return source;
  });
  register('yuanmengAi.inspectSceneFields', async (node) => {
    const value = node as SceneTreeNode | undefined;
    if (value?.kind !== 'instance' && value?.kind !== 'group') throw new ProductError('VALIDATION_FAILED', '请选择一个场景元件或编组。', ['在场景树右键目标。'], 'STATIC_LOCAL');
    const content = `${sceneJsonSnippet(
      value,
      runtimeForUniqueSelection(controller, value),
    )}\n`;
    const document = await vscode.workspace.openTextDocument({ content, language: 'json' });
    await vscode.window.showTextDocument(document, { preview: true });
    return content;
  });
  register('yuanmengAi.locateSceneByProperty', async (root) => {
    const managed = await manager.choose(typeof root === 'string' ? root : undefined);
    const snapshot = controller.get(managed.project.root).snapshot;
    if (snapshot === null) throw new ProductError('NOT_FOUND', '当前工程没有场景快照。', ['先绑定并刷新场景源。'], 'STATIC_LOCAL');
    const propertyName = await vscode.window.showInputBox({ prompt: '输入已经在元件上创建的自定义属性名称' });
    if (propertyName === undefined || propertyName.trim() === '') return undefined;
    const normalizedPropertyName = propertyName.trim();
    const staticMatches = snapshot.instances.flatMap((instance) => (
      instance.customProperties.state !== 'observed'
        ? []
        : instance.customProperties.value
          .filter((property) => property.key === normalizedPropertyName)
          .map((property) => ({ instanceId: instance.instanceId, value: property.value }))
    ));
    const runtimeCandidateIds = snapshot.instances
      .filter((instance) => instance.customProperties.state !== 'observed')
      .map((instance) => instance.instanceId);
    if (staticMatches.length > 0) {
      const document = await vscode.workspace.openTextDocument({
        content: `${JSON.stringify({ propertyName: normalizedPropertyName, staticMatches }, null, 2)}\n`,
        language: 'json',
      });
      await vscode.window.showTextDocument(document, { preview: true });
      if (runtimeCandidateIds.length === 0) {
        void vscode.window.showInformationMessage(`静态场景快照已定位 ${staticMatches.length} 个属性匹配，无需生成运行时探针。`);
        return { staticMatches, probeLua: null };
      }
    }
    const propertyType = await vscode.window.showQuickPick([...CUSTOM_PROPERTY_TYPES], { placeHolder: '选择该自定义属性的官方类型' });
    if (propertyType === undefined) return undefined;
    const source = generateCustomPropertyLookupProbe(
      runtimeCandidateIds,
      normalizedPropertyName,
      propertyType as CustomPropertyType,
      probeContext(managed.project.projectInstanceId, snapshot),
    );
    const document = await vscode.workspace.openTextDocument({ content: source, language: 'lua' });
    await vscode.window.showTextDocument(document, { preview: true });
    void vscode.window.showInformationMessage(staticMatches.length === 0
      ? '静态快照未确认该属性；已生成只读属性定位探针。试玩后搜索 YMAI_PROPERTY_MATCH。'
      : `静态快照已定位 ${staticMatches.length} 个匹配；仅为其余 ${runtimeCandidateIds.length} 个候选生成探针。`);
    return { staticMatches, probeLua: source };
  });
  register('yuanmengAi.generateFloorAlignment', async (node) => {
    const value = node as SceneTreeNode | undefined;
    if (value?.kind !== 'group') throw new ProductError('VALIDATION_FAILED', '请在场景树右键一个编组。', ['先刷新场景并展开“编组”。'], 'STATIC_LOCAL');
    const supportId = await vscode.window.showInputBox({ prompt: '输入承载面/地板实例 ID', validateInput: (input) => /^\d+$/u.test(input) ? null : '必须是十进制实例 ID' });
    if (supportId === undefined) return undefined;
    const managed = manager.get(value.root);
    const snapshot = controller.get(value.root).snapshot;
    if (snapshot === null) throw new ProductError('NOT_FOUND', '当前工程没有场景快照。', ['先绑定并刷新场景源。'], 'STATIC_LOCAL');
    const allMemberIds = resolveSceneGroupMemberIds(snapshot, value.group.groupId);
    const currentContext = probeContext(managed.project.projectInstanceId, snapshot);
    const evidence = await findStoredAlignmentPlanEvidence(
      managed.project.root,
      currentContext,
      supportId,
      allMemberIds,
      nodeFileIO,
    );
    let execute = false;
    if (evidence === null) {
      void vscode.window.showWarningMessage('当前精确快照没有已导入的无冲突贴地计划证据；只生成测量预览。');
    } else {
      const mode = await vscode.window.showQuickPick([
        { label: '只生成测量预览（推荐）', execute: false },
        { label: '使用已导入证据生成执行代码', execute: true },
      ], { placeHolder: '执行版仍会在运行时重新测量，漂移超容差会中止。' });
      if (mode === undefined) return undefined;
      execute = mode.execute;
    }
    const source = execute && evidence !== null
      ? generateFloorAlignmentLua(supportId, allMemberIds, { execute: true, context: currentContext, evidence })
      : generateFloorAlignmentLua(supportId, allMemberIds, { execute: false, context: currentContext });
    const document = await vscode.workspace.openTextDocument({ content: source, language: 'lua' });
    await vscode.window.showTextDocument(document, { preview: true });
    return source;
  });
  register('yuanmengAi.exportScene', async (root, suppliedFormat) => {
    const managed = await manager.choose(typeof root === 'string' ? root : undefined);
    const snapshot = controller.get(managed.project.root).snapshot;
    if (snapshot === null) throw new ProductError('NOT_FOUND', '当前工程没有场景快照。', ['先绑定并刷新场景源。'], 'STATIC_LOCAL');
    const selectedFormat = (suppliedFormat === 'json' || suppliedFormat === 'csv' || suppliedFormat === 'md')
      ? suppliedFormat
      : await vscode.window.showQuickPick(['json', 'csv', 'md'] as const, { placeHolder: '选择场景清单格式' });
    if (selectedFormat === undefined) return undefined;
    const format = selectedFormat as SceneExportFormat;
    const target = await vscode.window.showSaveDialog({
      title: '导出私有场景清单',
      defaultUri: vscode.Uri.file(`${managed.project.root}/scene-inventory.${format}`),
    });
    if (target === undefined) return undefined;
    await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(renderSceneExport(snapshot, format)));
    void vscode.window.showInformationMessage('场景清单已导出；请勿把含真实地图 ID 的清单提交到公开仓库。');
    return target.fsPath;
  });
  register('yuanmengAi.cleanSceneCache', async (root) => {
    const managed = await manager.choose(typeof root === 'string' ? root : undefined);
    const configuration = vscode.workspace.getConfiguration('yuanmengAi', vscode.Uri.file(managed.project.root));
    const options = {
      maxCount: configuration.get<number>('sceneCacheMaxCount', 20),
      maxAgeMilliseconds: configuration.get<number>('sceneCacheMaxAgeDays', 30) * 24 * 60 * 60 * 1000,
    };
    const preview = await previewSceneCachePrune(managed.project.root, options);
    if (preview.candidates.length === 0) {
      void vscode.window.showInformationMessage('没有可清理的私有场景缓存。');
      return preview;
    }
    const document = await vscode.workspace.openTextDocument({
      content: `${JSON.stringify(preview, null, 2)}\n`,
      language: 'json',
    });
    await vscode.window.showTextDocument(document, { preview: true });
    const confirmed = await vscode.window.showWarningMessage(
      `将清理 ${preview.candidates.length} 个私有缓存文件（${preview.totalBytes} bytes）。`,
      { modal: true, detail: '已打开仅含相对路径、字节数、原因和状态哈希的清理预览。缓存状态变化时将拒绝执行。' },
      '确认清理',
    );
    if (confirmed !== '确认清理') return preview;
    const result = await applySceneCachePrune(managed.project.root, options, preview.stateHash);
    void vscode.window.showInformationMessage(`已清理 ${result.deletedCount} 个私有缓存文件。`);
    return result;
  });
}
