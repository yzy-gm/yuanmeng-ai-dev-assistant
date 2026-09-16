import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, it } from 'vitest';

import { buildLuaSourceIndex } from '../../src/core/lua/source-index.js';
import type { RegistryDocument } from '../../src/core/model.js';
import {
  applyLuaRebindPatch,
  assertLuaRebindPatchGuards,
  buildSceneRebindPreview,
  createLuaRebindPatchPreview,
} from '../../src/core/scene/rebind.js';
import type { FieldEvidence, SceneInstance, SceneSnapshot } from '../../src/core/scene/types.js';
import { undoBackup } from '../../src/core/patch/proposal.js';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);
const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const evidence: FieldEvidence = { state: 'confirmed-calibration', source: 'test-calibration', confidence: 1 };

function instance(id: string): SceneInstance {
  return {
    instanceId: id, elementTypeId: '7000', ownerId: null, variant: 'standard', evidence,
    transform: {
      state: 'observed', evidence,
      value: {
        position: { x: 1, y: 2, z: 3 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 },
      },
    },
    customProperties: { state: 'absent' }, signals: { state: 'absent' }, resources: { state: 'absent' },
    bounds: { state: 'absent' }, unknownFields: [],
  };
}

function snapshot(id: string, source: string, item: SceneInstance): SceneSnapshot {
  return {
    schemaVersion: 1, snapshotId: id, bindingId: HASH_C, role: 'raw-pbin', sourceSha256: source,
    observedAt: '2026-08-21T00:00:00.000Z', adapterId: 'ym-layerdata-observed-v1',
    instances: [item], groups: [], issues: [], unknownFields: [],
  };
}

function registry(): RegistryDocument {
  return {
    schemaVersion: 1,
    records: [{
      recordId: 'scene-old', kind: 'scene-instance', name: 'private-object', value: '101', scope: 'map',
      projectInstanceId: PROJECT_ID, mapFingerprint: HASH_A, layerId: null, environment: 'test', validity: 'confirmed',
      source: {
        kind: 'user-entry', relativePath: null, sha256: HASH_A, observedAt: '2026-08-21T00:00:00.000Z',
        officialExtensionVersion: null, evidence: 'USER_ATTESTED',
      },
      lastConfirmedAt: '2026-08-21T00:00:00.000Z', notes: '',
    }],
  };
}

describe('Lua scene ID rebind patch preview', () => {
  it('builds a guarded proposal only for registry-backed Lua literal references', () => {
    const before = snapshot(HASH_A, HASH_A, instance('101'));
    const after = snapshot(HASH_B, HASH_B, instance('201'));
    const records = registry();
    const rebind = buildSceneRebindPreview(before, after, records);
    const source = '-- test only\nlocal TARGET = 101\nreturn TARGET\n';
    const sourceFile = { path: 'src/Test.lua', source };
    const sourceIndex = buildLuaSourceIndex([sourceFile], records, { calls: [], configuredIdFields: [] });

    const patch = createLuaRebindPatchPreview({
      projectInstanceId: PROJECT_ID,
      mapFingerprint: HASH_A,
      targetPath: sourceFile.path,
      source,
      sourceIndex,
      registry: records,
      currentSnapshot: after,
      rebind,
      createdAt: '2026-08-21T02:00:00.000Z',
    });

    expect(patch.replacements).toEqual([{ path: 'src/Test.lua', line: 2, column: 16, oldId: '101', newId: '201' }]);
    expect(patch.proposal.originalSha256).toBeTruthy();
    expect(patch.proposal.newContent).toBe('-- test only\nlocal TARGET = 201\nreturn TARGET\n');
    expect(patch.guards).toMatchObject({
      sceneSnapshotId: HASH_B,
      sceneSourceSha256: HASH_B,
      registrySha256: rebind.registrySha256,
      sourceSha256: patch.proposal.originalSha256,
    });
  });

  it('rejects registry and scene drift after preview', () => {
    const before = snapshot(HASH_A, HASH_A, instance('101'));
    const after = snapshot(HASH_B, HASH_B, instance('201'));
    const records = registry();
    const source = 'local TARGET = 101\n';
    const sourceIndex = buildLuaSourceIndex([{ path: 'src/Test.lua', source }], records, { calls: [], configuredIdFields: [] });
    const patch = createLuaRebindPatchPreview({
      projectInstanceId: PROJECT_ID, mapFingerprint: HASH_A, targetPath: 'src/Test.lua', source, sourceIndex, registry: records,
      currentSnapshot: after, rebind: buildSceneRebindPreview(before, after, records),
      createdAt: '2026-08-21T02:00:00.000Z',
    });

    const changedRegistry = structuredClone(records);
    changedRegistry.records[0]!.notes = 'changed-after-preview';
    expect(() => assertLuaRebindPatchGuards(patch, { registry: changedRegistry, snapshot: after }))
      .toThrowError(expect.objectContaining({ code: 'HASH_CONFLICT' }));
    expect(() => assertLuaRebindPatchGuards(patch, {
      registry: records,
      snapshot: { ...after, snapshotId: 'f'.repeat(64) },
    })).toThrowError(expect.objectContaining({ code: 'SCENE_SOURCE_CONFLICT' }));
    expect(() => assertLuaRebindPatchGuards(patch, {
      registry: records,
      snapshot: { ...after, instances: [instance('999')] },
    })).toThrowError(expect.objectContaining({ code: 'SCENE_SOURCE_CONFLICT' }));
  });

  it('requires confirmation, rejects source hash drift, and can roll back an applied Lua patch', async () => {
    const before = snapshot(HASH_A, HASH_A, instance('101'));
    const after = snapshot(HASH_B, HASH_B, instance('201'));
    const records = registry();
    const source = 'local TARGET = 101\n';
    const sourceIndex = buildLuaSourceIndex([{ path: 'src/Test.lua', source }], records, { calls: [], configuredIdFields: [] });
    const patch = createLuaRebindPatchPreview({
      projectInstanceId: PROJECT_ID, mapFingerprint: HASH_A, targetPath: 'src/Test.lua', source, sourceIndex, registry: records,
      currentSnapshot: after, rebind: buildSceneRebindPreview(before, after, records),
      createdAt: '2026-08-21T02:00:00.000Z',
    });
    const root = await mkdtemp(join(tmpdir(), 'ymai-rebind-'));
    await mkdir(join(root, 'src'), { recursive: true });
    const target = join(root, 'src', 'Test.lua');
    await writeFile(target, source, 'utf8');

    await expect(applyLuaRebindPatch(root, patch, { registry: records, snapshot: after }, false))
      .rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED' });
    await writeFile(target, `${source}-- drift\n`, 'utf8');
    await expect(applyLuaRebindPatch(root, patch, { registry: records, snapshot: after }, true))
      .rejects.toMatchObject({ code: 'HASH_CONFLICT' });

    await writeFile(target, source, 'utf8');
    const applied = await applyLuaRebindPatch(root, patch, { registry: records, snapshot: after }, true);
    expect(await readFile(target, 'utf8')).toBe('local TARGET = 201\n');
    await undoBackup(root, applied.manifestPath);
    expect(await readFile(target, 'utf8')).toBe(source);
  });

  it('refuses a registry scene ID from another map fingerprint', () => {
    const before = snapshot(HASH_A, HASH_A, instance('101'));
    const after = snapshot(HASH_B, HASH_B, instance('201'));
    const wrongMap = registry();
    wrongMap.records[0]!.mapFingerprint = 'f'.repeat(64);
    const source = 'local TARGET = 101\n';
    const sourceIndex = buildLuaSourceIndex([{ path: 'src/Test.lua', source }], wrongMap, { calls: [], configuredIdFields: [] });

    expect(() => createLuaRebindPatchPreview({
      projectInstanceId: PROJECT_ID,
      mapFingerprint: HASH_A,
      targetPath: 'src/Test.lua',
      source,
      sourceIndex,
      registry: wrongMap,
      currentSnapshot: after,
      rebind: buildSceneRebindPreview(before, after, wrongMap),
      createdAt: '2026-08-21T02:00:00.000Z',
    })).toThrowError(expect.objectContaining({ code: 'SCENE_EVIDENCE_INSUFFICIENT' }));
  });
});
