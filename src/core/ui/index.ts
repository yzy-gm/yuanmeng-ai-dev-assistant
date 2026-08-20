import { sha256Hex, stableJson } from '../hash.js';
import type { SourceEvidence, UiNode, UiSnapshot } from '../model.js';

export interface UiSnapshotInput {
  createdAt: string;
  projectInstanceId: string;
  mapFingerprint: string | null;
  sources: readonly SourceEvidence[];
  nodes: readonly UiNode[];
}

export type UiSearchMode = 'exact-name' | 'exact-id' | 'exact-path' | 'path-contains' | 'fuzzy';

export type UiSearchResult =
  | { kind: 'unique'; node: UiNode }
  | { kind: 'ambiguous'; candidates: UiNode[] }
  | { kind: 'not-found' };

function compareNode(left: UiNode, right: UiNode): number {
  return left.path < right.path ? -1 : left.path > right.path ? 1 : left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

export function buildUiSnapshot(input: UiSnapshotInput): UiSnapshot {
  const nodes = [...input.nodes].sort(compareNode);
  const pathsByName = new Map<string, string[]>();
  for (const node of nodes) {
    const paths = pathsByName.get(node.name) ?? [];
    paths.push(node.path);
    pathsByName.set(node.name, paths);
  }
  const duplicateNames = [...pathsByName]
    .filter(([, paths]) => paths.length > 1)
    .map(([name, paths]) => ({ name, paths: [...paths].sort() }))
    .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  const snapshotBody = {
    schemaVersion: 1 as const,
    createdAt: input.createdAt,
    projectInstanceId: input.projectInstanceId,
    mapFingerprint: input.mapFingerprint,
    sources: [...input.sources],
    nodes,
    duplicateNames,
  };
  return {
    ...snapshotBody,
    snapshotId: sha256Hex(stableJson(snapshotBody)),
  };
}

export function findUi(
  snapshot: UiSnapshot,
  query: string,
  options: { mode: UiSearchMode },
): UiSearchResult {
  const normalizedQuery = query.trim().toLocaleLowerCase('zh-CN');
  let matches: UiNode[];
  switch (options.mode) {
    case 'exact-name':
      matches = snapshot.nodes.filter((node) => node.name === query);
      break;
    case 'exact-id':
      matches = snapshot.nodes.filter((node) => node.id === query);
      break;
    case 'exact-path':
      matches = snapshot.nodes.filter((node) => node.path === query);
      break;
    case 'path-contains':
      matches = snapshot.nodes.filter((node) => node.path.toLocaleLowerCase('zh-CN').includes(normalizedQuery));
      break;
    case 'fuzzy':
      matches = normalizedQuery.length === 0
        ? []
        : snapshot.nodes.filter((node) => {
          const name = node.name.toLocaleLowerCase('zh-CN');
          const path = node.path.toLocaleLowerCase('zh-CN');
          return name.includes(normalizedQuery) || path.includes(normalizedQuery);
        });
      break;
  }
  matches.sort(compareNode);
  if (matches.length === 0) {
    return { kind: 'not-found' };
  }
  if (matches.length === 1) {
    return { kind: 'unique', node: matches[0]! };
  }
  return { kind: 'ambiguous', candidates: matches };
}
