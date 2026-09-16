import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  createSceneChangeJournalEntry,
  listSceneChangeJournal,
  listSceneChangeJournalWithEvidence,
  loadSceneChangeJournalEntry,
  saveSceneChangeJournalEntry,
} from '../../src/core/scene/change-journal.js';
import { buildSceneAiContext, renderSceneAiContext, renderSceneExport } from '../../src/core/scene/export.js';
import { createScenePlacementPlan } from '../../src/core/scene/placement-plan.js';
import { nodeFileIO } from '../../src/core/fs.js';
import { sha256Hex, stableJson } from '../../src/core/hash.js';
import type { SceneInstance, SceneSnapshot, Transform } from '../../src/core/scene/types.js';

const evidence = { state: 'observed-repeatable' as const, source: 'anonymous-calibration', confidence: 0.9 };

function transform(x: number, y = 0, z = 0): Transform {
  return {
    position: { x, y, z },
    rotation: { x: 10 + x, y: 20, z: 30 },
    scale: { x: 1, y: 2, z: 3 },
  };
}

function instance(id: string, value: Transform, ownerId: string | null = null): SceneInstance {
  return {
    instanceId: id,
    elementTypeId: '7000',
    ownerId,
    variant: 'standard',
    evidence,
    transform: { state: 'observed', value, evidence },
    customProperties: { state: 'candidate', wirePaths: [], evidence },
    signals: { state: 'candidate', wirePaths: [], evidence },
    resources: { state: 'candidate', wirePaths: [], evidence },
    bounds: { state: 'candidate', wirePaths: [], evidence: { state: 'unknown', source: 'not-calibrated', confidence: 0 } },
    unknownFields: [],
  };
}

function snapshot(id: string, observedAt: string, instances: SceneInstance[]): SceneSnapshot {
  return {
    schemaVersion: 1,
    snapshotId: id,
    bindingId: 'b'.repeat(64),
    role: 'raw-pbin',
    sourceSha256: id,
    observedAt,
    adapterId: 'observed-v1',
    instances,
    groups: [],
    issues: [],
    unknownFields: [],
  };
}

describe('scene placement plan', () => {
  it('aligns each group bottom to a trusted support top with full transform rollback', () => {
    const floor = instance('900', transform(0, 0, 0));
    const left = instance('101', transform(1, 0, 5), '800');
    const right = instance('102', transform(3, 0, 6), '800');
    floor.bounds = { state: 'observed', value: { min: { x: -10, y: -10, z: 0 }, max: { x: 10, y: 10, z: 1 }, evidence }, evidence };
    left.bounds = { state: 'observed', value: { min: { x: 0, y: -1, z: 4 }, max: { x: 2, y: 1, z: 6 }, evidence }, evidence };
    right.bounds = { state: 'observed', value: { min: { x: 2, y: -1, z: 5 }, max: { x: 4, y: 1, z: 7 }, evidence }, evidence };
    const scene = snapshot('0'.repeat(64), '2026-08-21T00:00:00.000Z', [floor, left, right]);
    scene.groups = [{ groupId: '800', memberIds: ['101', '102'], nestedGroupIds: [], evidence }];

    const plan = createScenePlacementPlan(scene, { kind: 'floor-align', supportId: '900', targetIds: ['101'] });

    expect(plan).toMatchObject({ status: 'ready', execute: false, operation: 'floor-align', referenceIds: ['900'] });
    expect(plan.changes.map((change) => ({ id: change.instanceId, z: change.newTransform.position.z, mask: change.mask }))).toEqual([
      { id: '101', z: 2, mask: ['position.z'] },
      { id: '102', z: 3, mask: ['position.z'] },
    ]);
    expect(plan.rollback.changes[0]).toMatchObject({ oldTransform: plan.changes[0]!.newTransform, newTransform: plan.changes[0]!.oldTransform });
  });

  it('applies only selected batch-offset components and includes rollback without mutating input', () => {
    const original = instance('101', transform(1, 2, 3));
    const scene = snapshot('1'.repeat(64), '2026-08-21T00:00:00.000Z', [original]);

    const plan = createScenePlacementPlan(scene, {
      kind: 'batch-offset',
      targetIds: ['101'],
      components: {
        position: { z: 5 },
        rotation: { x: -2 },
        scale: { y: 0.5 },
      },
    });

    expect(plan.status).toBe('ready');
    expect(plan.execute).toBe(false);
    expect(plan.changes).toEqual([expect.objectContaining({
      instanceId: '101',
      mask: ['position.z', 'rotation.x', 'scale.y'],
      oldTransform: transform(1, 2, 3),
      newTransform: {
        position: { x: 1, y: 2, z: 8 },
        rotation: { x: 9, y: 20, z: 30 },
        scale: { x: 1, y: 2.5, z: 3 },
      },
      delta: {
        position: { x: 0, y: 0, z: 5 },
        rotation: { x: -2, y: 0, z: 0 },
        scale: { x: 0, y: 0.5, z: 0 },
      },
    })]);
    expect(plan.rollback.changes[0]).toMatchObject({
      instanceId: '101',
      oldTransform: plan.changes[0]!.newTransform,
      newTransform: plan.changes[0]!.oldTransform,
    });
    expect(original.transform).toEqual({ state: 'observed', value: transform(1, 2, 3), evidence });
  });

  it('supports axis align, equal spacing, grid, rows and columns while preserving grouped relative offsets', () => {
    const members = [
      instance('101', transform(0, 0), '900'),
      instance('102', transform(2, 0), '900'),
      instance('103', transform(10, 1)),
      instance('104', transform(30, 2)),
    ];
    const scene = snapshot('2'.repeat(64), '2026-08-21T00:01:00.000Z', members);
    scene.groups = [{ groupId: '900', memberIds: ['101', '102'], nestedGroupIds: [], evidence }];
    if (scene.instances[2]!.transform.state !== 'observed') throw new Error('fixture transform missing');
    scene.instances[2]!.transform.evidence = { ...evidence, confidence: 0.8 };

    const aligned = createScenePlacementPlan(scene, {
      kind: 'axis-align', targetIds: ['900'], referenceId: '103', axis: 'x', anchor: 'position',
    });
    expect(aligned.changes.map((change) => [change.instanceId, change.delta.position.x])).toEqual([['101', 9], ['102', 9]]);
    expect(aligned.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ confidence: 0.8 }),
      expect.objectContaining({ confidence: 0.9 }),
    ]));

    const spaced = createScenePlacementPlan(scene, {
      kind: 'equal-spacing', targetIds: ['101', '103', '104'], axis: 'x', mode: 'position',
    });
    expect(spaced.changes.find((change) => change.instanceId === '103')?.newTransform.position.x).toBe(15.5);

    for (const request of [
      { kind: 'grid' as const, targetIds: ['101', '103', '104'], rowAxis: 'y' as const, columnAxis: 'x' as const, columns: 2, rowSpacing: 4, columnSpacing: 5 },
      { kind: 'rows' as const, targetIds: ['101', '103', '104'], axis: 'x' as const, spacing: 5 },
      { kind: 'columns' as const, targetIds: ['101', '103', '104'], axis: 'y' as const, spacing: 4 },
    ]) {
      const plan = createScenePlacementPlan(scene, request);
      expect(plan.status).toBe('ready');
      expect(plan.changes).toHaveLength(4); // 101 自动扩展为完整 900 编组，保持组内相对结构。
    }
  });

  it('returns deterministic AMBIGUOUS for duplicate target IDs and blocks bounds anchors without trusted bounds', () => {
    const duplicateScene = snapshot('3'.repeat(64), '2026-08-21T00:02:00.000Z', [
      instance('101', transform(0)),
      instance('101', transform(1)),
      instance('102', transform(2)),
    ]);
    expect(() => createScenePlacementPlan(duplicateScene, {
      kind: 'batch-offset', targetIds: ['101'], components: { position: { x: 1 } },
    })).toThrowError(expect.objectContaining({ code: 'SCENE_EVIDENCE_INSUFFICIENT', message: expect.stringContaining('重复') }));

    const scene = snapshot('4'.repeat(64), '2026-08-21T00:03:00.000Z', [instance('101', transform(0)), instance('102', transform(2))]);
    const blocked = createScenePlacementPlan(scene, {
      kind: 'axis-align', targetIds: ['101'], referenceId: '102', axis: 'z', anchor: 'min',
    });
    expect(blocked).toMatchObject({ status: 'evidence-insufficient', execute: false, changes: [], reasonCode: 'BOUNDS_EVIDENCE_REQUIRED' });
    expect(blocked.risks).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'BOUNDS_UNAVAILABLE' })]));
  });

  it('recursively expands nested groups once even when nesting repeats or cycles', () => {
    const scene = snapshot('7'.repeat(64), '2026-08-21T00:05:00.000Z', [
      instance('101', transform(1), '900'),
      instance('102', transform(2), '901'),
      instance('103', transform(3), '902'),
    ]);
    scene.groups = [
      { groupId: '900', memberIds: ['101'], nestedGroupIds: ['901', '901'], evidence },
      { groupId: '901', memberIds: ['102'], nestedGroupIds: ['902'], evidence },
      { groupId: '902', memberIds: ['103', '101'], nestedGroupIds: ['900'], evidence },
    ];
    const plan = createScenePlacementPlan(scene, {
      kind: 'batch-offset', targetIds: ['900'], components: { position: { z: 1 } },
    });
    expect(plan.affectedInstanceIds).toEqual(['101', '102', '103']);
    expect(plan.changes).toHaveLength(3);
  });

  it('includes unique owner-derived members that are absent from the explicit group member list', () => {
    const scene = snapshot('a'.repeat(64), '2026-08-21T00:06:00.000Z', [
      instance('101', transform(1), '900'),
      instance('102', transform(2), '900'),
    ]);
    scene.groups = [{ groupId: '900', memberIds: ['101'], nestedGroupIds: [], evidence }];
    const plan = createScenePlacementPlan(scene, {
      kind: 'batch-offset', targetIds: ['900'], components: { position: { z: 5 } },
    });
    expect(plan.changes.map((change) => change.instanceId)).toEqual(['101', '102']);
  });

  it('rejects partially overlapping target groups instead of emitting two changes for one instance', () => {
    const scene = snapshot('8'.repeat(64), '2026-08-21T00:06:00.000Z', [
      instance('101', transform(1)), instance('102', transform(2)), instance('103', transform(3)),
    ]);
    scene.groups = [
      { groupId: '900', memberIds: ['101', '102'], nestedGroupIds: [], evidence },
      { groupId: '901', memberIds: ['102', '103'], nestedGroupIds: [], evidence },
    ];
    expect(() => createScenePlacementPlan(scene, {
      kind: 'batch-offset', targetIds: ['900', '901'], components: { position: { x: 1 } },
    })).toThrowError(expect.objectContaining({ code: 'SCENE_EVIDENCE_INSUFFICIENT', message: expect.stringContaining('重叠') }));
  });
});

describe('content-addressed scene change journal', () => {
  it('stores one atomic summary for the same lineage and reuses the same journal ID idempotently', async () => {
    const before = snapshot('a'.repeat(64), '2026-08-21T00:00:00.000Z', [instance('101', transform(1))]);
    const changed = instance('101', transform(1));
    if (changed.transform.state !== 'observed') throw new Error('fixture transform missing');
    changed.transform.value.position.x = 2;
    const after = snapshot('c'.repeat(64), '2026-08-21T00:01:00.000Z', [changed]);
    const entry = createSceneChangeJournalEntry(before, after);
    expect(entry).toMatchObject({
      schemaVersion: 1,
      bindingId: before.bindingId,
      fromSnapshotId: before.snapshotId,
      toSnapshotId: after.snapshotId,
      changeCount: 1,
      summary: [{ kind: 'position', count: 1 }],
    });
    expect(JSON.stringify(entry)).not.toMatch(/[A-Za-z]:[\\/]/u);
    expect(JSON.stringify(entry)).not.toContain('unknownFields');

    const root = await mkdtemp(join(tmpdir(), 'ymai-journal-'));
    await saveSceneChangeJournalEntry(root, entry, nodeFileIO);
    await saveSceneChangeJournalEntry(root, createSceneChangeJournalEntry(before, after), nodeFileIO);
    const files = await readdir(join(root, '.yuanmeng-inspector', 'scene', 'journal'));
    expect(files.filter((name) => /^[a-f0-9]{64}\.json$/u.test(name))).toEqual([`${entry.journalId}.json`]);
    expect(files).toContain('index.json');
    expect(await loadSceneChangeJournalEntry(root, entry.journalId, nodeFileIO)).toEqual(entry);
    expect(await listSceneChangeJournal(root, nodeFileIO, { bindingId: before.bindingId, role: before.role, adapterId: before.adapterId, limit: 10 })).toEqual([entry]);
    expect(await readFile(join(root, '.yuanmeng-inspector', 'scene', 'journal', `${entry.journalId}.json`), 'utf8')).toContain(entry.journalId);
  });

  it('rejects a cross-lineage journal instead of silently merging timelines', () => {
    const before = snapshot('d'.repeat(64), '2026-08-21T00:00:00.000Z', [instance('101', transform(1))]);
    const after = { ...snapshot('e'.repeat(64), '2026-08-21T00:01:00.000Z', [instance('101', transform(2))]), bindingId: 'f'.repeat(64) };
    expect(() => createSceneChangeJournalEntry(before, after)).toThrowError(expect.objectContaining({ code: 'SCENE_SOURCE_CONFLICT' }));
  });

  it('rejects unknown or duplicate summary kinds even when the content hash was recomputed', async () => {
    const before = snapshot('3'.repeat(64), '2026-08-21T00:00:00.000Z', [instance('101', transform(1))]);
    const after = snapshot('4'.repeat(64), '2026-08-21T00:01:00.000Z', [instance('101', transform(2))]);
    const original = createSceneChangeJournalEntry(before, after);
    for (const summary of [
      [{ kind: 'not-a-change', count: 1 }],
      [{ kind: 'position', count: 1 }, { kind: 'position', count: 1 }],
    ]) {
      const base = { ...original, journalId: undefined };
      const body = { ...base, changeCount: summary.length, summary };
      const tampered = { ...body, journalId: sha256Hex(stableJson(body)) };
      await expect(saveSceneChangeJournalEntry(await mkdtemp(join(tmpdir(), 'ymai-journal-invalid-')), tampered as never, nodeFileIO))
        .rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    }
  });

  it('walks only the current snapshot lineage and ignores old branches', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ymai-journal-lineage-'));
    const a = snapshot('a'.repeat(64), '2026-08-21T00:00:00.000Z', [instance('101', transform(1))]);
    const b = snapshot('b'.repeat(64), '2026-08-21T00:01:00.000Z', [instance('101', transform(2))]);
    const c = snapshot('c'.repeat(64), '2026-08-21T00:02:00.000Z', [instance('101', transform(3))]);
    const x = snapshot('d'.repeat(64), '2026-08-20T00:00:00.000Z', [instance('101', transform(4))]);
    const y = snapshot('e'.repeat(64), '2026-08-20T00:01:00.000Z', [instance('101', transform(5))]);
    for (const entry of [createSceneChangeJournalEntry(a, b), createSceneChangeJournalEntry(b, c), createSceneChangeJournalEntry(x, y)]) {
      await saveSceneChangeJournalEntry(root, entry, nodeFileIO);
    }
    const result = await listSceneChangeJournalWithEvidence(root, nodeFileIO, {
      bindingId: a.bindingId, role: a.role, adapterId: a.adapterId, currentSnapshotId: c.snapshotId, limit: 200,
    });
    expect(result.status).toBe('complete');
    expect(result.entries.map((entry) => [entry.fromSnapshotId, entry.toSnapshotId])).toEqual([
      [b.snapshotId, c.snapshotId], [a.snapshotId, b.snapshotId],
    ]);
  });

  it('marks a disconnected current snapshot as evidence-insufficient instead of showing an old branch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ymai-journal-disconnected-'));
    const a = snapshot('a'.repeat(64), '2026-08-21T00:00:00.000Z', [instance('101', transform(1))]);
    const b = snapshot('b'.repeat(64), '2026-08-21T00:01:00.000Z', [instance('101', transform(2))]);
    const current = snapshot('c'.repeat(64), '2026-08-21T00:02:00.000Z', [instance('101', transform(3))]);
    await saveSceneChangeJournalEntry(root, createSceneChangeJournalEntry(a, b), nodeFileIO);
    const result = await listSceneChangeJournalWithEvidence(root, nodeFileIO, {
      bindingId: a.bindingId, role: a.role, adapterId: a.adapterId, currentSnapshotId: current.snapshotId, limit: 200,
    });
    expect(result).toMatchObject({ status: 'evidence-insufficient', entries: [] });
    expect(result.diagnostics.join('\n')).toMatch(/断开|不连续/u);
  });

  it('isolates a corrupt selected journal entry and returns evidence-insufficient', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ymai-journal-corrupt-'));
    const a = snapshot('1'.repeat(64), '2026-08-21T00:00:00.000Z', [instance('101', transform(1))]);
    const b = snapshot('2'.repeat(64), '2026-08-21T00:01:00.000Z', [instance('101', transform(2))]);
    const entry = createSceneChangeJournalEntry(a, b);
    await saveSceneChangeJournalEntry(root, entry, nodeFileIO);
    await import('node:fs/promises').then(({ writeFile }) => writeFile(
      join(root, '.yuanmeng-inspector', 'scene', 'journal', `${entry.journalId}.json`), '{', 'utf8',
    ));
    const result = await listSceneChangeJournalWithEvidence(root, nodeFileIO, {
      bindingId: a.bindingId, role: a.role, adapterId: a.adapterId, currentSnapshotId: b.snapshotId, limit: 200,
    });
    expect(result).toMatchObject({ status: 'evidence-insufficient', entries: [] });
    expect(result.diagnostics).toHaveLength(1);
  });
});

describe('AI scene export context', () => {
  it('includes observed v6 properties, signals and root metadata in private CSV/Markdown exports', () => {
    const scene = snapshot('4'.repeat(64), '2026-08-21T00:03:00.000Z', [instance('901', transform(1))]);
    scene.instances[0]!.customProperties = { state: 'observed', value: [{ key: '测试立方体', value: { kind: 'number', value: 66 } }], evidence };
    scene.instances[0]!.signals = { state: 'observed', value: [{ name: '测试冰箱' }], evidence };
    scene.signalRegistry = { state: 'observed', value: [{ name: '测试冰箱', unknownRefCount: 1 }], evidence };
    scene.sceneMetadata = {
      layerName: { state: 'observed', value: '主图层', evidence },
      editorVersionCandidate: { state: 'observed', value: '1.5.82.106', evidence },
      instanceIndex: { state: 'absent' },
    };
    scene.groups = [{
      groupId: '908', memberIds: ['901'], nestedGroupIds: ['909'], parentGroupId: '900', evidence,
      transform: { state: 'observed', value: transform(9, 8, 7), evidence },
      metadata: { state: 'observed', value: { opaqueRef: 'opaque', rawKind: 'candidate-kind', labelCandidate: '货柜候选' }, evidence },
      unknownFields: [{ path: '$.group.1', wireType: 2, length: 4, sha256: 'a'.repeat(64) }],
    }];
    const csv = renderSceneExport(scene, 'csv');
    const markdown = renderSceneExport(scene, 'md');
    expect(csv).toContain('recordKind,recordId');
    expect(csv).toContain('测试立方体');
    expect(csv).toContain('测试冰箱');
    expect(csv).toContain('scene-root');
    expect(csv).toContain('scene-group,908');
    expect(csv).toContain('货柜候选');
    expect(csv).toContain('主图层');
    expect(markdown).toContain('根信号：测试冰箱');
    expect(markdown).toContain('图层名称候选：主图层');
    expect(markdown).toContain('场景版本文本候选：1.5.82.106');
    expect(markdown).toContain('## 编组明细');
    expect(markdown).toContain('| 908 | 900 | 901 | 909 |');
  });

  it('contains fingerprints and evidence context but no raw IDs, paths or instance payloads', () => {
    const scene = snapshot('5'.repeat(64), '2026-08-21T00:04:00.000Z', [instance('901', transform(1))]);
    const context = buildSceneAiContext({
      projectFingerprint: '6'.repeat(64),
      snapshot: scene,
      query: { kind: 'instance-id', value: '901' },
      matches: scene.instances,
      nextActions: ['在官方编辑器复核当前结果'],
    });
    expect(Object.keys(context).sort()).toEqual(['ambiguity', 'binding', 'evidence', 'fingerprints', 'nextActions', 'query', 'snapshot']);
    const rendered = renderSceneAiContext(context, 'json');
    expect(rendered).not.toContain('901');
    expect(rendered).not.toContain('instanceId');
    expect(rendered).not.toMatch(/[A-Za-z]:[\\/]/u);
    expect(rendered).toContain(scene.snapshotId);
    expect(context.query).toMatchObject({ kind: 'instance-id', valueSha256: expect.stringMatching(/^[a-f0-9]{64}$/u), resultCount: 1 });
  });
});
