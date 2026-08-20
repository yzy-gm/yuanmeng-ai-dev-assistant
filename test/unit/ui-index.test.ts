import { describe, expect, it } from 'vitest';

import type { UiNode } from '../../src/core/model.js';
import { buildUiSnapshot, findUi } from '../../src/core/ui/index.js';

const baseNodes: UiNode[] = [
  {
    id: '41001', name: 'HUD', type: 'Canvas', parentId: null, path: '/HUD', depth: 0, siblingIndex: 0,
    sourceFile: 'src/Data/CustomUIData.lua', sourceRange: null,
  },
  {
    id: '41002', name: '经验', type: 'Text', parentId: '41001', path: '/HUD/经验', depth: 1, siblingIndex: 0,
    sourceFile: 'src/Data/CustomUIData.lua', sourceRange: null,
  },
  {
    id: '41003', name: '结算', type: 'Panel', parentId: null, path: '/结算', depth: 0, siblingIndex: 1,
    sourceFile: 'src/Data/CustomUIData2.lua', sourceRange: null,
  },
];

const source = {
  kind: 'official-export',
  relativePath: 'src/Data/CustomUIData.lua',
  sha256: 'a'.repeat(64),
  observedAt: '2026-08-19T00:00:00.000Z',
  officialExtensionVersion: '9.9.9-test',
  evidence: 'UNIT_E2E',
} as const;

function snapshot(nodes: UiNode[] = baseNodes) {
  return buildUiSnapshot({
    createdAt: '2026-08-19T00:00:00.000Z',
    projectInstanceId: '00000000-0000-4000-8000-000000000001',
    mapFingerprint: null,
    sources: [source],
    nodes,
  });
}

describe('UI snapshot and search', () => {
  it('returns the only exact Chinese name', () => {
    expect(findUi(snapshot(), '经验', { mode: 'exact-name' })).toMatchObject({
      kind: 'unique',
      node: { id: '41002', type: 'Text', path: '/HUD/经验' },
    });
  });

  it('never silently selects duplicate names', () => {
    const duplicate = {
      ...baseNodes[1]!, id: '41004', parentId: '41003', path: '/结算/经验', sourceFile: 'src/Data/CustomUIData2.lua' as const,
    };
    const result = findUi(snapshot([...baseNodes, duplicate]), '经验', { mode: 'exact-name' });

    expect(result).toEqual({
      kind: 'ambiguous',
      candidates: [
        expect.objectContaining({ path: '/HUD/经验' }),
        expect.objectContaining({ path: '/结算/经验' }),
      ],
    });
  });

  it('supports exact ID, exact path, path fragment, and explicit fuzzy modes', () => {
    const value = snapshot();

    expect(findUi(value, '41003', { mode: 'exact-id' })).toMatchObject({ kind: 'unique', node: { name: '结算' } });
    expect(findUi(value, '/HUD/经验', { mode: 'exact-path' })).toMatchObject({ kind: 'unique', node: { id: '41002' } });
    expect(findUi(value, 'HUD', { mode: 'path-contains' })).toMatchObject({ kind: 'ambiguous' });
    expect(findUi(value, 'jy', { mode: 'fuzzy' })).toMatchObject({ kind: 'not-found' });
    expect(findUi(value, '经', { mode: 'fuzzy' })).toMatchObject({ kind: 'unique', node: { id: '41002' } });
  });

  it('sorts nodes and records duplicate names deterministically', () => {
    const duplicate = { ...baseNodes[1]!, id: '41004', path: '/结算/经验', parentId: '41003' };
    const value = snapshot([duplicate, ...baseNodes].reverse());

    expect(value.nodes.map((node) => node.path)).toEqual(['/HUD', '/HUD/经验', '/结算', '/结算/经验']);
    expect(value.duplicateNames).toEqual([{ name: '经验', paths: ['/HUD/经验', '/结算/经验'] }]);
    expect(value.snapshotId).toMatch(/^[a-f0-9]{64}$/u);
  });
});
