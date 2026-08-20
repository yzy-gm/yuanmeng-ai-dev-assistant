import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const repoRoot = resolve(import.meta.dirname, '..', '..');

interface PreflightResult {
  schemaVersion: 1;
  ok: boolean;
  code: string;
  extensionId?: string;
  externalTargetVerified?: boolean;
  message?: string;
}

const validManifest = {
  name: 'yuanmeng-ai-dev-assistant',
  displayName: '元梦 AI 开发助手',
  description: '由不见星光开发，为《元梦之星》创作者提供本地 UI、ID、Lua 与 API 检查能力的 VS Code 伴随工具。',
  version: '0.1.0',
  private: true,
  publisher: 'bujianxingguang',
  author: '不见星光',
  license: 'UNLICENSED',
  pricing: 'Free',
  categories: ['Linters', 'Other'],
  keywords: ['元梦之星', '元梦', '开发助手', 'Lua', 'UI', 'Yuanmeng', 'UGC', 'AI'],
  engines: { vscode: '^1.70.0', node: '>=20' },
  main: './out/extension.cjs',
  icon: 'media/yuanmeng-ai.png',
};

async function runPreflight(args: readonly string[]): Promise<{
  code: number;
  stdout: string;
  stderr: string;
  result: PreflightResult | null;
}> {
  try {
    const output = await execFileAsync(
      process.execPath,
      ['scripts/public-release-preflight.mjs', ...args, '--json'],
      { cwd: repoRoot, encoding: 'utf8' },
    );
    return {
      code: 0,
      stdout: output.stdout,
      stderr: output.stderr,
      result: JSON.parse(output.stdout) as PreflightResult,
    };
  } catch (error) {
    const failure = error as { code: number; stdout: string; stderr: string };
    return {
      code: failure.code,
      stdout: failure.stdout,
      stderr: failure.stderr,
      result: failure.stdout === '' ? null : JSON.parse(failure.stdout) as PreflightResult,
    };
  }
}

async function initializeRepository(root: string): Promise<void> {
  await execFileAsync('git', ['init', '-b', 'main'], { cwd: root, encoding: 'utf8' });
  await execFileAsync('git', ['config', 'user.name', 'Fixture Author'], { cwd: root, encoding: 'utf8' });
  await execFileAsync('git', ['config', 'user.email', 'fixture@example.invalid'], { cwd: root, encoding: 'utf8' });
  await writeFile(join(root, 'README.md'), '# Anonymous fixture\n', 'utf8');
  await writeFile(join(root, '.gitignore'), 'work/\noutputs/\n', 'utf8');
  await mkdir(join(root, 'test', 'fixtures', 'property'), { recursive: true });
  await writeFile(
    join(root, 'test', 'fixtures', 'property', 'anonymous-property.txt'),
    'return { Enabled = true }\n',
    'utf8',
  );
  await execFileAsync('git', ['add', 'README.md', '.gitignore', 'test/fixtures/property/anonymous-property.txt'], { cwd: root, encoding: 'utf8' });
  await execFileAsync('git', ['commit', '-m', 'fixture'], { cwd: root, encoding: 'utf8' });
}

describe('public release preflight', () => {
  it('accepts the reviewed public Marketplace identity while keeping npm publication disabled', async () => {
    const checked = await runPreflight(['--manifest', 'package.json']);
    expect(checked.code).toBe(0);
    expect(checked.stderr).toBe('');
    expect(checked.result).toMatchObject({
      schemaVersion: 1,
      ok: true,
      code: 'PUBLIC_RELEASE_PREFLIGHT_OK',
      extensionId: 'bujianxingguang.yuanmeng-ai-dev-assistant',
      externalTargetVerified: false,
    });
    const manifest = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8')) as {
      author?: unknown;
      description?: unknown;
    };
    expect(manifest.author).toBe('不见星光');
    expect(manifest.description).toBe(validManifest.description);
    expect(JSON.stringify(manifest)).not.toContain('yuanmeng-local');
  });

  it('rejects a manifest whose public author identity is not exact', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ymai-public-manifest-'));
    try {
      await writeFile(join(root, 'package.json'), JSON.stringify({
        ...validManifest,
        author: { name: 'another-author' },
      }), 'utf8');
      const checked = await runPreflight(['--manifest', join(root, 'package.json')]);
      expect(checked.code).toBe(1);
      expect(checked.stderr).toBe('');
      expect(checked.result).toMatchObject({
        ok: false,
        code: 'PUBLIC_RELEASE_MANIFEST_INVALID',
      });
      expect(checked.stdout).not.toContain(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects private GitHub visibility and an existing mismatched origin', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ymai-public-origin-'));
    try {
      await writeFile(join(root, 'package.json'), JSON.stringify(validManifest), 'utf8');
      await execFileAsync('git', ['init'], { cwd: root, encoding: 'utf8' });
      await execFileAsync('git', ['remote', 'add', 'origin', 'https://github.com/example/wrong.git'], { cwd: root, encoding: 'utf8' });

      const privateTarget = await runPreflight([
        '--manifest', join(root, 'package.json'),
        '--github-visibility', 'PRIVATE',
      ]);
      expect(privateTarget.code).toBe(1);
      expect(privateTarget.result).toMatchObject({ code: 'GITHUB_TARGET_NOT_PUBLIC' });

      const mismatch = await runPreflight([
        '--manifest', join(root, 'package.json'),
        '--repository', root,
        '--expected-origin', 'https://github.com/example/yuanmeng-ai-dev-assistant.git',
        '--github-visibility', 'PUBLIC',
      ]);
      expect(mismatch.code).toBe(1);
      expect(mismatch.stderr).toBe('');
      expect(mismatch.result).toMatchObject({ code: 'ORIGIN_MISMATCH' });
      expect(mismatch.stdout).not.toContain(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects a missing or invalid VSIX instead of treating it as publishable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ymai-public-vsix-'));
    try {
      const missing = await runPreflight([
        '--manifest', 'package.json',
        '--vsix', join(root, 'missing.vsix'),
      ]);
      expect(missing.code).toBe(1);
      expect(missing.result).toMatchObject({ code: 'VSIX_REJECTED' });

      const invalidPath = join(root, 'invalid.vsix');
      await writeFile(invalidPath, 'not a zip', 'utf8');
      const invalid = await runPreflight(['--manifest', 'package.json', '--vsix', invalidPath]);
      expect(invalid.code).toBe(1);
      expect(invalid.result).toMatchObject({ code: 'VSIX_REJECTED' });
      expect(`${invalid.stdout}${invalid.stderr}`).not.toContain(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects credential-like command arguments without echoing their values', async () => {
    const secret = 'marketplace-secret-value-123456';
    const checked = await runPreflight(['--manifest', 'package.json', '--pat', secret]);
    expect(checked.code).toBe(2);
    expect(checked.result).toMatchObject({ code: 'SENSITIVE_ARGUMENT_REJECTED' });
    expect(`${checked.stdout}${checked.stderr}`).not.toContain(secret);
  });

  it('exports only the clean current tree into a one-commit public repository', async () => {
    const source = await mkdtemp(join(tmpdir(), 'ymai-public-source-'));
    const destination = join(source, 'work', 'public-release-repository');
    try {
      await initializeRepository(source);
      await mkdir(join(source, 'work'), { recursive: true });
      await writeFile(join(source, 'work', 'ignored-private-data.txt'), 'ignored', 'utf8');

      const output = await execFileAsync(process.execPath, [
        join(repoRoot, 'scripts', 'export-public-repository.mjs'),
        '--source', source,
        '--destination', destination,
        '--json',
      ], { cwd: repoRoot, encoding: 'utf8' });
      const result = JSON.parse(output.stdout) as {
        ok: boolean;
        code: string;
        commitCount: number;
        trackedFileCount: number;
      };
      expect(output.stderr).toBe('');
      expect(result).toMatchObject({
        ok: true,
        code: 'PUBLIC_EXPORT_READY',
        commitCount: 1,
        trackedFileCount: 3,
      });
      expect(await readFile(join(destination, 'README.md'), 'utf8')).toBe('# Anonymous fixture\n');
      expect(await readFile(
        join(destination, 'test', 'fixtures', 'property', 'anonymous-property.txt'),
        'utf8',
      )).toBe('return { Enabled = true }\n');
      await expect(readFile(join(destination, 'work', 'ignored-private-data.txt'), 'utf8')).rejects.toThrow();
      expect((await execFileAsync('git', ['status', '--porcelain'], { cwd: destination, encoding: 'utf8' })).stdout).toBe('');
      expect((await execFileAsync('git', ['rev-list', '--count', 'HEAD'], { cwd: destination, encoding: 'utf8' })).stdout.trim()).toBe('1');
    } finally {
      await rm(source, { recursive: true, force: true });
    }
  }, 30_000);

  it('rejects raw official-shaped data even when it is placed under test fixtures', async () => {
    const source = await mkdtemp(join(tmpdir(), 'ymai-public-dangerous-fixture-'));
    try {
      await initializeRepository(source);
      const dangerous = join(source, 'test', 'fixtures', 'property', 'CustomProperty_9_9.lua');
      await writeFile(dangerous, 'return { Secret = 9 }\n', 'utf8');
      await execFileAsync('git', ['add', '-f', 'test/fixtures/property/CustomProperty_9_9.lua'], { cwd: source, encoding: 'utf8' });
      await execFileAsync('git', ['commit', '-m', 'dangerous fixture'], { cwd: source, encoding: 'utf8' });
      await expect(execFileAsync(process.execPath, [
        join(repoRoot, 'scripts', 'export-public-repository.mjs'),
        '--source', source,
        '--destination', join(source, 'work', 'public-release-repository'),
      ], { cwd: repoRoot, encoding: 'utf8' })).rejects.toMatchObject({ code: 1 });
    } finally {
      await rm(source, { recursive: true, force: true });
    }
  });

  it('refuses a dirty source or a destination outside the source work directory', async () => {
    const source = await mkdtemp(join(tmpdir(), 'ymai-public-refusal-'));
    const outside = await mkdtemp(join(tmpdir(), 'ymai-public-outside-'));
    try {
      await initializeRepository(source);
      await writeFile(join(source, 'README.md'), '# Dirty fixture\n', 'utf8');

      await expect(execFileAsync(process.execPath, [
        join(repoRoot, 'scripts', 'export-public-repository.mjs'),
        '--source', source,
        '--destination', join(source, 'work', 'public-release-repository'),
      ], { cwd: repoRoot, encoding: 'utf8' })).rejects.toMatchObject({ code: 1 });

      await execFileAsync('git', ['restore', 'README.md'], { cwd: source, encoding: 'utf8' });
      await expect(execFileAsync(process.execPath, [
        join(repoRoot, 'scripts', 'export-public-repository.mjs'),
        '--source', source,
        '--destination', outside,
      ], { cwd: repoRoot, encoding: 'utf8' })).rejects.toMatchObject({ code: 1 });
    } finally {
      await rm(source, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('requires final Marketplace publisher, public GitHub identity, reviewed VSIX and matching origin', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ymai-final-marketplace-'));
    try {
      const releaseManifest = {
        ...validManifest,
        repository: { type: 'git', url: 'https://github.com/fixture-owner/yuanmeng-ai-dev-assistant.git' },
        homepage: 'https://github.com/fixture-owner/yuanmeng-ai-dev-assistant#readme',
        bugs: { url: 'https://github.com/fixture-owner/yuanmeng-ai-dev-assistant/issues' },
      };
      await writeFile(join(root, 'package.json'), JSON.stringify(releaseManifest), 'utf8');
      await execFileAsync('git', ['init', '-b', 'main'], { cwd: root, encoding: 'utf8' });
      await execFileAsync('git', ['remote', 'add', 'origin', 'https://github.com/fixture-owner/yuanmeng-ai-dev-assistant.git'], { cwd: root, encoding: 'utf8' });

      const missingConfirmation = await runPreflight([
        '--manifest', join(root, 'package.json'),
        '--final-marketplace',
      ]);
      expect(missingConfirmation.code).toBe(1);
      expect(missingConfirmation.result).toMatchObject({ code: 'PUBLISHER_NOT_CONFIRMED' });

      const missingExternalEvidence = await runPreflight([
        '--manifest', join(root, 'package.json'),
        '--final-marketplace',
        '--publisher-confirmed',
      ]);
      expect(missingExternalEvidence.code).toBe(1);
      expect(missingExternalEvidence.result).toMatchObject({ code: 'FINAL_RELEASE_EVIDENCE_MISSING' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps Marketplace assets, legal notice and package exclusions release-ready', async () => {
    const manifest = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8')) as {
      icon?: string;
      scripts?: Record<string, string>;
    };
    expect(manifest.icon).toBe('media/yuanmeng-ai.png');
    expect(manifest.scripts?.['package:vsix']).not.toContain('--skip-license');
    expect(manifest.scripts?.['package:release']).not.toContain('--allow-missing-repository');

    const icon = await readFile(join(repoRoot, 'media', 'yuanmeng-ai.png'));
    expect(icon.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(icon.readUInt32BE(16)).toBeGreaterThanOrEqual(128);
    expect(icon.readUInt32BE(20)).toBeGreaterThanOrEqual(128);

    const license = await readFile(join(repoRoot, 'LICENSE'), 'utf8');
    expect(license).toContain('All rights reserved');
    expect(license).toContain('不见星光');
    const ignore = await readFile(join(repoRoot, '.vscodeignore'), 'utf8');
    expect(ignore).toMatch(/^\.gitignore$/mu);
    expect(ignore).toMatch(/^docs\/\*\*$/mu);

    const readme = await readFile(join(repoRoot, 'README.md'), 'utf8');
    expect(readme.slice(0, 800)).toContain('**作者：不见星光**');
    expect(readme.slice(0, 800)).toContain('并非腾讯或《元梦之星》官方产品');
    const notice = await readFile(join(repoRoot, 'NOTICE.md'), 'utf8');
    expect(notice).toContain('与腾讯不存在隶属或授权关系');
    const commands = JSON.parse(await readFile(join(repoRoot, 'package.nls.json'), 'utf8')) as Record<string, string>;
    expect(commands['command.buildScripts']).toContain('实验性（真实编辑器未验收）');
    expect(commands['command.pushPropertyLiteral']).toContain('实验性（真实编辑器未验收）');
  });
});
