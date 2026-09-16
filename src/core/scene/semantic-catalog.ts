import { ProductError } from '../errors.js';
import type { SceneRuntimeCapabilityEvidence } from './probe-evidence.js';
import type { FieldEvidence, SceneInstance } from './types.js';

export type SceneActorFamily =
  | 'character'
  | 'creature'
  | 'element'
  | 'trigger-box'
  | 'logic-element'
  | 'player'
  | 'programming-element'
  | 'camera'
  | 'scene-group-unknown'
  | 'player-composed-group'
  | 'inventory-item'
  | 'effect'
  | 'unknown';

export type SceneIdDomain =
  | 'scene-instance'
  | 'scene-group'
  | 'element-type'
  | 'official-item-type'
  | 'custom-item-type'
  | 'effect-type'
  | 'runtime-effect-instance'
  | 'resource-id';

export type SceneCapabilityState =
  | 'confirmed'
  | 'official-api-supported'
  | 'runtime-observed'
  | 'runtime-probe-required'
  | 'unknown'
  | 'not-applicable';

export interface SceneCapability {
  key: string;
  state: SceneCapabilityState;
  apiSymbols: string[];
  notes: string;
}

export interface SceneInstanceIntelligence {
  canonicalName: string | null;
  aliases: string[];
  categoryPath: string[];
  actorFamily: SceneActorFamily;
  idDomain: SceneIdDomain;
  capabilities: SceneCapability[];
  eventNames: string[];
  apiModules: string[];
  evidence: FieldEvidence;
  warnings: string[];
  nextActions: string[];
  runtimeEvidence: SceneRuntimeCapabilityEvidence | null;
  catalog: {
    schemaVersion: 1;
    sourceId: 'yuanmeng-map-dev/element-type-ids.csv';
    sourceSha256: string;
    calibratedAt: '2026-08-11';
    verifiedOfficialApiVersion: '1.4.7';
    typeMatched: boolean;
  };
}

export interface SceneGroupIntelligence {
  canonicalName: '场景编组（用途未确认）';
  actorFamily: 'scene-group-unknown';
  idDomain: 'scene-group';
  directMemberCount: number;
  nestedGroupCount: number;
  recursiveMemberCount: number | null;
  capabilities: SceneCapability[];
  warnings: string[];
}

export interface SceneTypeCoverageSummary {
  encounteredTypeCount: number;
  calibratedTypeCount: number;
  calibratedInstanceCount: number;
  unknownInstanceCount: number;
  unknownTypeIds: string[];
  catalog: typeof CATALOG_PROVENANCE & { entryCount: number };
  warnings: string[];
}

export interface SceneTypeInventoryEntry {
  typeId: string | null;
  instanceCount: number;
  representativeInstanceIds: string[];
  variants: SceneInstance['variant'][];
  canonicalName: string | null;
  actorFamily: SceneActorFamily;
  calibrationState: 'calibrated' | 'runtime-calibrated' | 'pending-runtime-probe' | 'missing-type-id';
  runtimeObservedInstanceCount: number;
  runtimeActorFamilies: Array<{ actorFamily: SceneActorFamily; count: number }>;
  capabilityKeys: string[];
  eventNames: string[];
  nextActions: string[];
}

export interface SceneTypeInventory {
  summary: {
    uniqueTypeStates: number;
    calibratedTypes: number;
    pendingTypes: number;
    instanceCount: number;
  };
  entries: SceneTypeInventoryEntry[];
  pendingCalibration: SceneTypeInventoryEntry[];
  warnings: string[];
}

interface AssetTypeRecord {
  typeId: string;
  canonicalName: string;
  aliases: string[];
  categoryPath: string[];
  actorFamily: Exclude<SceneActorFamily, 'scene-group-unknown' | 'player-composed-group' | 'inventory-item' | 'effect' | 'unknown'>;
  capabilities: SceneCapability[];
  eventNames: string[];
  apiModules: string[];
  evidence: FieldEvidence;
  warnings: string[];
}

const CONFIRMED_TYPE_EVIDENCE: FieldEvidence = {
  state: 'confirmed-calibration',
  source: 'local-versioned-editor-asset-catalog',
  confidence: 1,
};

const UNKNOWN_TYPE_EVIDENCE: FieldEvidence = {
  state: 'unknown',
  source: 'type-id-not-in-calibrated-catalog',
  confidence: 0,
};

const CATALOG_PROVENANCE = Object.freeze({
  schemaVersion: 1 as const,
  sourceId: 'yuanmeng-map-dev/element-type-ids.csv' as const,
  sourceSha256: '8a801cc08b35d2245bacc45c094931ae8f3ce197f2afa2ee7da4111d3fe4e259',
  calibratedAt: '2026-08-11' as const,
  verifiedOfficialApiVersion: '1.4.7' as const,
});

function capability(
  key: string,
  state: SceneCapabilityState,
  apiSymbols: string[],
  notes: string,
): SceneCapability {
  return { key, state, apiSymbols, notes };
}

const TRANSFORM_CAPABILITIES = [
  capability('transform.read', 'official-api-supported', [
    'Element:GetPosition', 'Element:GetRotation', 'Element:GetScale', 'Element:GetSizeBox', 'Element:GetMeshCenter',
  ], '是否对具体对象可用仍由运行时对象族分类探针确认。'),
  capability('transform.write', 'official-api-supported', [
    'Element:SetPosition', 'Element:SetRotation', 'Element:SetScale',
  ], '写入只能在用户确认的测试/执行流程中使用。'),
];

const TYPE_CATALOG: readonly AssetTypeRecord[] = [
  {
    typeId: '1101002001034000',
    canonicalName: '立方体',
    aliases: ['基础积木', '方块'],
    categoryPath: ['资产', '积木', '基础'],
    actorFamily: 'element',
    capabilities: [
      ...TRANSFORM_CAPABILITIES,
      capability('collision.query', 'runtime-probe-required', ['Element:IsOpenCollision'], '碰撞开关是实例状态，不能仅按类型 ID 推断。'),
      capability('physics.query', 'runtime-probe-required', ['Element:IsOpenPysical'], '物理开关是实例状态，不能仅按类型 ID 推断。'),
      capability('physical-touch-event', 'official-api-supported', ['Events.ON_PLAYER_TOUCH_ELEMENT', 'Events.ON_ELEMENT_TOUCH_PLAYER'], '只有运行时确认为 Element 且实际开启碰撞时才有意义。'),
      capability('custom-property.read', 'official-api-supported', ['CustomProperty:GetCustomProperty'], '必须已知属性名和类型。'),
    ],
    eventNames: [
      'Events.ON_PLAYER_TOUCH_ELEMENT',
      'Events.ON_ELEMENT_TOUCH_PLAYER',
      'Events.ON_ELEMENT_ENTER_TRIGGER',
      'Events.ON_ELEMENT_LEAVE_TRIGGER',
      'Events.ON_ELEMENT_CREATED',
      'Events.ON_ELEMENT_DESTROYED',
    ],
    apiModules: ['Element', 'CustomProperty', 'Events'],
    evidence: CONFIRMED_TYPE_EVIDENCE,
    warnings: [],
  },
  {
    typeId: '1105000000000087',
    canonicalName: '信号触发盒',
    aliases: ['触发盒', '信号盒', 'TriggerBox', 'SignalBox'],
    categoryPath: ['资产', '玩法', '逻辑'],
    actorFamily: 'trigger-box',
    capabilities: [
      ...TRANSFORM_CAPABILITIES.map((value) => ({ ...value, state: 'runtime-probe-required' as const })),
      capability('spatial-query.raycast', 'official-api-supported', ['PlayInteractive.HIT_TYPE.TriggerBox'], '触发盒射线命中与普通元件碰撞是不同能力。'),
      capability('trigger.character-enter', 'confirmed', ['Events.ON_CHARACTER_ENTER_SIGNAL_BOX', 'TriggerBox:IsCharacterInTriggerBox'], '角色进入触发盒使用专属事件/API。'),
      capability('trigger.character-leave', 'confirmed', ['Events.ON_CHARACTER_LEAVE_SIGNAL_BOX'], '角色离开触发盒使用专属事件。'),
      capability('trigger.element-enter', 'official-api-supported', ['Events.ON_ELEMENT_ENTER_TRIGGER', 'TriggerBox:IsElementInTriggerBox'], '触发效果中还需勾选对应元件类型。'),
      capability('trigger.element-leave', 'official-api-supported', ['Events.ON_ELEMENT_LEAVE_TRIGGER'], '适用于普通元件离开触发盒。'),
      capability('physical-touch-event', 'not-applicable', ['Events.ON_PLAYER_TOUCH_ELEMENT'], '区域进入不是普通物理碰撞；禁止用普通元件接触事件替代。'),
      capability('collision.query', 'not-applicable', ['Element:IsOpenCollision'], '触发盒的核心语义是区域进入/离开，不以普通元件碰撞开关判断。'),
    ],
    eventNames: [
      'Events.ON_CHARACTER_ENTER_SIGNAL_BOX',
      'Events.ON_CHARACTER_LEAVE_SIGNAL_BOX',
      'Events.ON_ELEMENT_ENTER_TRIGGER',
      'Events.ON_ELEMENT_LEAVE_TRIGGER',
      'Events.ON_LOGIC_ACTOR_ENTER_TRIGGER',
      'Events.ON_LOGIC_ACTOR_LEAVE_TRIGGER',
      'Events.ON_CREATURE_ENTER_TRIGGER',
      'Events.ON_CREATURE_LEAVE_TRIGGER',
    ],
    apiModules: ['TriggerBox', 'Element', 'MiscService', 'Events', 'PlayInteractive'],
    evidence: CONFIRMED_TYPE_EVIDENCE,
    warnings: ['TriggerBox、SignalBox 与编辑器“信号触发盒”是官方资料中的不同别名。'],
  },
  {
    typeId: '1105000000000219',
    canonicalName: '编程元件',
    aliases: ['Lua 元件', '脚本元件'],
    categoryPath: ['资产', '玩法', '逻辑'],
    actorFamily: 'programming-element',
    capabilities: [
      capability('script.lifecycle', 'confirmed', ['Events.ON_BEGIN_PLAY', 'Events.ON_END_PLAY'], '脚本生命周期事件不等于物理碰撞能力。'),
      capability('runtime-family', 'runtime-probe-required', ['MiscService:IsObjectExist'], '当前静态目录不能证明其属于 Element 还是 LogicElement。'),
    ],
    eventNames: ['Events.ON_BEGIN_PLAY', 'Events.ON_END_PLAY'],
    apiModules: ['System', 'Events', 'MiscService'],
    evidence: CONFIRMED_TYPE_EVIDENCE,
    warnings: ['不能因为它有场景实例 ID 就自动套用 Element 碰撞事件。'],
  },
  {
    typeId: '1105000000000113',
    canonicalName: '电影相机',
    aliases: ['剧情相机', '运镜相机'],
    categoryPath: ['资产', '玩法', '相机'],
    actorFamily: 'camera',
    capabilities: [
      capability('camera.playback', 'official-api-supported', ['Camera:MovieCameraStart', 'Camera:MovieCameraStop'], '相机实例 ID 与普通元件接触能力无关。'),
      capability('runtime-family', 'runtime-probe-required', ['MiscService:IsObjectExist'], '需要运行时确认其是否同时暴露 Element 能力。'),
    ],
    eventNames: [],
    apiModules: ['Camera', 'MiscService'],
    evidence: CONFIRMED_TYPE_EVIDENCE,
    warnings: ['电影相机实例 ID 不是 UI 控件 ID。'],
  },
] as const;

const TYPE_BY_ID = new Map(TYPE_CATALOG.map((record) => [record.typeId, record]));

type RuntimeQueryableFamily = 'character' | 'creature' | 'element' | 'logic-element' | 'player' | 'trigger-box';

const RUNTIME_FAMILY_PROFILE: Record<RuntimeQueryableFamily, {
  canonicalName: string;
  eventNames: string[];
  apiModules: string[];
}> = {
  character: {
    canonicalName: '角色对象（运行时确认）',
    eventNames: [
      'Events.ON_CHARACTER_CREATED', 'Events.ON_CHARACTER_DESTROYED',
      'Events.ON_CHARACTER_ENTER_SIGNAL_BOX', 'Events.ON_CHARACTER_LEAVE_SIGNAL_BOX',
    ],
    apiModules: ['Character', 'MiscService'],
  },
  creature: {
    canonicalName: '生物对象（运行时确认）',
    eventNames: [
      'Events.ON_CREATURE_CREATED', 'Events.ON_CREATURE_DESTROYED',
      'Events.ON_CREATURE_ENTER_TRIGGER', 'Events.ON_CREATURE_LEAVE_TRIGGER',
      'Events.ON_CREATURE_TOUCH_ELEMENT',
    ],
    apiModules: ['Creature', 'MiscService'],
  },
  element: {
    canonicalName: '普通元件（运行时确认）',
    eventNames: [...TYPE_BY_ID.get('1101002001034000')!.eventNames],
    apiModules: ['Element', 'MiscService'],
  },
  'logic-element': {
    canonicalName: '逻辑元件（运行时确认）',
    eventNames: [
      'Events.ON_LOGIC_ACTOR_ENTER_TRIGGER', 'Events.ON_LOGIC_ACTOR_LEAVE_TRIGGER',
      'Events.ON_LOGIC_ACTOR_CREATED', 'Events.ON_LOGIC_ACTOR_DESTROYED',
      'Events.ON_LOGIC_ACTOR_START_MOVING', 'Events.ON_LOGIC_ACTOR_END_MOVING',
    ],
    apiModules: ['LogicElement', 'MiscService'],
  },
  player: {
    canonicalName: '玩家对象（运行时确认）',
    eventNames: ['Events.ON_PLAYER_ENTER', 'Events.ON_PLAYER_PRELEAVE', 'Events.ON_PLAYER_LEAVE'],
    apiModules: ['Player', 'MiscService'],
  },
  'trigger-box': {
    canonicalName: '信号触发盒（运行时确认）',
    eventNames: [...TYPE_BY_ID.get('1105000000000087')!.eventNames],
    apiModules: ['TriggerBox', 'MiscService'],
  },
};

function runtimeFamilyCapability(
  family: RuntimeQueryableFamily,
  state: 'present' | 'absent' | 'error',
): SceneCapability {
  return capability(
    `runtime.family.${family}`,
    state === 'present' ? 'runtime-observed' : state === 'absent' ? 'not-applicable' : 'unknown',
    ['MiscService:IsObjectExist'],
    state === 'error'
      ? '当前快照探针调用失败，保持未知；不能当成对象族不存在。'
      : '来自当前实例、当前快照和当前场景源哈希绑定的运行时分类探针。',
  );
}

function mergeRuntimeEvidence(
  base: SceneInstanceIntelligence,
  runtimeEvidence: SceneRuntimeCapabilityEvidence | null,
): SceneInstanceIntelligence {
  if (runtimeEvidence === null) return base;
  const familyStates = [
    ['character', runtimeEvidence.characterState ?? 'error'],
    ['creature', runtimeEvidence.creatureState ?? 'error'],
    ['element', runtimeEvidence.elementState],
    ['logic-element', runtimeEvidence.logicElementState],
    ['player', runtimeEvidence.playerState ?? 'error'],
    ['trigger-box', runtimeEvidence.triggerBoxState],
  ] as const;
  const present = familyStates.filter(([, state]) => state === 'present').map(([family]) => family);
  const hasProbeError = familyStates.some(([, state]) => state === 'error');
  let actorFamily = base.actorFamily;
  let canonicalName = base.canonicalName;
  let eventNames = [...base.eventNames];
  const warnings = [...base.warnings];
  if (base.actorFamily === 'unknown' && present.length === 1 && !hasProbeError) {
    actorFamily = present[0]!;
    canonicalName = RUNTIME_FAMILY_PROFILE[actorFamily].canonicalName;
    eventNames = [...RUNTIME_FAMILY_PROFILE[actorFamily].eventNames];
  } else if (base.actorFamily === 'unknown' && present.length === 1 && hasProbeError) {
    warnings.push('对象族探针仍有失败；即使一个对象族返回 present，也不能排除失败的对象族，保持未知。');
  } else if (present.length > 1) {
    warnings.push(`运行时报告多个对象族同时存在：${present.join('、')}；仅按已校准静态类型选择语义。`);
  }
  const expectedFamily = base.actorFamily in RUNTIME_FAMILY_PROFILE
    ? base.actorFamily as RuntimeQueryableFamily
    : null;
  if (expectedFamily !== null) {
    const observed = familyStates.find(([family]) => family === expectedFamily)?.[1];
    if (observed === 'absent') warnings.push(`当前运行时探针与已校准类型 ${expectedFamily} 冲突，执行能力保持阻断。`);
    if (observed === 'error') warnings.push(`当前运行时无法确认已校准类型 ${expectedFamily} 的对象族能力。`);
  }
  if (runtimeEvidence.fieldConflicts.length > 0) {
    warnings.push(`以下独立字段探针存在冲突，未合并：${runtimeEvidence.fieldConflicts.join('、')}。`);
  }
  return {
    ...base,
    actorFamily,
    canonicalName,
    eventNames,
    apiModules: actorFamily in RUNTIME_FAMILY_PROFILE
      ? [...new Set([...base.apiModules, ...RUNTIME_FAMILY_PROFILE[actorFamily as RuntimeQueryableFamily].apiModules])]
      : base.apiModules,
    capabilities: [
      ...base.capabilities,
      ...familyStates.map(([family, state]) => runtimeFamilyCapability(family, state)),
      ...Object.entries(runtimeEvidence.fields).map(([field, observation]) => capability(
        `runtime.field.${field}`,
        observation?.status === 'ok' ? 'runtime-observed' : observation?.status === 'not-applicable' ? 'not-applicable' : 'unknown',
        [],
        observation?.status === 'ok'
          ? '当前实例、当前快照中该字段已由独立官方 API 调用成功读取。'
          : observation?.status === 'error'
            ? '该字段独立调用失败，不影响其他已成功字段；本字段保持未知。'
            : '当前对象族不适用该字段。',
      )),
    ],
    warnings,
    nextActions: familyStates.some(([, state]) => state === 'error')
      ? [...base.nextActions, '修复失败的对象族探针后重新导入当前快照日志。']
      : base.nextActions,
    runtimeEvidence: {
      ...runtimeEvidence,
      triggerSample: runtimeEvidence.triggerSample === null ? null : [...runtimeEvidence.triggerSample],
      fields: Object.fromEntries(Object.entries(runtimeEvidence.fields).map(([field, observation]) => [
        field,
        observation === undefined ? undefined : { ...observation, value: cloneRuntimeFieldValue(observation.value) },
      ])),
      fieldConflicts: [...runtimeEvidence.fieldConflicts],
    },
  };
}

function cloneRuntimeFieldValue(
  value: NonNullable<SceneRuntimeCapabilityEvidence['fields'][keyof SceneRuntimeCapabilityEvidence['fields']]>['value'],
) {
  return value?.kind === 'vector' ? { kind: 'vector' as const, value: [...value.value] as [number, number, number] } : value === null ? null : { ...value };
}

export function resolveSceneInstanceIntelligence(
  input: Pick<SceneInstance, 'elementTypeId' | 'variant'>,
  runtimeEvidence: SceneRuntimeCapabilityEvidence | null = null,
): SceneInstanceIntelligence {
  const record = input.elementTypeId === null ? undefined : TYPE_BY_ID.get(input.elementTypeId);
  if (record === undefined) {
    return mergeRuntimeEvidence({
      canonicalName: null,
      aliases: [],
      categoryPath: [],
      actorFamily: 'unknown',
      idDomain: 'scene-instance',
      capabilities: [capability('runtime-family', 'runtime-probe-required', ['MiscService:IsObjectExist'], '逐项检查 Character、Creature、Element、LogicElement、Player 与 TriggerBox；结果不假定互斥。')],
      eventNames: [],
      apiModules: ['MiscService'],
      evidence: UNKNOWN_TYPE_EVIDENCE,
      warnings: input.variant === 'unsupported-oneof-1'
        ? ['当前实例使用尚未校准的 oneof 分支，不能据此猜测对象族。']
        : [],
      nextActions: ['先运行无副作用的运行时分类探针，再选择事件或专用 API。'],
      runtimeEvidence: null,
      catalog: { ...CATALOG_PROVENANCE, typeMatched: false },
    }, runtimeEvidence);
  }
  return mergeRuntimeEvidence({
    canonicalName: record.canonicalName,
    aliases: [...record.aliases],
    categoryPath: [...record.categoryPath],
    actorFamily: record.actorFamily,
    idDomain: 'scene-instance',
    capabilities: record.capabilities.map((value) => ({ ...value, apiSymbols: [...value.apiSymbols] })),
    eventNames: [...record.eventNames],
    apiModules: [...record.apiModules],
    evidence: { ...record.evidence },
    warnings: [...record.warnings],
    nextActions: record.capabilities.some((value) => value.state === 'runtime-probe-required')
      ? ['对实例运行分类/能力探针，补充当前地图的运行时证据。']
      : [],
    runtimeEvidence: null,
    catalog: { ...CATALOG_PROVENANCE, typeMatched: true },
  }, runtimeEvidence);
}

export function buildSceneGroupIntelligence(input: {
  directMemberCount: number;
  nestedGroupCount: number;
  recursiveMemberCount: number | null;
}): SceneGroupIntelligence {
  return {
    canonicalName: '场景编组（用途未确认）',
    actorFamily: 'scene-group-unknown',
    idDomain: 'scene-group',
    directMemberCount: input.directMemberCount,
    nestedGroupCount: input.nestedGroupCount,
    recursiveMemberCount: input.recursiveMemberCount,
    capabilities: [
      capability('group.members-immediate', 'unknown', [], '当前本地官方声明未找到公开的运行时直接成员查询 API；仅使用 LayerData 静态成员。'),
      capability('group.members-recursive', 'unknown', [], '当前本地官方声明未找到公开的运行时递归成员查询 API；仅使用 LayerData 静态嵌套关系。'),
      capability('group.structure-static', 'confirmed', [], 'LayerData 编组表可读取直接成员和嵌套编组。'),
    ],
    warnings: ['场景编组/玩家拼装物不是背包系统的“自制物品”；两者 ID 域和 API 完全不同。'],
  };
}

export function assertSceneEventCompatible(
  intelligence: SceneInstanceIntelligence,
  eventName: string,
): void {
  if (intelligence.actorFamily === 'unknown') {
    throw new ProductError(
      'SCENE_EVIDENCE_INSUFFICIENT',
      '当前类型没有足够证据选择对象事件。',
      ['先生成并运行场景对象分类探针。'],
      'STATIC_LOCAL',
    );
  }
  if (!intelligence.eventNames.includes(eventName)) {
    throw new ProductError(
      'SCENE_CAPABILITY_MISMATCH',
      `${intelligence.canonicalName ?? intelligence.actorFamily} 不适用事件 ${eventName}。`,
      [intelligence.actorFamily === 'trigger-box'
        ? '角色进入请使用 Events.ON_CHARACTER_ENTER_SIGNAL_BOX。'
        : '根据对象族选择已列出的官方事件，或先运行分类探针。'],
      'STATIC_LOCAL',
    );
  }
}

export function listCalibratedAssetTypes(): ReadonlyArray<Pick<AssetTypeRecord, 'typeId' | 'canonicalName' | 'actorFamily' | 'categoryPath'>> {
  return TYPE_CATALOG.map((record) => ({
    typeId: record.typeId,
    canonicalName: record.canonicalName,
    actorFamily: record.actorFamily,
    categoryPath: [...record.categoryPath],
  }));
}

/**
 * 汇总当前快照真正被静态类型目录覆盖的范围。
 *
 * null 类型也作为一种“未识别类型状态”计入 encounteredTypeCount；未知 ID 只以
 * 排序后的十进制字符串列出。这个摘要用于向用户暴露目录覆盖缺口，绝不把
 * 未收录的官方资产、玩家拼装物或特效自动猜成普通 Element。
 */
export function summarizeSceneTypeCoverage(input: {
  instances: ReadonlyArray<Pick<SceneInstance, 'elementTypeId'>>;
}): SceneTypeCoverageSummary {
  const encountered = new Set<string | null>();
  const calibrated = new Set<string>();
  const unknownTypeIds = new Set<string>();
  let calibratedInstanceCount = 0;
  let unknownInstanceCount = 0;

  for (const instance of input.instances) {
    encountered.add(instance.elementTypeId);
    if (instance.elementTypeId !== null && TYPE_BY_ID.has(instance.elementTypeId)) {
      calibrated.add(instance.elementTypeId);
      calibratedInstanceCount += 1;
    } else {
      unknownInstanceCount += 1;
      if (instance.elementTypeId !== null) unknownTypeIds.add(instance.elementTypeId);
    }
  }

  return {
    encounteredTypeCount: encountered.size,
    calibratedTypeCount: calibrated.size,
    calibratedInstanceCount,
    unknownInstanceCount,
    unknownTypeIds: [...unknownTypeIds].sort((left, right) => left.localeCompare(right, 'en')),
    catalog: { ...CATALOG_PROVENANCE, entryCount: TYPE_CATALOG.length },
    warnings: unknownInstanceCount === 0 ? [] : [
      `当前有 ${unknownInstanceCount} 个实例未被静态类型目录覆盖；不能把未覆盖类型自动归类，需读取更多官方资产资料或运行对象族探针。`,
    ],
  };
}

/**
 * 把逐实例类型 ID 聚合成适合 AI 查询的小清单。类型 ID 直接来自当前场景快照；
 * 只有版本化目录覆盖的类型才给出官方名称，未知类型不会被猜成普通元件。
 */
export function buildSceneTypeInventory(input: {
  instances: ReadonlyArray<Pick<SceneInstance, 'instanceId' | 'elementTypeId' | 'variant'>>;
  runtimeActorFamiliesByInstance?: ReadonlyMap<string, SceneActorFamily>;
}): SceneTypeInventory {
  const buckets = new Map<string, Array<Pick<SceneInstance, 'instanceId' | 'elementTypeId' | 'variant'>>>();
  for (const instance of input.instances) {
    const key = instance.elementTypeId ?? '\0missing-type-id';
    buckets.set(key, [...(buckets.get(key) ?? []), instance]);
  }
  const entries = [...buckets.entries()].map(([key, instances]): SceneTypeInventoryEntry => {
    const typeId = key === '\0missing-type-id' ? null : key;
    const exemplar = resolveSceneInstanceIntelligence({
      elementTypeId: typeId,
      variant: instances[0]?.variant ?? 'unknown',
    });
    const runtimeCounts = new Map<SceneActorFamily, number>();
    for (const instance of instances) {
      const family = input.runtimeActorFamiliesByInstance?.get(instance.instanceId);
      if (family !== undefined) runtimeCounts.set(family, (runtimeCounts.get(family) ?? 0) + 1);
    }
    const calibrated = exemplar.catalog.typeMatched;
    const runtimeFamilies = [...runtimeCounts.keys()].filter((family): family is RuntimeQueryableFamily => family in RUNTIME_FAMILY_PROFILE);
    const unanimousRuntimeFamily = !calibrated && typeId !== null && runtimeFamilies.length === 1
      && runtimeCounts.size === 1
      ? runtimeFamilies[0]!
      : null;
    const learnedProfile = unanimousRuntimeFamily === null ? null : RUNTIME_FAMILY_PROFILE[unanimousRuntimeFamily];
    const calibrationState: SceneTypeInventoryEntry['calibrationState'] = typeId === null
      ? 'missing-type-id'
      : calibrated
        ? 'calibrated'
        : unanimousRuntimeFamily === null ? 'pending-runtime-probe' : 'runtime-calibrated';
    return {
      typeId,
      instanceCount: instances.length,
      representativeInstanceIds: instances.map((instance) => instance.instanceId)
        .sort((left, right) => left.localeCompare(right, 'en')).slice(0, 3),
      variants: [...new Set(instances.map((instance) => instance.variant))]
        .sort((left, right) => left.localeCompare(right, 'en')),
      canonicalName: learnedProfile?.canonicalName ?? exemplar.canonicalName,
      actorFamily: unanimousRuntimeFamily ?? exemplar.actorFamily,
      calibrationState,
      runtimeObservedInstanceCount: [...runtimeCounts.values()].reduce((sum, count) => sum + count, 0),
      runtimeActorFamilies: [...runtimeCounts.entries()]
        .map(([actorFamily, count]) => ({ actorFamily, count }))
        .sort((left, right) => left.actorFamily.localeCompare(right.actorFamily, 'en')),
      capabilityKeys: learnedProfile === null
        ? exemplar.capabilities.map((value) => value.key).sort((left, right) => left.localeCompare(right, 'en'))
        : [`runtime.family.${unanimousRuntimeFamily}`],
      eventNames: [...(learnedProfile?.eventNames ?? exemplar.eventNames)].sort((left, right) => left.localeCompare(right, 'en')),
      nextActions: calibrated ? [...exemplar.nextActions] : typeId === null
        ? ['运行当前实例的官方 API 分类探针；当前保存文件没有可确认的类型 ID。']
        : unanimousRuntimeFamily !== null
          ? ['对象族已由同类型实例的当前快照运行时证据确认；若需要官方显示名称，可再做一次人工名称校准。']
          : runtimeCounts.size > 1
            ? ['同一类型 ID 的运行时对象族证据互相冲突；重新采集代表实例，冲突消除前保持未知。']
            : ['对代表实例运行对象族/能力探针；确认官方显示名称后只需为此类型 ID 校准一次。'],
    };
  }).sort((left, right) => {
    if (left.typeId === null) return 1;
    if (right.typeId === null) return -1;
    return left.typeId.localeCompare(right.typeId, 'en');
  });
  const pendingCalibration = entries.filter((entry) => entry.calibrationState !== 'calibrated' && entry.calibrationState !== 'runtime-calibrated');
  return {
    summary: {
      uniqueTypeStates: entries.length,
      calibratedTypes: entries.length - pendingCalibration.length,
      pendingTypes: pendingCalibration.length,
      instanceCount: input.instances.length,
    },
    entries,
    pendingCalibration,
    warnings: pendingCalibration.length === 0 ? [] : [
      `有 ${pendingCalibration.length} 种类型状态尚未完成名称/对象族校准；已保留类型 ID、代表实例和 variant，不会自动猜类型。`,
    ],
  };
}
