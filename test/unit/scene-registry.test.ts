import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { nodeFileIO } from '../../src/core/fs.js';
import { mutateRegistry, RegistryStore } from '../../src/core/registry/store.js';
import type { RegistryRecord, UiSnapshot } from '../../src/core/model.js';
import type { SceneSnapshot } from '../../src/core/scene/types.js';

const evidence = { state: 'observed-repeatable' as const, source: 'anonymous', confidence: 0.9 };
const snapshot: SceneSnapshot = {
  schemaVersion: 1, snapshotId: 'a'.repeat(64), bindingId: 'b'.repeat(64), role: 'raw-pbin', sourceSha256: 'c'.repeat(64),
  observedAt: '2026-08-21T00:00:00.000Z', adapterId: 'observed-v1', groups: [], issues: [], unknownFields: [],
  instances: [{
    instanceId: '901', elementTypeId: '7000', ownerId: null, variant: 'standard', evidence,
    transform: { state: 'absent' }, customProperties: { state: 'absent' }, signals: { state: 'absent' }, resources: { state: 'absent' }, bounds: { state: 'absent' }, unknownFields: [],
  }],
};

const projectInstanceId = '11111111-1111-4111-8111-111111111111';

function record(overrides: Partial<RegistryRecord>): RegistryRecord {
  return {
    recordId: 'scene-record',
    kind: 'scene-instance',
    name: '匿名场景记录',
    value: '901',
    scope: 'workspace',
    projectInstanceId,
    mapFingerprint: null,
    layerId: null,
    environment: 'unspecified',
    validity: 'pending',
    source: {
      kind: 'source-scan',
      relativePath: null,
      sha256: 'f'.repeat(64),
      observedAt: '2026-08-20T00:00:00.000Z',
      officialExtensionVersion: null,
      evidence: 'STATIC_LOCAL',
    },
    lastConfirmedAt: null,
    notes: '',
    ...overrides,
  };
}

describe('scene registry synchronization', () => {
  it('creates only pending unspecified records without treating a non-authoritative absence as disappearance', () => {
    const store = new RegistryStore({ schemaVersion: 1, records: [] });
    store.syncSceneSnapshot(snapshot, { projectInstanceId, mapFingerprint: null, authoritative: false });
    expect(store.list()).toEqual([
      expect.objectContaining({ kind: 'element-type', value: '7000', environment: 'unspecified', validity: 'pending', lastConfirmedAt: null }),
      expect.objectContaining({ kind: 'scene-instance', value: '901', environment: 'unspecified', validity: 'pending', lastConfirmedAt: null }),
    ]);

    store.syncSceneSnapshot({ ...snapshot, snapshotId: 'd'.repeat(64), sourceSha256: 'e'.repeat(64), instances: [] }, {
      projectInstanceId, mapFingerprint: null, authoritative: false,
    });
    expect(store.list({ kind: 'scene-instance' })[0]?.validity).toBe('pending');
  });

  it('lets only authoritative snapshots mark disappearances and restores reappearing suspected records', () => {
    const store = new RegistryStore({
      schemaVersion: 1,
      records: [
        record({ recordId: 'reappearing', validity: 'suspected-change' }),
        record({ recordId: 'missing', value: '902' }),
        record({ recordId: 'invalid-type', kind: 'element-type', value: '7000', validity: 'invalid' }),
      ],
    });

    store.syncSceneSnapshot(snapshot, { projectInstanceId, mapFingerprint: null, authoritative: false });
    expect(store.list().map(({ recordId, validity }) => ({ recordId, validity }))).toEqual([
      { recordId: 'invalid-type', validity: 'invalid' },
      { recordId: 'missing', validity: 'pending' },
      { recordId: 'reappearing', validity: 'pending' },
    ]);

    store.syncSceneSnapshot({ ...snapshot, instances: [] }, {
      projectInstanceId, mapFingerprint: null, authoritative: true,
    });
    expect(store.list().map(({ recordId, validity }) => ({ recordId, validity }))).toEqual([
      { recordId: 'invalid-type', validity: 'invalid' },
      { recordId: 'missing', validity: 'suspected-change' },
      { recordId: 'reappearing', validity: 'suspected-change' },
    ]);
  });

  it('keeps observed root signal names and layer-name metadata in pending scene registry records', () => {
    const enriched: SceneSnapshot = {
      ...snapshot,
      signalRegistry: { state: 'observed', value: [{ name: '测试冰箱', unknownRefCount: 104 }], evidence },
      sceneMetadata: {
        layerName: { state: 'observed', value: '主图层', evidence },
        editorVersionCandidate: { state: 'candidate', wirePaths: ['$.5.1'], evidence },
        instanceIndex: { state: 'absent' },
      },
    };
    const store = new RegistryStore({ schemaVersion: 1, records: [] });
    store.syncSceneSnapshot(enriched, { projectInstanceId, mapFingerprint: null, authoritative: true });
    expect(store.list({ kind: 'signal' })).toContainEqual(expect.objectContaining({
      name: '测试冰箱', value: '测试冰箱', validity: 'pending', notes: expect.stringContaining('104'),
    }));
    expect(store.list({ kind: 'scene-layer' })).toContainEqual(expect.objectContaining({
      name: '主图层', value: '主图层', validity: 'pending', notes: expect.stringContaining('非图层 ID'),
    }));
  });

  it('retains duplicate root signal records as explicit ambiguous registry entries', () => {
    const enriched: SceneSnapshot = {
      ...snapshot,
      signalRegistry: {
        state: 'observed',
        value: [
          { name: '重复信号', unknownRefCount: 1, ambiguous: true },
          { name: '重复信号', unknownRefCount: 2, ambiguous: true },
        ],
        evidence,
      },
    };
    const store = new RegistryStore({ schemaVersion: 1, records: [] });
    store.syncSceneSnapshot(enriched, { projectInstanceId, mapFingerprint: null, authoritative: true });
    const records = store.list({ kind: 'signal' }).filter((record) => record.value === '重复信号');
    expect(records).toHaveLength(2);
    expect(new Set(records.map((record) => record.recordId)).size).toBe(2);
    expect(records.every((record) => record.notes.includes('同名记录存在歧义'))).toBe(true);
  });

  it('updates and retires only auto-generated v6 signal/layer records when authoritative metadata changes', () => {
    const first: SceneSnapshot = {
      ...snapshot,
      signalRegistry: { state: 'observed', value: [{ name: '旧信号', unknownRefCount: 1 }], evidence },
      sceneMetadata: {
        layerName: { state: 'observed', value: '旧图层', evidence },
        editorVersionCandidate: { state: 'absent' }, instanceIndex: { state: 'absent' },
      },
    };
    const store = new RegistryStore({ schemaVersion: 1, records: [] });
    store.syncSceneSnapshot(first, { projectInstanceId, mapFingerprint: null, authoritative: true });

    const second: SceneSnapshot = {
      ...first,
      snapshotId: 'd'.repeat(64), sourceSha256: 'e'.repeat(64),
      signalRegistry: { state: 'observed', value: [{ name: '旧信号', unknownRefCount: 2 }, { name: '新信号', unknownRefCount: 1 }], evidence },
      sceneMetadata: {
        ...first.sceneMetadata!,
        layerName: { state: 'observed', value: '新图层', evidence },
      },
    };
    store.syncSceneSnapshot(second, { projectInstanceId, mapFingerprint: null, authoritative: true });
    expect(store.list({ kind: 'signal' })).toEqual(expect.arrayContaining([
      expect.objectContaining({ value: '旧信号', validity: 'pending', source: expect.objectContaining({ sha256: 'e'.repeat(64) }), notes: expect.stringContaining('2') }),
      expect.objectContaining({ value: '新信号', validity: 'pending' }),
    ]));
    expect(store.list({ kind: 'scene-layer' })).toEqual(expect.arrayContaining([
      expect.objectContaining({ value: '旧图层', validity: 'suspected-change' }),
      expect.objectContaining({ value: '新图层', validity: 'pending' }),
    ]));

    const third: SceneSnapshot = {
      ...second,
      snapshotId: 'f'.repeat(64), sourceSha256: '1'.repeat(64),
      signalRegistry: { state: 'observed', value: [{ name: '新信号', unknownRefCount: 1 }], evidence },
    };
    store.syncSceneSnapshot(third, { projectInstanceId, mapFingerprint: null, authoritative: true });
    expect(store.list({ kind: 'signal' }).find((entry) => entry.value === '旧信号')?.validity).toBe('suspected-change');

    const legacyWithoutMetadata: SceneSnapshot = {
      ...third,
      snapshotId: '2'.repeat(64), sourceSha256: '3'.repeat(64), signalRegistry: undefined, sceneMetadata: undefined,
    };
    store.syncSceneSnapshot(legacyWithoutMetadata, { projectInstanceId, mapFingerprint: null, authoritative: true });
    expect(store.list({ kind: 'signal' }).find((entry) => entry.value === '新信号')?.validity).toBe('pending');
    expect(store.list({ kind: 'scene-layer' }).find((entry) => entry.value === '新图层')?.validity).toBe('pending');
  });

  it('rolls back a registry file when its generation is cancelled during the atomic commit window', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ymai-scene-registry-'));
    const path = join(root, 'registry.json');
    const baseline = { schemaVersion: 1 as const, records: [record({ recordId: 'baseline' })] };
    await writeFile(path, JSON.stringify(baseline), 'utf8');
    const controller = new AbortController();
    const io = {
      ...nodeFileIO,
      rename: async (from: string, to: string) => {
        await nodeFileIO.rename(from, to);
        if (to === path && !controller.signal.aborted) controller.abort();
      },
    };
    try {
      const store = await RegistryStore.open(path, io);
      store.syncSceneSnapshot(snapshot, { projectInstanceId, mapFingerprint: null, authoritative: true });
      const guardedSave = store.save as unknown as (options: { signal: AbortSignal }) => Promise<void>;
      await expect(guardedSave.call(store, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
      expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(baseline);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rolls back when authority expires only after registry atomic rename returned', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ymai-registry-post-commit-'));
    const path = join(root, 'registry.json');
    const baseline = { schemaVersion: 1 as const, records: [record({ recordId: 'baseline' })] };
    await writeFile(path, JSON.stringify(baseline), 'utf8');
    let guards = 0;
    try {
      const store = await RegistryStore.open(path);
      store.syncSceneSnapshot(snapshot, { projectInstanceId, mapFingerprint: null, authoritative: true });
      await expect(store.save({
        commitGuard: () => {
          guards += 1;
          if (guards === 4) {
            const error = new Error('expired after rename');
            error.name = 'AbortError';
            throw error;
          }
        },
      })).rejects.toMatchObject({ name: 'AbortError' });
      expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(baseline);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('serializes UI and scene mutations so both record kinds survive concurrent refreshes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ymai-registry-concurrent-'));
    const path = join(root, 'registry.json');
    const uiSnapshot: UiSnapshot = {
      schemaVersion: 1,
      snapshotId: '9'.repeat(64),
      createdAt: '2026-08-21T00:00:00.000Z',
      projectInstanceId,
      mapFingerprint: null,
      sources: [{
        kind: 'source-scan', relativePath: 'src/Data/CustomUIData.lua', sha256: '8'.repeat(64), observedAt: '2026-08-21T00:00:00.000Z',
        officialExtensionVersion: null, evidence: 'STATIC_LOCAL',
      }],
      nodes: [{
        id: '100101', name: '匿名按钮', type: 'Button', parentId: null, path: '匿名按钮', depth: 0, siblingIndex: 0,
        sourceFile: 'src/Data/CustomUIData.lua', sourceRange: null,
      }],
      duplicateNames: [],
    };
    try {
      await Promise.all([
        mutateRegistry(path, (store) => { store.syncUiSnapshot(uiSnapshot, { fresh: false }); }),
        mutateRegistry(path, (store) => { store.syncSceneSnapshot(snapshot, { projectInstanceId, mapFingerprint: null, authoritative: true }); }),
      ]);
      const records = (await RegistryStore.open(path)).list();
      expect(records.map((item) => item.kind)).toEqual(expect.arrayContaining(['ui-control', 'scene-instance', 'element-type']));
      expect(records).toHaveLength(3);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('finishes a cancelled rollback before the next queued registry generation commits', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ymai-registry-rollback-queue-'));
    const path = join(root, 'registry.json');
    const uiSnapshot: UiSnapshot = {
      schemaVersion: 1,
      snapshotId: '7'.repeat(64),
      createdAt: '2026-08-21T00:00:00.000Z',
      projectInstanceId,
      mapFingerprint: null,
      sources: [{
        kind: 'source-scan', relativePath: 'src/Data/CustomUIData.lua', sha256: '6'.repeat(64), observedAt: '2026-08-21T00:00:00.000Z',
        officialExtensionVersion: null, evidence: 'STATIC_LOCAL',
      }],
      nodes: [{
        id: '100102', name: '后继按钮', type: 'Button', parentId: null, path: '后继按钮', depth: 0, siblingIndex: 0,
        sourceFile: 'src/Data/CustomUIData.lua', sourceRange: null,
      }],
      duplicateNames: [],
    };
    let guards = 0;
    try {
      const [staleResult, replacementResult] = await Promise.allSettled([
        mutateRegistry(
          path,
          (store) => { store.syncSceneSnapshot(snapshot, { projectInstanceId, mapFingerprint: null, authoritative: true }); },
          {
            commitGuard: () => {
              guards += 1;
              if (guards === 4) {
                const error = new Error('stale registry generation');
                error.name = 'AbortError';
                throw error;
              }
            },
          },
        ),
        mutateRegistry(path, (store) => { store.syncUiSnapshot(uiSnapshot, { fresh: false }); }),
      ]);
      expect(staleResult.status).toBe('rejected');
      expect(replacementResult.status).toBe('fulfilled');
      const records = (await RegistryStore.open(path)).list();
      expect(records.map((item) => `${item.kind}:${item.value}`)).toEqual(['ui-control:100102']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
