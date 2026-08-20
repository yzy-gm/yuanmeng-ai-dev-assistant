import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { FixedClock } from '../../src/core/clock.js';
import {
  EVIDENCE_LEVELS,
  FRESHNESS_VALUES,
  LINK_STATES,
  REGISTRY_ENVIRONMENTS,
  REGISTRY_KINDS,
  REGISTRY_SCOPES,
  REGISTRY_VALIDITIES,
  SOURCE_KINDS,
  UI_SOURCE_FILES,
  validateRegistryDocument,
  type RegistryDocument,
} from '../../src/core/model.js';

const source = {
  kind: 'user-entry',
  relativePath: null,
  sha256: 'a'.repeat(64),
  observedAt: '2026-08-19T00:00:00.000Z',
  officialExtensionVersion: null,
  evidence: 'USER_ATTESTED',
} as const;

describe('registry contract', () => {
  it('accepts every independent environment and validity combination', () => {
    for (const environment of REGISTRY_ENVIRONMENTS) {
      for (const validity of REGISTRY_VALIDITIES) {
        const document: RegistryDocument = {
          schemaVersion: 1,
          records: [{
            recordId: `${environment}-${validity}`,
            kind: 'ui-control',
            name: 'Fictional control',
            value: '41001',
            scope: 'map',
            projectInstanceId: '00000000-0000-4000-8000-000000000001',
            mapFingerprint: 'b'.repeat(64),
            layerId: null,
            environment,
            validity,
            source,
            lastConfirmedAt: null,
            notes: '',
          }],
        };

        expect(() => validateRegistryDocument(JSON.parse(JSON.stringify(document)))).not.toThrow();
      }
    }
  });

  it('rejects an unknown environment independently from validity', () => {
    const document = {
      schemaVersion: 1,
      records: [{
        recordId: 'bad-environment',
        kind: 'signal',
        name: 'Fictional signal',
        value: 'fictional_signal',
        scope: 'workspace',
        projectInstanceId: '00000000-0000-4000-8000-000000000001',
        mapFingerprint: null,
        layerId: null,
        environment: 'production',
        validity: 'confirmed',
        source,
        lastConfirmedAt: null,
        notes: '',
      }],
    };

    expect(() => validateRegistryDocument(document)).toThrowError(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
  });

  it('keeps TypeScript registry enums in parity with the JSON schema', async () => {
    const raw = await readFile(new URL('../../schemas/registry.schema.json', import.meta.url), 'utf8');
    const schema = JSON.parse(raw) as {
      $defs: {
        evidenceLevel: { enum: string[] };
        registryEnvironment: { enum: string[] };
        registryKind: { enum: string[] };
        registryScope: { enum: string[] };
        registryValidity: { enum: string[] };
        sourceKind: { enum: string[] };
      };
    };

    expect(schema.$defs.registryKind.enum).toEqual([...REGISTRY_KINDS]);
    expect(schema.$defs.registryEnvironment.enum).toEqual([...REGISTRY_ENVIRONMENTS]);
    expect(schema.$defs.registryValidity.enum).toEqual([...REGISTRY_VALIDITIES]);
    expect(schema.$defs.registryScope.enum).toEqual([...REGISTRY_SCOPES]);
    expect(schema.$defs.sourceKind.enum).toEqual([...SOURCE_KINDS]);
    expect(schema.$defs.evidenceLevel.enum).toEqual([...EVIDENCE_LEVELS]);
  });

  it('keeps status and UI enums in parity with their JSON schemas', async () => {
    const [statusRaw, uiRaw] = await Promise.all([
      readFile(new URL('../../schemas/status.schema.json', import.meta.url), 'utf8'),
      readFile(new URL('../../schemas/ui-snapshot.schema.json', import.meta.url), 'utf8'),
    ]);
    const statusSchema = JSON.parse(statusRaw) as {
      $defs: { freshness: { enum: string[] }; linkState: { enum: string[] } };
    };
    const uiSchema = JSON.parse(uiRaw) as {
      $defs: {
        evidenceLevel: { enum: string[] };
        sourceKind: { enum: string[] };
        uiSourceFile: { enum: string[] };
      };
    };

    expect(statusSchema.$defs.linkState.enum).toEqual([...LINK_STATES]);
    expect(statusSchema.$defs.freshness.enum).toEqual([...FRESHNESS_VALUES]);
    expect(uiSchema.$defs.sourceKind.enum).toEqual([...SOURCE_KINDS]);
    expect(uiSchema.$defs.evidenceLevel.enum).toEqual([...EVIDENCE_LEVELS]);
    expect(uiSchema.$defs.uiSourceFile.enum).toEqual([...UI_SOURCE_FILES]);
  });
});

describe('injectable clock', () => {
  it('returns the configured instant without sharing a mutable Date', () => {
    const clock = new FixedClock('2026-08-19T00:00:00.000Z');
    const first = clock.now();
    first.setUTCFullYear(2030);

    expect(clock.now().toISOString()).toBe('2026-08-19T00:00:00.000Z');
  });
});
