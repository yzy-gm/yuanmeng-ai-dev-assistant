import type { SceneSourceRole } from './container.js';

export type FieldEvidenceState = 'confirmed-calibration' | 'observed-repeatable' | 'inferred-candidate' | 'unknown';

export interface FieldEvidence {
  state: FieldEvidenceState;
  source: string;
  confidence: number;
}

export interface Vector3 {
  x: number;
  y: number;
  z: number;
}

export interface Transform {
  position: Vector3;
  rotation: Vector3;
  scale: Vector3;
}

export interface AxisAlignedBounds {
  min: Vector3;
  max: Vector3;
  evidence: FieldEvidence;
}

export type FeatureState<T> =
  | { state: 'observed'; value: T; evidence: FieldEvidence }
  | { state: 'candidate'; wirePaths: string[]; evidence: FieldEvidence }
  | { state: 'unsupported'; reason: string }
  | { state: 'absent' };

export interface UnknownFieldSummary {
  path: string;
  wireType: number;
  length: number;
  sha256: string;
}

export interface SceneInstance {
  instanceId: string;
  elementTypeId: string | null;
  ownerId: string | null;
  variant: 'standard' | 'unsupported-oneof-1' | 'component6-oneof-11' | 'component6-oneof-1' | 'unknown';
  evidence: FieldEvidence;
  transform: FeatureState<Transform>;
  customProperties: FeatureState<Array<{ key: string; value: unknown }>>;
  signals: FeatureState<Array<{ name: string }>>;
  resources: FeatureState<Array<{ resourceId: string }>>;
  bounds: FeatureState<AxisAlignedBounds>;
  unknownFields: UnknownFieldSummary[];
}

export interface SceneGroupMetadataCandidate {
  opaqueRef: string | null;
  rawKind: string | null;
  labelCandidate: string | null;
  /** 元数据记录中尚未校准的字段摘要；不保留原始 payload。 */
  unknownFields?: UnknownFieldSummary[];
}

export interface SceneGroup {
  groupId: string;
  memberIds: string[];
  nestedGroupIds: string[];
  evidence: FieldEvidence;
  /** field 2 保存的直接父编组；旧快照可能没有该派生字段。 */
  parentGroupId?: string | null;
  /** 编组自身的场景变换；旧快照可能没有该派生字段。 */
  transform?: FeatureState<Transform>;
  /** 仅保存未定名的来源引用/标签候选，不能提升为“自制物品类型”。 */
  metadata?: FeatureState<SceneGroupMetadataCandidate>;
  /** 未校准字段只保存稳定路径、wire 类型、长度和哈希，不解码原文。 */
  unknownFields?: UnknownFieldSummary[];
}

export interface SceneInstanceIndexSummary {
  entryCount: number;
  duplicateIds: string[];
  missingInstanceIds: string[];
  extraInstanceIds: string[];
  rawStatusValues: string[];
  unknownFields?: UnknownFieldSummary[];
}

export interface SceneMetadata {
  layerName: FeatureState<string>;
  /** 当前只确认这是根级版本文本，尚不能宣称它等于插件或 API 版本。 */
  editorVersionCandidate: FeatureState<string>;
  instanceIndex: FeatureState<SceneInstanceIndexSummary>;
}

export interface SceneIssue {
  code: 'UNSUPPORTED_INSTANCE_VARIANT' | 'DUPLICATE_INSTANCE' | 'DUPLICATE_GROUP' | 'ORPHAN_OWNER' | 'RELATION_CYCLE' | 'MISSING_GROUP_MEMBER' | 'GROUP_RELATION_CONFLICT'
    | 'INSTANCE_INDEX_DUPLICATE' | 'INSTANCE_INDEX_MISSING' | 'INSTANCE_INDEX_EXTRA';
  message: string;
  instanceId: string | null;
}

export interface SceneSnapshot {
  schemaVersion: 1;
  snapshotId: string;
  bindingId: string;
  role: SceneSourceRole;
  sourceSha256: string;
  observedAt: string;
  adapterId: string;
  instances: SceneInstance[];
  groups: SceneGroup[];
  issues: SceneIssue[];
  unknownFields: UnknownFieldSummary[];
  /** 根级信号注册表；引用方向尚未校准，只公开名称与不透明引用数量。 */
  signalRegistry?: FeatureState<Array<{
    name: string;
    unknownRefCount: number;
    /** 同名记录不静默合并；仅在重复时标记歧义。 */
    ambiguous?: boolean;
    /** 信号记录内部未知字段摘要。 */
    unknownFields?: UnknownFieldSummary[];
  }>>;
  /** 仅包含已校准或明确标为候选的非隐私场景元数据。 */
  sceneMetadata?: SceneMetadata;
}

export interface NormalizeSceneOptions {
  bindingId: string;
  role: SceneSourceRole;
  sourceSha256: string;
  observedAt: string;
  limits?: {
    maxInstances: number;
    maxGroups: number;
  };
}
