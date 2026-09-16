import { describe, expect, it } from 'vitest';

import { buildSceneRelations, pageSceneValues } from '../../src/core/scene/hierarchy.js';
import { createSceneIndex, queryScene, summarizeSceneSignalGroups } from '../../src/core/scene/index.js';
import { diffSceneSnapshots } from '../../src/core/scene/diff.js';
import {
  aabbCenter,
  aabbOverlap,
  aabbSpacing,
  aabbUnion,
  createFloorAlignmentPlan,
  findNearbySceneInstances,
  pointToAabbDistance,
} from '../../src/core/scene/spatial.js';
import type { SceneInstance, SceneSnapshot } from '../../src/core/scene/types.js';

const evidence = { state: 'observed-repeatable' as const, source: 'anonymous-calibration', confidence: 0.9 };

function instance(id: string, ownerId: string | null, x: number): SceneInstance {
  return {
    instanceId: id, elementTypeId: '7000', ownerId, variant: 'standard', evidence,
    transform: { state: 'observed', value: { position: { x, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } }, evidence },
    customProperties: { state: 'candidate', wirePaths: [], evidence }, signals: { state: 'candidate', wirePaths: [], evidence },
    resources: { state: 'candidate', wirePaths: [], evidence }, bounds: { state: 'absent' }, unknownFields: [],
  };
}

function snapshot(instances: SceneInstance[]): SceneSnapshot {
  return {
    schemaVersion: 1, snapshotId: `snapshot-${instances.map((item) => `${item.instanceId}:${item.transform.state === 'observed' ? item.transform.value.position.x : 0}`).join('-')}`,
    bindingId: 'binding-anonymous', role: 'raw-pbin', sourceSha256: 'c'.repeat(64), observedAt: '2026-08-21T00:00:00.000Z',
    adapterId: 'observed-v1', instances, groups: [{ groupId: '100', memberIds: ['101', '102'], nestedGroupIds: [], evidence }], issues: [], unknownFields: [],
  };
}

describe('scene relations and index', () => {
  it('resolves group members, ancestors and descendants and reports cycles/orphans', () => {
    const relations = buildSceneRelations(snapshot([instance('101', '100', 1), instance('102', '101', 2), instance('103', '999', 3)]));
    expect(relations.childrenByParent.get('100')).toEqual(['101']);
    expect(relations.ancestorsOf('102')).toEqual(['101', '100']);
    expect(relations.descendantsOf('100')).toEqual(['101', '102']);
    expect(relations.issues).toContainEqual(expect.objectContaining({ code: 'ORPHAN_OWNER', instanceId: '103' }));
  });

  it('includes nested groups in parent, ancestor and descendant relationships', () => {
    const scene = snapshot([
      instance('510', '513', 1),
      instance('511', '513', 2),
      instance('512', '513', 3),
      instance('517', '626', 4),
    ]);
    scene.groups = [
      { groupId: '513', memberIds: ['510', '511', '512'], nestedGroupIds: [], evidence },
      { groupId: '626', memberIds: ['517'], nestedGroupIds: ['513'], evidence },
    ];

    const relations = buildSceneRelations(scene);

    expect(relations.parentByChild.get('513')).toBe('626');
    expect(relations.childrenByParent.get('626')).toEqual(['513', '517']);
    expect(relations.ancestorsOf('510')).toEqual(['513', '626']);
    expect(relations.descendantsOf('626')).toEqual(['513', '510', '511', '512', '517']);
  });

  it('queries exact IDs and refuses ambiguous fuzzy results', () => {
    const index = createSceneIndex(snapshot([instance('101', '100', 1), instance('102', '100', 2)]));
    expect(queryScene(index, { instanceId: '101' })).toEqual({ kind: 'found', matches: [expect.objectContaining({ instanceId: '101' })] });
    expect(queryScene(index, { elementTypeId: '7000' })).toMatchObject({ kind: 'ambiguous', matches: [{ instanceId: '101' }, { instanceId: '102' }] });
  });

  it('indexes root signalRegistry records without collapsing duplicate names', () => {
    const scene = snapshot([instance('101', '100', 1)]);
    scene.signalRegistry = {
      state: 'observed',
      value: [
        { name: '根信号', unknownRefCount: 1, ambiguous: true },
        { name: '根信号', unknownRefCount: 2, ambiguous: true },
      ],
      evidence,
    };
    const index = createSceneIndex(scene);
    expect(index.bySignalRegistryName?.get('根信号')).toHaveLength(2);
  });

  it('indexes observed signal names and returns every matching instance without guessing candidates', () => {
    const first = instance('101', '100', 1);
    const second = instance('102', '100', 2);
    first.signals = { state: 'observed', value: [{ name: '测试冰箱' }], evidence };
    second.signals = { state: 'observed', value: [{ name: '测试冰箱' }, { name: '开门' }], evidence };
    const index = createSceneIndex(snapshot([first, second]));
    expect(index.bySignalName.get('测试冰箱')).toEqual([first, second]);
    expect(queryScene(index, { signalName: '开门' })).toEqual({ kind: 'found', matches: [second] });
  });

  it('groups repeated signal matches by unique owner group without claiming a confirmed player-made item', () => {
    const first = instance('101', '400', 1);
    const second = instance('102', '400', 2);
    const third = instance('201', '508', 3);
    for (const item of [first, second, third]) item.signals = { state: 'observed', value: [{ name: '测试冰箱' }], evidence };
    const scene = snapshot([first, second, third]);
    scene.groups = [
      { groupId: '400', memberIds: ['101', '102'], nestedGroupIds: [], evidence },
      { groupId: '508', memberIds: ['201', '202'], nestedGroupIds: [], evidence },
    ];
    const summary = summarizeSceneSignalGroups(createSceneIndex(scene), '测试冰箱');
    expect(summary.candidateGroups).toEqual([
      { groupId: '400', matchedMemberIds: ['101', '102'], recursiveMemberCount: 2, coverage: 'all-members-observed-with-signal' },
      { groupId: '508', matchedMemberIds: ['201'], recursiveMemberCount: 2, coverage: 'partial-members-observed-with-signal' },
    ]);
    expect(summary.warning).toContain('候选');
  });

  it('preserves every exact duplicate instance ID and reports the exact query as ambiguous', () => {
    const first = instance('101', '100', 1);
    const second = instance('101', '100', 2);
    const index = createSceneIndex(snapshot([first, second]));

    expect(index.byInstanceId.get('101')).toEqual([first, second]);
    expect(queryScene(index, { instanceId: '101' })).toEqual({ kind: 'ambiguous', matches: [first, second] });
  });

  it('does not fold duplicate instance or group IDs into authoritative hierarchy maps', () => {
    const scene = snapshot([
      instance('101', '900', 1),
      instance('101', '901', 2),
      instance('102', null, 3),
    ]);
    scene.groups = [
      { groupId: '900', memberIds: ['102'], nestedGroupIds: [], evidence },
      { groupId: '900', memberIds: ['101'], nestedGroupIds: [], evidence },
    ];
    const relations = buildSceneRelations(scene);
    expect(relations.parentByChild.has('101')).toBe(false);
    expect(relations.groupMembers.has('900')).toBe(false);
    expect(relations.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'DUPLICATE_INSTANCE', instanceId: '101' }),
      expect.objectContaining({ code: 'DUPLICATE_GROUP', instanceId: '900' }),
    ]));
  });

  it('walks a deep owner chain iteratively and reports self/cycle relationships once', () => {
    const instances = Array.from({ length: 12_000 }, (_value, index) => (
      instance(String(index), index === 0 ? null : String(index - 1), index)
    ));
    instances.push(instance('self', 'self', 0));
    instances.push(instance('cycle-a', 'cycle-b', 0));
    instances.push(instance('cycle-b', 'cycle-a', 0));
    const relations = buildSceneRelations(snapshot(instances));
    const descendants = relations.descendantsOf('0');
    expect(descendants).toHaveLength(11_999);
    expect(descendants.at(-1)).toBe('11999');
    expect(relations.issues.filter((issue) => issue.code === 'RELATION_CYCLE')).toEqual([
      expect.objectContaining({ instanceId: 'self' }),
      expect.objectContaining({ instanceId: 'cycle-a' }),
    ]);
  });

  it('pages 50k values without duplicates, omissions, or eager node creation', () => {
    const values = Array.from({ length: 50_000 }, (_value, index) => `instance-${index}`);
    const first = pageSceneValues(values, 0, 200);
    const second = pageSceneValues(values, first.nextOffset!, 200);
    const last = pageSceneValues(values, 49_800, 200);
    expect(first).toEqual({ values: values.slice(0, 200), nextOffset: 200, total: 50_000 });
    expect(second.values[0]).toBe('instance-200');
    expect(new Set([...first.values, ...second.values]).size).toBe(400);
    expect(last).toEqual({ values: values.slice(49_800), nextOffset: null, total: 50_000 });
  });
});

describe('scene diff and spatial plans', () => {
  it('rejects snapshots from different binding, role or adapter lineages', () => {
    const before = snapshot([instance('101', '100', 1)]);
    for (const after of [
      { ...before, snapshotId: 'other-binding', bindingId: 'binding-other' },
      { ...before, snapshotId: 'other-role', role: 'manual-dat' as const },
      { ...before, snapshotId: 'other-adapter', adapterId: 'candidate-v2' },
    ]) {
      expect(() => diffSceneSnapshots(before, after)).toThrowError(expect.objectContaining({ code: 'SCENE_SOURCE_CONFLICT' }));
    }
  });

  it('rejects duplicate instance or group IDs instead of last-write-wins diffing', () => {
    const before = snapshot([instance('101', '100', 1), instance('101', '100', 2)]);
    const after = snapshot([instance('101', '100', 3), instance('101', '100', 4)]);
    expect(() => diffSceneSnapshots(before, after)).toThrowError(expect.objectContaining({
      code: 'SCENE_EVIDENCE_INSUFFICIENT',
      message: expect.stringContaining('重复'),
    }));

    const uniqueBefore = snapshot([instance('101', '100', 1)]);
    const uniqueAfter = snapshot([instance('101', '100', 2)]);
    uniqueBefore.groups.push({ ...uniqueBefore.groups[0]!, memberIds: ['101'] });
    uniqueAfter.groups.push({ ...uniqueAfter.groups[0]!, memberIds: ['101'] });
    expect(() => diffSceneSnapshots(uniqueBefore, uniqueAfter)).toThrowError(expect.objectContaining({
      code: 'SCENE_EVIDENCE_INSUFFICIENT',
    }));
  });

  it('reports position, rotation and scale independently with per-component deltas and tolerances', () => {
    const before = snapshot([instance('101', '100', 1)]);
    const changed = structuredClone(before.instances[0]!);
    if (changed.transform.state !== 'observed') throw new Error('fixture transform missing');
    changed.transform.value = {
      position: { x: 1.02, y: 0.2, z: -0.3 },
      rotation: { x: 1, y: 2, z: 3 },
      scale: { x: 1.5, y: 2, z: 2.5 },
    };
    const after = { ...snapshot([changed]), bindingId: before.bindingId };

    const diff = diffSceneSnapshots(before, after, {
      positionTolerance: 0.05,
      rotationTolerance: 0.5,
      scaleTolerance: 0.25,
    });

    expect(diff.changes).toEqual([
      {
        kind: 'position', instanceId: '101',
        components: {
          y: { before: 0, after: 0.2, delta: 0.2 },
          z: { before: 0, after: -0.3, delta: -0.3 },
        },
      },
      {
        kind: 'rotation', instanceId: '101',
        components: {
          x: { before: 0, after: 1, delta: 1 },
          y: { before: 0, after: 2, delta: 2 },
          z: { before: 0, after: 3, delta: 3 },
        },
      },
      {
        kind: 'scale', instanceId: '101',
        components: {
          x: { before: 1, after: 1.5, delta: 0.5 },
          y: { before: 1, after: 2, delta: 1 },
          z: { before: 1, after: 2.5, delta: 1.5 },
        },
      },
    ]);
  });

  it('reports added and removed instances deterministically', () => {
    const before = snapshot([instance('101', '100', 1), instance('102', '100', 2)]);
    const after = snapshot([instance('101', '100', 4), instance('103', '100', 3)]);
    const diff = diffSceneSnapshots(before, after, { positionTolerance: 0.001 });
    expect(diff.changes.map((change) => `${change.kind}:${'instanceId' in change ? change.instanceId : ''}`)).toEqual(['removed:102', 'added:103', 'position:101']);
  });

  it('reports group, feature, unknown-field and evidence-only changes without raw values', () => {
    const beforeInstance = instance('101', '100', 1);
    beforeInstance.customProperties = { state: 'observed', value: [{ key: 'mode', value: 1 }], evidence };
    beforeInstance.signals = { state: 'candidate', wirePaths: ['6.1'], evidence };
    beforeInstance.bounds = {
      state: 'observed',
      value: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 }, evidence },
      evidence,
    };
    beforeInstance.unknownFields = [{ path: '8.1', wireType: 2, length: 3, sha256: 'd'.repeat(64) }];
    const before = snapshot([beforeInstance]);
    before.groups = [{
      groupId: '100', memberIds: ['101'], nestedGroupIds: [], evidence, parentGroupId: null,
      transform: { state: 'candidate', wirePaths: ['5.2.6'], evidence },
      metadata: { state: 'observed', value: { opaqueRef: 'hash-a', rawKind: '1', labelCandidate: null }, evidence },
      unknownFields: [{ path: '5.2.9', wireType: 2, length: 2, sha256: '1'.repeat(64) }],
    }];
    before.unknownFields = [{ path: '9', wireType: 2, length: 2, sha256: 'e'.repeat(64) }];
    before.signalRegistry = { state: 'observed', value: [{ name: 'before', unknownRefCount: 1 }], evidence };
    before.sceneMetadata = {
      layerName: { state: 'observed', value: 'before-layer', evidence },
      editorVersionCandidate: { state: 'absent' }, instanceIndex: { state: 'absent' },
    };

    const afterInstance = structuredClone(beforeInstance);
    afterInstance.evidence = { ...evidence, confidence: 0.8 };
    afterInstance.customProperties = {
      state: 'observed', value: [{ key: 'mode', value: 2 }], evidence: { ...evidence, confidence: 0.7 },
    };
    afterInstance.signals = { state: 'unsupported', reason: 'adapter-does-not-expose-signals' };
    afterInstance.resources = { state: 'observed', value: [{ resourceId: 'asset-anonymous' }], evidence };
    if (afterInstance.bounds.state !== 'observed') throw new Error('fixture bounds missing');
    afterInstance.bounds.value.evidence = { ...evidence, confidence: 0.5 };
    afterInstance.unknownFields = [{ path: '8.1', wireType: 2, length: 3, sha256: 'f'.repeat(64) }];
    const after = snapshot([afterInstance]);
    after.groups = [{
      groupId: '100', memberIds: ['101', '102'], nestedGroupIds: ['200'], evidence: { ...evidence, confidence: 0.6 }, parentGroupId: '300',
      transform: { state: 'observed', value: { position: { x: 1, y: 2, z: 3 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } }, evidence },
      metadata: { state: 'observed', value: { opaqueRef: 'hash-b', rawKind: '1', labelCandidate: 'candidate' }, evidence },
      unknownFields: [{ path: '5.2.9', wireType: 2, length: 2, sha256: '2'.repeat(64) }],
    }];
    after.unknownFields = [{ path: '9', wireType: 2, length: 2, sha256: 'a'.repeat(64) }];
    after.signalRegistry = { state: 'observed', value: [{ name: 'after', unknownRefCount: 2 }], evidence };
    after.sceneMetadata = {
      layerName: { state: 'observed', value: 'after-layer', evidence },
      editorVersionCandidate: { state: 'absent' }, instanceIndex: { state: 'absent' },
    };

    const diff = diffSceneSnapshots(before, after);

    expect(diff.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'group-members', groupId: '100', added: ['102'], removed: [] }),
      expect.objectContaining({ kind: 'group-nested', groupId: '100', added: ['200'], removed: [] }),
      expect.objectContaining({ kind: 'group-relation', groupId: '100', beforeParentGroupId: null, afterParentGroupId: '300' }),
      expect.objectContaining({ kind: 'group-feature', groupId: '100', field: 'transform' }),
      expect.objectContaining({ kind: 'group-feature', groupId: '100', field: 'metadata' }),
      expect.objectContaining({ kind: 'unknown-fields', scope: 'group', groupId: '100' }),
      expect.objectContaining({ kind: 'root-feature', field: 'signalRegistry' }),
      expect.objectContaining({ kind: 'root-feature', field: 'sceneMetadata' }),
      expect.objectContaining({ kind: 'feature', instanceId: '101', field: 'customProperties', before: { state: 'observed', count: 1, valueSha256: expect.any(String) }, after: { state: 'observed', count: 1, valueSha256: expect.any(String) } }),
      expect.objectContaining({ kind: 'feature', instanceId: '101', field: 'signals', before: { state: 'candidate', wirePaths: ['6.1'] }, after: { state: 'unsupported', reason: 'adapter-does-not-expose-signals' } }),
      expect.objectContaining({ kind: 'feature', instanceId: '101', field: 'resources', before: { state: 'candidate', wirePaths: [] }, after: { state: 'observed', count: 1, valueSha256: expect.any(String) } }),
      expect.objectContaining({ kind: 'unknown-fields', scope: 'instance', instanceId: '101', beforeSha256: expect.any(String), afterSha256: expect.any(String) }),
      expect.objectContaining({ kind: 'unknown-fields', scope: 'root', beforeSha256: expect.any(String), afterSha256: expect.any(String) }),
      expect.objectContaining({ kind: 'evidence', scope: 'instance', instanceId: '101', field: 'instance', before: evidence, after: { ...evidence, confidence: 0.8 } }),
      expect.objectContaining({ kind: 'evidence', scope: 'instance', instanceId: '101', field: 'customProperties', before: evidence, after: { ...evidence, confidence: 0.7 } }),
      expect.objectContaining({ kind: 'evidence', scope: 'instance', instanceId: '101', field: 'bounds.value', before: evidence, after: { ...evidence, confidence: 0.5 } }),
      expect.objectContaining({ kind: 'evidence', scope: 'group', groupId: '100', field: 'group', before: evidence, after: { ...evidence, confidence: 0.6 } }),
    ]));
    expect(JSON.stringify(diff)).not.toContain('asset-anonymous');
  });

  it('creates a Z-only group plan that keeps member relative structure', () => {
    const plan = createFloorAlignmentPlan({
      support: { instanceId: 'floor', min: { x: -10, y: -10, z: 0 }, max: { x: 10, y: 10, z: 1 }, evidence },
      movers: [
        { instanceId: '101', position: { x: 2, y: 0, z: 5 }, bounds: { min: { x: 1, y: -1, z: 4 }, max: { x: 3, y: 1, z: 6 }, evidence } },
        { instanceId: '102', position: { x: 4, y: 0, z: 6 }, bounds: { min: { x: 3, y: -1, z: 5 }, max: { x: 5, y: 1, z: 7 }, evidence } },
      ],
    });
    expect(plan.executable).toBe(true);
    expect(plan.deltaZ).toBe(-3);
    expect(plan.moves).toEqual([
      { instanceId: '101', from: { x: 2, y: 0, z: 5 }, to: { x: 2, y: 0, z: 2 } },
      { instanceId: '102', from: { x: 4, y: 0, z: 6 }, to: { x: 4, y: 0, z: 3 } },
    ]);
    expect(plan.rollback).toEqual({
      moves: [
        { instanceId: '101', from: { x: 2, y: 0, z: 2 }, to: { x: 2, y: 0, z: 5 } },
        { instanceId: '102', from: { x: 4, y: 0, z: 3 }, to: { x: 4, y: 0, z: 6 } },
      ],
    });
    expect(plan.risks).toEqual([]);
  });

  it('computes AABB center, union, point distance, overlap and spacing without origin fallbacks', () => {
    const left = { min: { x: 0, y: 0, z: 0 }, max: { x: 2, y: 2, z: 2 }, evidence };
    const right = { min: { x: 5, y: 1, z: 1 }, max: { x: 7, y: 3, z: 3 }, evidence };

    expect(aabbCenter(left)).toEqual({ x: 1, y: 1, z: 1 });
    expect(aabbUnion([left, right])).toEqual({ min: { x: 0, y: 0, z: 0 }, max: { x: 7, y: 3, z: 3 } });
    expect(pointToAabbDistance({ x: 4, y: 2, z: 2 }, left)).toBe(2);
    expect(aabbOverlap(left, right)).toBe(false);
    expect(aabbSpacing(left, right)).toBe(3);
    expect(aabbOverlap(left, { ...right, min: { x: 2, y: 1, z: 1 } })).toBe(true);
  });

  it('reports a simple mover overlap risk in floor plans', () => {
    const plan = createFloorAlignmentPlan({
      support: { instanceId: '900', min: { x: -10, y: -10, z: 0 }, max: { x: 10, y: 10, z: 1 }, evidence },
      movers: [
        { instanceId: '101', position: { x: 2, y: 0, z: 5 }, bounds: { min: { x: 1, y: -1, z: 4 }, max: { x: 4, y: 1, z: 6 }, evidence } },
        { instanceId: '102', position: { x: 4, y: 0, z: 6 }, bounds: { min: { x: 3, y: -1, z: 5 }, max: { x: 5, y: 1, z: 7 }, evidence } },
      ],
    });

    expect(plan.risks).toEqual([{ code: 'MOVER_BOUNDS_OVERLAP', instanceIds: ['101', '102'] }]);
  });

  it('sorts and limits nearby instances while degrading from bounds to observed point positions', () => {
    const target = instance('100', null, 0);
    target.bounds = { state: 'observed', value: { min: { x: -1, y: -1, z: -1 }, max: { x: 1, y: 1, z: 1 }, evidence }, evidence };
    const close = instance('102', null, 2);
    const sameDistanceLowerId = instance('101', null, -2);
    const far = instance('103', null, 8);
    const unavailable = instance('104', null, 0);
    unavailable.transform = { state: 'absent' };

    const result = findNearbySceneInstances(target, [far, close, unavailable, sameDistanceLowerId], { radius: 10, limit: 2 });

    expect(result.matches).toEqual([
      { instanceId: '101', distance: 1, method: 'bounds-point', overlap: false },
      { instanceId: '102', distance: 1, method: 'bounds-point', overlap: false },
    ]);
    expect(result.insufficientInstanceIds).toEqual(['104']);
  });

  it('rejects near queries whose target has neither observed bounds nor observed position', () => {
    const target = instance('100', null, 0);
    target.transform = { state: 'candidate', wirePaths: ['6.1'], evidence };
    target.bounds = { state: 'absent' };

    expect(() => findNearbySceneInstances(target, [], { radius: 10, limit: 5 })).toThrowError(
      expect.objectContaining({ code: 'SCENE_EVIDENCE_INSUFFICIENT' }),
    );
  });
});
