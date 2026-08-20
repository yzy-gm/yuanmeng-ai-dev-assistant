import { describe, expect, it } from 'vitest';

import type { UiNode, UiSnapshot } from '../../src/core/model.js';
import { diffUi } from '../../src/core/ui/diff.js';

function node(id: string, name: string, type: string, parentId: string | null, path: string): UiNode {
  return {
    id, name, type, parentId, path, depth: path.split('/').length - 2, siblingIndex: 0,
    sourceFile: 'src/Data/CustomUIData.lua', sourceRange: null,
  };
}

function snapshot(id: string, nodes: UiNode[]): UiSnapshot {
  return {
    schemaVersion: 1,
    snapshotId: id,
    createdAt: '2026-08-19T00:00:00.000Z',
    projectInstanceId: '00000000-0000-4000-8000-000000000001',
    mapFingerprint: null,
    sources: [],
    nodes,
    duplicateNames: [],
  };
}

describe('deterministic UI differences', () => {
  it('reports added, removed, renamed, moved, type-changed, and ID-changed nodes', () => {
    const from = snapshot('from', [
      node('1', 'Root', 'Canvas', null, '/Root'),
      node('2', 'Old name', 'Text', '1', '/Root/Old name'),
      node('3', 'Moved', 'Button', '1', '/Root/Moved'),
      node('4', 'Removed', 'Panel', '1', '/Root/Removed'),
      node('5', 'Type', 'Text', '1', '/Root/Type'),
      node('6', 'Changed ID', 'Image', '1', '/Root/Changed ID'),
      node('10', 'Other', 'Canvas', null, '/Other'),
    ]);
    const to = snapshot('to', [
      node('1', 'Root', 'Canvas', null, '/Root'),
      node('2', 'New name', 'Text', '1', '/Root/New name'),
      node('3', 'Moved', 'Button', '10', '/Other/Moved'),
      node('5', 'Type', 'Input', '1', '/Root/Type'),
      node('7', 'Added', 'Panel', '1', '/Root/Added'),
      node('8', 'Changed ID', 'Image', '1', '/Root/Changed ID'),
      node('10', 'Other', 'Canvas', null, '/Other'),
    ]);

    const result = diffUi(from, to);

    expect(result.added.map((value) => value.id)).toEqual(['7']);
    expect(result.removed.map((value) => value.id)).toEqual(['4']);
    expect(result.renamed).toEqual([expect.objectContaining({ from: expect.objectContaining({ id: '2' }) })]);
    expect(result.moved).toEqual([expect.objectContaining({ from: expect.objectContaining({ id: '3' }) })]);
    expect(result.typeChanged).toEqual([expect.objectContaining({ from: expect.objectContaining({ id: '5' }) })]);
    expect(result.idChanged).toEqual([expect.objectContaining({ from: expect.objectContaining({ id: '6' }), to: expect.objectContaining({ id: '8' }) })]);
  });

  it('does not guess an ID change when multiple candidates share a signature', () => {
    const from = snapshot('from', [
      node('1', 'Root', 'Canvas', null, '/Root'),
      node('2', 'Same', 'Text', '1', '/Root/Same'),
      node('3', 'Same', 'Text', '1', '/Root/Same'),
    ]);
    const to = snapshot('to', [
      node('1', 'Root', 'Canvas', null, '/Root'),
      node('4', 'Same', 'Text', '1', '/Root/Same'),
      node('5', 'Same', 'Text', '1', '/Root/Same'),
    ]);

    const result = diffUi(from, to);

    expect(result.idChanged).toEqual([]);
    expect(result.removed.map((value) => value.id)).toEqual(['2', '3']);
    expect(result.added.map((value) => value.id)).toEqual(['4', '5']);
    expect(result.ambiguousPotentialChanges).toHaveLength(1);
  });
});
