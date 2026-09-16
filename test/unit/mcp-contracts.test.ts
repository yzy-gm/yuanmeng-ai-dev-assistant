import { describe, expect, it } from 'vitest';
import {
  MCP_TOOL_NAMES,
  MCP_TOOL_PROFILE_NAMES,
  toolsForMcpProfile,
  yuanmengMcpEnvelopeSchema
} from '../../src/mcp/contracts.js';
import { MCP_TOOL_INPUT_SCHEMAS } from '../../src/mcp/tool-schemas.js';

describe('MCP contracts', () => {
  it('exposes exactly 42 unique, stable tool names including the compact task context', () => {
    expect(MCP_TOOL_NAMES).toHaveLength(42);
    expect(new Set(MCP_TOOL_NAMES).size).toBe(42);
    expect(MCP_TOOL_NAMES).toContain('yuanmeng_task_context');
    expect(MCP_TOOL_NAMES).toContain('yuanmeng_task_completion_check');
    expect(MCP_TOOL_NAMES).toContain('yuanmeng_gameplay_status');
    for (const toolName of MCP_TOOL_NAMES) {
      expect(toolName).toMatch(/^[a-z][a-z0-9_]+$/);
    }
  });

  it.each([
    ['code', 'FUTURE_CODE'],
    ['evidence level', 'FUTURE_EVIDENCE'],
    ['freshness', 'future-freshness']
  ] as const)('rejects an unknown %s value', (field, invalidValue) => {
    const envelope = {
      schemaVersion: 1,
      requestId: 'request-1',
      tool: 'yuanmeng_project_status',
      ok: false,
      code: 'OK',
      summary: '状态摘要',
      project: {
        projectInstanceId: 'project-1',
        displayName: null
      },
      evidence: {
        level: 'STATIC_LOCAL',
        freshness: 'fresh'
      },
      data: null,
      warnings: [],
      nextActions: []
    };

    if (field === 'code') {
      envelope.code = invalidValue;
    } else if (field === 'evidence level') {
      envelope.evidence.level = invalidValue;
    } else {
      envelope.evidence.freshness = invalidValue;
    }

    expect(yuanmengMcpEnvelopeSchema.safeParse(envelope).success).toBe(false);
  });

  it('accepts only complete automatic or manual gameplay-test inputs', () => {
    const schema = MCP_TOOL_INPUT_SCHEMAS.yuanmeng_gameplay_test;

    expect(schema.safeParse({}).success).toBe(true);
    expect(schema.safeParse({ focus: '复核结算流程', changedFiles: ['src/GameEntry.lua'] }).success).toBe(true);
    expect(schema.safeParse({ preview: true, changedFiles: ['src/GameEntry.lua'] }).success).toBe(true);
    expect(schema.safeParse({
      modelPath: 'gameplay/spec.json',
      scenarioDirectory: 'gameplay/scenarios',
      out: 'gameplay/reports'
    }).success).toBe(true);

    expect(schema.safeParse({ modelPath: 'gameplay/spec.json' }).success).toBe(false);
    expect(schema.safeParse({ out: 'gameplay/reports' }).success).toBe(false);
    expect(schema.safeParse({ modelPath: 'gameplay/spec.json', scenarioDirectory: 'gameplay/scenarios' }).success).toBe(false);
    expect(schema.safeParse({
      modelPath: 'gameplay/spec.json',
      scenarioDirectory: 'gameplay/scenarios',
      out: 'gameplay/reports',
      focus: '不能混用'
    }).success).toBe(false);
    expect(schema.safeParse({ unexpected: true }).success).toBe(false);
  });

  it('accepts only bounded relative inputs for the compact task context', () => {
    const schema = MCP_TOOL_INPUT_SCHEMAS.yuanmeng_task_context;
    expect(schema.safeParse({}).success).toBe(true);
    expect(schema.safeParse({ focus: '检查结算流程', changedFiles: ['src/GameEntry.lua'] }).success).toBe(true);
    expect(schema.safeParse({ changedFiles: ['D:/outside.lua'] }).success).toBe(false);
    expect(schema.safeParse({ focus: '--not-an-option' }).success).toBe(false);
    expect(schema.safeParse({ unexpected: true }).success).toBe(false);
  });

  it('defines smaller opt-in MCP profiles without changing the full profile', () => {
    expect(MCP_TOOL_PROFILE_NAMES).toEqual(['full', 'workflow', 'scene', 'gameplay']);
    expect(toolsForMcpProfile('full')).toEqual(MCP_TOOL_NAMES);
    expect(toolsForMcpProfile('workflow')).toContain('yuanmeng_task_context');
    expect(toolsForMcpProfile('workflow').length).toBeLessThan(MCP_TOOL_NAMES.length);
    expect(toolsForMcpProfile('workflow')).toContain('yuanmeng_ui_refresh');
    expect(toolsForMcpProfile('workflow')).toContain('yuanmeng_scene_refresh');
    expect(toolsForMcpProfile('workflow')).toContain('yuanmeng_scene_bind');
    expect(toolsForMcpProfile('workflow')).toContain('yuanmeng_gameplay_test');
    expect(new Set(toolsForMcpProfile('scene')).size).toBe(toolsForMcpProfile('scene').length);
    expect(new Set(toolsForMcpProfile('gameplay')).size).toBe(toolsForMcpProfile('gameplay').length);
  });
});
