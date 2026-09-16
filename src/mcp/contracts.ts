import { z } from 'zod';

export const MCP_TOOL_NAMES = [
  'yuanmeng_project_status',
  'yuanmeng_task_context',
  'yuanmeng_set_map_display_name',
  'yuanmeng_ui_refresh',
  'yuanmeng_ui_find',
  'yuanmeng_ui_resolve',
  'yuanmeng_ui_inspect_screen_point',
  'yuanmeng_ui_runtime_widgets',
  'yuanmeng_ui_screen_snapshot',
  'yuanmeng_ui_tree_screen_snapshot',
  'yuanmeng_ui_layout_audit',
  'yuanmeng_ui_diff',
  'yuanmeng_ids_list',
  'yuanmeng_where_used',
  'yuanmeng_api_search',
  'yuanmeng_official_audit',
  'yuanmeng_project_audit',
  'yuanmeng_scene_status',
  'yuanmeng_scene_bind',
  'yuanmeng_scene_refresh',
  'yuanmeng_scene_find',
  'yuanmeng_scene_tree',
  'yuanmeng_scene_fields',
  'yuanmeng_group_members',
  'yuanmeng_scene_diff',
  'yuanmeng_scene_near',
  'yuanmeng_scene_audit',
  'yuanmeng_scene_types',
  'yuanmeng_scene_capability_describe',
  'yuanmeng_runtime_probe',
  'yuanmeng_scene_geometry',
  'yuanmeng_scene_plan',
  'yuanmeng_scene_journal',
  'yuanmeng_property_locate',
  'yuanmeng_gameplay_review',
  'yuanmeng_gameplay_test',
  'yuanmeng_gameplay_status',
  'yuanmeng_task_completion_check',
  'yuanmeng_feedback_add',
  'yuanmeng_feedback_list',
  'yuanmeng_feedback_resolve',
  'yuanmeng_build_and_send_code'
] as const;

export type YuanmengMcpToolName = (typeof MCP_TOOL_NAMES)[number];

export const MCP_TOOL_PROFILE_NAMES = ['full', 'workflow', 'scene', 'gameplay'] as const;
export type YuanmengMcpToolProfile = (typeof MCP_TOOL_PROFILE_NAMES)[number];

const MCP_TOOL_PROFILE_TOOLS: Readonly<Record<YuanmengMcpToolProfile, readonly YuanmengMcpToolName[]>> = {
  full: MCP_TOOL_NAMES,
  workflow: [
    'yuanmeng_project_status', 'yuanmeng_task_context', 'yuanmeng_set_map_display_name',
    'yuanmeng_ui_refresh', 'yuanmeng_ui_find', 'yuanmeng_ui_resolve', 'yuanmeng_ui_diff',
    'yuanmeng_ids_list', 'yuanmeng_where_used', 'yuanmeng_api_search', 'yuanmeng_official_audit', 'yuanmeng_project_audit',
    'yuanmeng_scene_status', 'yuanmeng_scene_bind', 'yuanmeng_scene_refresh',
    'yuanmeng_scene_find', 'yuanmeng_scene_tree', 'yuanmeng_scene_fields', 'yuanmeng_group_members',
    'yuanmeng_scene_diff', 'yuanmeng_scene_audit', 'yuanmeng_scene_types',
    'yuanmeng_scene_capability_describe',
    'yuanmeng_gameplay_test', 'yuanmeng_gameplay_status', 'yuanmeng_task_completion_check',
    'yuanmeng_feedback_list', 'yuanmeng_build_and_send_code',
  ],
  scene: [
    'yuanmeng_project_status', 'yuanmeng_task_context', 'yuanmeng_ids_list',
    'yuanmeng_where_used', 'yuanmeng_api_search', 'yuanmeng_official_audit', 'yuanmeng_scene_status',
    'yuanmeng_scene_bind', 'yuanmeng_scene_refresh', 'yuanmeng_scene_find',
    'yuanmeng_scene_tree', 'yuanmeng_scene_fields', 'yuanmeng_group_members',
    'yuanmeng_scene_diff', 'yuanmeng_scene_near', 'yuanmeng_scene_audit',
    'yuanmeng_scene_types', 'yuanmeng_scene_capability_describe',
    'yuanmeng_runtime_probe', 'yuanmeng_scene_geometry', 'yuanmeng_scene_plan',
    'yuanmeng_scene_journal', 'yuanmeng_property_locate',
  ],
  gameplay: [
    'yuanmeng_project_status', 'yuanmeng_task_context', 'yuanmeng_project_audit',
    'yuanmeng_where_used', 'yuanmeng_api_search', 'yuanmeng_official_audit', 'yuanmeng_scene_status',
    'yuanmeng_scene_types', 'yuanmeng_scene_capability_describe',
    'yuanmeng_gameplay_review', 'yuanmeng_gameplay_test', 'yuanmeng_gameplay_status',
    'yuanmeng_task_completion_check', 'yuanmeng_feedback_list',
  ],
};

export function toolsForMcpProfile(profile: YuanmengMcpToolProfile): readonly YuanmengMcpToolName[] {
  return MCP_TOOL_PROFILE_TOOLS[profile];
}

export const mcpResultCodeSchema = z.enum([
  'OK',
  'OFFLINE',
  'STALE',
  'AMBIGUOUS',
  'NOT_FOUND',
  'VALIDATION_FAILED',
  'USAGE_ERROR',
  'LINK_OFFLINE',
  'COMMAND_UNAVAILABLE',
  'CHECK_FAILED',
  'EVIDENCE_INSUFFICIENT',
  'INTERNAL_ERROR'
]);

export const mcpEvidenceLevelSchema = z.enum([
  'STATIC_LOCAL',
  'EXTENSION_HOST',
  'STANDALONE_LOG',
  'OFFICIAL_EDITOR_SINGLE',
  'MULTIPLAYER_RUNTIME',
  'UNKNOWN'
]);

export const mcpFreshnessSchema = z.enum([
  'fresh',
  'stale',
  'missing',
  'unknown'
]);

export const mcpNextActionSchema = z.object({
  kind: z.enum([
    'call-tool',
    'run-vscode-command',
    'save-editor',
    'editor-test',
    'multiplayer-test'
  ]),
  label: z.string(),
  tool: z.string().optional(),
  commandId: z.string().optional(),
  arguments: z.record(z.string(), z.unknown()).optional()
}).strict();

export const yuanmengMcpEnvelopeSchema = z.object({
  schemaVersion: z.literal(1),
  requestId: z.string().min(1),
  tool: z.string().min(1),
  ok: z.boolean(),
  code: mcpResultCodeSchema,
  summary: z.string(),
  project: z.object({
    projectInstanceId: z.string().min(1),
    displayName: z.string().nullable()
  }).strict(),
  evidence: z.object({
    level: mcpEvidenceLevelSchema,
    freshness: mcpFreshnessSchema,
    snapshotId: z.string().optional()
  }).strict(),
  data: z.unknown().nullable(),
  warnings: z.array(z.string()),
  nextActions: z.array(mcpNextActionSchema),
  page: z.object({
    count: z.number().int().nonnegative(),
    total: z.number().int().nonnegative().optional(),
    nextCursor: z.string().optional()
  }).strict().optional()
}).strict();

export type McpResultCode = z.infer<typeof mcpResultCodeSchema>;
export type McpEvidenceLevel = z.infer<typeof mcpEvidenceLevelSchema>;
export type McpFreshness = z.infer<typeof mcpFreshnessSchema>;
export type McpNextAction = z.infer<typeof mcpNextActionSchema>;

export interface YuanmengMcpEnvelope<T> {
  readonly schemaVersion: 1;
  readonly requestId: string;
  readonly tool: string;
  readonly ok: boolean;
  readonly code: McpResultCode;
  readonly summary: string;
  readonly project: {
    readonly projectInstanceId: string;
    readonly displayName: string | null;
  };
  readonly evidence: {
    readonly level: McpEvidenceLevel;
    readonly freshness: McpFreshness;
    readonly snapshotId?: string;
  };
  readonly data: T | null;
  readonly warnings: readonly string[];
  readonly nextActions: readonly McpNextAction[];
  readonly page?: {
    readonly count: number;
    readonly total?: number;
    readonly nextCursor?: string;
  };
}
