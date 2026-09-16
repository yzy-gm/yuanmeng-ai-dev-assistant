import { describe, expect, it } from 'vitest';

import type { RegistryDocument } from '../../src/core/model.js';
import { buildSceneRebindPreview } from '../../src/core/scene/rebind.js';
import { createSceneProbeToken, type SceneProbeEvidenceDocument } from '../../src/core/scene/probe-evidence.js';
import type { FieldEvidence, SceneInstance, SceneSnapshot } from '../../src/core/scene/types.js';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);
const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const evidence: FieldEvidence = { state: 'confirmed-calibration', source: 'test-calibration', confidence: 1 };

function instance(id: string, type: string, ownerId: string | null, x: number): SceneInstance {
  return {
    instanceId: id,
    elementTypeId: type,
    ownerId,
    variant: 'standard',
    evidence,
    transform: {
      state: 'observed',
      evidence,
      value: {
        position: { x, y: 2, z: 3 },
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
      },
    },
    customProperties: { state: 'absent' },
    signals: { state: 'absent' },
    resources: { state: 'absent' },
    bounds: { state: 'absent' },
    unknownFields: [],
  };
}

function snapshot(snapshotId: string, sourceSha256: string, instances: SceneInstance[]): SceneSnapshot {
  return {
    schemaVersion: 1,
    snapshotId,
    bindingId: HASH_C,
    role: 'raw-pbin',
    sourceSha256,
    observedAt: '2026-08-21T00:00:00.000Z',
    adapterId: 'ym-layerdata-observed-v1',
    instances,
    groups: [],
    issues: [],
    unknownFields: [],
  };
}

function registry(): RegistryDocument {
  return {
    schemaVersion: 1,
    records: [{
      recordId: 'scene-old',
      kind: 'scene-instance',
      name: 'private-object-name',
      value: '101',
      scope: 'map',
      projectInstanceId: PROJECT_ID,
      mapFingerprint: HASH_A,
      layerId: null,
      environment: 'test',
      validity: 'confirmed',
      source: {
        kind: 'user-entry', relativePath: null, sha256: HASH_A,
        observedAt: '2026-08-21T00:00:00.000Z', officialExtensionVersion: null, evidence: 'USER_ATTESTED',
      },
      lastConfirmedAt: '2026-08-21T00:00:00.000Z',
      notes: '',
    }],
  };
}

function propertyEvidence(
  scene: SceneSnapshot,
  id: string,
  propertyHash: string,
): SceneProbeEvidenceDocument {
  const context = {
    projectInstanceId: PROJECT_ID,
    bindingId: scene.bindingId,
    snapshotId: scene.snapshotId,
    sceneSourceSha256: scene.sourceSha256,
  };
  return {
    schemaVersion: 1,
    sourceHash: 'd'.repeat(64),
    importedAt: '2026-08-21T01:00:00.000Z',
    ...context,
    entries: [{
      kind: 'property-match',
      line: 1,
      token: createSceneProbeToken(context, 'property', [id]),
      snapshotId: scene.snapshotId,
      sceneSourceSha256: scene.sourceSha256,
      selectionIds: [id],
      id,
      status: 'match',
      propertyHash,
      propertyType: 'String',
    }],
    issues: [],
  };
}

describe('scene ID rebind preview', () => {
  it('selects one recreated instance only from calibrated type and transform evidence', () => {
    const before = snapshot(HASH_A, HASH_A, [instance('101', '7000', null, 10)]);
    const after = snapshot(HASH_B, HASH_B, [instance('201', '7000', null, 10.01)]);

    const preview = buildSceneRebindPreview(before, after, registry(), {
      positionTolerance: 0.1,
      rotationTolerance: 0.01,
      scaleTolerance: 0.01,
    });

    expect(preview.summary).toEqual({ unique: 1, ambiguous: 0, insufficient: 0 });
    expect(preview.mappings).toEqual([expect.objectContaining({
      oldId: '101',
      status: 'unique',
      selectedNewId: '201',
      candidates: [expect.objectContaining({
        newId: '201',
        score: 95,
        evidence: ['ELEMENT_TYPE_MATCH', 'OWNER_STRUCTURE_MATCH', 'TRANSFORM_MATCH'],
      })],
    })]);
  });

  it('uses only an exact-snapshot confirmed property probe as additional matching evidence', () => {
    const before = snapshot(HASH_A, HASH_A, [instance('101', '7000', null, 10)]);
    const afterCandidate = instance('201', '7000', '999', 500);
    const after = snapshot(HASH_B, HASH_B, [afterCandidate]);
    const propertyHash = 'e'.repeat(64);

    const preview = buildSceneRebindPreview(before, after, registry(), {
      propertyEvidence: {
        before: propertyEvidence(before, '101', propertyHash),
        after: propertyEvidence(after, '201', propertyHash),
      },
    });

    expect(preview.mappings[0]).toMatchObject({
      status: 'unique',
      selectedNewId: '201',
      candidates: [{
        newId: '201',
        score: 100,
        evidence: ['ELEMENT_TYPE_MATCH', 'PROPERTY_PROBE_MATCH'],
      }],
    });
  });

  it('rejects a many-to-one candidate collision instead of silently rebinding two old IDs', () => {
    const before = snapshot(HASH_A, HASH_A, [
      instance('101', '7000', null, 10),
      instance('102', '7000', null, 10),
    ]);
    const after = snapshot(HASH_B, HASH_B, [instance('201', '7000', null, 10)]);

    const preview = buildSceneRebindPreview(before, after, registry());

    expect(preview.summary).toEqual({ unique: 0, ambiguous: 2, insufficient: 0 });
    expect(preview.mappings.map((mapping) => ({
      oldId: mapping.oldId,
      status: mapping.status,
      selectedNewId: mapping.selectedNewId,
    }))).toEqual([
      { oldId: '101', status: 'ambiguous', selectedNewId: null },
      { oldId: '102', status: 'ambiguous', selectedNewId: null },
    ]);
  });

  it('keeps every equally qualified candidate and marks the old ID ambiguous', () => {
    const before = snapshot(HASH_A, HASH_A, [instance('101', '7000', null, 10)]);
    const after = snapshot(HASH_B, HASH_B, [
      instance('201', '7000', null, 10),
      instance('202', '7000', null, 10),
    ]);

    const preview = buildSceneRebindPreview(before, after, registry());

    expect(preview.mappings[0]).toMatchObject({
      status: 'ambiguous', selectedNewId: null,
      candidates: [{ newId: '201', score: 95 }, { newId: '202', score: 95 }],
    });
  });

  it('refuses duplicate instance IDs and bounded candidate-pair overflow', () => {
    const duplicate = snapshot(HASH_A, HASH_A, [
      instance('101', '7000', null, 10),
      instance('101', '7000', null, 20),
    ]);
    const after = snapshot(HASH_B, HASH_B, [instance('201', '7000', null, 10)]);
    expect(() => buildSceneRebindPreview(duplicate, after, registry()))
      .toThrowError(expect.objectContaining({ code: 'SCENE_EVIDENCE_INSUFFICIENT' }));

    const before = snapshot(HASH_A, HASH_A, [
      instance('101', '7000', null, 10), instance('102', '7000', null, 20),
    ]);
    const many = snapshot(HASH_B, HASH_B, [
      instance('201', '7000', null, 10), instance('202', '7000', null, 20),
    ]);
    expect(() => buildSceneRebindPreview(before, many, registry(), { maxCandidatePairs: 3 }))
      .toThrowError(expect.objectContaining({ code: 'SCENE_LIMIT_EXCEEDED' }));
  });

  it('reports insufficient evidence when calibrated type is the only match', () => {
    const before = snapshot(HASH_A, HASH_A, [instance('101', '7000', null, 10)]);
    const after = snapshot(HASH_B, HASH_B, [instance('201', '7000', '999', 500)]);

    expect(buildSceneRebindPreview(before, after, registry()).mappings[0]).toEqual({
      oldId: '101', status: 'insufficient', selectedNewId: null, candidates: [],
    });
  });

  it('uses calibrated group membership shape even when ownerId itself is root', () => {
    const sharedBefore = [instance('102', '9000', null, 0), instance('103', '9000', null, 1)];
    const sharedAfter = [instance('102', '9000', null, 0), instance('103', '9000', null, 1)];
    const before: SceneSnapshot = {
      ...snapshot(HASH_A, HASH_A, [instance('101', '7000', null, 10), ...sharedBefore]),
      groups: [{ groupId: '100', memberIds: ['101', '102', '103'], nestedGroupIds: [], evidence }],
    };
    const after: SceneSnapshot = {
      ...snapshot(HASH_B, HASH_B, [instance('201', '7000', null, 500), ...sharedAfter]),
      groups: [{ groupId: '200', memberIds: ['201', '102', '103'], nestedGroupIds: [], evidence }],
    };

    expect(buildSceneRebindPreview(before, after, registry()).mappings[0]).toMatchObject({
      status: 'unique', selectedNewId: '201',
      candidates: [{ newId: '201', score: 85, evidence: ['ELEMENT_TYPE_MATCH', 'OWNER_STRUCTURE_MATCH'] }],
    });
  });
});
