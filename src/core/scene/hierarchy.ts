import type { SceneIssue, SceneSnapshot } from './types.js';

export interface SceneRelations {
  parentByChild: ReadonlyMap<string, string>;
  childrenByParent: ReadonlyMap<string, string[]>;
  groupMembers: ReadonlyMap<string, string[]>;
  issues: SceneIssue[];
  ancestorsOf(instanceId: string): string[];
  descendantsOf(instanceId: string): string[];
}

export interface SceneValuePage<T> {
  values: T[];
  nextOffset: number | null;
  total: number;
}

export function pageSceneValues<T>(
  values: readonly T[],
  offset: number,
  pageSize: number,
): SceneValuePage<T> {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new RangeError('offset must be a non-negative safe integer.');
  if (!Number.isSafeInteger(pageSize) || pageSize < 100 || pageSize > 250) throw new RangeError('pageSize must be between 100 and 250.');
  const page = values.slice(offset, offset + pageSize);
  const end = offset + page.length;
  return { values: page, nextOffset: end < values.length ? end : null, total: values.length };
}

export function buildSceneRelations(snapshot: SceneSnapshot): SceneRelations {
  const instanceCounts = new Map<string, number>();
  const groupCounts = new Map<string, number>();
  for (const instance of snapshot.instances) instanceCounts.set(instance.instanceId, (instanceCounts.get(instance.instanceId) ?? 0) + 1);
  for (const group of snapshot.groups) groupCounts.set(group.groupId, (groupCounts.get(group.groupId) ?? 0) + 1);
  const duplicateInstanceIds = new Set([...instanceCounts].filter(([, count]) => count > 1).map(([id]) => id));
  const duplicateGroupIds = new Set([...groupCounts].filter(([, count]) => count > 1).map(([id]) => id));
  const instanceIds = new Set(snapshot.instances.map((instance) => instance.instanceId));
  const groupIds = new Set(snapshot.groups.map((group) => group.groupId));
  const knownIds = new Set([...instanceIds, ...groupIds]);
  const parentByChild = new Map<string, string>();
  const childrenByParentMutable = new Map<string, string[]>();
  const issues: SceneIssue[] = [
    ...[...duplicateInstanceIds].sort((left, right) => left.localeCompare(right, 'en')).map((instanceId): SceneIssue => ({
      code: 'DUPLICATE_INSTANCE', message: `实例 ID ${instanceId} 重复，层级关系保持 AMBIGUOUS。`, instanceId,
    })),
    ...[...duplicateGroupIds].sort((left, right) => left.localeCompare(right, 'en')).map((groupId): SceneIssue => ({
      code: 'DUPLICATE_GROUP', message: `编组 ID ${groupId} 重复，层级关系保持 AMBIGUOUS。`, instanceId: groupId,
    })),
  ];
  for (const instance of snapshot.instances) {
    if (instance.ownerId === null) continue;
    if (
      duplicateInstanceIds.has(instance.instanceId)
      || duplicateInstanceIds.has(instance.ownerId)
      || duplicateGroupIds.has(instance.ownerId)
    ) continue;
    parentByChild.set(instance.instanceId, instance.ownerId);
    const children = childrenByParentMutable.get(instance.ownerId) ?? [];
    children.push(instance.instanceId);
    childrenByParentMutable.set(instance.ownerId, children);
    if (!knownIds.has(instance.ownerId)) issues.push({ code: 'ORPHAN_OWNER', message: `实例 ${instance.instanceId} 的 owner 不存在。`, instanceId: instance.instanceId });
  }
  for (const group of snapshot.groups) {
    if (duplicateGroupIds.has(group.groupId)) continue;
    for (const childGroupId of group.nestedGroupIds) {
      if (duplicateGroupIds.has(childGroupId)) continue;
      if (!groupIds.has(childGroupId)) {
        issues.push({ code: 'MISSING_GROUP_MEMBER', message: `编组 ${group.groupId} 的子编组 ${childGroupId} 不存在。`, instanceId: childGroupId });
        continue;
      }
      parentByChild.set(childGroupId, group.groupId);
      const children = childrenByParentMutable.get(group.groupId) ?? [];
      children.push(childGroupId);
      childrenByParentMutable.set(group.groupId, children);
    }
  }
  for (const children of childrenByParentMutable.values()) children.sort((left, right) => left.localeCompare(right, 'en'));
  const groupMembers = new Map(snapshot.groups
    .filter((group) => !duplicateGroupIds.has(group.groupId))
    .map((group) => [group.groupId, [...group.memberIds].sort((left, right) => left.localeCompare(right, 'en'))]));
  for (const group of snapshot.groups) for (const memberId of group.memberIds) {
    if (!instanceIds.has(memberId) && !groupIds.has(memberId)) issues.push({ code: 'MISSING_GROUP_MEMBER', message: `编组 ${group.groupId} 的成员 ${memberId} 不存在。`, instanceId: memberId });
  }

  const completed = new Set<string>();
  const reportedCycles = new Set<string>();
  for (const id of knownIds) {
    if (completed.has(id)) continue;
    const path: string[] = [];
    const positions = new Map<string, number>();
    let current: string | undefined = id;
    while (current !== undefined && !completed.has(current)) {
      const position = positions.get(current);
      if (position !== undefined) {
        const cycle = path.slice(position);
        const representative = [...cycle].sort((left, right) => left.localeCompare(right, 'en'))[0]!;
        const key = [...cycle].sort((left, right) => left.localeCompare(right, 'en')).join('\0');
        if (!reportedCycles.has(key)) {
          reportedCycles.add(key);
          issues.push({ code: 'RELATION_CYCLE', message: `关系链在 ${representative} 形成循环。`, instanceId: representative });
        }
        break;
      }
      positions.set(current, path.length);
      path.push(current);
      current = parentByChild.get(current);
    }
    for (const visited of path) completed.add(visited);
  }

  const ancestorsOf = (instanceId: string): string[] => {
    const result: string[] = [];
    const visited = new Set([instanceId]);
    let current = instanceId;
    while (true) {
      const parent = parentByChild.get(current);
      if (parent === undefined) return result;
      if (visited.has(parent)) return result;
      result.push(parent);
      visited.add(parent);
      current = parent;
    }
  };
  const descendantsOf = (instanceId: string): string[] => {
    const result: string[] = [];
    const visited = new Set([instanceId]);
    const stack = [...(childrenByParentMutable.get(instanceId) ?? [])].reverse();
    while (stack.length > 0) {
      const child = stack.pop()!;
      if (visited.has(child)) continue;
      visited.add(child);
      result.push(child);
      const children = childrenByParentMutable.get(child) ?? [];
      for (let index = children.length - 1; index >= 0; index -= 1) {
        stack.push(children[index]!);
      }
    }
    return result;
  };
  return { parentByChild, childrenByParent: childrenByParentMutable, groupMembers, issues, ancestorsOf, descendantsOf };
}
