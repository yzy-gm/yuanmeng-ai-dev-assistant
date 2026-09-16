import type { SceneInstance, SceneSnapshot } from './types.js';

export type SceneSignalRegistryRecord = NonNullable<Extract<NonNullable<SceneSnapshot['signalRegistry']>, { state: 'observed' }>['value']>[number];

export interface SceneIndex {
  snapshot: SceneSnapshot;
  byInstanceId: ReadonlyMap<string, SceneInstance[]>;
  byElementTypeId: ReadonlyMap<string, SceneInstance[]>;
  byOwnerId: ReadonlyMap<string, SceneInstance[]>;
  bySignalName: ReadonlyMap<string, SceneInstance[]>;
  /** 根级 signalRegistry 的完整记录索引；重复名称保留为多值，禁止覆盖。 */
  bySignalRegistryName?: ReadonlyMap<string, SceneSignalRegistryRecord[]>;
}

export interface SceneQuery {
  instanceId?: string;
  elementTypeId?: string;
  ownerId?: string;
  signalName?: string;
}

export type SceneQueryResult =
  | { kind: 'not-found'; matches: [] }
  | { kind: 'found'; matches: SceneInstance[] }
  | { kind: 'ambiguous'; matches: SceneInstance[] };

export interface SceneSignalGroupCandidate {
  groupId: string;
  matchedMemberIds: string[];
  recursiveMemberCount: number;
  coverage: 'all-members-observed-with-signal' | 'partial-members-observed-with-signal';
}

export interface SceneSignalGroupSummary {
  signalName: string;
  matchedInstanceIds: string[];
  candidateGroups: SceneSignalGroupCandidate[];
  ambiguousOwnerIds: string[];
  warning: string;
}

function append(map: Map<string, SceneInstance[]>, key: string | null, value: SceneInstance): void {
  if (key === null) return;
  const values = map.get(key) ?? [];
  values.push(value);
  map.set(key, values);
}

export function createSceneIndex(snapshot: SceneSnapshot): SceneIndex {
  const byInstanceId = new Map<string, SceneInstance[]>();
  const byElementTypeId = new Map<string, SceneInstance[]>();
  const byOwnerId = new Map<string, SceneInstance[]>();
  const bySignalName = new Map<string, SceneInstance[]>();
  const bySignalRegistryName = new Map<string, SceneSignalRegistryRecord[]>();
  for (const instance of snapshot.instances) {
    append(byInstanceId, instance.instanceId, instance);
    append(byElementTypeId, instance.elementTypeId, instance);
    append(byOwnerId, instance.ownerId, instance);
    if (instance.signals.state === 'observed') {
      for (const signal of instance.signals.value) append(bySignalName, signal.name, instance);
    }
  }
  if (snapshot.signalRegistry?.state === 'observed') {
    for (const signal of snapshot.signalRegistry.value) {
      const values = bySignalRegistryName.get(signal.name) ?? [];
      values.push(signal);
      bySignalRegistryName.set(signal.name, values);
    }
  }
  for (const values of [...byElementTypeId.values(), ...byOwnerId.values(), ...bySignalName.values()]) values.sort((left, right) => left.instanceId.localeCompare(right.instanceId, 'en'));
  for (const values of bySignalRegistryName.values()) values.sort((left, right) => stableSignalKey(left).localeCompare(stableSignalKey(right), 'en'));
  return { snapshot, byInstanceId, byElementTypeId, byOwnerId, bySignalName, bySignalRegistryName };
}

function stableSignalKey(value: SceneSignalRegistryRecord): string {
  return `${value.name}\0${value.unknownRefCount}\0${value.ambiguous === true ? '1' : '0'}`;
}

export function queryScene(index: SceneIndex, query: SceneQuery): SceneQueryResult {
  let matches = index.snapshot.instances;
  if (query.instanceId !== undefined) {
    matches = index.byInstanceId.get(query.instanceId) ?? [];
  }
  if (query.elementTypeId !== undefined) matches = matches.filter((instance) => instance.elementTypeId === query.elementTypeId);
  if (query.ownerId !== undefined) matches = matches.filter((instance) => instance.ownerId === query.ownerId);
  if (query.signalName !== undefined) {
    const signalMatches = new Set(index.bySignalName.get(query.signalName) ?? []);
    matches = matches.filter((instance) => signalMatches.has(instance));
  }
  const ordered = [...matches].sort((left, right) => left.instanceId.localeCompare(right.instanceId, 'en'));
  if (ordered.length === 0) return { kind: 'not-found', matches: [] };
  return ordered.length === 1 ? { kind: 'found', matches: ordered } : { kind: 'ambiguous', matches: ordered };
}

/** 只按已观察信号名和唯一 owner 编组聚合候选，不把候选升级为已确认物品。 */
export function summarizeSceneSignalGroups(index: SceneIndex, signalName: string): SceneSignalGroupSummary {
  const matches = [...(index.bySignalName.get(signalName) ?? [])];
  const groupsById = new Map<string, SceneSnapshot['groups']>();
  for (const group of index.snapshot.groups) {
    const candidates = groupsById.get(group.groupId) ?? [];
    candidates.push(group);
    groupsById.set(group.groupId, candidates);
  }
  const matchedByOwner = new Map<string, Set<string>>();
  for (const instance of matches) {
    if (instance.ownerId === null) continue;
    const ids = matchedByOwner.get(instance.ownerId) ?? new Set<string>();
    ids.add(instance.instanceId);
    matchedByOwner.set(instance.ownerId, ids);
  }
  const ambiguousOwnerIds: string[] = [];
  const candidateGroups: SceneSignalGroupCandidate[] = [];
  for (const [ownerId, matchedIds] of matchedByOwner) {
    const owners = groupsById.get(ownerId) ?? [];
    if (owners.length !== 1) {
      if (owners.length > 1) ambiguousOwnerIds.push(ownerId);
      continue;
    }
    const recursiveMembers = new Set<string>();
    const visitedGroups = new Set<string>();
    const stack = [owners[0]!];
    while (stack.length > 0) {
      const group = stack.pop()!;
      if (visitedGroups.has(group.groupId)) continue;
      visitedGroups.add(group.groupId);
      for (const memberId of group.memberIds) recursiveMembers.add(memberId);
      for (const nestedId of group.nestedGroupIds) {
        const nested = groupsById.get(nestedId) ?? [];
        if (nested.length === 1) stack.push(nested[0]!);
        else if (nested.length > 1) ambiguousOwnerIds.push(nestedId);
      }
    }
    const matchedMemberIds = [...matchedIds].sort((left, right) => left.localeCompare(right, 'en'));
    candidateGroups.push({
      groupId: ownerId,
      matchedMemberIds,
      recursiveMemberCount: recursiveMembers.size,
      coverage: recursiveMembers.size > 0
        && matchedMemberIds.length === recursiveMembers.size
        && matchedMemberIds.every((id) => recursiveMembers.has(id))
        ? 'all-members-observed-with-signal'
        : 'partial-members-observed-with-signal',
    });
  }
  candidateGroups.sort((left, right) => left.groupId.localeCompare(right.groupId, 'en'));
  return {
    signalName,
    matchedInstanceIds: [...new Set(matches.map((instance) => instance.instanceId))].sort((left, right) => left.localeCompare(right, 'en')),
    candidateGroups,
    ambiguousOwnerIds: [...new Set(ambiguousOwnerIds)].sort((left, right) => left.localeCompare(right, 'en')),
    warning: '按信号名和 owner/编组结构生成的候选，不等于已确认的玩家自制物品；需结合元数据或用户确认。',
  };
}
