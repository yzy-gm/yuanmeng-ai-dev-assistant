import { ProductError } from '../errors.js';
import { sha256Hex } from '../hash.js';
import {
  createSceneProbeToken,
  type AlignmentPlanEvidence,
  type SceneProbeContext,
} from './probe-evidence.js';

const MAX_PROBE_IDS = 100;
const MAX_GROUP_STATIC_IDS = 2_000;
const MAX_PROPERTY_LOOKUP_IDS = 2_000;
const MAX_ABSOLUTE_DELTA = 1_000_000_000;

export const CUSTOM_PROPERTY_TYPES = [
  'Bool', 'Number', 'String', 'Color', 'Vector', 'Element', 'Particle', 'ChainParticle', 'Audio', 'Image',
  'CharacterPart', 'Animation', 'RechargeAbility', 'Prop', 'CustomUI',
] as const;
export type CustomPropertyType = (typeof CUSTOM_PROPERTY_TYPES)[number];

export type FloorAlignmentOptions =
  | { execute: false; context: SceneProbeContext }
  | { execute: true; context: SceneProbeContext; evidence: AlignmentPlanEvidence; tolerance?: number };

function luaString(value: string): string {
  return `"${value.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"').replace(/\r/gu, '\\r').replace(/\n/gu, '\\n')}"`;
}

function validateIds(instanceIds: readonly string[], maximum: number, label: string): string[] {
  const unique = [...new Set(instanceIds)];
  if (unique.length === 0) {
    throw new ProductError('VALIDATION_FAILED', `${label}至少需要一个实例 ID。`, ['在场景视图选择元件后再生成。'], 'STATIC_LOCAL');
  }
  if (unique.length > maximum) {
    throw new ProductError('SCENE_LIMIT_EXCEEDED', `${label}最多处理 ${maximum} 个实例。`, ['拆分为多次处理。'], 'STATIC_LOCAL');
  }
  if (unique.some((id) => !/^\d{1,20}$/u.test(id))) {
    throw new ProductError('VALIDATION_FAILED', '实例 ID 必须是十进制数字字符串。', ['检查场景查询结果。'], 'STATIC_LOCAL');
  }
  return unique.sort((left, right) => left.localeCompare(right, 'en'));
}

function commonFields(context: SceneProbeContext, token: string): string {
  return `token=${token} snapshot=${context.snapshotId} source=${context.sceneSourceSha256}`;
}

export function generateSceneMeasurementProbe(
  instanceIds: readonly string[],
  context: SceneProbeContext,
): string {
  const unique = validateIds(instanceIds, MAX_PROBE_IDS, '场景测量探针');
  const ids = unique.map((id) => `    ${id}`).join(',\n');
  const selection = unique.join(',');
  const common = commonFields(context, createSceneProbeToken(context, 'measurement', unique));
  return `--[[
元梦 AI 开发助手：只读场景测量探针
用途：仅查询下面由用户明确选择的实例，不枚举全场景，不修改元件。
证据：日志只证明官方 API 在本次试玩中的返回值，不等于多人或发布验收。
完成测量后请从正式地图代码中移除本段测试探针。
]]

local YMAI_SCENE_PROBE_IDS = {
${ids}
}
local YMAI_SCENE_PROBE_COMMON = ${luaString(common)}
local YMAI_SCENE_PROBE_SELECTION = ${luaString(selection)}

local function YMAI_VectorText(value)
    if value == nil then return "invalid" end
    return tostring(value.X) .. "," .. tostring(value.Y) .. "," .. tostring(value.Z)
end

local function YMAI_ObjectState(objectType, instanceId)
    local ok, exists = pcall(function()
        return MiscService:IsObjectExist(objectType, instanceId)
    end)
    if not ok then return "error" end
    if type(exists) ~= "boolean" then return "error" end
    if exists == true then return "present" end
    return "absent"
end

local function YMAI_FieldText(fieldName, value)
    if fieldName == "position" or fieldName == "rotation" or fieldName == "scale"
        or fieldName == "sizeBox" or fieldName == "meshCenter" then
        return YMAI_VectorText(value)
    end
    if fieldName == "parent" then
        return value == nil and "none" or tostring(value)
    end
    return tostring(value)
end

local function YMAI_ProbeField(instanceId, fieldName, applicable, reader)
    if not applicable then
        Log:PrintLog(
            "[YMAI_SCENE_FIELD] " .. YMAI_SCENE_PROBE_COMMON
            .. " selection=" .. YMAI_SCENE_PROBE_SELECTION
            .. " id=" .. tostring(instanceId)
            .. " field=" .. fieldName .. " status=not-applicable value=invalid"
        )
        return false, nil
    end
    local ok, value = pcall(reader)
    if not ok then
        Log:PrintWarning(
            "[YMAI_SCENE_FIELD] " .. YMAI_SCENE_PROBE_COMMON
            .. " selection=" .. YMAI_SCENE_PROBE_SELECTION
            .. " id=" .. tostring(instanceId)
            .. " field=" .. fieldName .. " status=error value=invalid"
        )
        return false, nil
    end
    Log:PrintLog(
        "[YMAI_SCENE_FIELD] " .. YMAI_SCENE_PROBE_COMMON
        .. " selection=" .. YMAI_SCENE_PROBE_SELECTION
        .. " id=" .. tostring(instanceId)
        .. " field=" .. fieldName .. " status=ok value=" .. YMAI_FieldText(fieldName, value)
    )
    return true, value
end

local function YMAI_ProbeOne(instanceId)
    local characterState = YMAI_ObjectState(MiscService.EQueryableObjectType.Character, instanceId)
    local creatureState = YMAI_ObjectState(MiscService.EQueryableObjectType.Creature, instanceId)
    local elementState = YMAI_ObjectState(MiscService.EQueryableObjectType.Element, instanceId)
    local logicElementState = YMAI_ObjectState(MiscService.EQueryableObjectType.LogicElement, instanceId)
    local playerState = YMAI_ObjectState(MiscService.EQueryableObjectType.Player, instanceId)
    local triggerBoxState = YMAI_ObjectState(MiscService.EQueryableObjectType.TriggerBox, instanceId)
    local isElement = elementState == "present"
    local isTriggerBox = triggerBoxState == "present"
    local triggerSample = nil
    local triggerSampleState = "not-applicable"
    if isTriggerBox then
        local sampleOk, sample = pcall(function()
            return TriggerBox:GetRandomPosition(instanceId)
        end)
        if sampleOk then
            triggerSample = sample
            triggerSampleState = "ok"
        else
            triggerSampleState = "error"
        end
    end
    Log:PrintLog(
        "[YMAI_SCENE_CAPABILITY] " .. YMAI_SCENE_PROBE_COMMON
        .. " selection=" .. YMAI_SCENE_PROBE_SELECTION
        .. " id=" .. tostring(instanceId)
        .. " status=ok"
        .. " characterState=" .. characterState
        .. " creatureState=" .. creatureState
        .. " elementState=" .. elementState
        .. " logicElementState=" .. logicElementState
        .. " playerState=" .. playerState
        .. " triggerBoxState=" .. triggerBoxState
        .. " triggerSampleState=" .. triggerSampleState
        .. " triggerSample=" .. YMAI_VectorText(triggerSample)
    )
    local typeOk, elementType = YMAI_ProbeField(instanceId, "type", isElement, function() return Element:GetType(instanceId) end)
    local positionOk, position = YMAI_ProbeField(instanceId, "position", isElement, function() return Element:GetPosition(instanceId) end)
    local rotationOk, rotation = YMAI_ProbeField(instanceId, "rotation", isElement, function() return Element:GetRotation(instanceId) end)
    local scaleOk, scale = YMAI_ProbeField(instanceId, "scale", isElement, function() return Element:GetScale(instanceId) end)
    local sizeOk, sizeBox = YMAI_ProbeField(instanceId, "sizeBox", isElement, function() return Element:GetSizeBox(instanceId) end)
    local centerOk, meshCenter = YMAI_ProbeField(instanceId, "meshCenter", isElement, function() return Element:GetMeshCenter(instanceId) end)
    local visibleOk, isVisible = YMAI_ProbeField(instanceId, "visible", isElement, function() return Element:IsVisible(instanceId) end)
    local physicsOk, physicsOpen = YMAI_ProbeField(instanceId, "physics", isElement, function() return Element:IsOpenPysical(instanceId) end)
    -- 信号触发盒的区域进入语义不是普通碰撞；即使它同时暴露 Element，也不查询碰撞开关。
    local collisionOk, collisionOpen = YMAI_ProbeField(instanceId, "collision", isElement and not isTriggerBox, function() return Element:IsOpenCollision(instanceId) end)
    local grabbedOk, canBeGrabbed = YMAI_ProbeField(instanceId, "canBeGrabbed", isElement, function() return Element:IsCanBeGrabbed(instanceId) end)
    local parentOk, parentId = YMAI_ProbeField(instanceId, "parent", isElement, function() return Element:GetAttachParentElement(instanceId) end)
    local childOk, childCount = YMAI_ProbeField(instanceId, "childCount", isElement, function()
        local children = Element:GetChildElementsFromElement(instanceId)
        if type(children) ~= "table" then error("children-not-table") end
        return #children
    end)
    if typeOk and positionOk and rotationOk and scaleOk and sizeOk and centerOk and visibleOk
        and physicsOk and collisionOk and grabbedOk and parentOk and childOk then
        Log:PrintLog(
            "[YMAI_SCENE_PROBE] " .. YMAI_SCENE_PROBE_COMMON
            .. " selection=" .. YMAI_SCENE_PROBE_SELECTION
            .. " id=" .. tostring(instanceId)
            .. " status=ok"
            .. " type=" .. tostring(elementType)
            .. " position=" .. YMAI_VectorText(position)
            .. " rotation=" .. YMAI_VectorText(rotation)
            .. " scale=" .. YMAI_VectorText(scale)
            .. " sizeBox=" .. YMAI_VectorText(sizeBox)
            .. " meshCenter=" .. YMAI_VectorText(meshCenter)
            .. " visible=" .. tostring(isVisible)
            .. " physics=" .. tostring(physicsOpen)
            .. " collision=" .. tostring(collisionOpen)
            .. " canBeGrabbed=" .. tostring(canBeGrabbed)
            .. " parent=" .. (parentId == nil and "none" or tostring(parentId))
            .. " childCount=" .. tostring(childCount)
        )
    end
end

for _, instanceId in ipairs(YMAI_SCENE_PROBE_IDS) do
    YMAI_ProbeOne(instanceId)
end
`;
}

/**
 * 生成只读编组结构探针。静态成员来自当前快照；运行时只调用官方查询 API 交叉核对，
 * 不移动成员、不修改编组，也不会枚举全场景。
 */
export function generateSceneGroupStructureProbe(
  groupId: string,
  directMemberIds: readonly string[],
  nestedGroupIds: readonly string[],
  context: SceneProbeContext,
): string {
  if (!/^\d{1,20}$/u.test(groupId)) {
    throw new ProductError('VALIDATION_FAILED', '编组 ID 必须是十进制数字字符串。', ['从场景树选择一个编组。'], 'STATIC_LOCAL');
  }
  const direct = directMemberIds.length === 0 ? [] : validateIds(directMemberIds, MAX_GROUP_STATIC_IDS, '编组直接成员');
  const nested = nestedGroupIds.length === 0 ? [] : validateIds(nestedGroupIds, MAX_GROUP_STATIC_IDS, '嵌套编组');
  const selected = validateIds([groupId, ...direct, ...nested], MAX_GROUP_STATIC_IDS, '编组探针选择集');
  const common = commonFields(context, createSceneProbeToken(context, 'measurement', selected));
  const staticDirect = direct.length === 0 ? 'none' : direct.join(',');
  const staticNested = nested.length === 0 ? 'none' : nested.join(',');
  const selection = selected.join(',');
  return `--[[
元梦 AI 开发助手：玩家组合编组结构探针（只读）
说明：场景编组/玩家拼装物不是背包系统的“自制物品”。
只核对用户选中的编组，不修改场景，不枚举其他编组。
]]
local YMAI_GROUP_ID = ${groupId}
local YMAI_GROUP_COMMON = ${luaString(common)}
local YMAI_GROUP_STATIC_DIRECT = ${luaString(staticDirect)}
local YMAI_GROUP_STATIC_NESTED = ${luaString(staticNested)}
local YMAI_GROUP_SELECTION = ${luaString(selection)}
-- 当前本地官方声明没有“获取场景编组成员”的公开 API。
-- 只输出当前快照给出的静态成员，明确标记 runtime API 未确认；不生成伪调用。
local function YMAI_OnBeginPlay()
    if System:IsServer() then
        Log:PrintWarning(
            "[YMAI_SCENE_GROUP] " .. YMAI_GROUP_COMMON
            .. " selection=" .. YMAI_GROUP_SELECTION
            .. " group=" .. tostring(YMAI_GROUP_ID)
            .. " status=unsupported-api"
            .. " staticDirect=" .. YMAI_GROUP_STATIC_DIRECT
            .. " staticNested=" .. YMAI_GROUP_STATIC_NESTED
        )
    end
end

System:RegisterEvent(Events.ON_BEGIN_PLAY, YMAI_OnBeginPlay)
`;
}

export function generateCustomPropertyLookupProbe(
  instanceIds: readonly string[],
  propertyName: string,
  propertyType: CustomPropertyType,
  context: SceneProbeContext,
): string {
  const unique = validateIds(instanceIds, MAX_PROPERTY_LOOKUP_IDS, '属性定位');
  if (propertyName.trim() === '' || !CUSTOM_PROPERTY_TYPES.includes(propertyType)) {
    throw new ProductError('VALIDATION_FAILED', '属性定位参数无效。', ['检查属性名与属性类型。'], 'STATIC_LOCAL');
  }
  const ids = unique.map((id) => `    ${id}`).join(',\n');
  const selection = unique.join(',');
  const common = commonFields(context, createSceneProbeToken(context, 'property', unique));
  const propertyHash = sha256Hex(propertyName);
  return `-- 元梦 AI 开发助手：按已知自定义属性名定位场景实例（只读测试探针）
-- 本脚本只检查场景快照中的候选 ID，不枚举或修改官方数据库。
local YMAI_PROPERTY_IDS = {
${ids}
}
local YMAI_PROPERTY_NAME = ${luaString(propertyName)}
local YMAI_PROPERTY_COMMON = ${luaString(common)}
local YMAI_PROPERTY_SELECTION = ${luaString(selection)}

for _, instanceId in ipairs(YMAI_PROPERTY_IDS) do
    local ok, value = pcall(function()
        return CustomProperty:GetCustomProperty(
            instanceId,
            YMAI_PROPERTY_NAME,
            CustomProperty.PROPERTY_TYPE.${propertyType}
        )
    end)
    if ok and value ~= nil then
        Log:PrintLog(
            "[YMAI_PROPERTY_MATCH] " .. YMAI_PROPERTY_COMMON
            .. " selection=" .. YMAI_PROPERTY_SELECTION
            .. " id=" .. tostring(instanceId)
            .. " status=match"
            .. " propertyHash=${propertyHash}"
            .. " propertyType=${propertyType}"
        )
    end
end
`;
}

function validateAlignmentEvidence(
  supportId: string,
  movers: readonly string[],
  context: SceneProbeContext,
  options: FloorAlignmentOptions,
): { token: string; expectedDeltaZ: number | null; tolerance: number } {
  const token = createSceneProbeToken(context, 'alignment', [supportId, ...movers]);
  if (!options.execute) return { token, expectedDeltaZ: null, tolerance: 0.1 };
  const evidence = options.evidence;
  const tolerance = options.tolerance ?? 0.1;
  if (
    evidence === undefined
    || evidence.token !== token
    || evidence.supportId !== supportId
    || evidence.moverIds.length !== movers.length
    || evidence.moverIds.some((id, index) => id !== movers[index])
    || !Number.isFinite(evidence.deltaZ)
    || Math.abs(evidence.deltaZ) > MAX_ABSOLUTE_DELTA
    || !Number.isFinite(tolerance)
    || tolerance <= 0
    || tolerance > 100
  ) {
    throw new ProductError(
      'SCENE_EVIDENCE_INSUFFICIENT',
      '执行贴地代码缺少当前精确快照的有效计划证据。',
      ['先生成预览、在官方编辑器试玩并导入对应日志。'],
      'STATIC_LOCAL',
    );
  }
  return { token, expectedDeltaZ: evidence.deltaZ, tolerance };
}

export function generateFloorAlignmentLua(
  supportId: string,
  moverIds: readonly string[],
  options: FloorAlignmentOptions,
): string {
  if (!/^\d{1,20}$/u.test(supportId)) {
    throw new ProductError('VALIDATION_FAILED', '承载面 ID 必须是十进制实例 ID。', ['检查场景树选择。'], 'STATIC_LOCAL');
  }
  const movers = validateIds(moverIds, MAX_PROBE_IDS, '贴地计划');
  if (movers.includes(supportId)) {
    throw new ProductError('VALIDATION_FAILED', '承载面不能同时出现在移动集合中。', ['重新选择贴地目标。'], 'STATIC_LOCAL');
  }
  const gate = validateAlignmentEvidence(supportId, movers, options.context, options);
  const moverTable = movers.map((id) => `    ${id}`).join(',\n');
  const moverText = movers.join(',');
  const common = commonFields(options.context, gate.token);
  const executionConstants = options.execute
    ? `local YMAI_EVIDENCE_TOKEN = ${luaString(gate.token)}
local YMAI_EXPECTED_DELTA_Z = ${String(gate.expectedDeltaZ)}
local YMAI_DRIFT_TOLERANCE = ${String(gate.tolerance)}`
    : '';
  const executionBlock = options.execute
    ? `    if math.abs(deltaZ - YMAI_EXPECTED_DELTA_Z) > YMAI_DRIFT_TOLERANCE then
        YMAI_AlignLog("status=drift-abort currentDeltaZ=" .. tostring(deltaZ) .. " expectedDeltaZ=" .. tostring(YMAI_EXPECTED_DELTA_Z))
        return
    end
    if math.abs(deltaZ) <= YMAI_EPSILON then
        YMAI_AlignLog("status=within-tolerance currentDeltaZ=" .. tostring(deltaZ) .. " expectedDeltaZ=" .. tostring(YMAI_EXPECTED_DELTA_Z))
        return
    end
    local moved = {}
    for _, memberId in ipairs(YMAI_MOVER_IDS) do
        local oldPos = positions[memberId]
        local newPos = Engine.Vector(oldPos.X, oldPos.Y, oldPos.Z + deltaZ)
        local setOk = pcall(function()
            Element:SetPosition(memberId, newPos, Element.COORDINATE.World)
        end)
        if not setOk then
            for index = #moved, 1, -1 do
                local rollbackId = moved[index]
                pcall(function()
                    Element:SetPosition(rollbackId, positions[rollbackId], Element.COORDINATE.World)
                end)
            end
            YMAI_AlignLog("status=rollback reason=set-position-failed id=" .. tostring(memberId))
            return
        end
        moved[#moved + 1] = memberId
    end
    YMAI_AlignLog("status=executed currentDeltaZ=" .. tostring(deltaZ) .. " expectedDeltaZ=" .. tostring(YMAI_EXPECTED_DELTA_Z))`
    : `    YMAI_AlignLog(
        "status=planned"
        .. " supportTopZ=" .. tostring(supportTopZ)
        .. " lowestZ=" .. tostring(lowestZ)
        .. " deltaZ=" .. tostring(deltaZ)
    )`;
  return `--[[
元梦 AI 开发助手：编组/多元件贴地${options.execute ? '证据门禁执行' : '测量预览'}脚本
通用贴地方法曾由用户在一个简单地板+三元件货柜单人场景验证通过；当前 ID 组合仍未验证。
只做一次统一 Z 平移；不改 X/Y、旋转、缩放和成员相对结构。
]]
local YMAI_SUPPORT_ID = ${supportId}
local YMAI_MOVER_IDS = {
${moverTable}
}
local YMAI_ALIGN_COMMON = ${luaString(common)}
local YMAI_ALIGN_MOVERS = ${luaString(moverText)}
${executionConstants}
local YMAI_RAY_MARGIN = 5
local YMAI_RAY_LENGTH = 2000
local YMAI_EPSILON = 0.1

local function YMAI_AlignLog(fields)
    Log:PrintLog(
        "[YMAI_AUTO_ALIGN] " .. YMAI_ALIGN_COMMON
        .. " support=" .. tostring(YMAI_SUPPORT_ID)
        .. " movers=" .. YMAI_ALIGN_MOVERS
        .. " " .. fields
    )
end

local function YMAI_IsMover(elementId)
    for _, memberId in ipairs(YMAI_MOVER_IDS) do
        if memberId == elementId then return true end
    end
    return false
end

local function YMAI_IsElement(instanceId)
    local ok, exists = pcall(function()
        return MiscService:IsObjectExist(MiscService.EQueryableObjectType.Element, instanceId)
    end)
    return ok and exists == true
end

local function YMAI_MeasureAlignment()
    if not YMAI_IsElement(YMAI_SUPPORT_ID) then
        YMAI_AlignLog("status=capability-abort reason=support-not-element id=" .. tostring(YMAI_SUPPORT_ID))
        return nil
    end
    for _, memberId in ipairs(YMAI_MOVER_IDS) do
        if not YMAI_IsElement(memberId) then
            YMAI_AlignLog("status=capability-abort reason=mover-not-element id=" .. tostring(memberId))
            return nil
        end
    end
    local supportPos = Element:GetPosition(YMAI_SUPPORT_ID)
    if supportPos == nil then YMAI_AlignLog("status=error reason=support-position") return nil end
    local supportHitId, supportHit = PlayInteractive:GetHitResultWithRaycast(
        PlayInteractive.HIT_TYPE.Element,
        Engine.Vector(supportPos.X, supportPos.Y, supportPos.Z + YMAI_RAY_LENGTH),
        Engine.Vector(supportPos.X, supportPos.Y, supportPos.Z - YMAI_RAY_LENGTH),
        false,
        0
    )
    if supportHitId ~= YMAI_SUPPORT_ID or supportHit == nil or supportHit.hitPos == nil then
        YMAI_AlignLog("status=error reason=support-raycast")
        return nil
    end
    local supportTopZ = supportHit.hitPos.Z
    local positions = {}
    local lowestZ = nil
    for _, memberId in ipairs(YMAI_MOVER_IDS) do
        local memberPos = Element:GetPosition(memberId)
        if memberPos == nil then YMAI_AlignLog("status=error reason=mover-position") return nil end
        positions[memberId] = memberPos
        local hitId, hit = PlayInteractive:GetHitResultWithRaycast(
            PlayInteractive.HIT_TYPE.Element,
            Engine.Vector(memberPos.X, memberPos.Y, supportTopZ + YMAI_RAY_MARGIN),
            Engine.Vector(memberPos.X, memberPos.Y, supportTopZ + YMAI_RAY_LENGTH),
            false,
            0
        )
        if YMAI_IsMover(hitId) and hit ~= nil and hit.hitPos ~= nil then
            if lowestZ == nil or hit.hitPos.Z < lowestZ then lowestZ = hit.hitPos.Z end
        else
            YMAI_AlignLog("status=error reason=mover-raycast")
            return nil
        end
    end
    if lowestZ == nil then YMAI_AlignLog("status=error reason=no-lowest-surface") return nil end
    return positions, supportTopZ, lowestZ, supportTopZ - lowestZ
end

local function YMAI_RunAlignmentOnce()
    local positions, supportTopZ, lowestZ, deltaZ = YMAI_MeasureAlignment()
    if positions == nil then return end
${executionBlock}
end

local function YMAI_OnBeginPlay()
    if System:IsServer() then
        TimerManager:AddFrame(5, YMAI_RunAlignmentOnce)
    end
end

System:RegisterEvent(Events.ON_BEGIN_PLAY, YMAI_OnBeginPlay)
`;
}
