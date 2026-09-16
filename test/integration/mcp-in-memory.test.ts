import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { describe, expect, it, vi } from 'vitest';

import { MCP_TOOL_NAMES } from '../../src/mcp/contracts.js';
import { toolsForMcpProfile } from '../../src/mcp/contracts.js';
import { MCP_PROMPT_NAMES } from '../../src/mcp/prompts.js';
import { MCP_RESOURCE_URIS } from '../../src/mcp/resources.js';
import { MCP_RESOURCE_TOOL_CALLS } from '../../src/mcp/resources.js';
import { createYuanmengMcpServer } from '../../src/mcp/server.js';

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';

function createGateway() {
  return {
    call: vi.fn(async (tool: string) => ({
      schemaVersion: 1 as const,
      requestId: 'request-1',
      tool,
      ok: true,
      code: 'OK' as const,
      summary: '调用完成。',
      project: { projectInstanceId: PROJECT_ID, displayName: 'Alpha' },
      evidence: { level: 'STATIC_LOCAL' as const, freshness: 'fresh' as const },
      data: { tool },
      warnings: [],
      nextActions: []
    }))
  };
}

describe('MCP in-memory client', () => {
  it('initializes and exposes all tools, resources, prompts, and representative calls', async () => {
    const gateway = createGateway();
    const server = createYuanmengMcpServer({ gateway, version: '0.5.0-private.1' });
    const client = new Client({ name: 'integration-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      expect(client.getServerVersion()).toMatchObject({
        name: 'yuanmeng-ai-dev-assistant',
        version: '0.5.0-private.1'
      });

      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name).sort()).toEqual([...MCP_TOOL_NAMES].sort());
      expect(tools.tools).toHaveLength(42);
      for (const tool of tools.tools) {
        expect(tool.annotations?.destructiveHint).toBe(false);
      }
      expect(tools.tools.find((tool) => tool.name === 'yuanmeng_project_status')?.annotations?.readOnlyHint).toBe(true);
      expect(tools.tools.find((tool) => tool.name === 'yuanmeng_feedback_add')?.annotations?.readOnlyHint).toBe(false);

      const representativeCalls: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
        ['yuanmeng_project_status', {}],
        ['yuanmeng_task_context', { focus: '检查当前流程' }],
        ['yuanmeng_set_map_display_name', { displayName: 'Alpha' }],
        ['yuanmeng_scene_status', {}],
        ['yuanmeng_ui_resolve', { query: '/HUD/经验' }],
        ['yuanmeng_ui_inspect_screen_point', { x: 320, y: 240 }],
        ['yuanmeng_ui_runtime_widgets', { query: '商品列表' }],
        ['yuanmeng_runtime_probe', { kind: 'scene-capability', instanceId: '517' }],
        ['yuanmeng_scene_capability_describe', { instanceId: '517' }],
        ['yuanmeng_build_and_send_code', {}],
        ['yuanmeng_gameplay_review', { modelPath: 'gameplay/spec.json', out: 'gameplay/reports' }],
        ['yuanmeng_gameplay_test', {}],
        ['yuanmeng_gameplay_status', {}],
        ['yuanmeng_task_completion_check', { taskClass: 'small', failureCount: 0 }],
        ['yuanmeng_feedback_add', { kind: 'bug', title: '问题', message: '复现步骤' }]
      ];
      for (const [name, args] of representativeCalls) {
        const result = await client.callTool({ name, arguments: args });
        expect(result.structuredContent).toMatchObject({ tool: name, code: 'OK' });
      }

      const resources = await client.listResources();
      expect(resources.resources.map((resource) => resource.uri).sort()).toEqual([...MCP_RESOURCE_URIS].sort());
      expect(resources.resources).toHaveLength(7);
      expect(MCP_RESOURCE_TOOL_CALLS['yuanmeng://project/current/gameplay/latest']).toEqual({
        tool: 'yuanmeng_gameplay_status',
        input: {}
      });
      expect(MCP_RESOURCE_TOOL_CALLS['yuanmeng://project/current/ui']).toMatchObject({ input: { limit: 50 } });
      expect(MCP_RESOURCE_TOOL_CALLS['yuanmeng://project/current/scene/context']).toMatchObject({ input: { limit: 50 } });
      expect(MCP_RESOURCE_TOOL_CALLS['yuanmeng://project/current/registry']).toMatchObject({ input: { limit: 50 } });
      expect(MCP_RESOURCE_TOOL_CALLS['yuanmeng://project/current/feedback/open']).toMatchObject({ input: { limit: 50 } });
      for (const uri of MCP_RESOURCE_URIS) {
        const result = await client.readResource({ uri });
        expect(result.contents).toHaveLength(1);
        expect(result.contents[0]).toMatchObject({ uri, mimeType: 'application/json' });
        expect('text' in result.contents[0]! ? result.contents[0].text : '').not.toMatch(/[A-Za-z]:\\/u);
      }

      const prompts = await client.listPrompts();
      expect(prompts.prompts.map((prompt) => prompt.name).sort()).toEqual([...MCP_PROMPT_NAMES].sort());
      expect(prompts.prompts).toHaveLength(4);
      expect(prompts.prompts.map((prompt) => prompt.name)).toContain('yuanmeng_task_completion_check');
      const prompt = await client.getPrompt({
        name: 'yuanmeng_inspect_scene_object',
        arguments: { instanceId: '123' }
      });
      expect(prompt.messages).toHaveLength(1);
      expect(prompt.messages[0]?.content).toMatchObject({ type: 'text' });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('can expose an opt-in workflow profile while keeping resources internally routable', async () => {
    const gateway = createGateway();
    const server = createYuanmengMcpServer({ gateway, version: '0.5.0-private.1', toolProfile: 'workflow' });
    const client = new Client({ name: 'integration-test-profile', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name).sort()).toEqual([...toolsForMcpProfile('workflow')].sort());
      expect(tools.tools).toContainEqual(expect.objectContaining({ name: 'yuanmeng_scene_refresh' }));
      expect(tools.tools).not.toContainEqual(expect.objectContaining({ name: 'yuanmeng_runtime_probe' }));
      const resources = await client.listResources();
      expect(resources.resources).toHaveLength(5);
      expect(resources.resources.map((resource) => resource.uri)).not.toContain('yuanmeng://project/current/feedback/open');
      const prompts = await client.listPrompts();
      expect(prompts.prompts).toHaveLength(4);
      const resource = await client.readResource({ uri: 'yuanmeng://project/current/status' });
      expect(resource.contents).toHaveLength(1);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
