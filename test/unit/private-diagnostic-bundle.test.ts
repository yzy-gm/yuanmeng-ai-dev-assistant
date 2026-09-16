import { describe, expect, it } from 'vitest';

import {
  createAnonymousDiagnosticBundle,
  renderAnonymousDiagnosticBundle,
} from '../../src/core/diagnostics/private-bundle.js';
import { buildLuaSourceIndex } from '../../src/core/lua/source-index.js';
import type { RegistryDocument, UiSnapshot } from '../../src/core/model.js';
import type { FieldEvidence, SceneSnapshot } from '../../src/core/scene/types.js';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);
const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const evidence: FieldEvidence = { state: 'confirmed-calibration', source: 'private-calibration-name', confidence: 1 };

function registry(): RegistryDocument {
  return {
    schemaVersion: 1,
    records: [{
      recordId: 'private-record-id', kind: 'scene-instance', name: '超级秘密货柜', value: '509', scope: 'map',
      projectInstanceId: PROJECT_ID, mapFingerprint: HASH_A, layerId: null, environment: 'test', validity: 'confirmed',
      source: {
        kind: 'user-entry', relativePath: 'src/private-secret-name.lua', sha256: HASH_A,
        observedAt: '2026-08-21T00:00:00.000Z', officialExtensionVersion: null, evidence: 'USER_ATTESTED',
      },
      lastConfirmedAt: '2026-08-21T00:00:00.000Z', notes: 'token=TOP_SECRET_TOKEN',
    }],
  };
}

function scene(): SceneSnapshot {
  return {
    schemaVersion: 1, snapshotId: HASH_B, bindingId: HASH_C, role: 'raw-pbin', sourceSha256: HASH_A,
    observedAt: '2026-08-21T00:00:00.000Z', adapterId: 'private-adapter-name',
    instances: [{
      instanceId: '509', elementTypeId: '1101002001034000', ownerId: '513', variant: 'standard', evidence,
      transform: { state: 'absent' }, customProperties: { state: 'absent' }, signals: { state: 'absent' },
      resources: { state: 'absent' }, bounds: { state: 'absent' },
      unknownFields: [{ path: 'private.secret.path', wireType: 2, length: 16, sha256: HASH_C }],
    }],
    groups: [{ groupId: '513', memberIds: ['509'], nestedGroupIds: [], evidence }],
    issues: [{ code: 'ORPHAN_OWNER', message: 'contains private instance 509', instanceId: '509' }],
    unknownFields: [],
  };
}

function ui(): UiSnapshot {
  return {
    schemaVersion: 1, snapshotId: HASH_C, createdAt: '2026-08-21T00:00:00.000Z',
    projectInstanceId: PROJECT_ID, mapFingerprint: HASH_A, sources: [],
    nodes: [{
      id: '100113', name: '秘密积分控件', type: 'text', parentId: null, path: '/秘密积分控件', depth: 0,
      siblingIndex: 0, sourceFile: 'src/Data/CustomUIData.lua', sourceRange: null,
    }],
    duplicateNames: [{ name: '秘密积分控件', paths: ['/秘密积分控件', '/另一个秘密积分控件'] }],
  };
}

describe('private anonymous diagnostic bundle', () => {
  it('exports deterministic JSON and Markdown without IDs, paths, names, raw content or tokens', () => {
    const records = registry();
    const luaIndex = buildLuaSourceIndex([{
      path: 'src/private-secret-name.lua',
      source: '-- TOP_SECRET_TOKEN\nlocal SECRET_TARGET = 509\n',
    }], records, { calls: [], configuredIdFields: [] });
    const input = {
      pluginVersion: '0.2.0-private.1',
      protocolVersion: 'scene-v1',
      sceneSnapshot: scene(),
      uiSnapshot: ui(),
      registry: records,
      luaIndex,
      errors: [
        { code: 'SCENE_EVIDENCE_INSUFFICIENT' as const, evidence: 'STATIC_LOCAL' as const },
        { code: 'SCENE_EVIDENCE_INSUFFICIENT' as const, evidence: 'STATIC_LOCAL' as const },
      ],
      performanceSamples: [{ operation: 'scene-refresh' as const, itemCount: 1, durationMs: 12.3456, peakHeapBytes: 4096 }],
      nextActions: ['REFRESH_SCENE' as const, 'RUN_OFFICIAL_EDITOR_SINGLE' as const],
    };

    const first = createAnonymousDiagnosticBundle(input);
    const second = createAnonymousDiagnosticBundle(input);
    const json = renderAnonymousDiagnosticBundle(first, 'json');
    const markdown = renderAnonymousDiagnosticBundle(first, 'md');

    expect(second).toEqual(first);
    expect(renderAnonymousDiagnosticBundle(second, 'json')).toBe(json);
    expect(json).toContain('aaaaaaaaaaaa');
    expect(markdown).toContain('SCENE_EVIDENCE_INSUFFICIENT');
    for (const secret of [
      '509', '513', '100113', '1101002001034000', '超级秘密货柜', '秘密积分控件',
      'private-secret-name.lua', 'private.secret.path', 'private-adapter-name', 'TOP_SECRET_TOKEN', 'C:\\Users',
    ]) {
      expect(json).not.toContain(secret);
      expect(markdown).not.toContain(secret);
    }
  });

  it('rejects a tampered bundle instead of rendering injected raw fields', () => {
    const bundle = createAnonymousDiagnosticBundle({
      pluginVersion: '0.2.0-private.1', protocolVersion: 'scene-v1', errors: [], performanceSamples: [], nextActions: [],
    });
    const tampered = {
      ...bundle,
      raw: 'TOP_SECRET_TOKEN',
      errors: [{ code: 'NOT_FOUND', evidence: 'STATIC_LOCAL', count: 1, message: 'TOP_SECRET_TOKEN' }],
    };

    expect(() => renderAnonymousDiagnosticBundle(
      tampered as unknown as typeof bundle,
      'json',
    )).toThrowError(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
  });

  it('enforces closed enums and bounded input arrays', () => {
    const excessiveErrors = Array.from({ length: 10_001 }, () => ({
      code: 'NOT_FOUND' as const,
      evidence: 'STATIC_LOCAL' as const,
    }));
    expect(() => createAnonymousDiagnosticBundle({
      pluginVersion: '0.2.0-private.1', protocolVersion: 'scene-v1', errors: excessiveErrors,
      performanceSamples: [], nextActions: [],
    })).toThrowError(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
    expect(() => createAnonymousDiagnosticBundle({
      pluginVersion: '0.2.0-private.1', protocolVersion: 'scene-v1', errors: [],
      performanceSamples: [{ operation: 'raw-log-upload' as never, itemCount: 1, durationMs: 1, peakHeapBytes: null }],
      nextActions: [],
    })).toThrowError(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
  });
});
