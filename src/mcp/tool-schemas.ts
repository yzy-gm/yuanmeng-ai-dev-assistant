import { z } from 'zod';

import {
  REGISTRY_ENVIRONMENTS,
  REGISTRY_KINDS,
  REGISTRY_VALIDITIES
} from '../core/model.js';
import { CUSTOM_PROPERTY_TYPES } from '../core/scene/lua-probe.js';
import type { YuanmengMcpToolName } from './contracts.js';

const boundedText = z.string().min(1).max(4096).refine((value) => !value.startsWith('--'), {
  message: '值不能伪装成 CLI 选项。'
});
const decimalId = z.string().regex(/^\d{1,20}$/u, 'ID 必须是 1 到 20 位十进制字符串。');
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u, '必须是 64 位小写 SHA-256。');
const positiveTimeout = z.number().int().min(1).max(600);
const sceneRole = z.enum(['manual-dat', 'auto-dat', 'raw-pbin']);
const axis = z.enum(['x', 'y', 'z']);
const finiteNumber = z.number().finite();
const auditFile = z.string().min(1).max(4096).refine((value) => {
  const normalized = value.replace(/\\/gu, '/');
  const segments = normalized.split('/');
  return normalized.startsWith('src/')
    && normalized.toLowerCase().endsWith('.lua')
    && !/^[A-Za-z]:/u.test(normalized)
    && segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}, { message: '只接受 src/ 下的工程相对 Lua 路径。' });
const projectAuditInput = z.object({
  files: z.array(auditFile).max(100).optional(),
  errorsOnly: z.boolean().optional()
}).strict().superRefine((value, context) => {
  const normalized = (value.files ?? []).map((file) => file.replace(/\\/gu, '/'));
  if (new Set(normalized).size !== normalized.length) {
    context.addIssue({ code: 'custom', path: ['files'], message: '不能重复指定同一文件。' });
  }
});
const gameplayTestInput = z.union([
  z.object({
    focus: boundedText.max(2_000).optional(),
    changedFiles: z.array(auditFile).max(100).optional(),
    preview: z.boolean().optional(),
  }).strict(),
  z.object({
    modelPath: boundedText,
    scenarioDirectory: boundedText,
    out: boundedText
  }).strict()
]);

const emptyInput = z.object({}).strict();
const snapshotRange = z.object({
  from: sha256.optional(),
  to: sha256.optional()
}).strict();
const idArray = z.array(decimalId).min(1).max(500);
const componentOffsets = z.object({
  x: finiteNumber.optional(),
  y: finiteNumber.optional(),
  z: finiteNumber.optional()
}).strict().refine((value) => Object.keys(value).length > 0, {
  message: '至少提供一个分量。'
});

const uiScreenPointInput = z.object({
  x: finiteNumber,
  y: finiteNumber,
  includeGroup: z.boolean().optional(),
  groupId: decimalId.optional(),
  allowStale: z.boolean().optional()
}).strict().superRefine((value, context) => {
  if (value.includeGroup === true && value.groupId === undefined) {
    context.addIssue({ code: 'custom', path: ['groupId'], message: 'includeGroup=true 时必须提供 groupId。' });
  }
  if (value.includeGroup !== true && value.groupId !== undefined) {
    context.addIssue({ code: 'custom', path: ['groupId'], message: 'groupId 只能与 includeGroup=true 同时使用。' });
  }
});

const runtimeProbeInput = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('ui-screen-point'),
    x: finiteNumber,
    y: finiteNumber,
    includeGroup: z.boolean().optional(),
    groupId: decimalId.optional(),
    allowStale: z.boolean().optional()
  }).strict().superRefine((value, context) => {
    if (value.includeGroup === true && value.groupId === undefined) {
      context.addIssue({ code: 'custom', path: ['groupId'], message: 'includeGroup=true 时必须提供 groupId。' });
    }
    if (value.includeGroup !== true && value.groupId !== undefined) {
      context.addIssue({ code: 'custom', path: ['groupId'], message: 'groupId 只能与 includeGroup=true 同时使用。' });
    }
  }),
  z.object({
    kind: z.literal('ui-runtime-tree'),
    query: boundedText,
    allowStale: z.boolean().optional()
  }).strict(),
  z.object({
    kind: z.literal('scene-capability'),
    instanceId: decimalId
  }).strict()
]);

const scenePlanSchema = z.discriminatedUnion('operation', [
  z.object({
    operation: z.literal('floor-align'),
    supportId: decimalId,
    targetIds: idArray
  }).strict(),
  z.object({
    operation: z.literal('axis-align'),
    targetIds: idArray,
    referenceId: decimalId,
    axis,
    anchor: z.enum(['position', 'min', 'center', 'max']),
    preserveGroupRelative: z.boolean().optional()
  }).strict(),
  z.object({
    operation: z.literal('equal-spacing'),
    targetIds: z.array(decimalId).min(3).max(500),
    axis,
    mode: z.enum(['position', 'bounds-gap']).optional(),
    preserveGroupRelative: z.boolean().optional()
  }).strict(),
  z.object({
    operation: z.literal('grid'),
    targetIds: idArray,
    rowAxis: axis,
    columnAxis: axis,
    columns: z.number().int().min(1).max(500),
    rowSpacing: finiteNumber,
    columnSpacing: finiteNumber,
    preserveGroupRelative: z.boolean().optional()
  }).strict().refine((value) => value.rowAxis !== value.columnAxis, {
    message: '行轴和列轴不能相同。'
  }),
  z.object({
    operation: z.enum(['rows', 'columns']),
    targetIds: idArray,
    axis,
    spacing: finiteNumber,
    preserveGroupRelative: z.boolean().optional()
  }).strict(),
  z.object({
    operation: z.literal('batch-offset'),
    targetIds: idArray,
    position: componentOffsets.optional(),
    rotation: componentOffsets.optional(),
    scale: componentOffsets.optional(),
    preserveGroupRelative: z.boolean().optional()
  }).strict().refine((value) => value.position !== undefined || value.rotation !== undefined || value.scale !== undefined, {
    message: '批量偏移至少需要 position、rotation 或 scale。'
  })
]);

export const MCP_TOOL_INPUT_SCHEMAS: Readonly<Record<YuanmengMcpToolName, z.ZodType>> = {
  yuanmeng_project_status: emptyInput,
  yuanmeng_task_context: z.object({
    focus: boundedText.max(2_000).optional(),
    changedFiles: z.array(auditFile).max(100).optional(),
  }).strict(),
  yuanmeng_set_map_display_name: z.object({ displayName: boundedText.max(80) }).strict(),
  yuanmeng_ui_refresh: z.object({ timeoutSeconds: positiveTimeout.optional() }).strict(),
  yuanmeng_ui_find: z.object({
    query: boundedText,
    allowStale: z.boolean().optional(),
    fuzzy: z.boolean().optional()
  }).strict(),
  yuanmeng_ui_resolve: z.object({
    query: boundedText,
    allowStale: z.boolean().optional()
  }).strict(),
  yuanmeng_ui_inspect_screen_point: uiScreenPointInput,
  yuanmeng_ui_runtime_widgets: z.object({
    query: boundedText,
    allowStale: z.boolean().optional()
  }).strict(),
  yuanmeng_ui_screen_snapshot: z.object({
    query: boundedText,
    allowStale: z.boolean().optional(),
    fuzzy: z.boolean().optional()
  }).strict(),
  yuanmeng_ui_tree_screen_snapshot: z.object({
    query: boundedText,
    allowStale: z.boolean().optional(),
    fuzzy: z.boolean().optional()
  }).strict(),
  yuanmeng_ui_layout_audit: z.object({
    query: boundedText,
    allowStale: z.boolean().optional(),
    fuzzy: z.boolean().optional(),
    includePotentialSiblingOverlap: z.boolean().optional()
  }).strict(),
  yuanmeng_ui_diff: snapshotRange,
  yuanmeng_ids_list: z.object({
    kind: z.enum(REGISTRY_KINDS).optional(),
    environment: z.enum(REGISTRY_ENVIRONMENTS).optional(),
    validity: z.enum(REGISTRY_VALIDITIES).optional(),
    allowStale: z.boolean().optional(),
    limit: z.number().int().min(1).max(500).optional(),
    cursor: z.string().min(1).max(8_192).optional()
  }).strict(),
  yuanmeng_where_used: z.object({
    query: boundedText,
    kind: z.enum(['id', 'signal', 'ui', 'scene-instance', 'element-type', 'scene-layer']).optional()
  }).strict(),
  yuanmeng_api_search: z.object({ query: boundedText, limit: z.number().int().min(1).max(1_000).optional() }).strict(),
  yuanmeng_official_audit: z.object({ saveBaseline: z.boolean().optional() }).strict(),
  yuanmeng_project_audit: projectAuditInput,
  yuanmeng_scene_status: emptyInput,
  yuanmeng_scene_bind: z.object({ role: sceneRole, sourcePath: boundedText }).strict(),
  yuanmeng_scene_refresh: z.object({ role: sceneRole.optional(), timeoutSeconds: positiveTimeout.optional() }).strict(),
  yuanmeng_scene_find: z.object({
    query: boundedText,
    limit: z.number().int().min(1).max(500).optional(),
    cursor: z.string().min(1).max(8_192).optional()
  }).strict(),
  yuanmeng_scene_tree: z.object({ instanceId: decimalId }).strict(),
  yuanmeng_scene_fields: z.object({ instanceId: decimalId }).strict(),
  yuanmeng_group_members: z.object({ groupId: decimalId }).strict(),
  yuanmeng_scene_diff: snapshotRange,
  yuanmeng_scene_near: z.object({
    instanceId: decimalId,
    radius: z.number().finite().positive().max(1_000_000).optional(),
    limit: z.number().int().min(1).max(500).optional()
  }).strict(),
  yuanmeng_scene_audit: z.object({ detailed: z.boolean().optional() }).strict(),
  yuanmeng_scene_types: z.object({
    limit: z.number().int().min(1).max(500).optional(),
    cursor: z.string().min(1).max(8_192).optional()
  }).strict(),
  yuanmeng_scene_capability_describe: z.object({ instanceId: decimalId }).strict(),
  yuanmeng_runtime_probe: runtimeProbeInput,
  yuanmeng_scene_geometry: z.discriminatedUnion('operation', [
    z.object({ operation: z.literal('bounds'), targetId: decimalId }).strict(),
    z.object({
      operation: z.literal('contact'),
      targetId: decimalId,
      supportId: decimalId,
      tolerance: z.number().finite().min(0).max(1_000_000).optional()
    }).strict(),
    z.object({ operation: z.literal('overlaps'), targetIds: idArray.min(2).max(100) }).strict()
  ]),
  yuanmeng_scene_plan: scenePlanSchema,
  yuanmeng_scene_journal: z.discriminatedUnion('action', [
    z.object({ action: z.literal('list'), limit: z.number().int().min(1).max(200).optional() }).strict(),
    z.object({ action: z.literal('show'), journalId: sha256 }).strict()
  ]),
  yuanmeng_property_locate: z.object({
    propertyName: boundedText,
    propertyType: z.enum(CUSTOM_PROPERTY_TYPES)
  }).strict(),
  yuanmeng_gameplay_review: z.object({ modelPath: boundedText, out: boundedText }).strict(),
  yuanmeng_gameplay_test: gameplayTestInput,
  yuanmeng_gameplay_status: emptyInput,
  yuanmeng_task_completion_check: z.object({
    taskClass: z.enum(['small', 'complex', 'multiplayer']),
    failureCount: z.number().int().min(0).max(100).default(0),
    focus: boundedText.max(2_000).optional(),
    changedFiles: z.array(auditFile).max(100).optional()
  }).strict(),
  yuanmeng_feedback_add: z.object({
    kind: z.enum(['bug', 'friction', 'improvement']),
    title: boundedText.max(200),
    message: boundedText.max(20_000)
  }).strict(),
  yuanmeng_feedback_list: z.object({
    status: z.enum(['open', 'resolved']).optional(),
    kind: z.enum(['bug', 'friction', 'improvement']).optional(),
    limit: z.number().int().min(1).max(500).optional(),
    cursor: z.string().min(1).max(8_192).optional()
  }).strict(),
  yuanmeng_feedback_resolve: z.object({
    feedbackId: sha256,
    resolution: boundedText.max(20_000)
  }).strict(),
  yuanmeng_build_and_send_code: emptyInput
};

function appendOption(argv: string[], option: string, value: string | number | undefined): void {
  if (value !== undefined) argv.push(option, String(value));
}

function appendFlag(argv: string[], flag: string, enabled: boolean | undefined): void {
  if (enabled === true) argv.push(flag);
}

function formatOffsets(value: { x?: number | undefined; y?: number | undefined; z?: number | undefined }): string {
  return (['x', 'y', 'z'] as const)
    .filter((key) => value[key] !== undefined)
    .map((key) => `${key}=${value[key]}`)
    .join(',');
}

function mapScenePlan(input: z.infer<typeof scenePlanSchema>): string[] {
  if (input.operation === 'floor-align') {
    return ['scene-plan', 'floor-align', input.supportId, ...input.targetIds];
  }
  const argv = ['scene-plan', input.operation, ...input.targetIds];
  if (input.operation === 'axis-align') {
    argv.push('--reference', input.referenceId, '--axis', input.axis, '--anchor', input.anchor);
  } else if (input.operation === 'equal-spacing') {
    argv.push('--axis', input.axis);
    appendFlag(argv, '--bounds-gap', input.mode === 'bounds-gap');
  } else if (input.operation === 'grid') {
    argv.push(
      '--row-axis', input.rowAxis,
      '--column-axis', input.columnAxis,
      '--columns', String(input.columns),
      '--row-spacing', String(input.rowSpacing),
      '--column-spacing', String(input.columnSpacing)
    );
  } else if (input.operation === 'rows' || input.operation === 'columns') {
    argv.push('--axis', input.axis, '--spacing', String(input.spacing));
  } else if (input.operation === 'batch-offset') {
    if (input.position !== undefined) argv.push('--position', formatOffsets(input.position));
    if (input.rotation !== undefined) argv.push('--rotation', formatOffsets(input.rotation));
    if (input.scale !== undefined) argv.push('--scale', formatOffsets(input.scale));
  }
  appendFlag(argv, '--no-preserve-group', input.preserveGroupRelative === false);
  return argv;
}

export function toolToCliArgs(tool: YuanmengMcpToolName, rawInput: unknown): readonly string[] {
  const input = MCP_TOOL_INPUT_SCHEMAS[tool].parse(rawInput) as Record<string, unknown>;
  switch (tool) {
    case 'yuanmeng_project_status': return ['status'];
    case 'yuanmeng_task_context': return ['status'];
    case 'yuanmeng_set_map_display_name': return ['set-map-name', input.displayName as string];
    case 'yuanmeng_ui_refresh': {
      const argv = ['refresh-ui']; appendOption(argv, '--timeout', input.timeoutSeconds as number | undefined); return argv;
    }
    case 'yuanmeng_ui_find': {
      const argv = ['find-ui', input.query as string];
      appendFlag(argv, '--allow-stale', input.allowStale as boolean | undefined);
      appendFlag(argv, '--fuzzy', input.fuzzy as boolean | undefined);
      return argv;
    }
    case 'yuanmeng_ui_resolve': {
      const argv = ['resolve-ui', input.query as string];
      appendFlag(argv, '--allow-stale', input.allowStale as boolean | undefined);
      return argv;
    }
    case 'yuanmeng_ui_inspect_screen_point': {
      const argv = ['ui-inspect-point', String(input.x), String(input.y)];
      appendFlag(argv, '--include-group', input.includeGroup as boolean | undefined);
      appendOption(argv, '--group-id', input.groupId as string | undefined);
      appendFlag(argv, '--allow-stale', input.allowStale as boolean | undefined);
      return argv;
    }
    case 'yuanmeng_ui_runtime_widgets': {
      const argv = ['ui-runtime-widgets', input.query as string];
      appendFlag(argv, '--allow-stale', input.allowStale as boolean | undefined);
      return argv;
    }
    case 'yuanmeng_ui_screen_snapshot':
    case 'yuanmeng_ui_tree_screen_snapshot':
    case 'yuanmeng_ui_layout_audit': {
      const command = tool === 'yuanmeng_ui_screen_snapshot'
        ? 'ui-screen-snapshot'
        : tool === 'yuanmeng_ui_tree_screen_snapshot' ? 'ui-tree-screen-snapshot' : 'ui-layout-audit';
      const argv = [command, input.query as string];
      appendFlag(argv, '--allow-stale', input.allowStale as boolean | undefined);
      if (input.query?.toString().startsWith('/')) argv.push('--path');
      else appendFlag(argv, '--fuzzy', input.fuzzy as boolean | undefined);
      appendFlag(argv, '--include-overlaps', input.includePotentialSiblingOverlap as boolean | undefined);
      return argv;
    }
    case 'yuanmeng_ui_diff':
    case 'yuanmeng_scene_diff': {
      const argv = [tool === 'yuanmeng_ui_diff' ? 'diff-ui' : 'scene-diff'];
      appendOption(argv, '--from', input.from as string | undefined);
      appendOption(argv, '--to', input.to as string | undefined);
      return argv;
    }
    case 'yuanmeng_ids_list': {
      const argv = ['list-ids'];
      appendOption(argv, '--kind', input.kind as string | undefined);
      appendOption(argv, '--environment', input.environment as string | undefined);
      appendOption(argv, '--validity', input.validity as string | undefined);
      appendFlag(argv, '--allow-stale', input.allowStale as boolean | undefined);
      return argv;
    }
    case 'yuanmeng_where_used': {
      const argv = ['where-used', input.query as string]; appendOption(argv, '--kind', input.kind as string | undefined); return argv;
    }
    case 'yuanmeng_api_search': {
      const argv = ['api-search', input.query as string];
      appendOption(argv, '--limit', input.limit as number | undefined);
      return argv;
    }
    case 'yuanmeng_official_audit': {
      const argv = ['official-audit'];
      appendFlag(argv, '--save-baseline', input.saveBaseline as boolean | undefined);
      return argv;
    }
    case 'yuanmeng_project_audit': {
      const argv = ['audit'];
      for (const file of (input.files as string[] | undefined) ?? []) argv.push('--file', file);
      appendFlag(argv, '--errors-only', input.errorsOnly as boolean | undefined);
      return argv;
    }
    case 'yuanmeng_scene_status': return ['scene-status'];
    case 'yuanmeng_scene_bind': return ['bind-scene', input.role as string, input.sourcePath as string];
    case 'yuanmeng_scene_refresh': {
      const argv = ['refresh-scene'];
      if (input.role !== undefined) argv.push(input.role as string);
      appendOption(argv, '--timeout', input.timeoutSeconds as number | undefined);
      return argv;
    }
    case 'yuanmeng_scene_find': return ['find-scene', input.query as string];
    case 'yuanmeng_scene_tree': return ['scene-tree', input.instanceId as string];
    case 'yuanmeng_scene_fields': return ['field-inspect', input.instanceId as string];
    case 'yuanmeng_group_members': return ['group-members', input.groupId as string];
    case 'yuanmeng_scene_near': {
      const argv = ['scene-near', input.instanceId as string];
      appendOption(argv, '--radius', input.radius as number | undefined);
      appendOption(argv, '--limit', input.limit as number | undefined);
      return argv;
    }
    case 'yuanmeng_scene_audit': {
      const argv = ['scene-audit']; appendFlag(argv, '--detailed', input.detailed as boolean | undefined); return argv;
    }
    case 'yuanmeng_scene_types': return ['scene-types'];
    case 'yuanmeng_scene_capability_describe': return ['scene-capabilities', input.instanceId as string];
    case 'yuanmeng_runtime_probe': {
      if (input.kind === 'ui-screen-point') {
        const argv = ['runtime-probe', 'ui-screen-point', String(input.x), String(input.y)];
        appendFlag(argv, '--include-group', input.includeGroup as boolean | undefined);
        appendOption(argv, '--group-id', input.groupId as string | undefined);
        appendFlag(argv, '--allow-stale', input.allowStale as boolean | undefined);
        return argv;
      }
      if (input.kind === 'ui-runtime-tree') {
        const argv = ['runtime-probe', 'ui-runtime-tree', input.query as string];
        appendFlag(argv, '--allow-stale', input.allowStale as boolean | undefined);
        return argv;
      }
      return ['runtime-probe', 'scene-capability', input.instanceId as string];
    }
    case 'yuanmeng_scene_geometry': {
      if (input.operation === 'bounds') return ['scene-geometry', 'bounds', input.targetId as string];
      if (input.operation === 'contact') {
        const argv = ['scene-geometry', 'contact', input.targetId as string, input.supportId as string];
        appendOption(argv, '--tolerance', input.tolerance as number | undefined);
        return argv;
      }
      return ['scene-geometry', 'overlaps', ...(input.targetIds as string[])];
    }
    case 'yuanmeng_scene_plan': return mapScenePlan(input as z.infer<typeof scenePlanSchema>);
    case 'yuanmeng_scene_journal': {
      if (input.action === 'show') return ['scene-journal', 'show', input.journalId as string];
      const argv = ['scene-journal', 'list']; appendOption(argv, '--limit', input.limit as number | undefined); return argv;
    }
    case 'yuanmeng_property_locate': return ['property-locate', input.propertyName as string, input.propertyType as string];
    case 'yuanmeng_gameplay_review': return ['gameplay-review', input.modelPath as string, '--out', input.out as string];
    case 'yuanmeng_gameplay_test': {
      if (input.modelPath !== undefined) {
        return ['gameplay-test', input.modelPath as string, input.scenarioDirectory as string, '--out', input.out as string];
      }
      const argv = ['gameplay-test'];
      appendFlag(argv, '--preview', input.preview as boolean | undefined);
      appendOption(argv, '--focus', input.focus as string | undefined);
      for (const file of (input.changedFiles as string[] | undefined) ?? []) argv.push('--file', file);
      return argv;
    }
    case 'yuanmeng_gameplay_status':
    case 'yuanmeng_task_completion_check':
      throw new Error(`${tool} 由 MCP 网关直接编排，不映射单条 CLI 命令。`);
    case 'yuanmeng_feedback_add': return ['feedback', 'add', input.kind as string, input.title as string, '--message', input.message as string];
    case 'yuanmeng_feedback_list': return ['feedback', 'list', (input.status as string | undefined) ?? 'all', (input.kind as string | undefined) ?? 'all'];
    case 'yuanmeng_feedback_resolve': return ['feedback', 'resolve', input.feedbackId as string, '--message', input.resolution as string];
    case 'yuanmeng_build_and_send_code': return [];
  }
}
