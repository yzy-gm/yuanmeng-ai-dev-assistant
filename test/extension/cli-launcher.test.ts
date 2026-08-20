import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import * as vscode from 'vscode';

import type { ExtensionTestCase } from './index.js';
import { sha256Hex } from '../../src/core/hash.js';

function normalizedRoot(path: string): string {
  const value = path.replace(/\\/gu, '/').replace(/\/+$/u, '');
  return /^[A-Za-z]:/u.test(value) ? `${value[0]!.toLowerCase()}${value.slice(1)}` : value;
}

const execFileAsync = promisify(execFile);

async function runLauncher(
  launcherPath: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const commandInterpreter = process.env.ComSpec ?? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe');
  try {
    const result = await execFileAsync(commandInterpreter, ['/d', '/c', 'call', launcherPath, ...args], {
      encoding: 'utf8',
      env: environment,
    });
    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failure = error as { code: number; stdout: string; stderr: string };
    return { exitCode: failure.code, stdout: failure.stdout, stderr: failure.stderr };
  }
}

interface LauncherResult {
  manifestPath: string;
  launcherPath: string;
  changed: boolean;
}

interface LauncherApi {
  createOrRefreshCliLauncher(input: {
    projectRoot: string;
    projectInstanceId: string;
    projectRootHash: string;
    extensionRoot: string;
    extensionVersion: string;
    cliPath: string;
    generatedAt: string;
  }): Promise<LauncherResult>;
}

export const cliLauncherTests: ExtensionTestCase[] = [{
  name: 'CLI launcher creates and byte-stably refreshes Chinese and spaced paths',
  run: async () => {
    assert.equal(process.platform, 'win32');
    const temporaryRoot = process.env.YMAI_EXTENSION_TEST_TEMP;
    assert.ok(temporaryRoot);
    const projectRoot = join(temporaryRoot, '启动器 工程');
    const extensionRoot = join(temporaryRoot, '扩展 安装 v1');
    const cliPath = join(extensionRoot, 'out', 'cli.cjs');
    await mkdir(join(projectRoot, 'src'), { recursive: true });
    await mkdir(join(extensionRoot, 'out'), { recursive: true });
    await writeFile(join(projectRoot, 'src', 'GameEntry.lua'), 'return {}\n', 'utf8');
    await writeFile(cliPath, [
      "const fs = require('node:fs');",
      "if (process.env.YMAI_CAPTURE) fs.writeFileSync(process.env.YMAI_CAPTURE, JSON.stringify(process.argv.slice(2)));",
      'process.exitCode = 0;',
      '',
    ].join('\n'), 'utf8');

    const projectRootHash = sha256Hex(normalizedRoot(projectRoot));
    await mkdir(join(projectRoot, '.yuanmeng-inspector'), { recursive: true });
    await writeFile(join(projectRoot, '.yuanmeng-inspector', 'meta.json'), JSON.stringify({
      schemaVersion: 1,
      projectInstanceId: '00000000-0000-4000-8000-000000000801',
      projectRootHash,
    }), 'utf8');
    const input = {
      projectRoot,
      projectInstanceId: '00000000-0000-4000-8000-000000000801',
      projectRootHash,
      extensionRoot,
      extensionVersion: '0.1.0',
      cliPath,
      generatedAt: '2026-08-20T00:00:00.000Z',
    } as const;
    const extension = vscode.extensions.getExtension<LauncherApi>('bujianxingguang.yuanmeng-ai-dev-assistant');
    assert.ok(extension);
    const api = await extension.activate();
    assert.ok(api?.createOrRefreshCliLauncher);
    const first = await api.createOrRefreshCliLauncher(input);
    const manifestBytes = await readFile(first.manifestPath);
    const launcherBytes = await readFile(first.launcherPath);
    const second = await api.createOrRefreshCliLauncher({ ...input, generatedAt: '2026-08-20T01:00:00.000Z' });

    assert.equal(first.changed, true);
    assert.equal(second.changed, false);
    assert.deepEqual(await readFile(second.manifestPath), manifestBytes);
    assert.deepEqual(await readFile(second.launcherPath), launcherBytes);
    const launcher = launcherBytes.toString('utf8');
    assert.ok(launcher.includes('Get-FileHash'));
    assert.ok(!launcher.includes('Invoke-Expression'));

    const capture = join(temporaryRoot, 'forwarded.json');
    const success = await runLauncher(first.launcherPath, ['find-ui', '经验 值', '--json'], {
      ...process.env,
      YMAI_CAPTURE: capture,
    });
    assert.equal(success.exitCode, 0, success.stderr);
    assert.deepEqual(JSON.parse(await readFile(capture, 'utf8')), [
      '--launcher-manifest',
      first.manifestPath,
      '--project',
      projectRoot,
      'find-ui',
      '经验 值',
      '--json',
    ]);

    const relocatedRoot = join(temporaryRoot, '扩展 安装 v2');
    const relocatedCli = join(relocatedRoot, 'out', 'cli.cjs');
    await mkdir(join(relocatedRoot, 'out'), { recursive: true });
    await writeFile(relocatedCli, await readFile(cliPath));
    const relocated = await api.createOrRefreshCliLauncher({
      ...input,
      extensionRoot: relocatedRoot,
      extensionVersion: '0.2.0',
      cliPath: relocatedCli,
      generatedAt: '2026-08-20T02:00:00.000Z',
    });
    const relocatedManifest = JSON.parse(await readFile(relocated.manifestPath, 'utf8')) as Record<string, unknown>;
    assert.equal(relocated.changed, true);
    assert.equal(relocatedManifest.extensionVersion, '0.2.0');
    assert.equal(relocatedManifest.cliPath, relocatedCli);

    const installedCatalog = join(dirname(relocatedRoot), 'extensions.json');
    await writeFile(installedCatalog, JSON.stringify([{
      identifier: { id: 'bujianxingguang.yuanmeng-ai-dev-assistant' },
      version: '0.2.0',
    }]), 'utf8');
    const catalogSuccess = await runLauncher(relocated.launcherPath, ['status']);
    assert.equal(catalogSuccess.exitCode, 0, catalogSuccess.stderr);
    await writeFile(installedCatalog, '[]', 'utf8');
    const removedFromCatalog = await runLauncher(relocated.launcherPath, ['status']);
    assert.equal(removedFromCatalog.exitCode, 2);
    assert.match(removedFromCatalog.stderr, /元梦 AI 开发助手已卸载或安装路径失效/u);
    await rm(installedCatalog, { force: true });

    const missingNode = await runLauncher(relocated.launcherPath, ['status'], {
      ...process.env,
      PATH: join(temporaryRoot, 'empty-path'),
    });
    assert.equal(missingNode.exitCode, 2);
    assert.match(missingNode.stderr, /未找到 Node\.js 20/u);

    const fakeNodeRoot = join(temporaryRoot, 'fake-node');
    await mkdir(fakeNodeRoot, { recursive: true });
    await writeFile(join(fakeNodeRoot, 'node.cmd'), [
      '@echo off',
      'if "%~1"=="--version" (echo v18.19.0& exit /b 0)',
      'if not "%YMAI_NODE_MARKER%"=="" echo invoked>"%YMAI_NODE_MARKER%"',
      'exit /b 0',
      '',
    ].join('\r\n'), 'utf8');
    const belowNode = await runLauncher(relocated.launcherPath, ['status'], {
      ...process.env,
      PATH: fakeNodeRoot,
    });
    assert.equal(belowNode.exitCode, 2);
    assert.match(belowNode.stderr, /需要 Node\.js 20/u);

    const marker = join(temporaryRoot, 'node-invoked.txt');
    const removedCli = `${relocatedCli}.removed`;
    await rename(relocatedCli, removedCli);
    const missingCli = await runLauncher(relocated.launcherPath, ['status'], {
      ...process.env,
      PATH: fakeNodeRoot,
      YMAI_NODE_MARKER: marker,
    });
    assert.equal(missingCli.exitCode, 2);
    assert.match(missingCli.stderr, /元梦 AI 开发助手已卸载或安装路径失效/u);
    await assert.rejects(readFile(marker), { code: 'ENOENT' });
    await rename(removedCli, relocatedCli);

    await writeFile(relocatedCli, "require('node:fs').writeFileSync(process.env.YMAI_NODE_MARKER, 'unsafe');\n", 'utf8');
    const hashMismatch = await runLauncher(relocated.launcherPath, ['status'], {
      ...process.env,
      YMAI_NODE_MARKER: marker,
    });
    assert.equal(hashMismatch.exitCode, 6);
    await assert.rejects(readFile(marker), { code: 'ENOENT' });
    await writeFile(relocatedCli, await readFile(cliPath));

    const manifest = JSON.parse(await readFile(relocated.manifestPath, 'utf8')) as Record<string, unknown>;
    const outsideCli = join(temporaryRoot, 'outside', 'cli.cjs');
    await mkdir(join(temporaryRoot, 'outside'), { recursive: true });
    await writeFile(outsideCli, await readFile(cliPath));
    manifest.cliPath = outsideCli;
    await writeFile(relocated.manifestPath, JSON.stringify(manifest), 'utf8');
    const outsideTarget = await runLauncher(relocated.launcherPath, ['status']);
    assert.equal(outsideTarget.exitCode, 6);

    await api.createOrRefreshCliLauncher({
      ...input,
      extensionRoot: relocatedRoot,
      extensionVersion: '0.2.0',
      cliPath: relocatedCli,
      generatedAt: '2026-08-20T03:00:00.000Z',
    });
    await writeFile(join(projectRoot, '.yuanmeng-inspector', 'meta.json'), JSON.stringify({
      schemaVersion: 1,
      projectInstanceId: '00000000-0000-4000-8000-000000000899',
      projectRootHash,
    }), 'utf8');
    const projectMismatch = await runLauncher(relocated.launcherPath, ['status']);
    assert.equal(projectMismatch.exitCode, 6);

    await assert.rejects(api.createOrRefreshCliLauncher({
      ...input,
      extensionRoot: relocatedRoot,
      cliPath: outsideCli,
      extensionVersion: '0.2.0',
    }), (error: unknown) => (error as { code?: string }).code === 'VALIDATION_FAILED');
    await rm(marker, { force: true });
  },
}];
