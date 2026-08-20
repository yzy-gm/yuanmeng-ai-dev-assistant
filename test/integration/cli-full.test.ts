import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { beforeAll, describe, expect, it } from 'vitest';

import { buildUiSnapshot } from '../../src/core/ui/index.js';
import type { InspectorStatus, RegistryDocument } from '../../src/core/model.js';
import { sha256Hex } from '../../src/core/hash.js';
import { createOrRefreshCliLauncher } from '../../src/extension/cli-launcher.js';

const execFileAsync = promisify(execFile);
const repoRoot = resolve(import.meta.dirname, '..', '..');
const cliPath = join(repoRoot, 'out', 'cli.cjs');
const projectId = '00000000-0000-4000-8000-000000000910';

async function cli(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync(process.execPath, [cliPath, ...argv], { cwd: repoRoot, env, encoding: 'utf8' });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failed = error as { code: number; stdout: string; stderr: string };
    return { code: failed.code, stdout: failed.stdout, stderr: failed.stderr };
  }
}

async function fixture(): Promise<{ root: string; extensionPath: string; snapshotIds: [string, string]; projectRootHash: string }> {
  const root = await mkdtemp(join(tmpdir(), 'ymai-cli-full-中文-'));
  await mkdir(join(root, 'src'), { recursive: true });
  await mkdir(join(root, '.yuanmeng-inspector', 'ui', 'snapshots'), { recursive: true });
  await writeFile(join(root, 'src', 'GameEntry.lua'), 'return {}\n', 'utf8');
  await writeFile(join(root, 'src', 'Use.lua'), 'UI:SetText(101, "ready")\n', 'utf8');
  const canonical = (await realpath(root)).replace(/\\/gu, '/').replace(/\/+/gu, '/').replace(/^([A-Z]):/u, (_match, drive: string) => `${drive.toLowerCase()}:`).replace(/\/$/u, '');
  const rootHash = sha256Hex(canonical);
  await writeFile(join(root, '.yuanmeng-inspector', 'meta.json'), JSON.stringify({ schemaVersion: 1, projectInstanceId: projectId, projectRootHash: rootHash }), 'utf8');
  const base = {
    schemaVersion: 1 as const,
    project: { schemaVersion: 1 as const, projectInstanceId: projectId, projectRootHash: rootHash, hasSrc: true, hasGameEntry: true, mapFingerprint: null, mapName: null, currentLayerId: null, layers: [] },
    officialCommands: { refreshUi: true }, link: { state: 'online' as const, reasonCode: 'OK', lastProbeAt: '2026-08-20T00:00:00.000Z' },
    ui: { freshness: 'fresh' as const, lastRefreshAt: '2026-08-20T00:00:00.000Z', sourceHashes: {}, reasonCodes: [] }, issueCounts: { error: 0, warning: 0, info: 0 },
  } satisfies InspectorStatus;
  await writeFile(join(root, '.yuanmeng-inspector', 'status.json'), JSON.stringify(base), 'utf8');
  const records: RegistryDocument = { schemaVersion: 1, records: [{
    recordId: 'ui-101', kind: 'ui-control', name: 'Ready', value: '101', scope: 'workspace', projectInstanceId: projectId, mapFingerprint: null, layerId: null, environment: 'test', validity: 'confirmed',
    source: { kind: 'user-entry', relativePath: null, sha256: 'a'.repeat(64), observedAt: '2026-08-20T00:00:00.000Z', officialExtensionVersion: null, evidence: 'UNIT_E2E' }, lastConfirmedAt: '2026-08-20T00:00:00.000Z', notes: '',
  }] };
  await mkdir(join(root, '.yuanmeng-inspector', 'registry'), { recursive: true });
  await writeFile(join(root, '.yuanmeng-inspector', 'registry', 'registry.json'), JSON.stringify(records), 'utf8');
  const ids: [string, string] = ['', ''];
  for (const [index, name] of ['Ready', 'Ready Again'].entries()) {
    const snapshot = buildUiSnapshot({ createdAt: `2026-08-20T00:00:0${index}.000Z`, projectInstanceId: projectId, mapFingerprint: null, sources: [], nodes: [{ id: '101', name, type: 'unknown', parentId: null, path: `/${name}`, depth: 0, siblingIndex: 0, sourceFile: 'src/Data/CustomUIData2.lua', sourceRange: null }] });
    ids[index] = snapshot.snapshotId;
    await writeFile(join(root, '.yuanmeng-inspector', 'ui', 'current.json'), JSON.stringify(snapshot), 'utf8');
    await writeFile(join(root, '.yuanmeng-inspector', 'ui', 'snapshots', `${snapshot.snapshotId}.json`), JSON.stringify(snapshot), 'utf8');
  }
  const extensionRoot = await mkdtemp(join(tmpdir(), 'ymai-cli-full-api-'));
  const extensionPath = join(extensionRoot, 'fixture.official-1.2.3');
  await mkdir(join(extensionPath, 'res', 'lib'), { recursive: true });
  await writeFile(join(extensionPath, 'package.json'), JSON.stringify({ name: 'official', publisher: 'fixture', version: '1.2.3', contributes: { commands: [{ command: 'dreamhelper.GetCustomUIData' }] } }), 'utf8');
  await writeFile(join(extensionPath, 'res', 'lib', 'UI.d.lua'), await readFile(join(repoRoot, 'test', 'fixtures', 'api', 'UI.d.lua')), 'utf8');
  return { root, extensionPath, snapshotIds: ids, projectRootHash: rootHash };
}

beforeAll(async () => { await execFileAsync(process.execPath, [join(repoRoot, 'esbuild.mjs')], { cwd: repoRoot }); });

describe('complete CLI acceptance table', () => {
  it('runs mandatory commands in JSON and human modes with isolated paths and filters', async () => {
    const item = await fixture();
    try {
      const env = { ...process.env, VSCODE_EXTENSIONS: resolve(item.extensionPath, '..') };
      delete env.YMAI_OFFICIAL_EXTENSION_PATH;
      const launcher = await createOrRefreshCliLauncher({
        projectRoot: item.root,
        projectInstanceId: projectId,
        projectRootHash: item.projectRootHash,
        extensionRoot: repoRoot,
        extensionVersion: '0.1.0',
        cliPath,
        generatedAt: '2026-08-20T00:00:00.000Z',
      });
      for (const args of [
        ['status'], ['find-ui', 'Ready Again'], ['list-ids', '--environment', 'test', '--validity', 'confirmed'],
        ['diff-ui', '--from', item.snapshotIds[0], '--to', item.snapshotIds[1]], ['where-used', '101'], ['api-search', 'GetUIName'], ['audit'],
      ]) {
        const result = await cli([...args, '--project', item.root, '--json'], env);
        expect(result.code, args.join(' ')).toBe(0);
        expect(result.stderr, args.join(' ')).toBe('');
        expect(JSON.parse(result.stdout).schemaVersion).toBe(1);
      }
      const exportPath = join(item.root, '清单.json');
      const exported = await cli(['export', 'ui', '--format', 'json', '--out', exportPath, '--project', item.root, '--json'], env);
      expect(exported.code).toBe(0);
      expect(JSON.parse(await readFile(exportPath, 'utf8')).schemaVersion).toBe(1);
      const human = await cli(['find-ui', 'Ready Again', '--project', item.root], env);
      expect(human.code).toBe(0);
      expect(human.stdout).toContain('Ready');
      expect(human.stdout).not.toContain(item.root);
      const launcherJson = await cliWithLauncher(launcher.launcherPath, ['status', '--json']);
      expect(launcherJson.code, launcherJson.stderr).toBe(0);
      expect(launcherJson.stderr).toBe('');
      expect(JSON.parse(launcherJson.stdout)).toMatchObject({ schemaVersion: 1, code: 'OK' });
      const launcherHuman = await cliWithLauncher(launcher.launcherPath, ['find-ui', 'Ready Again']);
      expect(launcherHuman.code, launcherHuman.stderr).toBe(0);
      expect(launcherHuman.stdout).toContain('Ready Again');
      expect(launcherHuman.stdout).not.toContain(item.root);
      const metaPath = join(item.root, '.yuanmeng-inspector', 'meta.json');
      const originalMeta = await readFile(metaPath, 'utf8');
      await writeFile(metaPath, JSON.stringify({ schemaVersion: 1, projectInstanceId: projectId, projectRootHash: 'f'.repeat(64) }), 'utf8');
      const bindingFailure = await cliWithLauncher(launcher.launcherPath, ['status', '--json']);
      expect(bindingFailure.code).toBe(6);
      expect(bindingFailure.stdout).toBe('');
      expect(bindingFailure.stderr).toMatch(/绑定|校验/u);
      expect(bindingFailure.stderr).not.toContain(item.root);
      await writeFile(metaPath, originalMeta, 'utf8');
      const refresh = await cli(['refresh-ui', '--project', item.root, '--json'], env);
      expect(refresh.code).toBe(2);
      const removedStatus = await cli(['list-ids', '--status', 'confirmed', '--project', item.root, '--json'], env);
      expect(removedStatus.code).toBe(7);
    } finally {
      await rm(item.root, { recursive: true, force: true });
      await rm(item.extensionPath, { recursive: true, force: true });
    }
  }, 60_000);
});

async function cliWithLauncher(path: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const commandInterpreter = process.env.ComSpec ?? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe');
    // `call` preserves .cmd semantics and lets Node quote each argument safely,
    // including the path with spaces/中文 and the multi-word UI name.
    const result = await execFileAsync(commandInterpreter, ['/d', '/c', 'call', path, ...args], { encoding: 'utf8' });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failed = error as { code: number; stdout: string; stderr: string };
    return { code: failed.code, stdout: failed.stdout, stderr: failed.stderr };
  }
}
