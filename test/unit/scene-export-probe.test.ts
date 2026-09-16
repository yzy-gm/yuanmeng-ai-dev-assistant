import { describe, expect, it } from 'vitest';
import luaparse from 'luaparse';

import { renderSceneExport } from '../../src/core/scene/export.js';
import {
  generateCustomPropertyLookupProbe,
  generateFloorAlignmentLua,
  generateSceneGroupStructureProbe,
  generateSceneMeasurementProbe,
} from '../../src/core/scene/lua-probe.js';
import { createSceneProbeToken, type SceneProbeContext } from '../../src/core/scene/probe-evidence.js';
import type { SceneSnapshot } from '../../src/core/scene/types.js';

const evidence = { state: 'observed-repeatable' as const, source: 'anonymous', confidence: 0.9 };
const snapshot: SceneSnapshot = {
  schemaVersion: 1, snapshotId: 'a'.repeat(64), bindingId: 'b'.repeat(64), role: 'raw-pbin', sourceSha256: 'c'.repeat(64),
  observedAt: '2026-08-21T00:00:00.000Z', adapterId: 'observed-v1', groups: [], issues: [], unknownFields: [],
  instances: [{ instanceId: '901', elementTypeId: '7000', ownerId: null, variant: 'standard', evidence,
    transform: { state: 'absent' }, customProperties: { state: 'absent' }, signals: { state: 'absent' }, resources: { state: 'absent' }, bounds: { state: 'absent' }, unknownFields: [] }],
};
const context: SceneProbeContext = {
  projectInstanceId: '33333333-3333-4333-8333-333333333333',
  bindingId: snapshot.bindingId,
  snapshotId: snapshot.snapshotId,
  sceneSourceSha256: snapshot.sourceSha256,
};

function expectValidLua(source: string): void {
  expect(() => luaparse.parse(source, { luaVersion: '5.3' })).not.toThrow();
}

describe('scene exports and official API probes', () => {
  it.each(['json', 'csv', 'md'] as const)('exports %s without absolute paths or raw payloads', (format) => {
    const rendered = renderSceneExport(snapshot, format);
    expect(rendered).toContain('901');
    expect(rendered).not.toMatch(/[A-Za-z]:[\\/]/u);
    expect(rendered).not.toContain('payload');
  });

  it('classifies selected IDs before using family-specific read APIs', () => {
    const source = generateSceneMeasurementProbe(['901', '902'], context);
    expectValidLua(source);
    expect(source).toContain('MiscService:IsObjectExist(objectType, instanceId)');
    expect(source).toContain('YMAI_ObjectState(MiscService.EQueryableObjectType.Element, instanceId)');
    expect(source).toContain('YMAI_ObjectState(MiscService.EQueryableObjectType.LogicElement, instanceId)');
    expect(source).toContain('YMAI_ObjectState(MiscService.EQueryableObjectType.TriggerBox, instanceId)');
    expect(source).toContain('if not ok then return "error" end');
    expect(source).toContain('if exists == true then return "present" end');
    expect(source).toContain('if type(exists) ~= "boolean" then return "error" end');
    expect(source).toContain('return "absent"');
    expect(source).toContain('YMAI_ProbeField(instanceId, "position", isElement');
    expect(source).toContain('Element:GetPosition');
    expect(source).toContain('Element:GetSizeBox');
    expect(source).toContain('Element:GetAttachParentElement');
    expect(source).toContain('TriggerBox:GetRandomPosition');
    expect(source).toContain('[YMAI_SCENE_CAPABILITY]');
    expect(source).toContain('[YMAI_SCENE_FIELD]');
    expect(source).toContain('[YMAI_SCENE_PROBE]');
    expect(source).toContain('YMAI_ProbeField');
    expect(source).toContain('"collision", isElement and not isTriggerBox');
    expect(source).not.toContain('PrintTable');
    expect(source).not.toMatch(/while\s+true/iu);
    expect(source).toContain(`token=${createSceneProbeToken(context, 'measurement', ['901', '902'])}`);
    expect(source).toContain(`snapshot=${snapshot.snapshotId}`);
    expect(source).toContain(`source=${snapshot.sourceSha256}`);
    expect(() => generateSceneMeasurementProbe([], context)).toThrowError(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
    expect(() => generateSceneMeasurementProbe(Array.from({ length: 101 }, (_, index) => String(index)), context))
      .toThrowError(expect.objectContaining({ code: 'SCENE_LIMIT_EXCEEDED' }));
  });

  it('generates a bounded read-only group probe for direct and recursive members', () => {
    const source = generateSceneGroupStructureProbe('626', ['517'], ['513'], context);
    expectValidLua(source);
    // 当前本地官方声明没有这两个“编组成员” API；探针必须保持静态证据，
    // 不能生成会在官方运行时直接报错的伪调用。
    expect(source).not.toContain('Element:GetImmediateGroupMembers');
    expect(source).not.toContain('Element:GetAllGroupElements');
    expect(source).toContain('status=unsupported-api');
    expect(source).toContain('[YMAI_SCENE_GROUP]');
    expect(source).toContain('local YMAI_GROUP_STATIC_DIRECT = "517"');
    expect(source).toContain('local YMAI_GROUP_STATIC_NESTED = "513"');
    expect(source).toContain('.. " staticDirect=" .. YMAI_GROUP_STATIC_DIRECT');
    expect(source).not.toContain('SetPosition');
    expect(source).not.toContain('SetPhysics');
    expect(() => generateSceneGroupStructureProbe('bad', ['517'], [], context))
      .toThrowError(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
  });

  it('generates a bounded read-only custom-property name lookup across snapshot IDs', () => {
    const source = generateCustomPropertyLookupProbe(['901', '902'], '测试立方体', 'Number', context);
    expectValidLua(source);
    expect(source).toContain('CustomProperty:GetCustomProperty');
    expect(source).toContain('CustomProperty.PROPERTY_TYPE.Number');
    expect(source).toContain('[YMAI_PROPERTY_MATCH]');
    expect(source).not.toContain('SetCustomProperty');
  });

  it('generates one-shot preview and explicit execution variants for verified raycast alignment', () => {
    const preview = generateFloorAlignmentLua('900', ['901', '902'], { execute: false, context });
    expectValidLua(preview);
    expect(preview).toContain('PlayInteractive:GetHitResultWithRaycast');
    expect(preview).toContain('TimerManager:AddFrame');
    expect(preview).not.toContain('Element:SetPosition');
    expect(preview).toContain('status=planned');
    expect(preview).toContain('supportTopZ=');
    expect(preview).toContain('MiscService:IsObjectExist(MiscService.EQueryableObjectType.Element, instanceId)');
    expect(preview).toContain('status=capability-abort');
    expect(() => generateFloorAlignmentLua('900', ['901', '902'], { execute: true, context } as never))
      .toThrowError(expect.objectContaining({ code: 'SCENE_EVIDENCE_INSUFFICIENT' }));
    const token = createSceneProbeToken(context, 'alignment', ['900', '901', '902']);
    const execution = generateFloorAlignmentLua('900', ['901', '902'], {
      execute: true,
      context,
      evidence: { token, supportId: '900', moverIds: ['901', '902'], supportTopZ: 10, lowestZ: 7, deltaZ: 3 },
    });
    expectValidLua(execution);
    expect(execution).toContain('Element:SetPosition');
    expect(execution).toContain('status=rollback reason=set-position-failed');
    expect(execution).toContain('YMAI_EXPECTED_DELTA_Z = 3');
    expect(execution).toContain('math.abs(deltaZ - YMAI_EXPECTED_DELTA_Z)');
    expect(execution).toContain('status=drift-abort');
    expect(execution).toContain(`local YMAI_EVIDENCE_TOKEN = "${token}"`);
    expect(execution).not.toContain('AddLoopFrame');
    expect(execution).toContain('通用贴地方法曾由用户在一个简单地板+三元件货柜单人场景验证通过；当前 ID 组合仍未验证。');
  });
});
