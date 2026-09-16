import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { sha256Hex } from '../../src/core/hash.js';
import { normalizeCanonicalRoot } from '../../src/cli/project.js';

const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
let projectRoot = '';

beforeAll(async () => {
  projectRoot = await mkdtemp(join(tmpdir(), 'ymai-mcp-stdio-'));
  await mkdir(join(projectRoot, 'src'), { recursive: true });
  await mkdir(join(projectRoot, '.yuanmeng-inspector'), { recursive: true });
  await writeFile(join(projectRoot, 'src', 'GameEntry.lua'), 'return {}\n', 'utf8');
  await writeFile(join(projectRoot, '.yuanmeng-inspector', 'meta.json'), `${JSON.stringify({
    schemaVersion: 1,
    projectInstanceId: PROJECT_ID,
    projectRootHash: sha256Hex(normalizeCanonicalRoot(resolve(projectRoot)))
  })}\n`, 'utf8');
});

afterAll(async () => {
  if (projectRoot.startsWith(tmpdir())) {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

describe('MCP real stdio transport', () => {
  it('keeps stdout protocol-only, calls a tool, and closes cleanly', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve('out/mcp.cjs'), '--project', projectRoot],
      cwd: process.cwd(),
      stderr: 'pipe'
    });
    let stderr = '';
    transport.stderr?.on('data', (chunk) => { stderr += String(chunk); });
    const client = new Client({ name: 'stdio-integration-test', version: '1.0.0' });

    await client.connect(transport);
    const childPid = transport.pid;
    try {
      expect(childPid).toBeTypeOf('number');
      const tools = await client.listTools();
      expect(tools.tools).toHaveLength(42);
      const result = await client.callTool({ name: 'yuanmeng_project_status', arguments: {} });
      expect(result.structuredContent).toMatchObject({
        code: 'OFFLINE',
        project: { projectInstanceId: PROJECT_ID }
      });
      expect(stderr).not.toContain('缺少或不支持 CLI 命令');
      expect(stderr).not.toContain('LayerData');
      const delivery = await client.callTool({ name: 'yuanmeng_build_and_send_code', arguments: {} });
      expect(delivery.structuredContent).toMatchObject({
        code: 'LINK_OFFLINE',
        data: { status: 'LINK_OFFLINE', commandAvailable: false }
      });
    } finally {
      await client.close();
    }
    expect(transport.pid).toBeNull();
  });

  it('shuts down the stdio server after SIGINT', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve('out/mcp.cjs'), '--project', projectRoot],
      cwd: process.cwd(),
      stderr: 'pipe'
    });
    const client = new Client({ name: 'stdio-signal-test', version: '1.0.0' });
    const closed = new Promise<void>((resolveClose) => {
      client.onclose = resolveClose;
    });

    await client.connect(transport);
    const childPid = transport.pid;
    expect(childPid).toBeTypeOf('number');
    process.kill(childPid!, 'SIGINT');

    await expect(Promise.race([
      closed.then(() => 'closed'),
      new Promise<string>((resolveTimeout) => setTimeout(() => resolveTimeout('timeout'), 5_000))
    ])).resolves.toBe('closed');
    expect(transport.pid).toBeNull();
  });
});
