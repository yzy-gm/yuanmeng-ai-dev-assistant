import { performance } from 'node:perf_hooks';

import { describe, expect, it, vi } from 'vitest';

import { McpGateway } from '../../src/mcp/gateway.js';

describe('MCP warm-call performance and resource stability', () => {
  it('stays within direct runCli median + 15% + 25ms and does not add process listeners', async () => {
    const runCli = vi.fn(async () => ({
      exitCode: 0,
      envelope: { schemaVersion: 1 as const, ok: true, code: 'OK' as const, message: 'OK', data: null, warnings: [] }
    }));
    const gateway = new McpGateway({
      projectRoot: 'C:\\maps\\perf',
      projectInstanceId: '66666666-6666-4666-8666-666666666666',
      displayName: 'Perf',
      currentCliPath: 'C:\\extension\\out\\cli.cjs',
      runCli
    });
    const listenersBefore = process.eventNames().reduce((total, name) => total + process.listenerCount(name), 0);
    const direct: number[] = [];
    const throughMcp: number[] = [];
    for (let index = 0; index < 20; index += 1) {
      let started = performance.now();
      await runCli([]);
      direct.push(performance.now() - started);
      started = performance.now();
      await gateway.call('yuanmeng_project_status', {}, new AbortController().signal);
      throughMcp.push(performance.now() - started);
    }
    const median = (items: number[]) => [...items].sort((a, b) => a - b)[Math.floor(items.length / 2)]!;
    expect(median(throughMcp)).toBeLessThanOrEqual(median(direct) * 1.15 + 25);
    expect(process.eventNames().reduce((total, name) => total + process.listenerCount(name), 0)).toBe(listenersBefore);
    expect(runCli).toHaveBeenCalledTimes(40);
  });
});
