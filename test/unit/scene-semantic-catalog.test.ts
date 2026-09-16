import { describe, expect, it } from 'vitest';

import {
  assertSceneEventCompatible,
  buildSceneTypeInventory,
  buildSceneGroupIntelligence,
  resolveSceneInstanceIntelligence,
  summarizeSceneTypeCoverage,
} from '../../src/core/scene/semantic-catalog.js';

describe('scene semantic and capability catalog', () => {
  it('identifies a calibrated signal trigger box and rejects ordinary collision events', () => {
    const result = resolveSceneInstanceIntelligence({
      elementTypeId: '1105000000000087',
      variant: 'unsupported-oneof-1',
    });

    expect(result).toMatchObject({
      canonicalName: '信号触发盒',
      actorFamily: 'trigger-box',
      categoryPath: ['资产', '玩法', '逻辑'],
      evidence: { state: 'confirmed-calibration' },
    });
    expect(result.capabilities).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'trigger.character-enter', state: 'confirmed' }),
      expect.objectContaining({ key: 'physical-touch-event', state: 'not-applicable' }),
    ]));
    expect(result.eventNames).toEqual(expect.arrayContaining([
      'Events.ON_CHARACTER_ENTER_SIGNAL_BOX',
      'Events.ON_CHARACTER_LEAVE_SIGNAL_BOX',
    ]));
    expect(() => assertSceneEventCompatible(result, 'Events.ON_PLAYER_TOUCH_ELEMENT')).toThrowError(
      expect.objectContaining({ code: 'SCENE_CAPABILITY_MISMATCH' }),
    );
    expect(() => assertSceneEventCompatible(result, 'Events.ON_CHARACTER_ENTER_SIGNAL_BOX')).not.toThrow();
  });

  it('keeps a basic block distinct from trigger boxes, items, effects and resources', () => {
    const result = resolveSceneInstanceIntelligence({
      elementTypeId: '1101002001034000',
      variant: 'standard',
    });

    expect(result).toMatchObject({ canonicalName: '立方体', actorFamily: 'element' });
    expect(result.idDomain).toBe('scene-instance');
    expect(result.capabilities).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'collision.query', state: 'runtime-probe-required' }),
      expect.objectContaining({ key: 'transform.read', state: 'official-api-supported' }),
    ]));
  });

  it('describes player-built groups structurally without mislabeling them as custom inventory items', () => {
    const result = buildSceneGroupIntelligence({
      directMemberCount: 3,
      nestedGroupCount: 1,
      recursiveMemberCount: 8,
    });

    expect(result).toMatchObject({
      canonicalName: '场景编组（用途未确认）',
      actorFamily: 'scene-group-unknown',
      idDomain: 'scene-group',
      directMemberCount: 3,
      nestedGroupCount: 1,
      recursiveMemberCount: 8,
    });
    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining('不是背包系统的“自制物品”'),
    ]));
  });

  it('does not guess unknown type IDs and requires runtime classification before event generation', () => {
    const result = resolveSceneInstanceIntelligence({
      elementTypeId: '9999999999999999',
      variant: 'unsupported-oneof-1',
    });

    expect(result).toMatchObject({ canonicalName: null, actorFamily: 'unknown' });
    expect(result.nextActions).toEqual(expect.arrayContaining([
      expect.stringContaining('运行时分类探针'),
    ]));
    expect(() => assertSceneEventCompatible(result, 'Events.ON_PLAYER_TOUCH_ELEMENT')).toThrowError(
      expect.objectContaining({ code: 'SCENE_EVIDENCE_INSUFFICIENT' }),
    );
  });

  it('uses exact snapshot-bound runtime family evidence without turning probe errors into false negatives', () => {
    const trigger = resolveSceneInstanceIntelligence({
      elementTypeId: '9999999999999999',
      variant: 'unsupported-oneof-1',
    }, {
      instanceId: '517', snapshotId: 'a'.repeat(64), sceneSourceSha256: 'b'.repeat(64), importedAt: '2026-08-21T02:00:00.000Z',
      characterState: 'absent', creatureState: 'absent',
      elementState: 'absent', logicElementState: 'absent', triggerBoxState: 'present',
      playerState: 'absent',
      triggerSampleState: 'ok', triggerSample: [1, 2, 3],
      fields: { position: { status: 'ok', value: { kind: 'vector', value: [1, 2, 3] } } }, fieldConflicts: [],
    });
    expect(trigger).toMatchObject({ actorFamily: 'trigger-box' });
    expect(trigger.capabilities).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'runtime.family.trigger-box', state: 'runtime-observed' }),
      expect.objectContaining({ key: 'runtime.family.element', state: 'not-applicable' }),
    ]));
    expect(() => assertSceneEventCompatible(trigger, 'Events.ON_CHARACTER_ENTER_SIGNAL_BOX')).not.toThrow();

    const errors = resolveSceneInstanceIntelligence({ elementTypeId: null, variant: 'unknown' }, {
      instanceId: '999', snapshotId: 'a'.repeat(64), sceneSourceSha256: 'b'.repeat(64), importedAt: '2026-08-21T02:00:00.000Z',
      elementState: 'error', logicElementState: 'error', triggerBoxState: 'error',
      triggerSampleState: 'error', triggerSample: null,
      fields: { collision: { status: 'error', value: null } }, fieldConflicts: [],
    });
    expect(errors.actorFamily).toBe('unknown');
    expect(errors.capabilities).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'runtime.family.element', state: 'unknown' }),
      expect.objectContaining({ key: 'runtime.family.trigger-box', state: 'unknown' }),
    ]));
    expect(() => assertSceneEventCompatible(errors, 'Events.ON_PLAYER_TOUCH_ELEMENT')).toThrowError(
      expect.objectContaining({ code: 'SCENE_EVIDENCE_INSUFFICIENT' }),
    );

    const partiallyFailed = resolveSceneInstanceIntelligence({ elementTypeId: null, variant: 'unknown' }, {
      instanceId: '1000', snapshotId: 'a'.repeat(64), sceneSourceSha256: 'b'.repeat(64), importedAt: '2026-08-21T02:00:00.000Z',
      elementState: 'present', logicElementState: 'absent', triggerBoxState: 'error',
      triggerSampleState: 'error', triggerSample: null, fields: {}, fieldConflicts: [],
    });
    expect(partiallyFailed.actorFamily).toBe('unknown');
    expect(partiallyFailed.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining('对象族探针仍有失败'),
    ]));
    expect(() => assertSceneEventCompatible(partiallyFailed, 'Events.ON_PLAYER_TOUCH_ELEMENT')).toThrowError(
      expect.objectContaining({ code: 'SCENE_EVIDENCE_INSUFFICIENT' }),
    );
  });

  it('reports calibrated type coverage without pretending unknown official assets are classified', () => {
    const coverage = summarizeSceneTypeCoverage({
      instances: [
        { elementTypeId: '1105000000000087' },
        { elementTypeId: '1105000000000087' },
        { elementTypeId: '1101002001034000' },
        { elementTypeId: '9999999999999999' },
        { elementTypeId: null },
      ],
    });

    expect(coverage).toMatchObject({
      encounteredTypeCount: 4,
      calibratedTypeCount: 2,
      calibratedInstanceCount: 3,
      unknownInstanceCount: 2,
      catalog: {
        calibratedAt: '2026-08-11',
        verifiedOfficialApiVersion: '1.4.7',
      },
    });
    expect(coverage.unknownTypeIds).toEqual(['9999999999999999']);
    expect(coverage.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining('不能把未覆盖类型自动归类'),
    ]));
  });

  it('builds a deterministic per-type inventory with representatives and a calibration queue', () => {
    const inventory = buildSceneTypeInventory({
      instances: [
        { instanceId: '12', elementTypeId: '9999999999999999', variant: 'unsupported-oneof-1' },
        { instanceId: '10', elementTypeId: '1105000000000087', variant: 'component6-oneof-11' },
        { instanceId: '11', elementTypeId: '9999999999999999', variant: 'standard' },
        { instanceId: '13', elementTypeId: null, variant: 'unknown' },
      ],
    });

    expect(inventory.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        typeId: '1105000000000087', instanceCount: 1, canonicalName: '信号触发盒',
        actorFamily: 'trigger-box', calibrationState: 'calibrated', representativeInstanceIds: ['10'],
      }),
      expect.objectContaining({
        typeId: '9999999999999999', instanceCount: 2, canonicalName: null,
        actorFamily: 'unknown', calibrationState: 'pending-runtime-probe', representativeInstanceIds: ['11', '12'],
        variants: ['standard', 'unsupported-oneof-1'],
      }),
      expect.objectContaining({ typeId: null, instanceCount: 1, calibrationState: 'missing-type-id' }),
    ]));
    expect(inventory.summary).toMatchObject({ uniqueTypeStates: 3, calibratedTypes: 1, pendingTypes: 2 });
    expect(inventory.pendingCalibration.map((entry) => entry.typeId)).toEqual(['9999999999999999', null]);
  });

  it('reuses unanimous runtime family evidence for an unknown type ID without guessing its official display name', () => {
    const inventory = buildSceneTypeInventory({
      instances: [
        { instanceId: '21', elementTypeId: '9999999999999998', variant: 'unknown' },
        { instanceId: '22', elementTypeId: '9999999999999998', variant: 'unknown' },
      ],
      runtimeActorFamiliesByInstance: new Map([
        ['21', 'creature'],
        ['22', 'creature'],
      ]),
    });

    expect(inventory.entries[0]).toMatchObject({
      typeId: '9999999999999998', actorFamily: 'creature', calibrationState: 'runtime-calibrated',
      canonicalName: '生物对象（运行时确认）', runtimeObservedInstanceCount: 2,
    });
    expect(inventory.entries[0]?.eventNames).toEqual(expect.arrayContaining([
      'Events.ON_CREATURE_CREATED',
      'Events.ON_CREATURE_DESTROYED',
    ]));
    expect(inventory.summary).toMatchObject({ calibratedTypes: 1, pendingTypes: 0 });
  });

  it('does not type-learn when runtime family observations conflict for the same type ID', () => {
    const inventory = buildSceneTypeInventory({
      instances: [
        { instanceId: '31', elementTypeId: '9999999999999997', variant: 'unknown' },
        { instanceId: '32', elementTypeId: '9999999999999997', variant: 'unknown' },
      ],
      runtimeActorFamiliesByInstance: new Map([
        ['31', 'creature'],
        ['32', 'player'],
      ]),
    });

    expect(inventory.entries[0]).toMatchObject({
      actorFamily: 'unknown', calibrationState: 'pending-runtime-probe', runtimeObservedInstanceCount: 2,
    });
    expect(inventory.entries[0]?.nextActions.join(' ')).toMatch(/冲突/u);
  });

  it('exposes official LogicElement events after a unique runtime classification', () => {
    const result = resolveSceneInstanceIntelligence({ elementTypeId: null, variant: 'unknown' }, {
      instanceId: '40', snapshotId: 'a'.repeat(64), sceneSourceSha256: 'b'.repeat(64), importedAt: '2026-08-21T02:00:00.000Z',
      characterState: 'absent', creatureState: 'absent', elementState: 'absent', logicElementState: 'present',
      playerState: 'absent', triggerBoxState: 'absent', triggerSampleState: 'not-applicable', triggerSample: null,
      fields: {}, fieldConflicts: [],
    });

    expect(result).toMatchObject({ actorFamily: 'logic-element', canonicalName: '逻辑元件（运行时确认）' });
    expect(result.eventNames).toEqual(expect.arrayContaining([
      'Events.ON_LOGIC_ACTOR_ENTER_TRIGGER',
      'Events.ON_LOGIC_ACTOR_END_MOVING',
    ]));
  });
});
