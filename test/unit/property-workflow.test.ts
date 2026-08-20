import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import type { RegistryRecord } from '../../src/core/model.js';
import {
  PropertyWorkflow,
  createPropertySnapshot,
  diffPropertySnapshots,
  editPropertyLiteral,
  searchPropertySnapshot,
  selectPropertyTarget,
  validatePropertyFilename,
} from '../../src/core/property/workflow.js';

const projectInstanceId = '00000000-0000-4000-8000-000000000904';
const mapFingerprint = 'c'.repeat(64);

function record(
  kind: RegistryRecord['kind'],
  value: string,
  options: Partial<RegistryRecord> = {},
): RegistryRecord {
  return {
    recordId: `${kind}-${value}`,
    kind,
    name: `${kind} ${value}`,
    value,
    scope: 'workspace',
    projectInstanceId,
    mapFingerprint,
    layerId: kind === 'scene-instance' ? '7001' : null,
    environment: 'test',
    validity: 'confirmed',
    source: {
      kind: 'user-entry', relativePath: null, sha256: 'a'.repeat(64),
      observedAt: '2026-08-20T00:00:00.000Z', officialExtensionVersion: null, evidence: 'UNIT_E2E',
    },
    lastConfirmedAt: '2026-08-20T00:00:00.000Z',
    notes: '',
    ...options,
  };
}

const layer = record('scene-layer', '7001');
const instance = record('scene-instance', '8001');

describe('custom property target selection', () => {
  it('requires exact same-project map records and exact filename', () => {
    const target = selectPropertyTarget({ projectInstanceId, mapFingerprint, layers: [layer], instances: [instance] });
    expect(target).toMatchObject({ layerId: '7001', uid: '8001', filename: 'CustomProperty_7001_8001.lua', warning: null });
    expect(validatePropertyFilename(target, 'CustomProperty_7001_8001.lua')).toBe(true);
    expect(() => validatePropertyFilename(target, '../CustomProperty_7001_8001.lua')).toThrowError(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
    expect(() => validatePropertyFilename(target, 'CustomProperty_7001_9999.lua')).toThrowError(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
    expect(() => selectPropertyTarget({ projectInstanceId, mapFingerprint, layers: [layer], instances: [
      { ...instance, mapFingerprint: 'd'.repeat(64) },
    ] })).toThrowError(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
    expect(() => selectPropertyTarget({ projectInstanceId, mapFingerprint, layers: [layer], instances: [
      { ...instance, validity: 'suspected-change' },
    ] })).toThrowError(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
  });

  it('permits one user-entered non-formal pair when MAP_INFO fingerprint is unknown without promoting it', () => {
    const unknownLayer = { ...layer, mapFingerprint: null, environment: 'unspecified' as const, validity: 'pending' as const };
    const unknownInstance = { ...instance, mapFingerprint: null };
    const before = JSON.stringify([unknownLayer, unknownInstance]);
    const target = selectPropertyTarget({ projectInstanceId, mapFingerprint: null, layers: [unknownLayer], instances: [unknownInstance] });
    expect(target.warning).toBe('地图身份未由官方确认');
    expect(JSON.stringify([unknownLayer, unknownInstance])).toBe(before);
    expect(() => selectPropertyTarget({ projectInstanceId, mapFingerprint: null, layers: [{ ...unknownLayer, environment: 'formal' }], instances: [unknownInstance] })).toThrowError(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
    expect(() => selectPropertyTarget({ projectInstanceId, mapFingerprint: null, layers: [unknownLayer], instances: [{ ...unknownInstance, source: { ...unknownInstance.source, kind: 'official-export' } }] })).toThrowError(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
    expect(() => selectPropertyTarget({ projectInstanceId, mapFingerprint: null, layers: [unknownLayer, { ...unknownLayer, value: '7002' }], instances: [unknownInstance] })).toThrowError(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
    expect(() => selectPropertyTarget({ projectInstanceId, mapFingerprint: null, layers: [unknownLayer], instances: [{ ...unknownInstance, projectInstanceId: '00000000-0000-4000-8000-000000000999' }] })).toThrowError(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
  });
});

describe('custom property literal edit and push states', () => {
  it('edits only existing scalar ranges and creates comparable snapshots', async () => {
    const source = await readFile('test/fixtures/property/anonymous-property.txt', 'utf8');
    const before = createPropertySnapshot(source, '2026-08-20T00:00:00.000Z');
    const edited = editPropertyLiteral(source, '/title', 'Changed');
    const after = createPropertySnapshot(edited, '2026-08-20T00:01:00.000Z');
    expect(edited).toContain('title = "Changed"');
    expect(after.sha256).not.toBe(before.sha256);
    expect(after.values['/title']).toBe('Changed');
    expect(diffPropertySnapshots(before, after)).toMatchObject({
      added: [], removed: [], changed: [{ path: '/title', before: 'Anonymous', after: 'Changed' }],
    });
    expect(searchPropertySnapshot(after, 'title')).toEqual([{ path: '/title', value: 'Changed' }]);
    expect(() => editPropertyLiteral(source, '/nested', 'no')).toThrowError(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
    expect(() => editPropertyLiteral(source, '/missing', 1)).toThrowError(expect.objectContaining({ code: 'NOT_FOUND' }));
    expect(() => editPropertyLiteral(source, '/count', { unsafe: true } as never)).toThrowError(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
  });

  it('keeps file and push confirmations separate and command resolution is not editor verification', () => {
    const workflow = new PropertyWorkflow();
    workflow.requestRead();
    workflow.load();
    workflow.previewEdit();
    expect(() => workflow.writeFile(false)).toThrowError(expect.objectContaining({ code: 'CONFIRMATION_REQUIRED' }));
    workflow.writeFile(true);
    expect(workflow.state).toBe('file-written');
    expect(() => workflow.requestPush(false)).toThrowError(expect.objectContaining({ code: 'CONFIRMATION_REQUIRED' }));
    workflow.requestPush(true);
    workflow.commandResolved();
    expect(workflow.state).toBe('push-requested');
    workflow.recordEditorVerification();
    expect(workflow.state).toBe('editor-verified');
  });
});
