import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { runCli } from '../../src/cli/main.js';
import { normalizeCanonicalRoot } from '../../src/cli/project.js';
import { sha256Hex } from '../../src/core/hash.js';
import type { InspectorStatus, RegistryDocument } from '../../src/core/model.js';
import type { SceneInstance, SceneSnapshot } from '../../src/core/scene/types.js';

const directories: string[] = [];
function containsExactScalar(value: unknown, forbidden: string): boolean {
  if (value === forbidden || value === Number(forbidden)) return true;
  if (Array.isArray(value)) return value.some((entry) => containsExactScalar(entry, forbidden));
  if (value !== null && typeof value === 'object') {
    return Object.values(value).some((entry) => containsExactScalar(entry, forbidden));
  }
  return false;
}
async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'ymai-cli-scene-'));
  directories.push(directory);
  return directory;
}
afterEach(async () => Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

function varint(value: bigint): number[] {
  const bytes: number[] = [];
  let rest = value;
  do {
    let byte = Number(rest & 0x7fn); rest >>= 7n; if (rest !== 0n) byte |= 0x80; bytes.push(byte);
  } while (rest !== 0n);
  return bytes;
}
function tag(field: number, wire: 0 | 2 | 5): number[] { return varint(BigInt((field << 3) | wire)); }
function v(field: number, value: bigint): number[] { return [...tag(field, 0), ...varint(value)]; }
function b(field: number, value: number[]): number[] { return [...tag(field, 2), ...varint(BigInt(value.length)), ...value]; }
function f32(field: number, value: number): number[] {
  const buffer = new ArrayBuffer(4); new DataView(buffer).setFloat32(0, value, true); return [...tag(field, 5), ...new Uint8Array(buffer)];
}
function vec(x: number, y: number, z: number): number[] { return [...f32(1, x), ...f32(2, y), ...f32(3, z)]; }
function instance(
  owner: bigint,
  id: bigint,
  x = 1,
  signalName: string | null = null,
  customNumber: { name: string; value: number } | null = null,
): number[] {
  const transform = [...b(1, vec(x, 2, 3)), ...b(2, vec(0, 0, 0)), ...b(3, vec(1, 1, 1))];
  const commonBase = [
    ...b(1, transform),
    ...(signalName === null ? [] : b(12, [...new TextEncoder().encode(signalName)])),
    ...(customNumber === null ? [] : b(23, [
      ...b(2, [...new TextEncoder().encode(customNumber.name)]),
      ...b(7, b(2, f32(11, customNumber.value))),
    ])),
  ];
  return [...v(1, 7000n), ...v(2, id), ...v(3, owner), ...b(6, b(11, b(1, commonBase)))];
}

describe('scene CLI workflow', () => {
  it('binds, refreshes, queries hierarchy, exports and generates an evidence-gated spatial probe', async () => {
    const root = await temporaryDirectory();
    await mkdir(join(root, 'src'), { recursive: true });
    await mkdir(join(root, '.yuanmeng-inspector'), { recursive: true });
    await writeFile(join(root, 'src', 'GameEntry.lua'), 'return {}\n', 'utf8');
    const canonical = await realpath(root);
    await writeFile(join(root, '.yuanmeng-inspector', 'meta.json'), JSON.stringify({
      schemaVersion: 1,
      projectInstanceId: '11111111-1111-4111-8111-111111111111',
      projectRootHash: sha256Hex(normalizeCanonicalRoot(canonical)),
    }), 'utf8');
    const sourceDirectory = join(root, 'scene-source');
    await mkdir(sourceDirectory);
    const group = [...v(1, 900n), ...v(3, 901n), ...v(3, 902n)];
    const nestedGroup = [...v(1, 910n), ...v(2, 900n), ...v(3, 903n)];
    const body = [
      ...b(24, [
        ...v(1, 7000n),
        ...b(2, instance(900n, 901n, 1, '测试冰箱', { name: '测试立方体', value: 66 })),
        ...b(2, instance(900n, 902n)),
        ...b(2, instance(910n, 903n, 20)),
      ]),
      ...b(2, group),
      ...b(2, nestedGroup),
    ];
    const source = join(sourceDirectory, 'LayerData.pbin');
    await writeFile(source, Uint8Array.from(b(5, body)));

    const bound = await runCli(['bind-scene', 'raw-pbin', source, '--json'], { cwd: root });
    expect(bound.envelope).toMatchObject({ ok: true, data: { role: 'raw-pbin' } });
    const found = await runCli(['find-scene', 'type:7000', '--json'], { cwd: root });
    expect(found.envelope).toMatchObject({ code: 'AMBIGUOUS', data: { matches: [{ instanceId: '901' }, { instanceId: '902' }, { instanceId: '903' }] } });
    const foundBySignal = await runCli(['find-scene', 'signal:测试冰箱', '--json'], { cwd: root });
    expect(foundBySignal.envelope).toMatchObject({
      ok: true,
      data: {
        matches: [{ instanceId: '901', signals: { state: 'observed', value: [{ name: '测试冰箱' }] } }],
        intelligence: [{ actorFamily: 'unknown', idDomain: 'scene-instance' }],
      },
    });
    const tree = await runCli(['scene-tree', '900', '--json'], { cwd: root });
    expect(tree.envelope).toMatchObject({
      ok: true,
      data: {
        groupMembers: ['901', '902'],
        descendants: ['901', '902', '910', '903'],
      },
    });
    const members = await runCli(['group-members', '900', '--json'], { cwd: root });
    expect(members.envelope).toMatchObject({
      ok: true,
      data: {
        directMemberIds: ['901', '902'],
        descendantGroupIds: ['910'],
        allMemberIds: ['901', '902', '903'],
      },
    });
    const property = await runCli(['property-locate', '测试立方体', 'Number', '--json'], { cwd: root });
    expect(property.envelope).toMatchObject({
      ok: true,
      data: {
        staticMatches: [{ instanceId: '901', value: { kind: 'number', value: 66 } }],
        staticMatchCount: 1,
        runtimeCandidateCount: 2,
      },
    });
    expect((property.envelope.data as { probeLua: string }).probeLua).not.toContain('\n    901,');
    const fields = await runCli(['field-inspect', '902', '--json'], { cwd: root });
    expect(fields.envelope).toMatchObject({
      ok: true,
      data: { fields: expect.arrayContaining([expect.objectContaining({ field: 'customProperties', reasonCode: 'EVIDENCE_INSUFFICIENT' })]) },
    });
    const near = await runCli(['scene-near', '901', '--radius', '5', '--limit', '1', '--json'], { cwd: root });
    expect(near.envelope).toMatchObject({
      ok: true,
      data: { matches: [{ instanceId: '902', distance: 0, method: 'point-point' }] },
    });
    const geometry = await runCli(['scene-geometry', 'bounds', '900', '--json'], { cwd: root });
    expect(geometry.envelope).toMatchObject({
      ok: false,
      code: 'EVIDENCE_INSUFFICIENT',
      data: { reasonCode: 'SCENE_EVIDENCE_INSUFFICIENT', snapshotId: expect.any(String) },
    });
    const audit = await runCli(['scene-audit', '--json'], { cwd: root });
    expect(audit.envelope).toMatchObject({
      ok: true,
      data: {
        truncated: true,
        totalFindingCount: expect.any(Number),
        findingGroups: expect.arrayContaining([expect.objectContaining({ reasonCode: 'SNAPSHOT_INSTANCE_INDEX_MISSING' })]),
        findings: expect.arrayContaining([expect.objectContaining({ reasonCode: 'SNAPSHOT_INSTANCE_INDEX_MISSING' })]),
        coverage: expect.arrayContaining([expect.objectContaining({ field: 'customProperties' })]),
      },
    });
    const detailedAudit = await runCli(['scene-audit', '--detailed', '--json'], { cwd: root });
    expect(detailedAudit.envelope).toMatchObject({ ok: true, data: { truncated: false } });
    expect((detailedAudit.envelope.data as { findings: unknown[] }).findings).toHaveLength(
      (detailedAudit.envelope.data as { totalFindingCount: number }).totalFindingCount,
    );
    const types = await runCli(['scene-types', '--json'], { cwd: root });
    expect(types.envelope).toMatchObject({
      ok: true,
      data: {
        summary: expect.objectContaining({ uniqueTypeStates: expect.any(Number) }),
        entries: expect.arrayContaining([
          expect.objectContaining({ typeId: '7000', representativeInstanceIds: expect.any(Array) }),
        ]),
        pendingCalibration: expect.any(Array),
      },
    });
    const capabilities = await runCli(['scene-capabilities', '901', '--json'], { cwd: root });
    expect(capabilities.envelope).toMatchObject({
      ok: true,
      data: {
        reasonCode: 'SCENE_CAPABILITY_DESCRIPTION',
        instance: { instanceId: '901', elementTypeId: '7000' },
        intelligence: { actorFamily: 'unknown', capabilities: expect.any(Array) },
        probeLua: expect.stringContaining('[YMAI_SCENE_CAPABILITY]'),
      },
    });
    const capabilityProbe = await runCli(['runtime-probe', 'scene-capability', '901', '--json'], { cwd: root });
    expect(capabilityProbe.envelope).toMatchObject({
      ok: true, data: { kind: 'scene-capability', instanceId: '901', probeLua: expect.stringContaining('[YMAI_SCENE_CAPABILITY]') },
    });
    const plan = await runCli(['scene-plan', '901', '902', '--json'], { cwd: root });
    expect(plan.envelope).toMatchObject({ ok: true, data: { executable: false, reasonCode: 'BOUNDS_EVIDENCE_REQUIRED' } });
    expect((plan.envelope.data as { probeLua: string }).probeLua).toContain('[YMAI_AUTO_ALIGN]');
    const groupPlan = await runCli(['scene-plan', 'floor-align', '901', '910', '--json'], { cwd: root });
    expect(groupPlan.envelope).toMatchObject({
      ok: true,
      data: {
        executable: false,
        reasonCode: 'BOUNDS_EVIDENCE_REQUIRED',
        affectedInstanceIds: ['903'],
        referenceIds: ['901'],
      },
    });
    expect((groupPlan.envelope.data as { probeLua: string }).probeLua).toContain('903');
    const offset = await runCli(['scene-plan', 'batch-offset', '901', '--position', 'z=5', '--rotation', 'x=15', '--json'], { cwd: root });
    expect(offset.envelope).toMatchObject({
      ok: true,
      data: {
        status: 'ready', execute: false,
        changes: expect.arrayContaining([expect.objectContaining({ instanceId: '901', mask: ['position.z', 'rotation.x'] })]),
      },
    });
    const output = join(root, 'scene.md');
    const exported = await runCli(['export', 'scene', '--format', 'md', '--out', output], { cwd: root });
    expect(exported.envelope.ok).toBe(true);
    expect(await readFile(output, 'utf8')).toContain('901');
    const aiOutput = join(root, 'scene-ai.json');
    const aiExported = await runCli(['export', 'scene-ai', '--format', 'json', '--out', aiOutput], { cwd: root });
    expect(aiExported.envelope).toMatchObject({ ok: true, data: { subject: 'scene-ai' } });
    const aiContext = await readFile(aiOutput, 'utf8');
    expect(containsExactScalar(JSON.parse(aiContext) as unknown, '901')).toBe(false);
    expect(aiContext).not.toContain(sourceDirectory);

    const movedBody = [
      ...b(24, [...v(1, 7000n), ...b(2, instance(900n, 901n, 9)), ...b(2, instance(900n, 902n)), ...b(2, instance(910n, 903n, 20))]),
      ...b(2, group),
      ...b(2, nestedGroup),
    ];
    await writeFile(source, Uint8Array.from(b(5, movedBody)));
    const refreshed = await runCli(['refresh-scene', 'raw-pbin', '--json'], { cwd: root });
    expect(refreshed.envelope.ok).toBe(true);
    const automaticJournal = await runCli(['scene-journal', 'list', '--json'], { cwd: root });
    expect(automaticJournal.envelope).toMatchObject({
      ok: true,
      data: { entries: [expect.objectContaining({ summary: expect.arrayContaining([{ kind: 'position', count: 1 }]) })] },
    });
  });

  it('diffs the preferred head against only the previous snapshot in the same exact lineage', async () => {
    const root = await temporaryDirectory();
    await mkdir(join(root, 'src'), { recursive: true });
    await mkdir(join(root, '.yuanmeng-inspector', 'scene', 'snapshots'), { recursive: true });
    await writeFile(join(root, 'src', 'GameEntry.lua'), 'return {}\n', 'utf8');
    const canonical = await realpath(root);
    await writeFile(join(root, '.yuanmeng-inspector', 'meta.json'), JSON.stringify({
      schemaVersion: 1,
      projectInstanceId: '33333333-3333-4333-8333-333333333333',
      projectRootHash: sha256Hex(normalizeCanonicalRoot(canonical)),
    }), 'utf8');
    const evidence = { state: 'observed-repeatable' as const, source: 'anonymous', confidence: 0.9 };
    const makeInstance = (x: number): SceneInstance => ({
      instanceId: '901', elementTypeId: '7000', ownerId: null, variant: 'standard', evidence,
      transform: { state: 'observed', value: { position: { x, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } }, evidence },
      customProperties: { state: 'absent' }, signals: { state: 'absent' }, resources: { state: 'absent' }, bounds: { state: 'absent' }, unknownFields: [],
    });
    const makeSnapshot = (
      snapshotId: string,
      observedAt: string,
      x: number,
      overrides: Partial<Pick<SceneSnapshot, 'bindingId' | 'role' | 'adapterId'>> = {},
    ): SceneSnapshot => ({
      schemaVersion: 1, snapshotId, bindingId: overrides.bindingId ?? 'b'.repeat(64), role: overrides.role ?? 'raw-pbin',
      sourceSha256: 'c'.repeat(64), observedAt, adapterId: overrides.adapterId ?? 'observed-v1', instances: [makeInstance(x)],
      groups: [], issues: [], unknownFields: [],
    });
    const base = makeSnapshot('1'.repeat(64), '2026-08-21T00:00:00.000Z', 1);
    const wrongBinding = makeSnapshot('2'.repeat(64), '2026-08-21T00:01:00.000Z', 20, { bindingId: 'd'.repeat(64) });
    const interleavedManual = makeSnapshot('3'.repeat(64), '2026-08-21T00:02:00.000Z', 30, { role: 'manual-dat' });
    const wrongAdapter = makeSnapshot('4'.repeat(64), '2026-08-21T00:03:00.000Z', 40, { adapterId: 'candidate-v2' });
    const after = makeSnapshot('5'.repeat(64), '2026-08-21T00:04:00.000Z', 5);
    for (const item of [base, wrongBinding, interleavedManual, wrongAdapter, after]) {
      await writeFile(join(root, '.yuanmeng-inspector', 'scene', 'snapshots', `${item.snapshotId}.json`), JSON.stringify(item), 'utf8');
    }
    await writeFile(join(root, '.yuanmeng-inspector', 'scene', 'snapshots', `${'7'.repeat(64)}.json`), '{damaged-history', 'utf8');
    await writeFile(join(root, '.yuanmeng-inspector', 'scene', 'heads.json'), JSON.stringify({
      schemaVersion: 1,
      manualSnapshotId: interleavedManual.snapshotId,
      autoSnapshotId: null,
      rawSnapshotId: after.snapshotId,
      preferredSnapshotId: after.snapshotId,
    }), 'utf8');

    const diff = await runCli(['scene-diff', '--json'], { cwd: root });
    expect(diff.envelope).toMatchObject({
      ok: true,
      data: {
        fromSnapshotId: base.snapshotId,
        toSnapshotId: after.snapshotId,
        changes: [expect.objectContaining({ kind: 'position', instanceId: '901' })],
      },
    });
    const journalId = (diff.envelope.data as { journalId: string }).journalId;
    expect(journalId).toMatch(/^[a-f0-9]{64}$/u);
    const journals = await runCli(['scene-journal', 'list', '--limit', '10', '--json'], { cwd: root });
    expect(journals.envelope).toMatchObject({ ok: true, data: { entries: [expect.objectContaining({ journalId, changeCount: 1 })] } });
    const journal = await runCli(['scene-journal', 'show', journalId, '--json'], { cwd: root });
    expect(journal.envelope).toMatchObject({ ok: true, data: { entry: { journalId, fromSnapshotId: base.snapshotId, toSnapshotId: after.snapshotId } } });

    const explicitWrongSource = await runCli(['scene-diff', '--from', base.snapshotId, '--to', interleavedManual.snapshotId, '--json'], { cwd: root });
    expect(explicitWrongSource.envelope).toMatchObject({ code: 'VALIDATION_FAILED', data: { reasonCode: 'SCENE_SOURCE_CONFLICT' } });
  });

  it('returns AMBIGUOUS for duplicate IDs in scene-tree and both placement modes', async () => {
    const root = await temporaryDirectory();
    await mkdir(join(root, 'src'), { recursive: true });
    await mkdir(join(root, '.yuanmeng-inspector'), { recursive: true });
    await writeFile(join(root, 'src', 'GameEntry.lua'), 'return {}\n', 'utf8');
    const canonical = await realpath(root);
    await writeFile(join(root, '.yuanmeng-inspector', 'meta.json'), JSON.stringify({
      schemaVersion: 1,
      projectInstanceId: '55555555-5555-4555-8555-555555555555',
      projectRootHash: sha256Hex(normalizeCanonicalRoot(canonical)),
    }), 'utf8');
    const snapshotId = '9'.repeat(64);
    const evidence = { state: 'observed-repeatable' as const, source: 'anonymous', confidence: 0.9 };
    const makeInstance = (id: string, x: number): SceneInstance => ({
      instanceId: id, elementTypeId: '7000', ownerId: null, variant: 'standard', evidence,
      transform: { state: 'observed', value: { position: { x, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } }, evidence },
      customProperties: { state: 'candidate', wirePaths: [], evidence }, signals: { state: 'candidate', wirePaths: [], evidence },
      resources: { state: 'candidate', wirePaths: [], evidence }, bounds: { state: 'candidate', wirePaths: [], evidence }, unknownFields: [],
    });
    const duplicateSnapshot: SceneSnapshot = {
      schemaVersion: 1, snapshotId, bindingId: 'b'.repeat(64), role: 'raw-pbin', sourceSha256: 'c'.repeat(64),
      observedAt: '2026-08-21T00:00:00.000Z', adapterId: 'observed-v1',
      instances: [makeInstance('901', 1), makeInstance('901', 2), makeInstance('902', 3)], groups: [], issues: [], unknownFields: [],
    };
    await mkdir(join(root, '.yuanmeng-inspector', 'scene', 'snapshots'), { recursive: true });
    await writeFile(join(root, '.yuanmeng-inspector', 'scene', 'snapshots', `${snapshotId}.json`), JSON.stringify(duplicateSnapshot), 'utf8');
    await writeFile(join(root, '.yuanmeng-inspector', 'scene', 'heads.json'), JSON.stringify({
      schemaVersion: 1, manualSnapshotId: null, autoSnapshotId: null, rawSnapshotId: snapshotId, preferredSnapshotId: snapshotId,
    }), 'utf8');

    expect((await runCli(['scene-tree', '901', '--json'], { cwd: root })).envelope).toMatchObject({ code: 'AMBIGUOUS', data: { reasonCode: 'SCENE_AMBIGUOUS' } });
    expect((await runCli(['scene-plan', '901', '902', '--json'], { cwd: root })).envelope).toMatchObject({ code: 'AMBIGUOUS', data: { duplicateIds: ['901'] } });
    expect((await runCli(['scene-plan', 'batch-offset', '901', '--position', 'z=1', '--json'], { cwd: root })).envelope).toMatchObject({ code: 'AMBIGUOUS', data: { duplicateIds: ['901'] } });

    const trustedSnapshotId = '8'.repeat(64);
    const floor = makeInstance('900', 0);
    const left = { ...makeInstance('101', 1), ownerId: '800' };
    const right = { ...makeInstance('102', 3), ownerId: '800' };
    floor.bounds = { state: 'observed', value: { min: { x: -10, y: -10, z: 0 }, max: { x: 10, y: 10, z: 1 }, evidence }, evidence };
    left.bounds = { state: 'observed', value: { min: { x: 0, y: -1, z: 4 }, max: { x: 2, y: 1, z: 6 }, evidence }, evidence };
    right.bounds = { state: 'observed', value: { min: { x: 2, y: -1, z: 5 }, max: { x: 4, y: 1, z: 7 }, evidence }, evidence };
    const trustedSnapshot: SceneSnapshot = {
      ...duplicateSnapshot,
      snapshotId: trustedSnapshotId,
      instances: [floor, left, right],
      groups: [{ groupId: '800', memberIds: ['101', '102'], nestedGroupIds: [], evidence }],
    };
    await writeFile(join(root, '.yuanmeng-inspector', 'scene', 'snapshots', `${trustedSnapshotId}.json`), JSON.stringify(trustedSnapshot), 'utf8');
    await writeFile(join(root, '.yuanmeng-inspector', 'scene', 'heads.json'), JSON.stringify({
      schemaVersion: 1, manualSnapshotId: null, autoSnapshotId: null, rawSnapshotId: trustedSnapshotId, preferredSnapshotId: trustedSnapshotId,
    }), 'utf8');
    expect((await runCli(['scene-plan', '900', '101', '--json'], { cwd: root })).envelope).toMatchObject({
      ok: true,
      data: {
        operation: 'floor-align', execute: false,
        changes: [
          expect.objectContaining({ instanceId: '101', mask: ['position.z'] }),
          expect.objectContaining({ instanceId: '102', mask: ['position.z'] }),
        ],
      },
    });
  });

  it('returns SCENE_DIFF_BASE_NOT_FOUND when the preferred snapshot has no prior exact-lineage history', async () => {
    const root = await temporaryDirectory();
    await mkdir(join(root, 'src'), { recursive: true });
    await mkdir(join(root, '.yuanmeng-inspector', 'scene', 'snapshots'), { recursive: true });
    await writeFile(join(root, 'src', 'GameEntry.lua'), 'return {}\n', 'utf8');
    const canonical = await realpath(root);
    await writeFile(join(root, '.yuanmeng-inspector', 'meta.json'), JSON.stringify({
      schemaVersion: 1,
      projectInstanceId: '44444444-4444-4444-8444-444444444444',
      projectRootHash: sha256Hex(normalizeCanonicalRoot(canonical)),
    }), 'utf8');
    const onlyId = '6'.repeat(64);
    const only: SceneSnapshot = {
      schemaVersion: 1, snapshotId: onlyId, bindingId: 'b'.repeat(64), role: 'raw-pbin', sourceSha256: 'c'.repeat(64),
      observedAt: '2026-08-21T00:00:00.000Z', adapterId: 'observed-v1', instances: [{
        instanceId: '901', elementTypeId: '7000', ownerId: null, variant: 'standard',
        evidence: { state: 'observed-repeatable', source: 'anonymous', confidence: 0.9 },
        transform: { state: 'absent' }, customProperties: { state: 'absent' }, signals: { state: 'absent' },
        resources: { state: 'absent' }, bounds: { state: 'absent' }, unknownFields: [],
      }], groups: [], issues: [], unknownFields: [],
    };
    await writeFile(join(root, '.yuanmeng-inspector', 'scene', 'snapshots', `${onlyId}.json`), JSON.stringify(only), 'utf8');
    await writeFile(join(root, '.yuanmeng-inspector', 'scene', 'heads.json'), JSON.stringify({
      schemaVersion: 1, manualSnapshotId: null, autoSnapshotId: null, rawSnapshotId: onlyId, preferredSnapshotId: onlyId,
    }), 'utf8');

    const diff = await runCli(['scene-diff', '--json'], { cwd: root });
    expect(diff.envelope).toMatchObject({ code: 'VALIDATION_FAILED', data: { reasonCode: 'SCENE_DIFF_BASE_NOT_FOUND' } });
    const near = await runCli(['scene-near', '901', '--json'], { cwd: root });
    expect(near.envelope).toMatchObject({ code: 'VALIDATION_FAILED', data: { reasonCode: 'EVIDENCE_INSUFFICIENT' } });

    await writeFile(join(root, '.yuanmeng-inspector', 'scene', 'heads.json'), '{broken-heads', 'utf8');
    const audit = await runCli(['scene-audit', '--json'], { cwd: root });
    expect(audit.envelope).toMatchObject({
      ok: true,
      data: { findings: [expect.objectContaining({ reasonCode: 'SCENE_HEADS_INVALID' })] },
    });
  });

  it('uses only a matching status fingerprint and does not gate scene registry queries on UI freshness', async () => {
    const root = await temporaryDirectory();
    await mkdir(join(root, 'src'), { recursive: true });
    await mkdir(join(root, '.yuanmeng-inspector', 'registry'), { recursive: true });
    await writeFile(join(root, 'src', 'GameEntry.lua'), 'return {}\n', 'utf8');
    const canonical = await realpath(root);
    const projectRootHash = sha256Hex(normalizeCanonicalRoot(canonical));
    const projectInstanceId = '22222222-2222-4222-8222-222222222222';
    const mapFingerprint = 'd'.repeat(64);
    await writeFile(join(root, '.yuanmeng-inspector', 'meta.json'), JSON.stringify({
      schemaVersion: 1,
      projectInstanceId,
      projectRootHash,
    }), 'utf8');
    const status: InspectorStatus = {
      schemaVersion: 1,
      project: {
        schemaVersion: 1,
        projectInstanceId,
        projectRootHash,
        hasSrc: true,
        hasGameEntry: true,
        mapFingerprint,
        mapName: null,
        currentLayerId: null,
        layers: [],
      },
      officialCommands: {},
      link: { state: 'online', reasonCode: 'REFRESH_SUCCEEDED', lastProbeAt: '2026-08-21T00:00:00.000Z' },
      ui: { freshness: 'stale', lastRefreshAt: null, sourceHashes: {}, reasonCodes: ['SNAPSHOT_EXPIRED'] },
      issueCounts: { error: 0, warning: 0, info: 0 },
    };
    await writeFile(join(root, '.yuanmeng-inspector', 'status.json'), JSON.stringify(status), 'utf8');
    const registry: RegistryDocument = {
      schemaVersion: 1,
      records: [{
        recordId: 'anonymous-ui',
        kind: 'ui-control',
        name: '匿名控件',
        value: '51001',
        scope: 'map',
        projectInstanceId,
        mapFingerprint,
        layerId: null,
        environment: 'unspecified',
        validity: 'pending',
        source: {
          kind: 'user-entry',
          relativePath: null,
          sha256: 'e'.repeat(64),
          observedAt: '2026-08-21T00:00:00.000Z',
          officialExtensionVersion: null,
          evidence: 'STATIC_LOCAL',
        },
        lastConfirmedAt: null,
        notes: '',
      }, {
        recordId: 'anonymous-layer',
        kind: 'scene-layer',
        name: '匿名场景层',
        value: '61001',
        scope: 'map',
        projectInstanceId,
        mapFingerprint,
        layerId: '61001',
        environment: 'unspecified',
        validity: 'pending',
        source: {
          kind: 'user-entry',
          relativePath: null,
          sha256: 'f'.repeat(64),
          observedAt: '2026-08-21T00:00:00.000Z',
          officialExtensionVersion: null,
          evidence: 'STATIC_LOCAL',
        },
        lastConfirmedAt: null,
        notes: '',
      }, {
        recordId: 'anonymous-suspected-scene',
        kind: 'scene-instance',
        name: '匿名待复核元件',
        value: '999',
        scope: 'map',
        projectInstanceId,
        mapFingerprint,
        layerId: null,
        environment: 'unspecified',
        validity: 'suspected-change',
        source: {
          kind: 'source-scan',
          relativePath: null,
          sha256: 'a'.repeat(64),
          observedAt: '2026-08-21T00:00:00.000Z',
          officialExtensionVersion: null,
          evidence: 'STATIC_LOCAL',
        },
        lastConfirmedAt: null,
        notes: '',
      }],
    };
    await writeFile(join(root, '.yuanmeng-inspector', 'registry', 'registry.json'), JSON.stringify(registry), 'utf8');

    const missingBinding = await runCli(['refresh-scene', '--json'], { cwd: root });
    expect(missingBinding.envelope).toMatchObject({
      code: 'NOT_FOUND',
      data: { reasonCode: 'NOT_FOUND' },
    });

    const sourceDirectory = join(root, 'anonymous-scene-source');
    await mkdir(sourceDirectory);
    const source = join(sourceDirectory, 'LayerData.pbin');
    await writeFile(source, Uint8Array.from(b(5, b(24, b(2, instance(0n, 903n))))));
    await runCli(['bind-scene', 'raw-pbin', source, '--json'], { cwd: root });

    const saved = JSON.parse(await readFile(join(root, '.yuanmeng-inspector', 'registry', 'registry.json'), 'utf8')) as RegistryDocument;
    expect(saved.records.find((record) => record.kind === 'scene-instance' && record.value === '903')).toMatchObject({
      value: '903',
      mapFingerprint,
    });
    const sceneRecords = await runCli(['list-ids', '--kind', 'scene-instance', '--json'], { cwd: root });
    expect(sceneRecords.envelope).toMatchObject({
      code: 'OK',
      data: { records: expect.arrayContaining([expect.objectContaining({ kind: 'scene-instance', value: '903' })]) },
    });
    const layerRecords = await runCli(['list-ids', '--kind', 'scene-layer', '--json'], { cwd: root });
    expect(layerRecords.envelope).toMatchObject({
      code: 'OK',
      data: { records: [expect.objectContaining({ kind: 'scene-layer', value: '61001' })] },
    });
    const uiRecords = await runCli(['list-ids', '--kind', 'ui-control', '--json'], { cwd: root });
    expect(uiRecords.envelope).toMatchObject({ code: 'STALE' });
    const audit = await runCli(['scene-audit', '--json'], { cwd: root });
    expect(audit.envelope).toMatchObject({
      ok: true,
      data: { findings: expect.arrayContaining([expect.objectContaining({ reasonCode: 'REGISTRY_SUSPECTED_CHANGE', instanceId: '999' })]) },
    });
  });
});
