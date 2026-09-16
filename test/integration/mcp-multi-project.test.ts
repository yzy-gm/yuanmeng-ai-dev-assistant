import { describe, expect, it, vi } from 'vitest';

import { McpGateway } from '../../src/mcp/gateway.js';
import { decodeCursor, encodeCursor } from '../../src/mcp/pagination.js';

const SHARED_ID = '55555555-5555-4555-8555-555555555555';

function gateway(root: string, marker: string) {
  const runCli = vi.fn(async (argv: readonly string[]) => ({
    exitCode: 0,
    envelope: {
      schemaVersion: 1 as const,
      ok: true,
      code: 'OK' as const,
      message: marker,
      data: { rootMarker: marker, argv: [...argv], evidence: 'STATIC_LOCAL', freshness: 'fresh' },
      warnings: []
    }
  }));
  return {
    gateway: new McpGateway({
      projectRoot: root,
      projectInstanceId: SHARED_ID,
      displayName: marker,
      currentCliPath: 'C:\\extension\\out\\cli.cjs',
      runCli
    }),
    runCli
  };
}

describe('MCP multi-project isolation and concurrency', () => {
  it('keeps roots isolated under concurrent calls even when instance IDs match', async () => {
    const alpha = gateway('C:\\maps\\alpha', 'Alpha');
    const beta = gateway('C:\\maps\\beta', 'Beta');
    const calls = await Promise.all(Array.from({ length: 100 }, async (_unused, index) => {
      const selected = index % 2 === 0 ? alpha.gateway : beta.gateway;
      return selected.call(index % 3 === 0 ? 'yuanmeng_scene_status' : 'yuanmeng_project_status', {}, new AbortController().signal);
    }));
    expect(calls.filter((item) => item.project.displayName === 'Alpha')).toHaveLength(50);
    expect(calls.filter((item) => item.project.displayName === 'Beta')).toHaveLength(50);
    expect(alpha.runCli.mock.calls.every(([argv]) => argv[1] === 'C:\\maps\\alpha')).toBe(true);
    expect(beta.runCli.mock.calls.every(([argv]) => argv[1] === 'C:\\maps\\beta')).toBe(true);
  });

  it('rejects signed cursors across project, snapshot, query, or tampering', () => {
    const secret = Buffer.from('cursor-secret-at-least-32-bytes-long');
    const cursor = encodeCursor({ projectInstanceId: 'alpha', snapshotId: 'snap-a', tool: 'ids', query: 'q', offset: 100 }, secret);
    expect(decodeCursor(cursor, { projectInstanceId: 'alpha', snapshotId: 'snap-a', tool: 'ids', query: 'q' }, secret).offset).toBe(100);
    expect(() => decodeCursor(cursor, { projectInstanceId: 'beta', snapshotId: 'snap-a', tool: 'ids', query: 'q' }, secret)).toThrow();
    expect(() => decodeCursor(cursor, { projectInstanceId: 'alpha', snapshotId: 'snap-b', tool: 'ids', query: 'q' }, secret)).toThrow();
    expect(() => decodeCursor(`${cursor.slice(0, -1)}x`, { projectInstanceId: 'alpha', snapshotId: 'snap-a', tool: 'ids', query: 'q' }, secret)).toThrow();
  });
});
