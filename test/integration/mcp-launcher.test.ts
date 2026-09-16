import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';

import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterEach, describe, expect, it } from 'vitest';

import { sha256Hex } from '../../src/core/hash.js';
import { normalizeCanonicalRoot } from '../../src/cli/project.js';
import { createOrRefreshMcpLauncher } from '../../src/extension/cli-launcher.js';
import { toolsForMcpProfile } from '../../src/mcp/contracts.js';
import { promptsForMcpProfile } from '../../src/mcp/prompts.js';
import { resourcesForMcpProfile } from '../../src/mcp/resources.js';

const execFileAsync = promisify(execFile);
const PROJECT_ID = '33333333-3333-4333-8333-333333333333';
const temporaryRoots: string[] = [];

async function fixture(bundlePath?: string) {
  const root = await mkdtemp(join(tmpdir(), 'ymai-mcp-launcher-'));
  temporaryRoots.push(root);
  const projectRoot = join(root, '地图 工程');
  await mkdir(join(projectRoot, 'src'), { recursive: true });
  await mkdir(join(projectRoot, '.yuanmeng-inspector'), { recursive: true });
  await writeFile(join(projectRoot, 'src', 'GameEntry.lua'), 'return {}\n', 'utf8');
  const projectRootHash = sha256Hex(normalizeCanonicalRoot(resolve(projectRoot)));
  const packageJson = JSON.parse(await readFile(resolve('package.json'), 'utf8')) as { version: string };
  await writeFile(join(projectRoot, '.yuanmeng-inspector', 'meta.json'), `${JSON.stringify({
    schemaVersion: 1,
    projectInstanceId: PROJECT_ID,
    projectRootHash
  })}\n`, 'utf8');
  return {
    root,
    projectRoot,
    projectRootHash,
    input: {
      projectRoot,
      projectInstanceId: PROJECT_ID,
      projectRootHash,
      extensionRoot: resolve('.'),
      extensionVersion: packageJson.version,
      mcpPath: bundlePath ?? resolve('out/mcp.cjs'),
      generatedAt: '2026-08-22T04:00:00.000Z'
    }
  };
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('validated project-local MCP launcher', () => {
  it('creates three fixed artifacts and refreshes byte-idempotently', async () => {
    const item = await fixture();
    const first = await createOrRefreshMcpLauncher(item.input);
    const original = await Promise.all([
      readFile(first.manifestPath),
      readFile(first.validatorPath),
      readFile(first.launcherPath)
    ]);
    const second = await createOrRefreshMcpLauncher({
      ...item.input,
      generatedAt: '2026-08-22T05:00:00.000Z'
    });

    expect(first).toMatchObject({ changed: true });
    expect(first.manifestPath).toBe(join(item.projectRoot, '.yuanmeng-inspector', 'bin', 'mcp-launcher.json'));
    expect(first.validatorPath).toBe(join(item.projectRoot, '.yuanmeng-inspector', 'bin', 'ymai-mcp.cjs'));
    expect(first.launcherPath).toBe(join(item.projectRoot, '.yuanmeng-inspector', 'bin', 'ymai-mcp.cmd'));
    expect(second.changed).toBe(false);
    expect(await Promise.all([
      readFile(second.manifestPath),
      readFile(second.validatorPath),
      readFile(second.launcherPath)
    ])).toEqual(original);
    expect(original[2]!.toString('utf8')).not.toMatch(/PowerShell|Invoke-Expression|Get-FileHash/iu);
  });

  it('forwards arguments as an array and rejects bundle or manifest tampering before execution', async () => {
    const item = await fixture();
    const fakeBundle = join(item.root, 'extension', 'out', 'mcp.cjs');
    await mkdir(join(item.root, 'extension', 'out'), { recursive: true });
    await writeFile(fakeBundle, [
      "require('node:fs').writeFileSync(process.env.YMAI_CAPTURE, JSON.stringify(process.argv.slice(2)));",
      ''
    ].join('\n'), 'utf8');
    const created = await createOrRefreshMcpLauncher({
      ...item.input,
      extensionRoot: join(item.root, 'extension'),
      mcpPath: fakeBundle
    });
    const command = process.env.ComSpec ?? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe');
    const capture = join(item.root, 'capture.json');
    await execFileAsync(command, ['/d', '/c', 'call', created.launcherPath, '--probe', '含 空格'], {
      env: { ...process.env, YMAI_CAPTURE: capture, YMAI_MCP_PROFILE: 'scene' },
      encoding: 'utf8'
    });
    expect(JSON.parse(await readFile(capture, 'utf8'))).toEqual([
      '--launcher-manifest',
      created.manifestPath,
      '--project',
      item.projectRoot,
      '--profile',
      'full',
      '--probe',
      '含 空格'
    ]);

    await writeFile(fakeBundle, "require('node:fs').writeFileSync(process.env.YMAI_CAPTURE, 'unsafe');\n", 'utf8');
    await expect(execFileAsync(command, ['/d', '/c', 'call', created.launcherPath], {
      env: { ...process.env, YMAI_CAPTURE: capture },
      encoding: 'utf8'
    })).rejects.toMatchObject({ code: 6 });
    expect(await readFile(capture, 'utf8')).not.toBe('unsafe');
  });

  it('pins a configured compact profile in the project-local launcher', async () => {
    const item = await fixture();
    const fakeBundle = join(item.root, 'extension', 'out', 'mcp.cjs');
    await mkdir(join(item.root, 'extension', 'out'), { recursive: true });
    await writeFile(fakeBundle, [
      "require('node:fs').writeFileSync(process.env.YMAI_CAPTURE, JSON.stringify(process.argv.slice(2)));",
      ''
    ].join('\n'), 'utf8');
    const created = await createOrRefreshMcpLauncher({
      ...item.input,
      extensionRoot: join(item.root, 'extension'),
      mcpPath: fakeBundle,
      toolProfile: 'workflow'
    });
    const command = process.env.ComSpec ?? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe');
    const capture = join(item.root, 'profile-capture.json');
    await execFileAsync(command, ['/d', '/c', 'call', created.launcherPath], {
      env: { ...process.env, YMAI_CAPTURE: capture },
      encoding: 'utf8'
    });
    expect(JSON.parse(await readFile(capture, 'utf8'))).toEqual([
      '--launcher-manifest',
      created.manifestPath,
      '--project',
      item.projectRoot,
      '--profile',
      'workflow'
    ]);
  });

  it('starts the real stdio MCP server through the validated launcher', async () => {
    const item = await fixture();
    const created = await createOrRefreshMcpLauncher(item.input);
    const command = process.env.ComSpec ?? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe');
    const transport = new StdioClientTransport({
      command,
      args: ['/d', '/c', 'call', created.launcherPath],
      cwd: item.projectRoot,
      stderr: 'pipe'
    });
    let stderr = '';
    transport.stderr?.on('data', (chunk) => { stderr += String(chunk); });
    const client = new Client({ name: 'validated-launcher-test', version: '1.0.0' });
    try {
      await client.connect(transport);
    } catch (error) {
      throw new Error(`validated launcher connection failed: ${stderr}`, { cause: error });
    }
    try {
      expect((await client.listTools()).tools).toHaveLength(42);
      expect((await client.callTool({ name: 'yuanmeng_project_status', arguments: {} })).structuredContent)
        .toMatchObject({ project: { projectInstanceId: PROJECT_ID } });
      expect(stderr).not.toContain('缺少或不支持 CLI 命令');
    } finally {
      await client.close();
    }
  });

  it('carries the configured workflow profile through the real stdio launcher', async () => {
    const item = await fixture();
    const created = await createOrRefreshMcpLauncher({ ...item.input, toolProfile: 'workflow' });
    const command = process.env.ComSpec ?? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe');
    const transport = new StdioClientTransport({
      command,
      args: ['/d', '/c', 'call', created.launcherPath],
      cwd: item.projectRoot,
      stderr: 'pipe'
    });
    const client = new Client({ name: 'validated-workflow-launcher-test', version: '1.0.0' });
    try {
      await client.connect(transport);
      expect((await client.listTools()).tools).toHaveLength(toolsForMcpProfile('workflow').length);
      expect((await client.listResources()).resources).toHaveLength(resourcesForMcpProfile('workflow').length);
      expect((await client.listPrompts()).prompts).toHaveLength(promptsForMcpProfile('workflow').length);
    } finally {
      await client.close().catch(() => undefined);
    }
  });
});
