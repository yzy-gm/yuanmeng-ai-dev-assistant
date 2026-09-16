import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

import { afterEach, describe, expect, it } from 'vitest';

const directories: string[] = [];
async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'ymai-private-release-'));
  directories.push(directory);
  return directory;
}
afterEach(async () => Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

async function run(script: string, args: string[] = []): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

describe('public MIT release policy', () => {
  it('exports all runtime sources without repository history or private evidence and refuses overwrite', async () => {
    const destination = join(await temporaryDirectory(), 'source');
    const output = await run('scripts/export-public-repository.mjs', ['--json', '--destination', destination]);
    expect(output.code, output.stdout + output.stderr).toBe(0);
    await expect(access(join(destination, 'src/mcp/server.ts'))).resolves.toBeUndefined();
    await expect(access(join(destination, 'src/core/official/zip-reader.ts'))).resolves.toBeUndefined();
    await expect(access(join(destination, '.git'))).rejects.toThrow();
    await expect(access(join(destination, 'docs/acceptance'))).rejects.toThrow();
    await expect(access(join(destination, 'outputs'))).rejects.toThrow();
    await expect(access(join(destination, 'test/fixtures/source-project/.yuanmeng-inspector'))).rejects.toThrow();
    const repeat = await run('scripts/export-public-repository.mjs', ['--json', '--destination', destination]);
    expect(repeat.code).toBe(1);
    expect(JSON.parse(repeat.stdout).code).toBe('DESTINATION_EXISTS');
  }, 30000);

  it('preserves the Marketplace identity and exposes an MIT stable release', async () => {
    const manifest = JSON.parse(await readFile('package.json', 'utf8')) as {
      publisher?: string; name?: string; license?: string; version?: string; repository?: unknown; scripts?: Record<string, string>;
    };
    expect(`${manifest.publisher}.${manifest.name}`).toBe('bujianxingguang.yuanmeng-ai-dev-assistant');
    expect(manifest.version).toBe('0.6.0');
    expect(manifest.license).toBe('MIT');
    expect(manifest.repository).toBeDefined();
    expect(manifest.scripts?.['package:vsix']).toContain('package-public-release');
    expect(await readFile('LICENSE', 'utf8')).toContain('Permission is hereby granted');
  });
});
