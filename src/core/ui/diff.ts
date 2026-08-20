import type { UiNode, UiSnapshot } from '../model.js';

export interface UiNodeChange {
  from: UiNode;
  to: UiNode;
}

export interface AmbiguousUiChange {
  signature: string;
  removedCandidates: UiNode[];
  addedCandidates: UiNode[];
}

export interface UiDiff {
  fromSnapshotId: string;
  toSnapshotId: string;
  added: UiNode[];
  removed: UiNode[];
  renamed: UiNodeChange[];
  moved: UiNodeChange[];
  typeChanged: UiNodeChange[];
  idChanged: UiNodeChange[];
  ambiguousPotentialChanges: AmbiguousUiChange[];
}

function compareNode(left: UiNode, right: UiNode): number {
  return left.path < right.path ? -1 : left.path > right.path ? 1 : left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function parentPath(node: UiNode): string {
  const separator = node.path.lastIndexOf('/');
  return separator <= 0 ? '' : node.path.slice(0, separator);
}

function signature(node: UiNode): string {
  return `${node.type}\0${parentPath(node)}\0${node.name}`;
}

function groups(nodes: readonly UiNode[]): Map<string, UiNode[]> {
  const result = new Map<string, UiNode[]>();
  for (const node of nodes) {
    const key = signature(node);
    const values = result.get(key) ?? [];
    values.push(node);
    result.set(key, values);
  }
  return result;
}

export function diffUi(from: UiSnapshot, to: UiSnapshot): UiDiff {
  const oldById = new Map(from.nodes.map((node) => [node.id, node]));
  const newById = new Map(to.nodes.map((node) => [node.id, node]));
  const renamed: UiNodeChange[] = [];
  const moved: UiNodeChange[] = [];
  const typeChanged: UiNodeChange[] = [];
  const unmatchedOld = from.nodes.filter((node) => !newById.has(node.id));
  const unmatchedNew = to.nodes.filter((node) => !oldById.has(node.id));

  for (const [id, oldNode] of oldById) {
    const newNode = newById.get(id);
    if (newNode === undefined) {
      continue;
    }
    if (oldNode.name !== newNode.name) {
      renamed.push({ from: oldNode, to: newNode });
    }
    if (oldNode.parentId !== newNode.parentId) {
      moved.push({ from: oldNode, to: newNode });
    }
    if (oldNode.type !== newNode.type) {
      typeChanged.push({ from: oldNode, to: newNode });
    }
  }

  const oldGroups = groups(unmatchedOld);
  const newGroups = groups(unmatchedNew);
  const matchedOldIds = new Set<string>();
  const matchedNewIds = new Set<string>();
  const idChanged: UiNodeChange[] = [];
  const ambiguousPotentialChanges: AmbiguousUiChange[] = [];

  for (const [key, oldCandidates] of oldGroups) {
    const newCandidates = newGroups.get(key);
    if (newCandidates === undefined) {
      continue;
    }
    if (oldCandidates.length === 1 && newCandidates.length === 1) {
      const oldNode = oldCandidates[0]!;
      const newNode = newCandidates[0]!;
      matchedOldIds.add(oldNode.id);
      matchedNewIds.add(newNode.id);
      idChanged.push({ from: oldNode, to: newNode });
    } else {
      ambiguousPotentialChanges.push({
        signature: key,
        removedCandidates: [...oldCandidates].sort(compareNode),
        addedCandidates: [...newCandidates].sort(compareNode),
      });
    }
  }

  const sortChanges = (values: UiNodeChange[]): UiNodeChange[] => values.sort((left, right) => compareNode(left.from, right.from));
  return {
    fromSnapshotId: from.snapshotId,
    toSnapshotId: to.snapshotId,
    added: unmatchedNew.filter((node) => !matchedNewIds.has(node.id)).sort(compareNode),
    removed: unmatchedOld.filter((node) => !matchedOldIds.has(node.id)).sort(compareNode),
    renamed: sortChanges(renamed),
    moved: sortChanges(moved),
    typeChanged: sortChanges(typeChanged),
    idChanged: sortChanges(idChanged),
    ambiguousPotentialChanges: ambiguousPotentialChanges.sort((left, right) => left.signature < right.signature ? -1 : 1),
  };
}
