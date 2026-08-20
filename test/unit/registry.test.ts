import { describe, expect, it } from 'vitest';

import type {
  RegistryEnvironment,
  RegistryRecord,
  RegistryValidity,
  SourceEvidence,
  UiSnapshot,
} from '../../src/core/model.js';
import { REGISTRY_ENVIRONMENTS, REGISTRY_VALIDITIES } from '../../src/core/model.js';
import { RegistryStore } from '../../src/core/registry/store.js';

const PROJECT_A = '00000000-0000-4000-8000-000000000001';
const PROJECT_B = '00000000-0000-4000-8000-000000000002';
const MAP_A = 'a'.repeat(64);
const MAP_B = 'b'.repeat(64);

function source(kind: SourceEvidence['kind'] = 'user-entry'): SourceEvidence {
  return {
    kind,
    relativePath: null,
    sha256: 'c'.repeat(64),
    observedAt: '2026-08-20T00:00:00.000Z',
    officialExtensionVersion: null,
    evidence: 'UNIT_E2E',
  };
}

function record(overrides: Partial<RegistryRecord> = {}): RegistryRecord {
  return {
    recordId: 'record-a',
    kind: 'ui-control',
    name: '经验',
    value: '41001',
    scope: 'map',
    projectInstanceId: PROJECT_A,
    mapFingerprint: MAP_A,
    layerId: null,
    environment: 'unspecified',
    validity: 'pending',
    source: source(),
    lastConfirmedAt: null,
    notes: '',
    ...overrides,
  };
}

function snapshot(mapFingerprint: string | null = MAP_A): UiSnapshot {
  return {
    schemaVersion: 1,
    snapshotId: 'd'.repeat(64),
    createdAt: '2026-08-20T00:01:00.000Z',
    projectInstanceId: PROJECT_A,
    mapFingerprint,
    sources: [{ ...source('official-export'), relativePath: 'src/Data/CustomUIData.lua' }],
    nodes: [{
      id: '41001',
      name: '经验',
      type: 'Text',
      parentId: null,
      path: '/经验',
      depth: 0,
      siblingIndex: 0,
      sourceFile: 'src/Data/CustomUIData.lua',
      sourceRange: null,
    }],
    duplicateNames: [],
  };
}

describe('map-scoped registry state', () => {
  it('preserves all 12 independent environment and validity combinations', () => {
    const records = REGISTRY_ENVIRONMENTS.flatMap((environment) => REGISTRY_VALIDITIES.map((validity) => record({
      recordId: `${environment}-${validity}`,
      environment,
      validity,
    })));
    const store = new RegistryStore({ schemaVersion: 1, records });

    for (const environment of REGISTRY_ENVIRONMENTS) {
      for (const validity of REGISTRY_VALIDITIES) {
        expect(store.list({ environment, validity })).toEqual([
          expect.objectContaining({ environment, validity }),
        ]);
      }
    }
  });

  it('never promotes test or formal environment during UI sync', () => {
    const store = new RegistryStore({
      schemaVersion: 1,
      records: [
        record({ recordId: 'test-id', environment: 'test', validity: 'pending' }),
        record({ recordId: 'formal-id', environment: 'formal', validity: 'suspected-change', value: '41002' }),
      ],
    });

    const result = store.syncUiSnapshot(snapshot(), { fresh: true });

    expect(result.records.find((item) => item.recordId === 'test-id')).toMatchObject({
      environment: 'test',
      validity: 'confirmed',
    });
    expect(result.records.find((item) => item.recordId === 'formal-id')).toMatchObject({
      environment: 'formal',
      validity: 'suspected-change',
    });
  });

  it('updates the confirmation time when a fresh map-scoped snapshot confirms an existing ID', () => {
    const store = new RegistryStore({
      schemaVersion: 1,
      records: [record({
        environment: 'test',
        validity: 'pending',
        lastConfirmedAt: null,
      })],
    });

    const result = store.syncUiSnapshot(snapshot(), { fresh: true });

    expect(result.records[0]).toMatchObject({
      environment: 'test',
      validity: 'confirmed',
      lastConfirmedAt: '2026-08-20T00:01:00.000Z',
    });
  });

  it.each([
    { mapFingerprint: MAP_A, fresh: true, validity: 'confirmed' as RegistryValidity },
    { mapFingerprint: MAP_A, fresh: false, validity: 'pending' as RegistryValidity },
    { mapFingerprint: null, fresh: true, validity: 'pending' as RegistryValidity },
  ])('auto-registers UI IDs as unspecified/$validity', ({ mapFingerprint, fresh, validity }) => {
    const store = new RegistryStore({ schemaVersion: 1, records: [] });

    const result = store.syncUiSnapshot(snapshot(mapFingerprint), { fresh });

    expect(result.records).toEqual([
      expect.objectContaining({
        kind: 'ui-control',
        value: '41001',
        environment: 'unspecified',
        validity,
        mapFingerprint,
      }),
    ]);
  });

  it('marks disappeared UI records suspected-change without changing environment', () => {
    const store = new RegistryStore({
      schemaVersion: 1,
      records: [record({ environment: 'formal', validity: 'confirmed' })],
    });
    const empty = { ...snapshot(), nodes: [] };

    const result = store.markSuspectedChanges(empty);

    expect(result.records[0]).toMatchObject({ environment: 'formal', validity: 'suspected-change' });
  });

  it('excludes records from another project or map fingerprint', () => {
    const store = new RegistryStore({
      schemaVersion: 1,
      records: [
        record({ recordId: 'same', projectInstanceId: PROJECT_A, mapFingerprint: MAP_A }),
        record({ recordId: 'other-map', projectInstanceId: PROJECT_A, mapFingerprint: MAP_B }),
        record({ recordId: 'other-project', projectInstanceId: PROJECT_B, mapFingerprint: MAP_A }),
      ],
    });

    expect(store.usableForMap(PROJECT_A, MAP_A).map((item) => item.recordId)).toEqual(['same']);
  });
});

describe('property target eligibility', () => {
  const layer = record({
    recordId: 'layer',
    kind: 'scene-layer',
    name: '测试层',
    value: 'layer-a',
    environment: 'test',
    validity: 'confirmed',
  });
  const instance = record({
    recordId: 'instance',
    kind: 'scene-instance',
    name: '测试元件',
    value: 'instance-a',
    layerId: 'layer-a',
    environment: 'unspecified',
    validity: 'pending',
  });

  it('strictly matches a known map fingerprint', () => {
    const result = RegistryStore.propertyEligibility({
      projectInstanceId: PROJECT_A,
      mapFingerprint: MAP_A,
      records: [layer, instance],
    });

    expect(result).toMatchObject({ allowed: true, warning: null });
  });

  it('allows one user-entered test/unspecified pair when official map identity is unavailable', () => {
    const result = RegistryStore.propertyEligibility({
      projectInstanceId: PROJECT_A,
      mapFingerprint: null,
      records: [{ ...layer, mapFingerprint: null }, { ...instance, mapFingerprint: null }],
    });

    expect(result).toMatchObject({ allowed: true, warning: '地图身份未由官方确认' });
  });

  it.each([
    ['cross-project', [{ ...layer, mapFingerprint: null }, { ...instance, mapFingerprint: null, projectInstanceId: PROJECT_B }]],
    ['formal', [{ ...layer, mapFingerprint: null, environment: 'formal' as RegistryEnvironment }, { ...instance, mapFingerprint: null }]],
    ['invalid', [{ ...layer, mapFingerprint: null }, { ...instance, mapFingerprint: null, validity: 'invalid' as RegistryValidity }]],
    ['suspected-change', [{ ...layer, mapFingerprint: null, validity: 'suspected-change' as RegistryValidity }, { ...instance, mapFingerprint: null }]],
    ['non-user-entry', [{ ...layer, mapFingerprint: null, source: source('official-export') }, { ...instance, mapFingerprint: null }]],
    ['multiple-layers', [{ ...layer, mapFingerprint: null }, { ...layer, recordId: 'layer-2', mapFingerprint: null }, { ...instance, mapFingerprint: null }]],
    ['multiple-instances', [{ ...layer, mapFingerprint: null }, { ...instance, mapFingerprint: null }, { ...instance, recordId: 'instance-2', mapFingerprint: null }]],
  ])('rejects unknown-map target: %s', (_name, records) => {
    const before = structuredClone(records);

    expect(RegistryStore.propertyEligibility({
      projectInstanceId: PROJECT_A,
      mapFingerprint: null,
      records,
    })).toMatchObject({ allowed: false });
    expect(records).toEqual(before);
  });
});
