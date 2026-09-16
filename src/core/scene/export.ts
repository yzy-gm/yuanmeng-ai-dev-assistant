import { ProductError } from '../errors.js';
import { sha256Hex, stableJson } from '../hash.js';
import type { SceneInstance, SceneSnapshot } from './types.js';

export type SceneExportFormat = 'json' | 'csv' | 'md';

export interface SceneAiContext {
  fingerprints: { projectSha256: string; resultSetSha256: string };
  binding: { bindingId: string; role: SceneSnapshot['role']; adapterId: string };
  snapshot: { snapshotId: string; sourceSha256: string; observedAt: string };
  query: { kind: string; valueSha256: string; resultCount: number };
  evidence: { states: string[]; minimumConfidence: number | null };
  ambiguity: { ambiguous: boolean; candidateCount: number };
  nextActions: string[];
}

export interface BuildSceneAiContextInput {
  projectFingerprint: string;
  snapshot: SceneSnapshot;
  query: { kind: string; value: string };
  matches: readonly SceneInstance[];
  nextActions: readonly string[];
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export function buildSceneAiContext(input: BuildSceneAiContextInput): SceneAiContext {
  if (!SHA256_PATTERN.test(input.projectFingerprint)) {
    throw new ProductError('VALIDATION_FAILED', 'AI 场景上下文只能接收 SHA-256 项目指纹。', ['传入脱敏后的工程指纹。'], 'STATIC_LOCAL');
  }
  const evidence = input.matches.flatMap((instance) => {
    const values = [instance.evidence];
    if (instance.transform.state === 'observed' || instance.transform.state === 'candidate') values.push(instance.transform.evidence);
    return values;
  });
  const resultSetSha256 = sha256Hex(stableJson(input.matches.map((instance) => ({
    idSha256: sha256Hex(instance.instanceId),
    typeSha256: instance.elementTypeId === null ? null : sha256Hex(instance.elementTypeId),
    ownerSha256: instance.ownerId === null ? null : sha256Hex(instance.ownerId),
    variant: instance.variant,
    evidence: instance.evidence,
  }))));
  return {
    fingerprints: { projectSha256: input.projectFingerprint, resultSetSha256 },
    binding: { bindingId: input.snapshot.bindingId, role: input.snapshot.role, adapterId: input.snapshot.adapterId },
    snapshot: { snapshotId: input.snapshot.snapshotId, sourceSha256: input.snapshot.sourceSha256, observedAt: input.snapshot.observedAt },
    query: { kind: input.query.kind, valueSha256: sha256Hex(input.query.value), resultCount: input.matches.length },
    evidence: {
      states: [...new Set(evidence.map((item) => item.state))].sort((left, right) => left.localeCompare(right, 'en')),
      minimumConfidence: evidence.length === 0 ? null : Math.min(...evidence.map((item) => item.confidence)),
    },
    ambiguity: { ambiguous: input.matches.length > 1, candidateCount: input.matches.length },
    nextActions: [...input.nextActions],
  };
}

export function renderSceneAiContext(context: SceneAiContext, format: 'json' | 'md'): string {
  if (format === 'json') return stableJson(context);
  return [
    '# 元梦场景 AI 脱敏上下文',
    '',
    `- 工程指纹：${context.fingerprints.projectSha256}`,
    `- 结果指纹：${context.fingerprints.resultSetSha256}`,
    `- Binding：${context.binding.bindingId} / ${context.binding.role} / ${context.binding.adapterId}`,
    `- Snapshot：${context.snapshot.snapshotId}`,
    `- Source：${context.snapshot.sourceSha256}`,
    `- Query：${context.query.kind} / ${context.query.valueSha256}`,
    `- 结果数量：${context.query.resultCount}`,
    `- 歧义：${context.ambiguity.ambiguous ? '是' : '否'}（${context.ambiguity.candidateCount}）`,
    `- 证据：${context.evidence.states.join(', ') || 'none'} / minConfidence=${context.evidence.minimumConfidence ?? 'n/a'}`,
    '',
    '## 下一步',
    '',
    ...context.nextActions.map((action) => `- ${action}`),
    '',
  ].join('\n');
}

function csv(value: string): string {
  return /[",\r\n]/u.test(value) ? `"${value.replace(/"/gu, '""')}"` : value;
}

function markdownCell(value: string): string {
  return value.replace(/\|/gu, '\\|').replace(/[\r\n]+/gu, ' ');
}

export function renderSceneExport(snapshot: SceneSnapshot, format: SceneExportFormat): string {
  if (format === 'json') return stableJson(snapshot);
  if (format === 'csv') {
    const headers = [
      'recordKind', 'recordId', 'elementTypeId', 'ownerId', 'variant',
      'positionX', 'positionY', 'positionZ', 'transformJson', 'customPropertiesJson',
      'signalsJson', 'resourcesJson', 'boundsJson', 'memberIdsJson', 'nestedGroupIdsJson',
      'parentGroupId', 'metadataJson', 'signalRegistryJson', 'sceneMetadataJson',
      'unknownFieldsJson', 'evidence',
    ] as const;
    const row = (values: Readonly<Record<(typeof headers)[number], string>>): string => (
      headers.map((header) => csv(values[header])).join(',')
    );
    const blank = (): Record<(typeof headers)[number], string> => Object.fromEntries(
      headers.map((header) => [header, '']),
    ) as Record<(typeof headers)[number], string>;
    const rows: string[] = [];
    rows.push(row({
      ...blank(),
      recordKind: 'scene-root', recordId: snapshot.snapshotId,
      signalRegistryJson: stableJson(snapshot.signalRegistry ?? null),
      sceneMetadataJson: stableJson(snapshot.sceneMetadata ?? null),
      unknownFieldsJson: stableJson(snapshot.unknownFields), evidence: 'snapshot',
    }));
    for (const group of snapshot.groups) {
      const values = blank();
      values.recordKind = 'scene-group';
      values.recordId = group.groupId;
      values.transformJson = stableJson(group.transform ?? null);
      values.memberIdsJson = stableJson(group.memberIds);
      values.nestedGroupIdsJson = stableJson(group.nestedGroupIds);
      values.parentGroupId = group.parentGroupId ?? '';
      values.metadataJson = stableJson(group.metadata ?? null);
      values.unknownFieldsJson = stableJson(group.unknownFields ?? []);
      values.evidence = group.evidence.state;
      rows.push(row(values));
    }
    for (const instance of snapshot.instances) {
      const transform = instance.transform.state === 'observed' ? instance.transform.value : null;
      const values = blank();
      values.recordKind = 'scene-instance';
      values.recordId = instance.instanceId;
      values.elementTypeId = instance.elementTypeId ?? '';
      values.ownerId = instance.ownerId ?? '';
      values.variant = instance.variant;
      values.positionX = transform?.position.x.toString() ?? '';
      values.positionY = transform?.position.y.toString() ?? '';
      values.positionZ = transform?.position.z.toString() ?? '';
      values.transformJson = stableJson(instance.transform);
      values.customPropertiesJson = stableJson(instance.customProperties);
      values.signalsJson = stableJson(instance.signals);
      values.resourcesJson = stableJson(instance.resources);
      values.boundsJson = stableJson(instance.bounds);
      values.unknownFieldsJson = stableJson(instance.unknownFields);
      values.evidence = instance.evidence.state;
      rows.push(row(values));
    }
    return `${headers.join(',')}\n${rows.join('\n')}\n`;
  }
  const rootSignals = snapshot.signalRegistry?.state === 'observed'
    ? snapshot.signalRegistry.value.map((signal) => `${signal.name}（不透明引用 ${signal.unknownRefCount}）`)
    : [];
  const layerName = snapshot.sceneMetadata?.layerName.state === 'observed'
    ? snapshot.sceneMetadata.layerName.value
    : null;
  const editorVersion = snapshot.sceneMetadata?.editorVersionCandidate.state === 'observed'
    ? snapshot.sceneMetadata.editorVersionCandidate.value
    : null;
  const lines = [
    '# 元梦场景只读清单',
    '',
    `- 快照：${snapshot.snapshotId}`,
    `- 来源角色：${snapshot.role}`,
    `- 观测时间：${snapshot.observedAt}`,
    `- 元件：${snapshot.instances.length}`,
    `- 编组：${snapshot.groups.length}`,
    `- 问题：${snapshot.issues.length}`,
    `- 图层名称候选：${layerName ?? '未观测'}`,
    `- 场景版本文本候选：${editorVersion ?? '未观测'}`,
    `- 根信号：${rootSignals.length === 0 ? '未观测' : rootSignals.join('、')}`,
    '',
    '## 编组明细',
    '',
    '| 编组 ID | 父编组 | 直接成员 | 嵌套编组 | 变换 | 元数据候选 | 未校准摘要 | 证据 |',
    '|---|---|---|---|---|---|---|---|',
    ...snapshot.groups.map((group) => {
      const transform = group.transform === undefined ? '旧快照未提供' : markdownCell(stableJson(group.transform));
      const metadata = group.metadata === undefined ? '旧快照未提供' : markdownCell(stableJson(group.metadata));
      const unknown = markdownCell(stableJson(group.unknownFields ?? []));
      return `| ${group.groupId} | ${group.parentGroupId ?? '无'} | ${group.memberIds.join('、') || '无'} | ${group.nestedGroupIds.join('、') || '无'} | ${transform} | ${metadata} | ${unknown} | ${group.evidence.state} |`;
    }),
    '',
    '## 实例明细',
    '',
    '| 实例 ID | 类型 ID | Owner | 分支 | 位置 | 自定义属性 | 信号 | 证据 |',
    '|---|---|---|---|---|---|---|---|',
  ];
  for (const instance of snapshot.instances) {
    const position = instance.transform.state === 'observed'
      ? `${instance.transform.value.position.x}, ${instance.transform.value.position.y}, ${instance.transform.value.position.z}`
      : '未校准';
    const properties = instance.customProperties.state === 'observed' ? stableJson(instance.customProperties.value) : instance.customProperties.state;
    const signals = instance.signals.state === 'observed' ? stableJson(instance.signals.value) : instance.signals.state;
    lines.push(`| ${instance.instanceId} | ${instance.elementTypeId ?? '未知'} | ${instance.ownerId ?? '无'} | ${instance.variant} | ${position} | ${markdownCell(properties)} | ${markdownCell(signals)} | ${instance.evidence.state} |`);
  }
  return `${lines.join('\n')}\n`;
}
