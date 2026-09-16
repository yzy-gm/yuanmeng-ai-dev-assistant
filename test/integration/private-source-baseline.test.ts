import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

import { createPrivateSourceBaseline } from '../../scripts/create-private-source-baseline.mjs';

describe('private source rollback baseline', () => {
  it('archives source and metadata without generated outputs, caches or environment secrets', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ymai-baseline-'));
    await mkdir(join(root, 'src'), { recursive: true });
    await mkdir(join(root, 'node_modules', 'pkg'), { recursive: true });
    await mkdir(join(root, 'outputs', 'private'), { recursive: true });
    await mkdir(join(root, '.yuanmeng-inspector'), { recursive: true });
    await writeFile(join(root, 'src', 'index.ts'), 'export const ready = true;\n', 'utf8');
    await writeFile(join(root, 'package.json'), JSON.stringify({ version: '0.6.0-private.1' }), 'utf8');
    await writeFile(join(root, '.env'), 'SECRET=never-archive\n', 'utf8');
    await writeFile(join(root, 'node_modules', 'pkg', 'index.js'), 'generated\n', 'utf8');
    await writeFile(join(root, '.yuanmeng-inspector', 'private.json'), '{}\n', 'utf8');

    const result = await createPrivateSourceBaseline({
      root,
      createdAt: '2026-08-24T01:02:03.000Z',
      gitHead: 'a'.repeat(40),
      gitBranch: 'codex/test',
    });

    const manifest = JSON.parse(await readFile(result.manifestPath, 'utf8')) as Record<string, unknown>;
    const listing = execFileSync('tar', ['-tf', result.archivePath], { encoding: 'utf8' }).replaceAll('\\', '/');
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      extensionVersion: '0.6.0-private.1',
      archiveSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      fileCount: 2,
    });
    expect(listing).toContain('src/index.ts');
    expect(listing).toContain('package.json');
    expect(listing).not.toContain('.env');
    expect(listing).not.toContain('node_modules');
    expect(listing).not.toContain('.yuanmeng-inspector');
    expect(listing).not.toContain('outputs/private');
  });
});
