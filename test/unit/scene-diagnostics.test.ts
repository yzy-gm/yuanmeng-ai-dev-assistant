import { describe, expect, it } from 'vitest';

import {
  analyzeSceneSpatialProblems,
  auditSceneSnapshot,
  compactSceneAuditResult,
  inspectSceneInstanceFields,
} from '../../src/core/scene/diagnostics.js';
import type { RegistryRecord } from '../../src/core/model.js';
import type { SceneInstance, SceneSnapshot } from '../../src/core/scene/types.js';

const evidence = { state: 'observed-repeatable' as const, source: 'anonymous-calibration', confidence: 0.9 };

function instance(id: string): SceneInstance {
  return {
    instanceId: id,
    elementTypeId: '7000',
    ownerId: null,
    variant: 'standard',
    evidence,
    transform: {
      state: 'observed',
      value: {
        position: { x: 1, y: 2, z: 3 },
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
      },
      evidence,
    },
    customProperties: { state: 'candidate', wirePaths: ['6.1'], evidence: { state: 'inferred-candidate', source: 'anonymous-wire', confidence: 0.4 } },
    signals: { state: 'unsupported', reason: 'adapter-does-not-expose-signals' },
    resources: { state: 'observed', value: [], evidence },
    bounds: { state: 'absent' },
    unknownFields: [],
  };
}

function snapshot(instances: SceneInstance[]): SceneSnapshot {
  return {
    schemaVersion: 1,
    snapshotId: 'a'.repeat(64),
    bindingId: 'b'.repeat(64),
    role: 'raw-pbin',
    sourceSha256: 'c'.repeat(64),
    observedAt: '2026-08-21T00:00:00.000Z',
    adapterId: 'observed-v1',
    instances,
    groups: [],
    issues: [],
    unknownFields: [],
  };
}

describe('scene evidence diagnostics', () => {
  it('distinguishes candidate, unsupported and absent fields without claiming a candidate is absent', () => {
    const fields = inspectSceneInstanceFields(instance('101'));

    expect(fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'transform', state: 'observed', reasonCode: 'FIELD_OBSERVED', evidence }),
      expect.objectContaining({ field: 'customProperties', state: 'candidate', reasonCode: 'EVIDENCE_INSUFFICIENT', wirePaths: ['6.1'] }),
      expect.objectContaining({ field: 'signals', state: 'unsupported', reasonCode: 'FIELD_UNSUPPORTED' }),
      expect.objectContaining({ field: 'bounds', state: 'absent', reasonCode: 'FIELD_ABSENT' }),
    ]));
    expect(fields.find((field) => field.field === 'customProperties')?.nextAction).toMatch(/探针|校准/u);
  });

  it('audits actionable problems while aggregating ordinary field-evidence gaps as coverage', () => {
    const first = instance('101');
    const second = instance('101');
    first.variant = 'unsupported-oneof-1';
    second.variant = 'unsupported-oneof-1';
    const current = snapshot([first, second]);
    current.issues = [{ code: 'ORPHAN_OWNER', message: '匿名 owner 不存在。', instanceId: '101' }];
    const suspected: RegistryRecord = {
      recordId: 'anonymous-suspected',
      kind: 'scene-instance',
      name: '匿名元件',
      value: '101',
      scope: 'workspace',
      projectInstanceId: '11111111-1111-4111-8111-111111111111',
      mapFingerprint: null,
      layerId: null,
      environment: 'unspecified',
      validity: 'suspected-change',
      source: {
        kind: 'source-scan', relativePath: null, sha256: 'd'.repeat(64), observedAt: '2026-08-21T00:00:00.000Z',
        officialExtensionVersion: null, evidence: 'STATIC_LOCAL',
      },
      lastConfirmedAt: null,
      notes: '',
    };

    const audit = auditSceneSnapshot(current, { registryRecords: [suspected] });
    const reasonCodes = audit.findings.map((finding) => finding.reasonCode);

    expect(reasonCodes).toEqual(expect.arrayContaining([
      'DUPLICATE_INSTANCE_ID',
      'SNAPSHOT_ORPHAN_OWNER',
      'UNSUPPORTED_INSTANCE_VARIANT',
      'REGISTRY_SUSPECTED_CHANGE',
    ]));
    expect(reasonCodes).not.toContain('EVIDENCE_INSUFFICIENT');
    expect(audit.summary).toMatchObject({ duplicateInstanceIds: 1, snapshotIssues: 1, registrySuspected: 1 });
    expect(audit.coverage).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'customProperties', observed: 0, candidate: 2, unsupported: 0, absent: 0 }),
      expect.objectContaining({ field: 'signals', observed: 0, candidate: 0, unsupported: 2, absent: 0 }),
    ]));
    expect(audit.totalFindingCount).toBe(audit.findings.length);

    const compact = compactSceneAuditResult(audit, { examplesPerGroup: 1 });
    expect(compact.totalFindingCount).toBe(audit.findings.length);
    expect(compact.findings.length).toBeLessThan(audit.findings.length);
    expect(compact.truncated).toBe(true);
    expect(compact.findingGroups.every((group) => group.sampleInstanceIds.length <= 1)).toBe(true);
  });

  it('reports only evidence-backed overlap as confirmed and separates probe-required or invalid spatial data', () => {
    const first = instance('101');
    const second = instance('102');
    const candidate = instance('103');
    first.bounds = { state: 'observed', evidence, value: { min: { x: 0, y: 0, z: 0 }, max: { x: 2, y: 2, z: 2 }, evidence } };
    second.bounds = { state: 'observed', evidence, value: { min: { x: 1, y: 1, z: 1 }, max: { x: 3, y: 3, z: 3 }, evidence } };
    candidate.bounds = { state: 'candidate', wirePaths: ['7.1'], evidence: { state: 'inferred-candidate', source: 'wire', confidence: 0.4 } };
    if (second.transform.state !== 'observed') throw new Error('fixture transform missing');
    second.transform.value.position.x = Number.POSITIVE_INFINITY;
    const current = snapshot([first, second, candidate]);
    current.groups = [{ groupId: '900', memberIds: ['101', '101'], nestedGroupIds: [], evidence }];

    const result = analyzeSceneSpatialProblems(current, { maxFindings: 100 });
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'AABB_VOLUME_OVERLAP', certainty: 'confirmed', instanceIds: ['101', '102'] }),
      expect.objectContaining({ code: 'BOUNDS_EVIDENCE_REQUIRED', certainty: 'needs-probe', instanceIds: ['103'] }),
      expect.objectContaining({ code: 'NON_FINITE_TRANSFORM', certainty: 'confirmed', instanceIds: ['102'] }),
      expect.objectContaining({ code: 'DUPLICATE_GROUP_MEMBER', certainty: 'confirmed', instanceIds: ['101'] }),
    ]));
    expect(result.truncated).toBe(false);
  });
});
