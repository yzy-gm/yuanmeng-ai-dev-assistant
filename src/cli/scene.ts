import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import type { CliArgs } from './args.js';
import { result, type CliRunResult } from './output.js';
import type { ResolvedCliProject } from './project.js';
import { ProductError } from '../core/errors.js';
import { nodeFileIO } from '../core/fs.js';
import { RegistryStore } from '../core/registry/store.js';
import type { RegistryRecord } from '../core/model.js';
import { diffSceneSnapshots } from '../core/scene/diff.js';
import {
  createSceneChangeJournalEntry,
  listSceneChangeJournal,
  loadSceneChangeJournalEntry,
  saveSceneChangeJournalEntry,
} from '../core/scene/change-journal.js';
import { auditSceneSnapshot, compactSceneAuditResult, inspectSceneInstanceFields } from '../core/scene/diagnostics.js';
import { buildSceneRelations } from '../core/scene/hierarchy.js';
import { createSceneIndex, queryScene, summarizeSceneSignalGroups } from '../core/scene/index.js';
import { generateCustomPropertyLookupProbe, generateFloorAlignmentLua, generateSceneMeasurementProbe } from '../core/scene/lua-probe.js';
import { findNearbySceneInstances } from '../core/scene/spatial.js';
import { querySceneGeometry } from '../core/scene/geometry.js';
import { createScenePlacementPlan } from '../core/scene/placement-plan.js';
import { buildSceneGroupIntelligence, buildSceneTypeInventory, resolveSceneInstanceIntelligence } from '../core/scene/semantic-catalog.js';
import { summarizeSceneCache } from '../core/scene/cache.js';
import { loadSceneHeads, loadSceneSnapshot, loadSceneSnapshotIfValid } from '../core/scene/store.js';
import type { SceneSnapshot } from '../core/scene/types.js';
import {
  loadStoredCapabilityEvidenceIndex,
  type CapabilityEvidenceResolution,
  type SceneProbeContext,
} from '../core/scene/probe-evidence.js';
import { refreshSceneFromBinding } from '../core/scene/workflow.js';
import {
  createSceneSourceBinding,
  loadSceneSourceBindings,
  saveSceneSourceBinding,
  type SceneSourceBinding,
} from '../integrations/scene/source.js';

// TypeScript's built-in Extract is used directly; this alias keeps signatures compact.
type ArgsFor<T extends CliArgs['command']> = Extract<CliArgs, { command: T }>;

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

function probeContext(project: ResolvedCliProject, snapshot: SceneSnapshot): SceneProbeContext {
  return {
    projectInstanceId: project.projectInstanceId,
    bindingId: snapshot.bindingId,
    snapshotId: snapshot.snapshotId,
    sceneSourceSha256: snapshot.sourceSha256,
  };
}

async function runtimeCapabilities(
  project: ResolvedCliProject,
  snapshot: SceneSnapshot,
): Promise<Map<string, CapabilityEvidenceResolution>> {
  return loadStoredCapabilityEvidenceIndex(project.root, probeContext(project, snapshot), nodeFileIO);
}

function intelligenceWithRuntime(
  instance: SceneSnapshot['instances'][number],
  runtime: ReadonlyMap<string, CapabilityEvidenceResolution>,
  allowRuntime = true,
) {
  const resolved = allowRuntime ? runtime.get(instance.instanceId) : undefined;
  return {
    intelligence: resolveSceneInstanceIntelligence(instance, resolved?.state === 'unique' ? resolved.evidence : null),
    runtimeCapabilityEvidence: resolved ?? null,
  };
}

async function matchingStatusMapFingerprint(project: ResolvedCliProject): Promise<string | null> {
  try {
    const value = JSON.parse(await readFile(join(project.root, '.yuanmeng-inspector', 'status.json'), 'utf8')) as unknown;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    const status = value as { schemaVersion?: unknown; project?: unknown };
    if (status.schemaVersion !== 1 || typeof status.project !== 'object' || status.project === null || Array.isArray(status.project)) return null;
    const identity = status.project as Record<string, unknown>;
    if (
      identity.projectInstanceId !== project.projectInstanceId
      || identity.projectRootHash !== project.projectRootHash
    ) return null;
    return identity.mapFingerprint === null
      || (typeof identity.mapFingerprint === 'string' && SHA256_PATTERN.test(identity.mapFingerprint))
      ? identity.mapFingerprint
      : null;
  } catch {
    return null;
  }
}

async function syncRegistry(project: ResolvedCliProject, snapshot: SceneSnapshot, authoritative: boolean): Promise<void> {
  const path = resolve(project.root, '.yuanmeng-inspector', 'registry', 'registry.json');
  let store: RegistryStore;
  try {
    store = await RegistryStore.open(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    store = new RegistryStore({ schemaVersion: 1, records: [] }, path);
  }
  store.syncSceneSnapshot(snapshot, {
    projectInstanceId: project.projectInstanceId,
    mapFingerprint: await matchingStatusMapFingerprint(project),
    authoritative,
  });
  await store.save();
}

export async function loadPreferredSceneSnapshot(project: ResolvedCliProject): Promise<SceneSnapshot | null> {
  const heads = await loadSceneHeads(project.root, nodeFileIO);
  if (heads.preferredSnapshotId === null) return null;
  return loadSceneSnapshot(project.root, heads.preferredSnapshotId, nodeFileIO);
}

function chooseBinding(bindings: readonly SceneSourceBinding[], role: ArgsFor<'refresh-scene'>['role']): SceneSourceBinding {
  const selected = role === null
    ? bindings.find((binding) => binding.role === 'manual-dat')
      ?? bindings.find((binding) => binding.role === 'raw-pbin')
      ?? bindings.find((binding) => binding.role === 'auto-dat')
    : bindings.find((binding) => binding.role === role);
  if (selected === undefined) throw new ProductError(
    'NOT_FOUND',
    '当前工程尚未绑定所选场景来源。',
    ['AI 先运行 scene-status --json；若已唯一确认当前地图 LayerData 的绝对路径，直接运行 bind-scene <角色> <路径> --json。只有路径无法唯一确认时才需要用户选择一次文件。'],
    'STATIC_LOCAL',
  );
  return selected;
}

async function refreshBinding(project: ResolvedCliProject, binding: SceneSourceBinding, timeoutSeconds: number): Promise<SceneSnapshot> {
  const resultValue = await refreshSceneFromBinding(project.root, binding, {
    io: nodeFileIO,
    preferred: binding.role !== 'auto-dat',
    totalTimeoutMilliseconds: timeoutSeconds * 1000,
  });
  await syncRegistry(project, resultValue.snapshot, resultValue.heads.preferredSnapshotId === resultValue.snapshot.snapshotId);
  return resultValue.snapshot;
}

export async function runSceneStatus(project: ResolvedCliProject): Promise<CliRunResult> {
  const [bindings, heads, snapshot, cache] = await Promise.all([
    loadSceneSourceBindings(project.root, nodeFileIO),
    loadSceneHeads(project.root, nodeFileIO),
    loadPreferredSceneSnapshot(project),
    summarizeSceneCache(project.root),
  ]);
  if (bindings.length === 0) return result(
    'OFFLINE',
    '当前工程尚未绑定场景源。AI 已知准确 LayerData 路径时可直接绑定；路径无法唯一确认时才需要用户选择一次。',
    {
      bindings: [],
      heads,
      snapshot: null,
      cache,
      nextActions: [
        '确认当前地图已保存到磁盘。',
        '若当前地图 LayerData 路径已唯一确认，运行 bind-scene <manual-dat|auto-dat|raw-pbin> <绝对路径> --json。',
        '运行 refresh-scene --json，再用一个已知实例 ID 执行 field-inspect 校验没有串图。',
      ],
    },
  );
  return result('OK', snapshot === null ? '场景源已绑定但尚无快照。' : `场景快照可用：${snapshot.instances.length} 个元件。`, {
    bindings: bindings.map((binding) => ({ role: binding.role, displayDirectory: binding.displayDirectory, bindingId: binding.bindingId })),
    heads,
    cache,
    snapshot: snapshot === null ? null : {
      snapshotId: snapshot.snapshotId,
      role: snapshot.role,
      adapterId: snapshot.adapterId,
      observedAt: snapshot.observedAt,
      instances: snapshot.instances.length,
      groups: snapshot.groups.length,
      issues: snapshot.issues.length,
      sceneMetadata: snapshot.sceneMetadata ?? null,
      signalRegistry: snapshot.signalRegistry === undefined ? null : {
        state: snapshot.signalRegistry.state,
        count: snapshot.signalRegistry.state === 'observed' ? snapshot.signalRegistry.value.length : 0,
      },
      unknownFieldCount: snapshot.unknownFields.length,
    },
  });
}

export async function runBindScene(project: ResolvedCliProject, args: ArgsFor<'bind-scene'>, cwd: string): Promise<CliRunResult> {
  const binding = await createSceneSourceBinding({
    io: nodeFileIO,
    projectInstanceId: project.projectInstanceId,
    projectRootHash: project.projectRootHash,
    role: args.role,
    sourcePath: resolve(cwd, args.sourcePath),
  });
  await saveSceneSourceBinding(project.root, binding, nodeFileIO);
  const snapshot = await refreshBinding(project, binding, 30);
  return result('OK', `场景源已绑定：${snapshot.instances.length} 个元件。`, {
    role: binding.role,
    displayDirectory: binding.displayDirectory,
    bindingId: binding.bindingId,
    snapshotId: snapshot.snapshotId,
  });
}

export async function runRefreshScene(project: ResolvedCliProject, args: ArgsFor<'refresh-scene'>): Promise<CliRunResult> {
  const binding = chooseBinding(await loadSceneSourceBindings(project.root, nodeFileIO), args.role);
  const beforeHeads = await loadSceneHeads(project.root, nodeFileIO);
  const beforeId = binding.role === 'manual-dat'
    ? beforeHeads.manualSnapshotId
    : binding.role === 'auto-dat'
      ? beforeHeads.autoSnapshotId
      : beforeHeads.rawSnapshotId;
  const before = beforeId === null ? null : await loadSceneSnapshotIfValid(project.root, beforeId, nodeFileIO);
  const snapshot = await refreshBinding(project, binding, args.timeoutSeconds);
  if (
    before !== null
    && before.snapshotId !== snapshot.snapshotId
    && before.bindingId === snapshot.bindingId
    && before.role === snapshot.role
    && before.adapterId === snapshot.adapterId
  ) {
    await saveSceneChangeJournalEntry(project.root, createSceneChangeJournalEntry(before, snapshot), nodeFileIO);
  }
  return result('OK', `场景已刷新：${snapshot.instances.length} 个元件，${snapshot.groups.length} 个编组。`, {
    snapshotId: snapshot.snapshotId, role: snapshot.role, observedAt: snapshot.observedAt,
    instances: snapshot.instances.length, groups: snapshot.groups.length, issues: snapshot.issues,
  });
}

async function requireSnapshot(project: ResolvedCliProject): Promise<SceneSnapshot> {
  const snapshot = await loadPreferredSceneSnapshot(project);
  if (snapshot === null) throw new ProductError('NOT_FOUND', '没有场景快照。', ['先运行 bind-scene 或 refresh-scene。'], 'STATIC_LOCAL');
  return snapshot;
}

export async function runFindScene(project: ResolvedCliProject, args: ArgsFor<'find-scene'>): Promise<CliRunResult> {
  const snapshot = await requireSnapshot(project);
  const query = args.query.startsWith('type:')
    ? { elementTypeId: args.query.slice(5) }
    : args.query.startsWith('owner:')
      ? { ownerId: args.query.slice(6) }
      : args.query.startsWith('signal:')
        ? { signalName: args.query.slice(7) }
      : { instanceId: args.query };
  const index = createSceneIndex(snapshot);
  const found = queryScene(index, query);
  const signalGroupSummary = 'signalName' in query ? summarizeSceneSignalGroups(index, query.signalName!) : null;
  if (found.kind === 'not-found') return result('NOT_FOUND', '未找到匹配的场景元件。', { reasonCode: 'SCENE_NOT_FOUND', matches: [] });
  const capabilities = await runtimeCapabilities(project, snapshot);
  const counts = new Map<string, number>();
  for (const instance of found.matches) counts.set(instance.instanceId, (counts.get(instance.instanceId) ?? 0) + 1);
  const resolved = found.matches.map((instance) => intelligenceWithRuntime(instance, capabilities, counts.get(instance.instanceId) === 1));
  const intelligence = resolved.map((entry) => entry.intelligence);
  const runtimeCapabilityEvidence = resolved.map((entry) => entry.runtimeCapabilityEvidence);
  if (found.kind === 'ambiguous') return result('AMBIGUOUS', '存在多个场景候选。', {
    reasonCode: 'SCENE_AMBIGUOUS', matches: found.matches, intelligence, runtimeCapabilityEvidence, signalGroupSummary,
  });
  return result('OK', `找到场景实例 ${found.matches[0]!.instanceId}。`, {
    reasonCode: 'SCENE_FOUND', matches: found.matches, intelligence, runtimeCapabilityEvidence, signalGroupSummary,
  });
}

export async function runSceneTree(project: ResolvedCliProject, args: ArgsFor<'scene-tree'>): Promise<CliRunResult> {
  const snapshot = await requireSnapshot(project);
  const found = queryScene(createSceneIndex(snapshot), { instanceId: args.instanceId });
  const groups = snapshot.groups.filter((candidate) => candidate.groupId === args.instanceId);
  if (found.kind === 'ambiguous' || groups.length > 1 || (found.kind === 'found' && groups.length === 1)) {
    return result('AMBIGUOUS', '该 ID 在场景层级中对应多条记录，不能任取一条。', {
      reasonCode: 'SCENE_AMBIGUOUS',
      instanceMatches: found.matches,
      groupMatches: groups,
    });
  }
  const instance = found.kind === 'found' ? found.matches[0]! : null;
  const group = groups[0] ?? null;
  if (instance === null && group === null) return result('NOT_FOUND', '场景层级中没有该 ID。', { reasonCode: 'SCENE_NOT_FOUND' });
  const relations = buildSceneRelations(snapshot);
  const capabilities = await runtimeCapabilities(project, snapshot);
  return result('OK', '场景层级关系已生成。', {
    id: args.instanceId,
    instance,
    instanceIntelligence: instance === null ? null : intelligenceWithRuntime(instance, capabilities).intelligence,
    runtimeCapabilityEvidence: instance === null ? null : intelligenceWithRuntime(instance, capabilities).runtimeCapabilityEvidence,
    group,
    groupIntelligence: group === null ? null : buildSceneGroupIntelligence({
      directMemberCount: group.memberIds.length,
      nestedGroupCount: group.nestedGroupIds.length,
      recursiveMemberCount: relations.descendantsOf(group.groupId).filter((id) => snapshot.instances.some((candidate) => candidate.instanceId === id)).length,
    }),
    parentId: relations.parentByChild.get(args.instanceId) ?? null,
    children: relations.childrenByParent.get(args.instanceId) ?? [],
    ancestors: relations.ancestorsOf(args.instanceId),
    descendants: relations.descendantsOf(args.instanceId),
    groupMembers: relations.groupMembers.get(args.instanceId) ?? [],
    issues: relations.issues.filter((issue) => issue.instanceId === args.instanceId),
  });
}

export async function runFieldInspect(project: ResolvedCliProject, args: ArgsFor<'field-inspect'>): Promise<CliRunResult> {
  const snapshot = await requireSnapshot(project);
  const found = queryScene(createSceneIndex(snapshot), { instanceId: args.instanceId });
  if (found.kind === 'not-found') return result('NOT_FOUND', '没有该场景实例。', { reasonCode: 'SCENE_NOT_FOUND' });
  if (found.kind === 'ambiguous') {
    return result('AMBIGUOUS', '该实例 ID 对应多条快照记录。', { reasonCode: 'SCENE_AMBIGUOUS', matches: found.matches });
  }
  const instance = found.matches[0]!;
  const capabilities = await runtimeCapabilities(project, snapshot);
  return result('OK', '场景字段证据已读取。', {
    reasonCode: 'SCENE_FIELD_INSPECTION',
    instance: {
      instanceId: instance.instanceId,
      elementTypeId: instance.elementTypeId,
      ownerId: instance.ownerId,
      variant: instance.variant,
      evidence: instance.evidence,
    },
    ...intelligenceWithRuntime(instance, capabilities),
    fields: inspectSceneInstanceFields(instance),
  });
}

export async function runGroupMembers(project: ResolvedCliProject, args: ArgsFor<'group-members'>): Promise<CliRunResult> {
  const snapshot = await requireSnapshot(project);
  const matchingGroups = snapshot.groups.filter((candidate) => candidate.groupId === args.groupId);
  if (matchingGroups.length === 0) return result('NOT_FOUND', '没有该场景编组。', { reasonCode: 'SCENE_GROUP_NOT_FOUND' });
  if (matchingGroups.length > 1) {
    return result('AMBIGUOUS', '该编组 ID 对应多条场景记录，不能任取一条。', {
      reasonCode: 'SCENE_AMBIGUOUS',
      matches: matchingGroups,
    });
  }
  const group = matchingGroups[0]!;
  const relations = buildSceneRelations(snapshot);
  const uniqueInstanceIds = new Set<string>();
  const instanceCounts = new Map<string, number>();
  for (const instance of snapshot.instances) instanceCounts.set(instance.instanceId, (instanceCounts.get(instance.instanceId) ?? 0) + 1);
  for (const [instanceId, count] of instanceCounts) if (count === 1) uniqueInstanceIds.add(instanceId);
  const groupIds = new Set(snapshot.groups.map((candidate) => candidate.groupId));
  const descendants = relations.descendantsOf(group.groupId);
  const descendantGroupIds = descendants.filter((id) => groupIds.has(id));
  const allMemberIds = [...new Set([
    ...group.memberIds,
    ...descendants.filter((id) => uniqueInstanceIds.has(id)),
  ])].sort((left, right) => left.localeCompare(right, 'en'));
  return result(
    'OK',
    `编组直接包含 ${group.memberIds.length} 个元件、${group.nestedGroupIds.length} 个子编组，递归共 ${allMemberIds.length} 个元件。`,
    {
      group,
      intelligence: buildSceneGroupIntelligence({
        directMemberCount: group.memberIds.length,
        nestedGroupCount: group.nestedGroupIds.length,
        recursiveMemberCount: allMemberIds.length,
      }),
      directMemberIds: [...group.memberIds],
      descendantGroupIds,
      allMemberIds,
    },
  );
}

async function recentSnapshots(project: ResolvedCliProject): Promise<SceneSnapshot[]> {
  const directory = resolve(project.root, '.yuanmeng-inspector', 'scene', 'snapshots');
  let names: string[];
  try {
    names = (await readdir(directory)).filter((name) => /^[a-f0-9]{64}\.json$/u.test(name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const snapshots = await Promise.all(names.map((name) => loadSceneSnapshotIfValid(project.root, name.slice(0, -5), nodeFileIO)));
  return snapshots
    .filter((snapshot): snapshot is SceneSnapshot => snapshot !== null)
    .sort((left, right) => left.observedAt.localeCompare(right.observedAt) || left.snapshotId.localeCompare(right.snapshotId));
}

export async function runSceneDiff(project: ResolvedCliProject, args: ArgsFor<'scene-diff'>): Promise<CliRunResult> {
  if ((args.from === null) !== (args.to === null)) throw new ProductError('USAGE_ERROR', '--from 与 --to 必须同时提供。', ['提供两个场景快照 ID。'], 'STATIC_LOCAL');
  let before: SceneSnapshot;
  let after: SceneSnapshot;
  if (args.from !== null && args.to !== null) {
    [before, after] = await Promise.all([
      loadSceneSnapshot(project.root, args.from, nodeFileIO),
      loadSceneSnapshot(project.root, args.to, nodeFileIO),
    ]);
  } else {
    after = await requireSnapshot(project);
    const snapshots = await recentSnapshots(project);
    const beforeCandidates = snapshots.filter((snapshot) => (
      snapshot.snapshotId !== after.snapshotId
      && snapshot.bindingId === after.bindingId
      && snapshot.role === after.role
      && snapshot.adapterId === after.adapterId
      && (
        snapshot.observedAt < after.observedAt
        || (snapshot.observedAt === after.observedAt && snapshot.snapshotId < after.snapshotId)
      )
    ));
    const selected = beforeCandidates.at(-1);
    if (selected === undefined) {
      return result(
        'VALIDATION_FAILED',
        '当前 preferred 场景快照没有同 binding、role、adapter lineage 的上一份历史。',
        {
          reasonCode: 'SCENE_DIFF_BASE_NOT_FOUND',
          nextActions: ['刷新同一场景来源后再比较，或显式提供同源 --from/--to。'],
        },
      );
    }
    before = selected;
  }
  const diff = diffSceneSnapshots(before, after);
  const journal = createSceneChangeJournalEntry(before, after);
  await saveSceneChangeJournalEntry(project.root, journal, nodeFileIO);
  return result('OK', '场景差异已生成并写入内容寻址变更日志。', { ...diff, journalId: journal.journalId });
}

export async function runSceneJournal(project: ResolvedCliProject, args: ArgsFor<'scene-journal'>): Promise<CliRunResult> {
  if (args.action === 'show') {
    try {
      const entry = await loadSceneChangeJournalEntry(project.root, args.journalId, nodeFileIO);
      return result('OK', '场景变更日志摘要已读取。', { reasonCode: 'SCENE_JOURNAL_FOUND', entry });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return result('NOT_FOUND', '没有该场景变更日志。', { reasonCode: 'SCENE_JOURNAL_NOT_FOUND' });
      }
      throw error;
    }
  }
  const snapshot = await requireSnapshot(project);
  const entries = await listSceneChangeJournal(project.root, nodeFileIO, {
    bindingId: snapshot.bindingId,
    role: snapshot.role,
    adapterId: snapshot.adapterId,
    limit: args.limit,
  });
  return result('OK', `当前 lineage 有 ${entries.length} 条场景变更日志。`, {
    reasonCode: 'SCENE_JOURNAL_LIST',
    lineage: { bindingId: snapshot.bindingId, role: snapshot.role, adapterId: snapshot.adapterId },
    entries,
  });
}

export async function runSceneNear(project: ResolvedCliProject, args: ArgsFor<'scene-near'>): Promise<CliRunResult> {
  const snapshot = await requireSnapshot(project);
  const found = queryScene(createSceneIndex(snapshot), { instanceId: args.instanceId });
  if (found.kind === 'not-found') return result('NOT_FOUND', '没有该场景实例。', { reasonCode: 'SCENE_NOT_FOUND', matches: [] });
  if (found.kind === 'ambiguous') return result('AMBIGUOUS', '该实例 ID 对应多条快照记录。', { reasonCode: 'SCENE_AMBIGUOUS', matches: found.matches });
  let near: ReturnType<typeof findNearbySceneInstances>;
  try {
    near = findNearbySceneInstances(found.matches[0]!, snapshot.instances, { radius: args.radius, limit: args.limit });
  } catch (error) {
    if (error instanceof ProductError && error.code === 'SCENE_EVIDENCE_INSUFFICIENT') {
      return result('VALIDATION_FAILED', error.message, {
        reasonCode: 'EVIDENCE_INSUFFICIENT',
        nextActions: [...error.nextActions],
        evidence: error.evidence,
      });
    }
    throw error;
  }
  return result('OK', `找到 ${near.matches.length} 个有足够空间证据的邻近实例。`, {
    reasonCode: 'SCENE_NEAR_COMPLETE',
    targetInstanceId: args.instanceId,
    radius: args.radius,
    limit: args.limit,
    ...near,
  }, near.insufficientInstanceIds.length === 0
    ? []
    : [`${near.insufficientInstanceIds.length} 个实例因缺少可信 bounds/position 未参与距离排序`]);
}

export async function runSceneGeometry(project: ResolvedCliProject, args: ArgsFor<'scene-geometry'>): Promise<CliRunResult> {
  const snapshot = await requireSnapshot(project);
  try {
    const geometry = querySceneGeometry(snapshot, args.request);
    const summary = geometry.operation === 'bounds'
      ? `已读取 ${geometry.target.targetId} 的可信场景包围盒。`
      : geometry.operation === 'contact'
        ? `目标与承载面的贴合状态：${geometry.contact.status}。`
        : `完成 ${geometry.targets.length} 个目标的严格体积穿插检查，命中 ${geometry.overlaps.length} 对。`;
    return result('OK', summary, {
      reasonCode: 'SCENE_GEOMETRY_COMPLETE',
      evidence: 'STATIC_LOCAL',
      snapshotId: snapshot.snapshotId,
      geometry,
    });
  } catch (error) {
    if (error instanceof ProductError && error.code === 'SCENE_EVIDENCE_INSUFFICIENT') {
      return result('EVIDENCE_INSUFFICIENT', error.message, {
        reasonCode: error.code,
        evidence: error.evidence,
        snapshotId: snapshot.snapshotId,
        nextActions: [...error.nextActions],
      });
    }
    throw error;
  }
}

function headsAuditResult(message: string): CliRunResult {
  return result('OK', '场景审计完成，但 heads 无法安全绑定到当前快照。', {
    reasonCode: 'SCENE_AUDIT_COMPLETE',
    snapshotId: null,
    summary: { errors: 1, warnings: 0, info: 0, duplicateInstanceIds: 0, snapshotIssues: 0, registrySuspected: 0 },
    totalFindingCount: 1,
    truncated: false,
    findingGroups: [{
      severity: 'error', reasonCode: 'SCENE_HEADS_INVALID', field: null, count: 1,
      sampleInstanceIds: [], nextAction: '重新刷新场景源；不要猜测 preferred 快照。',
    }],
    findings: [{
      severity: 'error',
      reasonCode: 'SCENE_HEADS_INVALID',
      message,
      instanceId: null,
      field: null,
      nextAction: '重新刷新场景源；不要猜测 preferred 快照。',
    }],
  });
}

export async function runSceneAudit(project: ResolvedCliProject, args: ArgsFor<'scene-audit'>): Promise<CliRunResult> {
  let heads;
  try {
    heads = await loadSceneHeads(project.root, nodeFileIO);
  } catch (error) {
    if (error instanceof SyntaxError || (error instanceof ProductError && error.code === 'VALIDATION_FAILED')) {
      return headsAuditResult('场景 heads JSON 已损坏或字段无效。');
    }
    throw error;
  }
  if (heads.preferredSnapshotId === null) return headsAuditResult('场景 heads 没有 preferredSnapshotId。');
  let snapshot: SceneSnapshot;
  try {
    snapshot = await loadSceneSnapshot(project.root, heads.preferredSnapshotId, nodeFileIO);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError || (error instanceof ProductError && error.code === 'VALIDATION_FAILED')) {
      return headsAuditResult('场景 heads 指向缺失或损坏的 preferred 快照。');
    }
    throw error;
  }
  let registryRecords: RegistryRecord[] = [];
  try {
    registryRecords = (await RegistryStore.open(resolve(project.root, '.yuanmeng-inspector', 'registry', 'registry.json'))).list()
      .filter((record) => record.projectInstanceId === project.projectInstanceId);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const audit = auditSceneSnapshot(snapshot, { registryRecords });
  return result('OK', args.detailed
    ? '场景证据审计已完成（完整明细）。'
    : '场景证据审计已完成（同类问题已聚合；使用 --detailed 查看完整明细）。', {
    reasonCode: 'SCENE_AUDIT_COMPLETE',
    ...(args.detailed ? audit : compactSceneAuditResult(audit)),
  });
}

export async function runSceneTypes(project: ResolvedCliProject): Promise<CliRunResult> {
  const snapshot = await requireSnapshot(project);
  const runtime = await runtimeCapabilities(project, snapshot);
  const instanceCounts = new Map<string, number>();
  for (const instance of snapshot.instances) {
    instanceCounts.set(instance.instanceId, (instanceCounts.get(instance.instanceId) ?? 0) + 1);
  }
  const runtimeFamilies = new Map<string, ReturnType<typeof resolveSceneInstanceIntelligence>['actorFamily']>();
  for (const instance of snapshot.instances) {
    if (instanceCounts.get(instance.instanceId) !== 1) continue;
    const evidence = runtime.get(instance.instanceId);
    if (evidence?.state !== 'unique') continue;
    runtimeFamilies.set(
      instance.instanceId,
      resolveSceneInstanceIntelligence(instance, evidence.evidence).actorFamily,
    );
  }
  const inventory = buildSceneTypeInventory({
    instances: snapshot.instances,
    runtimeActorFamiliesByInstance: runtimeFamilies,
  });
  return result('OK', inventory.pendingCalibration.length === 0
    ? `已自动读取并识别 ${inventory.entries.length} 种场景类型状态。`
    : `已自动读取 ${inventory.entries.length} 种场景类型状态；${inventory.pendingCalibration.length} 种仍需一次性校准，未作猜测。`, {
    reasonCode: 'SCENE_TYPE_INVENTORY_COMPLETE',
    snapshotId: snapshot.snapshotId,
    ...inventory,
  });
}

async function sceneCapabilityPayload(project: ResolvedCliProject, instanceId: string) {
  const snapshot = await requireSnapshot(project);
  const found = queryScene(createSceneIndex(snapshot), { instanceId });
  if (found.kind === 'not-found') return { outcome: 'not-found' as const };
  if (found.kind === 'ambiguous') return { outcome: 'ambiguous' as const, matches: found.matches };
  const instance = found.matches[0]!;
  const runtime = await runtimeCapabilities(project, snapshot);
  const resolved = intelligenceWithRuntime(instance, runtime);
  return {
    outcome: 'found' as const,
    snapshot,
    instance,
    ...resolved,
    probeLua: generateSceneMeasurementProbe([instance.instanceId], probeContext(project, snapshot)),
  };
}

export async function runSceneCapabilities(
  project: ResolvedCliProject,
  args: ArgsFor<'scene-capabilities'>,
): Promise<CliRunResult> {
  const payload = await sceneCapabilityPayload(project, args.instanceId);
  if (payload.outcome === 'not-found') return result('NOT_FOUND', '没有该场景实例。', { reasonCode: 'SCENE_NOT_FOUND' });
  if (payload.outcome === 'ambiguous') return result('AMBIGUOUS', '该实例 ID 对应多条场景记录，不能任取一条。', {
    reasonCode: 'SCENE_AMBIGUOUS', matches: payload.matches,
  });
  return result('OK', '已按当前静态类型目录与绑定运行时证据说明对象能力。', {
    reasonCode: 'SCENE_CAPABILITY_DESCRIPTION', snapshotId: payload.snapshot.snapshotId,
    instance: {
      instanceId: payload.instance.instanceId,
      elementTypeId: payload.instance.elementTypeId,
      ownerId: payload.instance.ownerId,
      variant: payload.instance.variant,
    },
    intelligence: payload.intelligence,
    runtimeCapabilityEvidence: payload.runtimeCapabilityEvidence,
    recommendedEvents: payload.intelligence.eventNames,
    probeLua: payload.probeLua,
    nextActions: payload.intelligence.nextActions,
  });
}

export async function runSceneCapabilityProbe(project: ResolvedCliProject, instanceId: string): Promise<CliRunResult> {
  const payload = await sceneCapabilityPayload(project, instanceId);
  if (payload.outcome === 'not-found') return result('NOT_FOUND', '没有该场景实例。', { reasonCode: 'SCENE_NOT_FOUND' });
  if (payload.outcome === 'ambiguous') return result('AMBIGUOUS', '该实例 ID 对应多条场景记录，不能任取一条。', {
    reasonCode: 'SCENE_AMBIGUOUS', matches: payload.matches,
  });
  return result('OK', '已生成场景对象能力的受控只读探针。', {
    reasonCode: 'RUNTIME_PROBE_GENERATED', kind: 'scene-capability', snapshotId: payload.snapshot.snapshotId,
    instanceId, staticIntelligence: payload.intelligence, probeLua: payload.probeLua, evidence: 'STATIC_LOCAL',
  });
}

export async function runScenePlan(project: ResolvedCliProject, args: ArgsFor<'scene-plan'>): Promise<CliRunResult> {
  const snapshot = await requireSnapshot(project);
  if (args.mode === 'placement') {
    const referencedIds = args.request.kind === 'axis-align'
      ? [...args.request.targetIds, args.request.referenceId]
      : args.request.targetIds;
    const duplicateIds = [...new Set(referencedIds)].filter((id) => {
      const instanceCount = snapshot.instances.filter((instance) => instance.instanceId === id).length;
      const groupCount = snapshot.groups.filter((group) => group.groupId === id).length;
      return instanceCount > 1 || groupCount > 1 || (instanceCount > 0 && groupCount > 0);
    }).sort((left, right) => left.localeCompare(right, 'en'));
    if (duplicateIds.length > 0) {
      return result('AMBIGUOUS', '空间计划引用了重复或跨实体类型冲突的 ID。', {
        reasonCode: 'SCENE_AMBIGUOUS',
        duplicateIds,
      });
    }
    try {
      const plan = createScenePlacementPlan(snapshot, args.request);
      return result('OK', plan.status === 'ready' ? '只读摆放计划已生成；默认不会执行。' : '摆放计划因证据不足被阻止。', plan,
        plan.status === 'ready' ? ['计划只供预览；不会直接修改场景二进制或编辑器。'] : ['先补齐计划列出的证据，再重新生成。']);
    } catch (error) {
      if (error instanceof ProductError && error.code === 'NOT_FOUND') {
        return result('NOT_FOUND', error.message, { reasonCode: 'SCENE_NOT_FOUND', nextActions: [...error.nextActions] });
      }
      throw error;
    }
  }
  const referencedIds = [args.supportId, ...args.moverIds];
  const duplicateIds = [...new Set(referencedIds)].filter((id) => {
    const instanceCount = snapshot.instances.filter((instance) => instance.instanceId === id).length;
    const groupCount = snapshot.groups.filter((group) => group.groupId === id).length;
    return instanceCount > 1 || groupCount > 1 || (instanceCount > 0 && groupCount > 0);
  }).sort((left, right) => left.localeCompare(right, 'en'));
  if (duplicateIds.length > 0) {
    return result('AMBIGUOUS', '空间计划引用了重复或跨实体类型冲突的 ID。', {
      reasonCode: 'SCENE_AMBIGUOUS',
      duplicateIds,
    });
  }
  let plan;
  try {
    const relations = buildSceneRelations(snapshot);
    const supportLineage = new Set([args.supportId, ...relations.ancestorsOf(args.supportId)]);
    const placementTargetIds = [...new Set(args.moverIds.map((targetId) => {
      // 明确给出编组 ID 时保留编组，由 placement core 递归展开。
      if (snapshot.groups.filter((group) => group.groupId === targetId).length === 1) return targetId;
      const instances = snapshot.instances.filter((instance) => instance.instanceId === targetId);
      if (instances.length !== 1) return targetId;
      const ownerId = instances[0]!.ownerId;
      if (ownerId === null || supportLineage.has(ownerId)) return targetId;
      // 成员属于唯一编组且该编组不包含支撑物时，显式转换为整组目标。
      // 这样既不会拆散自制物品，也不会把支撑物本身一起移动。
      return snapshot.groups.filter((group) => group.groupId === ownerId).length === 1 ? ownerId : targetId;
    }))];
    plan = createScenePlacementPlan(snapshot, {
      kind: 'floor-align',
      supportId: args.supportId,
      targetIds: placementTargetIds,
      // owner 编组已在上方按支撑物边界显式展开，防止 core 再次把支撑物所在编组并入目标。
      preserveGroupRelative: false,
    });
  } catch (error) {
    if (error instanceof ProductError && error.code === 'NOT_FOUND') {
      return result('NOT_FOUND', error.message, { reasonCode: 'SCENE_NOT_FOUND', nextActions: [...error.nextActions] });
    }
    throw error;
  }
  if (plan.status === 'evidence-insufficient') {
    const probeLua = plan.reasonCode === 'BOUNDS_EVIDENCE_REQUIRED' && plan.referenceIds.length === 1
      ? generateFloorAlignmentLua(plan.referenceIds[0]!, plan.affectedInstanceIds, {
        execute: false,
        context: probeContext(project, snapshot),
      })
      : null;
    return result('OK', probeLua === null
      ? '贴地计划因场景证据不足被阻止。'
      : '静态快照缺少可信边界；已按递归展开后的真实元件生成官方 API 测量探针。', {
      ...plan,
      executable: false,
      ...(probeLua === null ? {} : { probeLua }),
    }, probeLua === null
      ? ['补齐计划列出的证据后重新生成。']
      : ['必须在官方编辑器试玩中验证 GetSizeBox/射线命中后再生成移动计划']);
  }
  return result('OK', '完整贴地预览计划已生成；默认不会执行。', plan, ['计划只供预览；不会直接修改场景二进制或编辑器。']);
}

export async function runPropertyLocate(project: ResolvedCliProject, args: ArgsFor<'property-locate'>): Promise<CliRunResult> {
  const snapshot = await requireSnapshot(project);
  const staticMatches = snapshot.instances.flatMap((instance) => {
    if (instance.customProperties.state !== 'observed') return [];
    return instance.customProperties.value
      .filter((property) => property.key === args.propertyName)
      .map((property) => ({ instanceId: instance.instanceId, value: property.value }));
  });
  const runtimeCandidateIds = snapshot.instances
    .filter((instance) => instance.customProperties.state !== 'observed')
    .map((instance) => instance.instanceId);
  const source = generateCustomPropertyLookupProbe(
    runtimeCandidateIds,
    args.propertyName,
    args.propertyType,
    probeContext(project, snapshot),
  );
  return result('OK', staticMatches.length === 0
    ? '静态快照未确认该属性；已为候选实例生成只读 Lua 探针。'
    : `静态快照已定位 ${staticMatches.length} 个匹配；其余候选保留只读探针。`, {
    propertyName: args.propertyName,
    propertyType: args.propertyType,
    staticMatches,
    staticMatchCount: staticMatches.length,
    runtimeCandidateCount: runtimeCandidateIds.length,
    probeLua: source,
  }, runtimeCandidateIds.length === 0
    ? []
    : ['静态快照未观测到属性表的实例仍需在官方编辑器试玩日志中读取 YMAI_PROPERTY_MATCH。']);
}
