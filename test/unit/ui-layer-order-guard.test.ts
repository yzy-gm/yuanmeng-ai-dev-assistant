import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { nodeFileIO } from '../../src/core/fs.js';
import type { UiNode, UiSnapshot } from '../../src/core/model.js';
import {
  buildUiLayerOrderBaseline,
  evaluateUiLayerOrder,
  updateUiLayerOrderGuard,
} from '../../src/core/ui/layer-order-guard.js';

function node(id: string, parentId: string | null, siblingIndex: number, name = `控件${id}`): UiNode {
  const parentPath = parentId === null ? '' : '/任务面板';
  return {
    id,
    name,
    type: 'unknown',
    parentId,
    path: `${parentPath}/${name}`,
    depth: parentId === null ? 0 : 1,
    siblingIndex,
    sourceFile: 'src/Data/CustomUIData2.lua',
    sourceRange: null,
  };
}

function snapshot(snapshotId: string, children: readonly string[], mapFingerprint = 'map-a'): UiSnapshot {
  return {
    schemaVersion: 1,
    snapshotId,
    createdAt: '2026-08-24T00:00:00.000Z',
    projectInstanceId: '00000000-0000-4000-8000-000000000001',
    mapFingerprint,
    sources: [],
    nodes: [
      node('100', null, 0, '任务面板'),
      ...children.map((id, index) => node(id, '100', index)),
    ],
    duplicateNames: [],
  };
}

describe('UI layer order guard', () => {
  it('detects an exact whole-group reversal and keeps the last known-good baseline', () => {
    const trusted = buildUiLayerOrderBaseline(snapshot('good', ['1', '2', '3', '4']));

    const result = evaluateUiLayerOrder(trusted, snapshot('candidate', ['4', '3', '2', '1']), '2026-08-24T00:01:00.000Z');

    expect(result.status.state).toBe('reversal-detected');
    expect(result.promoteCandidate).toBe(false);
    expect(result.baseline.snapshotId).toBe('good');
    expect(result.status.reversedGroups).toEqual([
      expect.objectContaining({
        parentId: '100',
        parentPath: '/任务面板',
        expectedChildIds: ['1', '2', '3', '4'],
        observedChildIds: ['4', '3', '2', '1'],
      }),
    ]);
  });

  it('promotes ordinary edits instead of reporting them as a whole-group reversal', () => {
    const trusted = buildUiLayerOrderBaseline(snapshot('good', ['1', '2', '3', '4']));

    const result = evaluateUiLayerOrder(trusted, snapshot('candidate', ['1', '3', '2', '4', '5']), '2026-08-24T00:01:00.000Z');

    expect(result.status.state).toBe('clean');
    expect(result.promoteCandidate).toBe(true);
    expect(result.baseline.snapshotId).toBe('candidate');
    expect(result.status.reversedGroups).toEqual([]);
  });

  it('does not compare a different map with the previous map baseline', () => {
    const trusted = buildUiLayerOrderBaseline(snapshot('good', ['1', '2', '3'], 'map-a'));

    const result = evaluateUiLayerOrder(trusted, snapshot('new-map', ['3', '2', '1'], 'map-b'), '2026-08-24T00:01:00.000Z');

    expect(result.status.state).toBe('baseline-created');
    expect(result.promoteCandidate).toBe(true);
    expect(result.baseline.mapFingerprint).toBe('map-b');
  });

  it('does not treat a two-control swap as reliable whole-group reversal evidence', () => {
    const trusted = buildUiLayerOrderBaseline(snapshot('good', ['1', '2']));

    const result = evaluateUiLayerOrder(trusted, snapshot('candidate', ['2', '1']), '2026-08-24T00:01:00.000Z');

    expect(result.status.state).toBe('clean');
    expect(result.promoteCandidate).toBe(true);
  });

  it('persists only private evidence and never replaces the trusted baseline with a reversed candidate', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ymai-ui-layer-guard-'));
    try {
      const first = await updateUiLayerOrderGuard(
        root,
        snapshot('good', ['1', '2', '3', '4']),
        '2026-08-24T00:00:00.000Z',
        nodeFileIO,
      );
      expect(first.status.state).toBe('baseline-created');

      const second = await updateUiLayerOrderGuard(
        root,
        snapshot('reversed', ['4', '3', '2', '1']),
        '2026-08-24T00:01:00.000Z',
        nodeFileIO,
      );
      expect(second.status.state).toBe('reversal-detected');
      expect(second.incidentRelativePath).toMatch(/^\.yuanmeng-inspector\/ui\/layer-order-incidents\//u);

      const baseline = JSON.parse(await readFile(
        join(root, '.yuanmeng-inspector', 'ui', 'layer-order-baseline.json'),
        'utf8',
      )) as { snapshotId: string };
      expect(baseline.snapshotId).toBe('good');
      expect(await readFile(join(root, second.incidentRelativePath!), 'utf8')).toContain('reversal-detected');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rebuilds a malformed private baseline instead of breaking the official UI refresh path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ymai-ui-layer-corrupt-'));
    try {
      const directory = join(root, '.yuanmeng-inspector', 'ui');
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, 'layer-order-baseline.json'), JSON.stringify({
        schemaVersion: 1,
        projectInstanceId: '00000000-0000-4000-8000-000000000001',
        mapFingerprint: 'map-a',
        snapshotId: 'broken',
        createdAt: '2026-08-24T00:00:00.000Z',
        groups: [null],
      }), 'utf8');

      const result = await updateUiLayerOrderGuard(
        root,
        snapshot('recovered', ['1', '2', '3']),
        '2026-08-24T00:02:00.000Z',
        nodeFileIO,
      );

      expect(result.status.state).toBe('baseline-created');
      expect(result.baseline.snapshotId).toBe('recovered');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
