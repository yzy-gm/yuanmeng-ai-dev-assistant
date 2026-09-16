import { access, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { runCli } from '../../src/cli/main.js';
import { normalizeCanonicalRoot } from '../../src/cli/project.js';
import { nodeFileIO } from '../../src/core/fs.js';
import { sha256Hex } from '../../src/core/hash.js';
import { SCENE_ADAPTER_ID } from '../../src/core/scene/normalize.js';
import { saveSceneSnapshot } from '../../src/core/scene/store.js';
import type { SceneSnapshot } from '../../src/core/scene/types.js';

const roots: string[] = [];

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function projectRoot(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `ymai-gameplay-auto-${name}-`));
  roots.push(root);
  await mkdir(join(root, 'src'), { recursive: true });
  await mkdir(join(root, '.yuanmeng-inspector'), { recursive: true });
  await writeFile(join(root, '.yuanmeng-inspector', 'meta.json'), JSON.stringify({
    schemaVersion: 1,
    projectInstanceId: '77777777-7777-4777-8777-777777777777',
    projectRootHash: sha256Hex(normalizeCanonicalRoot(await realpath(root))),
  }), 'utf8');
  return root;
}

function automaticSource(effect = 'Show'): string {
  return ['---@ymai-side server', 'System:RegisterEvent("auto.workflow", function()', `  UI:${effect}()`, 'end)'].join('\n');
}

async function hash(path: string): Promise<string> {
  return sha256Hex(await readFile(path, 'utf8'));
}

describe('automatic gameplay CLI', () => {
  it('prepares and simulates without any manually confirmed gameplay directory', async () => {
    const root = await projectRoot('basic');
    await writeFile(join(root, 'src', 'GameEntry.lua'), automaticSource(), 'utf8');

    const result = await runCli(['gameplay-test', '--json'], { cwd: root });
    expect(result.envelope).toMatchObject({
      ok: true,
      data: {
        mode: 'auto',
        runId: expect.any(String),
        classification: 'partial-needs-editor',
        simulationGate: 'pass',
        latestUpdated: true,
      },
    });
    const data = result.envelope.data as { runId: string; outputs: string[] };
    expect(data.outputs).toEqual([`.yuanmeng-inspector/gameplay/runs/${data.runId}`]);
    expect(JSON.parse(await readFile(join(root, '.yuanmeng-inspector', 'gameplay', 'latest.json'), 'utf8'))).toMatchObject({ runId: data.runId });
    await expect(access(join(root, 'gameplay', 'spec.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('runs a read-only automatic preview without creating a run or latest pointer', async () => {
    const root = await projectRoot('preview');
    const sourcePath = join(root, 'src', 'GameEntry.lua');
    const metaPath = join(root, '.yuanmeng-inspector', 'meta.json');
    await writeFile(sourcePath, automaticSource(), 'utf8');
    const protectedPaths = [sourcePath, metaPath];
    const before = await Promise.all(protectedPaths.map(hash));

    const result = await runCli(['gameplay-test', '--preview', '--json'], { cwd: root });
    expect(result.envelope).toMatchObject({
      ok: true,
      data: {
        mode: 'auto',
        preview: true,
        runId: null,
        classification: 'partial-needs-editor',
        simulationGate: 'pass',
        latestUpdated: false,
        outputs: [],
      },
    });
    expect(await Promise.all(protectedPaths.map(hash))).toEqual(before);
    await expect(access(join(root, '.yuanmeng-inspector', 'gameplay', 'latest.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(join(root, '.yuanmeng-inspector', 'gameplay', 'runs'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('ignores 43 unrelated trigger boxes and an unreachable broken backup, but blocks reachable syntax errors', async () => {
    const root = await projectRoot('scope');
    await writeFile(join(root, 'src', 'GameEntry.lua'), automaticSource(), 'utf8');
    await mkdir(join(root, 'src', 'Backup'), { recursive: true });
    await writeFile(join(root, 'src', 'Backup', 'Broken.lua'), 'local =', 'utf8');
    const evidence = { state: 'observed-repeatable' as const, source: 'anonymous-trigger-fixture', confidence: 0.9 };
    const snapshot: SceneSnapshot = {
      schemaVersion: 1, snapshotId: 'a'.repeat(64), bindingId: 'b'.repeat(64), role: 'raw-pbin',
      sourceSha256: 'c'.repeat(64), observedAt: '2026-08-26T00:00:00.000Z', adapterId: SCENE_ADAPTER_ID,
      instances: Array.from({ length: 43 }, (_, index) => ({
        instanceId: String(9000 + index), elementTypeId: '1105000000000087', ownerId: null,
        variant: 'component6-oneof-1' as const, evidence,
        transform: { state: 'absent' as const }, customProperties: { state: 'absent' as const },
        signals: { state: 'absent' as const }, resources: { state: 'absent' as const },
        bounds: { state: 'absent' as const }, unknownFields: [],
      })),
      groups: [], issues: [], unknownFields: [],
    };
    await saveSceneSnapshot(root, snapshot, nodeFileIO, { preferred: true });

    const unrelated = await runCli(['gameplay-test', '--json'], { cwd: root });
    expect(unrelated.envelope).toMatchObject({
      ok: true,
      data: { strictStaticGate: 'blocked', simulationGate: 'pass', classification: 'partial-needs-editor' },
    });

    await writeFile(join(root, 'src', 'GameEntry.lua'), 'local =', 'utf8');
    const reachable = await runCli(['gameplay-test', '--json'], { cwd: root });
    expect(reachable.envelope).toMatchObject({
      ok: false, code: 'VALIDATION_FAILED',
      data: { mode: 'auto', classification: 'not-run-fatal', simulationGate: 'blocked' },
    });
  });

  it('creates a new immutable run after evidence changes without modifying source or manual artifacts', async () => {
    const root = await projectRoot('immutable');
    const luaPath = join(root, 'src', 'GameEntry.lua');
    const uiPath = join(root, 'src', 'CustomUIData_fixture.lua');
    const manualSpec = join(root, 'gameplay', 'spec.json');
    const manualScenario = join(root, 'gameplay', 'scenarios', 'one.json');
    await writeFile(luaPath, automaticSource(), 'utf8');
    await writeFile(uiPath, 'return { safe = true }\n', 'utf8');
    await mkdir(join(root, 'gameplay', 'scenarios'), { recursive: true });
    await writeFile(manualSpec, '{"manual":true}\n', 'utf8');
    await writeFile(manualScenario, '{"manual":true}\n', 'utf8');
    const protectedPaths = [luaPath, uiPath, manualSpec, manualScenario];
    const before = await Promise.all(protectedPaths.map(hash));

    const first = await runCli(['gameplay-test', '--focus', '入口链', '--file', 'src/GameEntry.lua', '--json'], { cwd: root });
    const firstData = first.envelope.data as { runId: string };
    expect(await Promise.all(protectedPaths.map(hash))).toEqual(before);

    await writeFile(luaPath, automaticSource('Hide'), 'utf8');
    const afterUserChange = await Promise.all(protectedPaths.map(hash));
    const second = await runCli(['gameplay-test', '--json'], { cwd: root });
    const secondData = second.envelope.data as { runId: string };
    expect(secondData.runId).not.toBe(firstData.runId);
    expect(await Promise.all(protectedPaths.map(hash))).toEqual(afterUserChange);
    expect(JSON.parse(await readFile(join(root, '.yuanmeng-inspector', 'gameplay', 'latest.json'), 'utf8'))).toMatchObject({ runId: secondData.runId });
    await expect(access(join(root, '.yuanmeng-inspector', 'gameplay', 'runs', firstData.runId, 'manifest.json'))).resolves.toBeUndefined();
  });
});
