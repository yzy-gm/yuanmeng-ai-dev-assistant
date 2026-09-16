import { describe, expect, it } from 'vitest';

import { normalizeObservedScene, sceneSnapshotNeedsAdapterRefresh } from '../../src/core/scene/normalize.js';

function varint(value: bigint): number[] {
  const bytes: number[] = [];
  let rest = value;
  do {
    let byte = Number(rest & 0x7fn);
    rest >>= 7n;
    if (rest !== 0n) byte |= 0x80;
    bytes.push(byte);
  } while (rest !== 0n);
  return bytes;
}
function tag(field: number, wire: 0 | 2 | 5): number[] { return varint(BigInt((field << 3) | wire)); }
function v(field: number, value: bigint): number[] { return [...tag(field, 0), ...varint(value)]; }
function b(field: number, value: number[]): number[] { return [...tag(field, 2), ...varint(BigInt(value.length)), ...value]; }
function f32(field: number, value: number): number[] {
  const buffer = new ArrayBuffer(4);
  new DataView(buffer).setFloat32(0, value, true);
  return [...tag(field, 5), ...new Uint8Array(buffer)];
}
function text(value: string): number[] { return [...new TextEncoder().encode(value)]; }
function vec(x: number, y: number, z: number): number[] { return [...f32(1, x), ...f32(2, y), ...f32(3, z)]; }
function instance(type: bigint, id: bigint, owner: bigint, position: [number, number, number]): number[] {
  const transform = [...b(1, vec(...position)), ...b(2, vec(0, 0, 0)), ...b(3, vec(1, 1, 1))];
  return [...v(1, type), ...v(2, id), ...v(3, owner), ...b(6, b(11, b(1, b(1, transform))))];
}

describe('observed scene normalizer', () => {
  it('marks older semantic adapters stale even when the source bytes have not changed', () => {
    expect(sceneSnapshotNeedsAdapterRefresh({ adapterId: 'ym-layerdata-observed-v5' })).toBe(true);
    expect(sceneSnapshotNeedsAdapterRefresh({ adapterId: 'ym-layerdata-observed-v6' })).toBe(false);
  });

  it('extracts calibrated instance, transform and group relationships while retaining evidence', () => {
    const first = instance(1101002001034000n, 901n, 900n, [1, 2, 3]);
    const second = instance(1101002001034000n, 902n, 900n, [4, 5, 6]);
    const group = [...v(1, 900n), ...v(3, 901n), ...v(3, 902n)];
    const body = [...b(24, [...v(1, 1101002001034000n), ...b(2, first), ...b(2, second)]), ...b(2, group)];
    const payload = Uint8Array.from(b(5, body));

    const snapshot = normalizeObservedScene(payload, {
      bindingId: 'binding-anonymous', role: 'raw-pbin', sourceSha256: 'a'.repeat(64), observedAt: '2026-08-21T00:00:00.000Z',
    });

    expect(snapshot.instances).toHaveLength(2);
    expect(snapshot.adapterId).toBe('ym-layerdata-observed-v6');
    expect(snapshot.instances[0]).toMatchObject({
      instanceId: '901', elementTypeId: '1101002001034000', ownerId: '900', variant: 'component6-oneof-11',
      transform: { state: 'observed', value: { position: { x: 1, y: 2, z: 3 } } },
      bounds: { state: 'candidate', evidence: { state: 'unknown' } },
    });
    expect(snapshot.groups).toEqual([expect.objectContaining({
      groupId: '900', parentGroupId: null, memberIds: ['901', '902'], nestedGroupIds: [], evidence: expect.any(Object),
      transform: { state: 'absent' }, metadata: { state: 'absent' },
    })]);
  });

  it('interprets group field 2 as the parent group and attaches the child to that parent', () => {
    const cabinet = [...v(1, 513n), ...v(2, 626n), ...v(3, 510n), ...v(3, 511n), ...v(3, 512n)];
    const signalBox = [...v(1, 626n), ...v(3, 517n)];
    const body = [
      ...b(24, [
        ...v(1, 7000n),
        ...b(2, instance(7000n, 510n, 513n, [0, 0, 1])),
        ...b(2, instance(7000n, 511n, 513n, [0, 0, 1])),
        ...b(2, instance(7000n, 512n, 513n, [0, 0, 1])),
        ...b(2, instance(7000n, 517n, 626n, [0, 0, 1])),
      ]),
      ...b(2, cabinet),
      ...b(2, signalBox),
    ];

    const snapshot = normalizeObservedScene(Uint8Array.from(b(5, body)), {
      bindingId: 'binding-anonymous', role: 'raw-pbin', sourceSha256: 'c'.repeat(64), observedAt: '2026-08-21T00:00:00.000Z',
    });

    expect(snapshot.groups).toEqual([
      expect.objectContaining({ groupId: '513', parentGroupId: '626', memberIds: ['510', '511', '512'], nestedGroupIds: [] }),
      expect.objectContaining({ groupId: '626', parentGroupId: null, memberIds: ['517'], nestedGroupIds: ['513'] }),
    ]);
  });

  it('reads the alternate component branch transform instead of silently marking it unsupported', () => {
    const transform = [...b(1, vec(10, 20, 30)), ...b(2, vec(0, 90, 0)), ...b(3, vec(1, 2, 3))];
    const commonBase = b(1, transform);
    const alternate = [
      ...v(1, 1105000000000087n), ...v(2, 517n), ...v(3, 626n),
      ...b(6, b(1, b(1, b(1, b(1, commonBase))))),
    ];
    const payload = Uint8Array.from(b(5, b(24, [...v(1, 1n), ...b(2, alternate)])));
    const snapshot = normalizeObservedScene(payload, {
      bindingId: 'binding-anonymous', role: 'raw-pbin', sourceSha256: 'b'.repeat(64), observedAt: '2026-08-21T00:00:00.000Z',
    });
    expect(snapshot.instances[0]).toMatchObject({
      instanceId: '517', elementTypeId: '1105000000000087', variant: 'component6-oneof-1',
      transform: { state: 'observed', value: { position: { x: 10, y: 20, z: 30 }, rotation: { y: 90 }, scale: { x: 1, y: 2, z: 3 } } },
    });
    expect(snapshot.issues).not.toEqual(expect.arrayContaining([expect.objectContaining({ code: 'UNSUPPORTED_INSTANCE_VARIANT' })]));
  });

  it('retains an unknown component oneof as a bounded raw field summary', () => {
    const unknownComponent = b(6, b(99, [1, 2, 3, 4]));
    const unknown = [...v(1, 7n), ...v(2, 274n), ...v(3, 508n), ...unknownComponent];
    const payload = Uint8Array.from(b(5, b(24, [...v(1, 7n), ...b(2, unknown)])));

    const snapshot = normalizeObservedScene(payload, {
      bindingId: 'binding-anonymous', role: 'raw-pbin', sourceSha256: '9'.repeat(64), observedAt: '2026-08-21T00:00:00.000Z',
    });

    expect(snapshot.instances[0]).toMatchObject({ variant: 'unknown' });
    expect(snapshot.instances[0]!.unknownFields).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'instances[274].6[0]', wireType: 2, length: unknownComponent.length }),
    ]));
    expect(snapshot.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'UNSUPPORTED_INSTANCE_VARIANT', instanceId: '274' }),
    ]));
  });

  it('extracts calibrated signal names and numeric custom properties from the common component base', () => {
    const transform = [...b(1, vec(1, 2, 3)), ...b(2, vec(0, 0, 0)), ...b(3, vec(1, 1, 1))];
    const property = [...b(2, text('测试立方体')), ...b(7, b(2, f32(11, 66)))];
    const commonBase = [
      ...b(1, transform),
      ...b(12, text('测试冰箱')),
      ...b(23, property),
      ...v(88, 7n),
      ...f32(89, 3.5),
      ...b(90, text('password=must-not-be-decoded')),
    ];
    const richInstance = [...v(1, 7n), ...v(2, 273n), ...v(3, 508n), ...b(6, b(11, b(1, commonBase)))];
    const signalRegistry = [...b(1, text('测试冰箱')), ...v(3, 123n), ...v(3, 456n)];
    const instanceIndex = [...v(1, 273n), ...v(2, 0n)];
    const payload = Uint8Array.from([
      ...b(2, text('主图层')),
      ...b(5, b(24, [...v(1, 7n), ...b(2, richInstance)])),
      ...b(7, instanceIndex),
      ...b(9, signalRegistry),
      ...b(11, text('1.5.82.106')),
    ]);

    const snapshot = normalizeObservedScene(payload, {
      bindingId: 'binding-anonymous', role: 'raw-pbin', sourceSha256: 'd'.repeat(64), observedAt: '2026-08-21T00:00:00.000Z',
    });

    expect(snapshot.instances[0]).toMatchObject({
      signals: { state: 'observed', value: [{ name: '测试冰箱' }] },
      customProperties: { state: 'observed', value: [{ key: '测试立方体', value: { kind: 'number', value: 66 } }] },
    });
    expect(snapshot.signalRegistry).toEqual({
      state: 'observed', value: [{ name: '测试冰箱', unknownRefCount: 2 }], evidence: expect.any(Object),
    });
    expect(snapshot.sceneMetadata).toMatchObject({
      layerName: { state: 'observed', value: '主图层' },
      editorVersionCandidate: { state: 'observed', value: '1.5.82.106' },
      instanceIndex: {
        state: 'observed',
        value: { entryCount: 1, duplicateIds: [], missingInstanceIds: [], extraInstanceIds: [], rawStatusValues: ['0'] },
      },
    });
    expect(snapshot.instances[0]!.unknownFields).toHaveLength(3);
    expect(snapshot.instances[0]!.unknownFields.map((field) => field.wireType)).toEqual([0, 5, 2]);
    expect(JSON.stringify(snapshot)).not.toContain('must-not-be-decoded');
    expect(snapshot.unknownFields).toEqual([]);
  });

  it('reports duplicate, missing and extra root instance-index records without guessing raw status semantics', () => {
    const one = instance(7n, 273n, 508n, [1, 2, 3]);
    const payload = Uint8Array.from([
      ...b(5, b(24, [...v(1, 7n), ...b(2, one)])),
      ...b(7, [...v(1, 999n), ...v(2, 3n)]),
      ...b(7, [...v(1, 999n), ...v(2, 3n)]),
    ]);
    const snapshot = normalizeObservedScene(payload, {
      bindingId: 'binding-anonymous', role: 'raw-pbin', sourceSha256: '1'.repeat(64), observedAt: '2026-08-21T00:00:00.000Z',
    });
    expect(snapshot.sceneMetadata?.instanceIndex).toMatchObject({
      state: 'observed',
      value: { entryCount: 2, duplicateIds: ['999'], missingInstanceIds: ['273'], extraInstanceIds: ['999'], rawStatusValues: ['3'] },
    });
    expect(snapshot.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      'INSTANCE_INDEX_DUPLICATE', 'INSTANCE_INDEX_MISSING', 'INSTANCE_INDEX_EXTRA',
    ]));
  });

  it('retains nested signal, instance-index and group-metadata unknown summaries and marks duplicate signal names ambiguous', () => {
    const one = instance(7n, 273n, 508n, [1, 2, 3]);
    const group = [...v(1, 508n), ...b(77, [9, 8, 7])];
    const metadata = [...v(1, 999n), ...v(2, 508n), ...b(4, text('组合')), ...v(5, 1n), ...b(66, [4, 3])];
    const signalA = [...b(1, text('同名信号')), ...v(3, 1n), ...b(88, [1, 2])];
    const signalB = [...b(1, text('同名信号')), ...v(3, 2n)];
    const payload = Uint8Array.from([
      ...b(5, [...b(24, [...v(1, 7n), ...b(2, one)]), ...b(2, group)]),
      ...b(6, metadata),
      ...b(7, [...v(1, 273n), ...v(2, 0n), ...b(55, [5])]),
      ...b(9, signalA),
      ...b(9, signalB),
    ]);
    const snapshot = normalizeObservedScene(payload, {
      bindingId: 'binding-anonymous', role: 'raw-pbin', sourceSha256: '2'.repeat(64), observedAt: '2026-08-21T00:00:00.000Z',
    });
    expect(snapshot.signalRegistry?.state === 'observed' ? snapshot.signalRegistry.value : []).toEqual([
      expect.objectContaining({ name: '同名信号', unknownRefCount: 1, ambiguous: true, unknownFields: expect.any(Array) }),
      expect.objectContaining({ name: '同名信号', unknownRefCount: 1, ambiguous: true }),
    ]);
    expect(snapshot.sceneMetadata?.instanceIndex).toMatchObject({
      state: 'observed', value: { unknownFields: expect.arrayContaining([expect.objectContaining({ path: 'sceneMetadata.instanceIndex[].55[0]', wireType: 2 })]) },
    });
    expect(snapshot.groups[0]?.metadata).toMatchObject({
      state: 'observed', value: { unknownFields: expect.arrayContaining([expect.objectContaining({ path: 'groupMetadata[508].66[0]', wireType: 2 })]) },
    });
  });

  it('reads direct child groups, group transform and opaque player-composition metadata without assigning unverified semantics', () => {
    const groupTransform = [...b(1, vec(-4550, 3200, 0.25)), ...b(2, vec(0, 0, 0)), ...b(3, vec(1, 1, 1))];
    const group = [...v(1, 608n), ...v(3, 544n), ...v(4, 620n), ...b(7, groupTransform), ...v(6, 999n)];
    const child = [...v(1, 620n), ...v(2, 608n)];
    const metadata = [...v(1, 999n), ...v(2, 608n), ...b(4, text('货柜组合')), ...v(5, 1n)];
    const one = instance(7n, 544n, 608n, [0, 0, 1]);
    const payload = Uint8Array.from([...b(5, [...b(24, [...v(1, 7n), ...b(2, one)]), ...b(2, group), ...b(2, child)]), ...b(6, metadata)]);

    const snapshot = normalizeObservedScene(payload, {
      bindingId: 'binding-anonymous', role: 'raw-pbin', sourceSha256: 'e'.repeat(64), observedAt: '2026-08-21T00:00:00.000Z',
    });

    expect(snapshot.groups.find((value) => value.groupId === '608')).toMatchObject({
      parentGroupId: null,
      memberIds: ['544'],
      nestedGroupIds: ['620'],
      transform: { state: 'observed', value: { position: { x: -4550, y: 3200, z: 0.25 } } },
      metadata: { state: 'observed', value: { opaqueRef: '999', rawKind: '1', labelCandidate: '货柜组合' }, evidence: { state: 'inferred-candidate' } },
    });
  });

  it('reports a direct-child/parent relation conflict instead of silently choosing one side', () => {
    const parent = [...v(1, 608n), ...v(4, 620n)];
    const child = [...v(1, 620n), ...v(2, 777n)];
    const one = instance(7n, 544n, 608n, [0, 0, 1]);
    const payload = Uint8Array.from(b(5, [...b(24, [...v(1, 7n), ...b(2, one)]), ...b(2, parent), ...b(2, child)]));
    const snapshot = normalizeObservedScene(payload, {
      bindingId: 'binding-anonymous', role: 'raw-pbin', sourceSha256: 'f'.repeat(64), observedAt: '2026-08-21T00:00:00.000Z',
    });
    expect(snapshot.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'GROUP_RELATION_CONFLICT', instanceId: '620' })]));
  });

  it('enforces instance and group limits while records are being normalized', () => {
    const twoInstances = Uint8Array.from(b(5, b(24, [
      ...v(1, 1n),
      ...b(2, [...v(2, 101n), ...v(3, 7000n)]),
      ...b(2, [...v(2, 102n), ...v(3, 7001n)]),
    ])));
    expect(() => normalizeObservedScene(twoInstances, {
      bindingId: 'a'.repeat(64), role: 'raw-pbin', sourceSha256: 'b'.repeat(64), observedAt: '2026-08-21T00:00:00.000Z',
      limits: { maxInstances: 1, maxGroups: 1 },
    } as never)).toThrowError(expect.objectContaining({ code: 'SCENE_LIMIT_EXCEEDED' }));

    const oneInstanceTwoGroups = Uint8Array.from(b(5, [
      ...b(24, [...v(1, 1n), ...b(2, [...v(2, 101n), ...v(3, 7000n)])]),
      ...b(2, v(1, 900n)),
      ...b(2, v(1, 901n)),
    ]));
    expect(() => normalizeObservedScene(oneInstanceTwoGroups, {
      bindingId: 'a'.repeat(64), role: 'raw-pbin', sourceSha256: 'b'.repeat(64), observedAt: '2026-08-21T00:00:00.000Z',
      limits: { maxInstances: 1, maxGroups: 1 },
    } as never)).toThrowError(expect.objectContaining({ code: 'SCENE_LIMIT_EXCEEDED' }));
  });
});
