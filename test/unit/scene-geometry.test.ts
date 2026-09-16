import { describe, expect, it } from 'vitest';

import { querySceneGeometry } from '../../src/core/scene/geometry.js';
import type { AxisAlignedBounds, FieldEvidence, SceneInstance, SceneSnapshot } from '../../src/core/scene/types.js';

const evidence: FieldEvidence = { state: 'confirmed-calibration', source: 'unit-fixture', confidence: 1 };

function bounds(min: [number, number, number], max: [number, number, number]): AxisAlignedBounds {
  return {
    min: { x: min[0], y: min[1], z: min[2] },
    max: { x: max[0], y: max[1], z: max[2] },
    evidence,
  };
}

function instance(instanceId: string, ownerId: string | null, value: AxisAlignedBounds): SceneInstance {
  return {
    instanceId,
    ownerId,
    elementTypeId: '7000',
    variant: 'standard',
    evidence,
    transform: { state: 'absent' },
    customProperties: { state: 'absent' },
    signals: { state: 'absent' },
    resources: { state: 'absent' },
    bounds: { state: 'observed', value, evidence },
    unknownFields: [],
  };
}

function snapshot(): SceneSnapshot {
  return {
    schemaVersion: 1,
    snapshotId: 'a'.repeat(64),
    bindingId: 'b'.repeat(64),
    role: 'raw-pbin',
    sourceSha256: 'c'.repeat(64),
    observedAt: '2026-08-23T00:00:00.000Z',
    adapterId: 'confirmed-fixture',
    instances: [
      instance('509', null, bounds([-10, -10, 0], [10, 10, 1])),
      instance('510', '513', bounds([0, 0, 1], [2, 2, 4])),
      instance('511', '513', bounds([4, 0, 1], [6, 2, 3])),
      instance('600', null, bounds([6, 0, 1], [8, 2, 3])),
      instance('601', null, bounds([5.5, 0, 1], [7, 2, 3])),
    ],
    groups: [{ groupId: '513', memberIds: ['510', '511'], nestedGroupIds: [], evidence }],
    issues: [],
    unknownFields: [],
  };
}

describe('scene geometry query', () => {
  it('unions trusted recursive group member bounds without inventing a group box', () => {
    expect(querySceneGeometry(snapshot(), { operation: 'bounds', targetId: '513' })).toMatchObject({
      operation: 'bounds',
      target: {
        targetId: '513', kind: 'group', memberInstanceIds: ['510', '511'],
        bounds: { min: { x: 0, y: 0, z: 1 }, max: { x: 6, y: 2, z: 4 } },
        center: { x: 3, y: 1, z: 2.5 },
        size: { x: 6, y: 2, z: 3 },
      },
    });
  });

  it('classifies exact contact, floating and penetration against a support top', () => {
    expect(querySceneGeometry(snapshot(), { operation: 'contact', targetId: '513', supportId: '509', tolerance: 0.1 })).toMatchObject({
      contact: { status: 'aligned', deltaZ: 0, horizontalOverlap: true },
    });
    const scene = snapshot();
    const target = scene.instances.find((item) => item.instanceId === '510')!;
    if (target.bounds.state !== 'observed') throw new Error('fixture bounds missing');
    target.bounds.value.min.z = 1.2;
    target.bounds.value.max.z = 4.2;
    const floating = querySceneGeometry(scene, { operation: 'contact', targetId: '510', supportId: '509', tolerance: 0.1 });
    expect(floating).toMatchObject({ contact: { status: 'floating' } });
    if (floating.operation !== 'contact') throw new Error('unexpected result');
    expect(floating.contact.deltaZ).toBeCloseTo(0.2);
    target.bounds.value.min.z = 0.7;
    const penetrating = querySceneGeometry(scene, { operation: 'contact', targetId: '510', supportId: '509', tolerance: 0.1 });
    expect(penetrating).toMatchObject({ contact: { status: 'penetrating' } });
    if (penetrating.operation !== 'contact') throw new Error('unexpected result');
    expect(penetrating.contact.deltaZ).toBeCloseTo(-0.3);
  });

  it('does not report boundary contact as penetration but reports strict volume overlap', () => {
    expect(querySceneGeometry(snapshot(), { operation: 'overlaps', targetIds: ['513', '600'] })).toMatchObject({
      overlaps: [],
    });
    expect(querySceneGeometry(snapshot(), { operation: 'overlaps', targetIds: ['513', '601'] })).toMatchObject({
      overlaps: [{ leftTargetId: '513', leftInstanceId: '511', rightTargetId: '601', rightInstanceId: '601' }],
    });
  });

  it('fails closed when an included instance lacks trusted observed bounds', () => {
    const scene = snapshot();
    scene.instances.find((item) => item.instanceId === '511')!.bounds = {
      state: 'candidate', wirePaths: ['6.1'], evidence: { ...evidence, state: 'inferred-candidate' },
    };
    expect(() => querySceneGeometry(scene, { operation: 'bounds', targetId: '513' })).toThrowError(
      expect.objectContaining({ code: 'SCENE_EVIDENCE_INSUFFICIENT' }),
    );
  });
});
