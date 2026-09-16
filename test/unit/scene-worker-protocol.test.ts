import { describe, expect, it } from 'vitest';

import {
  parseSceneWorkerRequest,
  parseSceneWorkerResponse,
} from '../../src/core/scene/worker-protocol.js';

const evidence = { state: 'observed-repeatable', source: 'anonymous', confidence: 0.9 } as const;

function validInstance() {
  return {
    instanceId: '101', elementTypeId: '7000', ownerId: null, variant: 'standard', evidence,
    transform: { state: 'absent' as const }, customProperties: { state: 'absent' as const },
    signals: { state: 'absent' as const }, resources: { state: 'absent' as const },
    bounds: { state: 'absent' as const }, unknownFields: [],
  };
}

function validSnapshot() {
  return {
    schemaVersion: 1 as const, snapshotId: 'a'.repeat(64), bindingId: 'b'.repeat(64), role: 'raw-pbin' as const,
    sourceSha256: 'c'.repeat(64), observedAt: '2026-08-21T00:00:00.000Z', adapterId: 'observed-v1',
    instances: [validInstance()], groups: [], issues: [], unknownFields: [],
  };
}

describe('closed scene worker protocol', () => {
  it('rejects request properties outside the closed protocol', () => {
    expect(() => parseSceneWorkerRequest({
      protocolVersion: 1,
      kind: 'process',
      requestId: 'request-1',
      input: {
        bytes: Uint8Array.from([8, 1]),
        bindingId: 'a'.repeat(64),
        role: 'raw-pbin',
        sourceSha256: 'b'.repeat(64),
        observedAt: '2026-08-21T00:00:00.000Z',
      },
      privatePath: 'D:\\private-map\\LayerData.pbin',
    })).toThrowError(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
  });

  it('rejects response properties outside the closed protocol', () => {
    expect(() => parseSceneWorkerResponse({
      protocolVersion: 1,
      kind: 'error',
      requestId: 'request-1',
      code: 'VALIDATION_FAILED',
      message: '请求无效。',
      nextActions: [],
      evidence: 'STATIC_LOCAL',
      stack: 'D:\\private-map\\LayerData.pbin',
    })).toThrowError(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
  });

  it('rejects private fields hidden inside a result payload', () => {
    expect(() => parseSceneWorkerResponse({
      protocolVersion: 1,
      kind: 'result',
      requestId: 'request-1',
      operation: 'process',
      value: {
        snapshot: {},
        index: {},
        metrics: { elapsedMilliseconds: 1, peakHeapUsedBytes: 1 },
        privatePath: 'D:\\private-map\\LayerData.pbin',
      },
    })).toThrowError(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
  });

  it('rejects unknown properties nested inside snapshot instances and issues', () => {
    const snapshot = validSnapshot();
    (snapshot.instances[0] as unknown as Record<string, unknown>).privatePath = 'D:\\private-map\\LayerData.pbin';
    expect(() => parseSceneWorkerRequest({
      protocolVersion: 1, kind: 'index', requestId: 'request-nested-instance', snapshot,
    })).toThrowError(expect.objectContaining({ code: 'VALIDATION_FAILED' }));

    const issueSnapshot = validSnapshot();
    issueSnapshot.issues.push({
      code: 'ORPHAN_OWNER', message: 'anonymous', instanceId: '101', privatePath: 'D:\\private-map\\LayerData.pbin',
    } as never);
    expect(() => parseSceneWorkerRequest({
      protocolVersion: 1, kind: 'index', requestId: 'request-nested-issue', snapshot: issueSnapshot,
    })).toThrowError(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
  });

  it('rejects malformed map entries and hidden properties in diff changes', () => {
    const snapshot = validSnapshot();
    expect(() => parseSceneWorkerResponse({
      protocolVersion: 1, kind: 'result', requestId: 'request-bad-index', operation: 'index',
      value: {
        snapshot,
        byInstanceId: new Map([['101', [{ ...validInstance(), privatePath: 'D:\\private-map' }]]]),
        byElementTypeId: new Map([['7000', [validInstance()]]]), byOwnerId: new Map(),
      },
    })).toThrowError(expect.objectContaining({ code: 'VALIDATION_FAILED' }));

    expect(() => parseSceneWorkerResponse({
      protocolVersion: 1, kind: 'result', requestId: 'request-bad-diff', operation: 'diff',
      value: {
        fromSnapshotId: 'a'.repeat(64), toSnapshotId: 'd'.repeat(64),
        changes: [{ kind: 'relation', instanceId: '101', beforeOwnerId: null, afterOwnerId: '200', privatePath: 'D:\\private-map' }],
      },
    })).toThrowError(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
  });

  it('accepts the closed v4 scene intelligence fields without allowing hidden payloads', () => {
    const snapshot = validSnapshot();
    snapshot.instances[0]!.variant = 'component6-oneof-1';
    snapshot.groups.push({
      groupId: '608', memberIds: ['101'], nestedGroupIds: [], parentGroupId: null, evidence,
      transform: { state: 'absent' },
      metadata: { state: 'observed', value: { opaqueRef: '999', rawKind: '1', labelCandidate: '匿名组合' }, evidence },
    } as never);
    (snapshot as unknown as Record<string, unknown>).signalRegistry = {
      state: 'observed', value: [{ name: '匿名信号', unknownRefCount: 2 }], evidence,
    };
    expect(() => parseSceneWorkerRequest({
      protocolVersion: 1, kind: 'index', requestId: 'request-v4', snapshot,
    })).not.toThrow();

    ((snapshot.groups[0] as unknown as { metadata: { value: Record<string, unknown> } }).metadata.value).privatePath = 'D:\\private';
    expect(() => parseSceneWorkerRequest({
      protocolVersion: 1, kind: 'index', requestId: 'request-v4-private', snapshot,
    })).toThrowError(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
  });
});
