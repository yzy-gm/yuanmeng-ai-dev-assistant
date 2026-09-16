import { describe, expect, it } from 'vitest';

import {
  createRuntimeOnlyProbeContext,
  createSceneProbeToken,
  parseSceneProbeLog,
  requireAlignmentPlanEvidence,
  resolveCapabilityEvidenceDocuments,
  type SceneProbeContext,
} from '../../src/core/scene/probe-evidence.js';

const context: SceneProbeContext = {
  projectInstanceId: '33333333-3333-4333-8333-333333333333',
  bindingId: 'b'.repeat(64),
  snapshotId: 'a'.repeat(64),
  sceneSourceSha256: 'c'.repeat(64),
};
const importedAt = '2026-08-21T02:00:00.000Z';

function common(kind: 'measurement' | 'property' | 'alignment', ids: readonly string[]): string {
  return [
    `token=${createSceneProbeToken(context, kind, ids)}`,
    `snapshot=${context.snapshotId}`,
    `source=${context.sceneSourceSha256}`,
  ].join(' ');
}

function bytes(lines: readonly string[]): Uint8Array {
  return new TextEncoder().encode(`${lines.join('\n')}\n`);
}

describe('scene probe evidence', () => {
  it('creates deterministic runtime-only contexts for explicitly registered instances without a full snapshot', () => {
    const first = createRuntimeOnlyProbeContext(context.projectInstanceId, 'manual-scene-901', 'd'.repeat(64));
    const same = createRuntimeOnlyProbeContext(context.projectInstanceId, 'manual-scene-901', 'd'.repeat(64));
    const other = createRuntimeOnlyProbeContext(context.projectInstanceId, 'manual-scene-902', 'd'.repeat(64));
    expect(first).toEqual(same);
    expect(first.bindingId).toBe('d'.repeat(64));
    expect(first.sceneSourceSha256).toBe('d'.repeat(64));
    expect(first.snapshotId).toMatch(/^[a-f0-9]{64}$/u);
    expect(other.snapshotId).not.toBe(first.snapshotId);
    expect(() => createRuntimeOnlyProbeContext(context.projectInstanceId, 'manual-scene-901', 'not-a-sha')).toThrowError(
      expect.objectContaining({ code: 'VALIDATION_FAILED' }),
    );
  });

  it('parses all five structured markers after arbitrary log prefixes without treating unrelated numbers as IDs', () => {
    const log = bytes([
      'engine retry=777 [YMAI_SCENE_PROBE] '
        + `${common('measurement', ['901', '902'])} selection=901,902 id=901 status=ok type=7000 `
        + 'position=1,2,3 rotation=0,0,0 scale=1,1,1 sizeBox=4,5,6 meshCenter=0,0,1 '
        + 'visible=true physics=true collision=true canBeGrabbed=false parent=0 childCount=2',
      'prefix 123 [YMAI_PROPERTY_MATCH] '
        + `${common('property', ['901', '902'])} selection=901,902 id=902 status=match `
        + `propertyHash=${'d'.repeat(64)} propertyType=Number`,
      'runtime 456 [YMAI_SCENE_CAPABILITY] '
        + `${common('measurement', ['901', '902'])} selection=901,902 id=902 status=ok `
        + 'characterState=absent creatureState=absent elementState=error logicElementState=absent '
        + 'playerState=absent triggerBoxState=present triggerSampleState=ok triggerSample=1,2,3',
      'field [YMAI_SCENE_FIELD] '
        + `${common('measurement', ['901', '902'])} selection=901,902 id=902 field=position status=ok value=1,2,3`,
      'group 789 [YMAI_SCENE_GROUP] '
        + `${common('measurement', ['626', '517', '513'])} selection=513,517,626 group=626 status=ok `
        + 'immediateSuccess=true recursiveSuccess=true immediateCount=2 recursiveCount=4 '
        + 'immediate=513,517 recursive=510,511,512,517 truncated=false staticDirect=517 staticNested=513',
      'anything [YMAI_AUTO_ALIGN] '
        + `${common('alignment', ['900', '901', '902'])} support=900 movers=901,902 status=planned `
        + 'supportTopZ=10.5 lowestZ=7 deltaZ=3.5',
    ]);

    const parsed = parseSceneProbeLog(log, { context, importedAt });

    expect(parsed).toMatchObject({
      schemaVersion: 1,
      importedAt,
      ...context,
    });
    expect(parsed.sourceHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(parsed.entries).toEqual([
      expect.objectContaining({ kind: 'measurement', id: '901', selectionIds: ['901', '902'], elementTypeId: '7000' }),
      expect.objectContaining({ kind: 'property-match', id: '902', selectionIds: ['901', '902'], propertyType: 'Number' }),
      expect.objectContaining({
        kind: 'capability', id: '902', characterState: 'absent', creatureState: 'absent',
        triggerBoxState: 'present', elementState: 'error', playerState: 'absent', triggerSampleState: 'ok',
      }),
      expect.objectContaining({ kind: 'field-capability', id: '902', field: 'position', status: 'ok', value: { kind: 'vector', value: [1, 2, 3] } }),
      expect.objectContaining({ kind: 'group-structure', groupId: '626', immediateIds: ['513', '517'], recursiveCount: 4 }),
      expect.objectContaining({ kind: 'alignment-plan', supportId: '900', moverIds: ['901', '902'], deltaZ: 3.5 }),
    ]);
    expect(parsed.issues).toEqual([]);
    expect(JSON.stringify(parsed)).not.toContain('retry=777');
  });

  it.each([
    ['token', `token=${'f'.repeat(64)}`],
    ['snapshot', `snapshot=${'e'.repeat(64)}`],
    ['source', `source=${'d'.repeat(64)}`],
  ])('rejects a bound line with the wrong %s', (field, replacement) => {
    const valid = `[YMAI_AUTO_ALIGN] ${common('alignment', ['900', '901'])} support=900 movers=901 status=planned supportTopZ=5 lowestZ=3 deltaZ=2`;
    const damaged = valid.replace(new RegExp(`${field}=[^ ]+`, 'u'), replacement);
    expect(() => parseSceneProbeLog(bytes([damaged]), { context, importedAt })).toThrowError(
      expect.objectContaining({ code: 'SCENE_EVIDENCE_INSUFFICIENT' }),
    );
  });

  it('reports duplicate, conflicting, malformed and non-finite entries as explicit issues', () => {
    const base = `[YMAI_AUTO_ALIGN] ${common('alignment', ['900', '901', '902'])} support=900 movers=901,902 status=planned supportTopZ=10 lowestZ=7 deltaZ=3`;
    const parsed = parseSceneProbeLog(bytes([
      base,
      base,
      base.replace('deltaZ=3', 'deltaZ=4'),
      `[YMAI_AUTO_ALIGN] ${common('alignment', ['900', '901', '902'])} support=900 movers=901,901 status=planned supportTopZ=NaN lowestZ=7 deltaZ=Infinity`,
      `[YMAI_SCENE_PROBE] ${'x'.repeat(5000)}`,
    ]), { context, importedAt });

    expect(parsed.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      'DUPLICATE_ENTRY',
      'CONFLICTING_ENTRY',
      'INVALID_ID_SET',
      'NON_FINITE_NUMBER',
      'LINE_TOO_LONG',
    ]));
    expect(() => requireAlignmentPlanEvidence(parsed, context, '900', ['901', '902'])).toThrowError(
      expect.objectContaining({ code: 'SCENE_EVIDENCE_INSUFFICIENT' }),
    );
  });

  it('accepts only a conflict-free successful plan for the exact support and mover set', () => {
    const parsed = parseSceneProbeLog(bytes([
      `[YMAI_AUTO_ALIGN] ${common('alignment', ['900', '901', '902'])} support=900 movers=901,902 status=planned supportTopZ=10 lowestZ=7 deltaZ=3`,
    ]), { context, importedAt });

    expect(requireAlignmentPlanEvidence(parsed, context, '900', ['902', '901'])).toMatchObject({
      token: createSceneProbeToken(context, 'alignment', ['900', '901', '902']),
      deltaZ: 3,
    });
    expect(() => requireAlignmentPlanEvidence(parsed, context, '900', ['903'])).toThrowError(
      expect.objectContaining({ code: 'SCENE_EVIDENCE_INSUFFICIENT' }),
    );
  });

  it('merges only identical capability observations from the exact current scene context', () => {
    const capabilityLine = (triggerBoxState: 'present' | 'absent') => (
      `[YMAI_SCENE_CAPABILITY] ${common('measurement', ['517'])} selection=517 id=517 status=ok `
      + `elementState=absent logicElementState=absent triggerBoxState=${triggerBoxState} `
      + `triggerSampleState=${triggerBoxState === 'present' ? 'ok' : 'not-applicable'} triggerSample=${triggerBoxState === 'present' ? '1,2,3' : 'invalid'}`
    );
    const first = parseSceneProbeLog(bytes([capabilityLine('present')]), { context, importedAt });
    const duplicate = parseSceneProbeLog(bytes([capabilityLine('present')]), { context, importedAt: '2026-08-21T03:00:00.000Z' });
    const conflicting = parseSceneProbeLog(bytes([capabilityLine('absent')]), { context, importedAt: '2026-08-21T04:00:00.000Z' });
    expect(resolveCapabilityEvidenceDocuments([first, duplicate], context).get('517')).toMatchObject({
      state: 'unique', evidence: { triggerBoxState: 'present', triggerSample: [1, 2, 3] },
    });
    expect(resolveCapabilityEvidenceDocuments([first, conflicting], context).get('517')).toEqual({ state: 'conflict', evidence: null });
    expect(resolveCapabilityEvidenceDocuments([{ ...first, snapshotId: 'f'.repeat(64) }], context).size).toBe(0);
  });

  it('keeps legacy three-family logs usable while marking newly introduced families unknown', () => {
    const parsed = parseSceneProbeLog(bytes([
      `[YMAI_SCENE_CAPABILITY] ${common('measurement', ['517'])} selection=517 id=517 status=ok `
      + 'elementState=absent logicElementState=absent triggerBoxState=present '
      + 'triggerSampleState=ok triggerSample=1,2,3',
    ]), { context, importedAt });

    expect(parsed.entries[0]).toMatchObject({
      kind: 'capability', characterState: 'error', creatureState: 'error', playerState: 'error',
    });
  });
});
