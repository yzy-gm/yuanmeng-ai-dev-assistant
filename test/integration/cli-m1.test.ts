import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, realpath, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import { sha256Hex } from '../../src/core/hash.js';
import { buildUiSnapshot } from '../../src/core/ui/index.js';
import { createUiGeometryProbeToken, parseUiGeometryProbeLog } from '../../src/core/ui/runtime-geometry.js';
import {
  createUiRuntimeWidgetProbeToken,
  createUiScreenPointProbeToken,
  parseUiRuntimeWidgetProbeLog,
  parseUiScreenPointProbeLog,
} from '../../src/core/ui/runtime-inspection.js';
import type { InspectorStatus, RegistryDocument, UiNode, UiSnapshot } from '../../src/core/model.js';

const execFileAsync = promisify(execFile);
const repoRoot = resolve(import.meta.dirname, '..', '..');
const cliPath = join(repoRoot, 'out', 'cli.cjs');
const projectId = '00000000-0000-4000-8000-000000000701';

function normalizedRoot(path: string): string {
  let value = path.replace(/\\/gu, '/').replace(/\/+$/u, '');
  if (/^[A-Za-z]:/u.test(value)) {
    value = `${value[0]!.toLowerCase()}${value.slice(1)}`;
  }
  return value;
}

function node(id: string, name: string, path: string): UiNode {
  return {
    id,
    name,
    type: 'Text',
    parentId: null,
    path,
    depth: 0,
    siblingIndex: 0,
    sourceFile: 'src/Data/CustomUIData.lua',
    sourceRange: null,
  };
}

async function createProject(kind: 'offline' | 'fresh' | 'stale' | 'duplicate'): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `ymai-cli-${kind}-`));
  const canonical = await realpath(root);
  const rootHash = sha256Hex(normalizedRoot(canonical));
  await mkdir(join(root, 'src'), { recursive: true });
  await mkdir(join(root, '.yuanmeng-inspector', 'ui', 'snapshots'), { recursive: true });
  await writeFile(join(root, 'src', 'GameEntry.lua'), 'return {}\n', 'utf8');
  await writeFile(join(root, '.yuanmeng-inspector', 'meta.json'), JSON.stringify({
    schemaVersion: 1,
    projectInstanceId: projectId,
    projectRootHash: rootHash,
  }), 'utf8');
  if (kind === 'offline') {
    return root;
  }

  const createdAt = kind === 'stale' ? '2026-08-19T00:00:00.000Z' : new Date().toISOString();
  const nodes = kind === 'duplicate'
    ? [node('101', '经验', '/HUD/经验'), node('102', '经验', '/结算/经验')]
    : [node('101', '经验', '/HUD/经验')];
  const snapshot = buildUiSnapshot({
    createdAt,
    projectInstanceId: projectId,
    mapFingerprint: null,
    sources: [],
    nodes,
  });
  const status: InspectorStatus = {
    schemaVersion: 1,
    project: {
      schemaVersion: 1,
      projectInstanceId: projectId,
      projectRootHash: rootHash,
      hasSrc: true,
      hasGameEntry: true,
      mapFingerprint: null,
      mapName: null,
      currentLayerId: null,
      layers: [],
    },
    officialCommands: { refreshUi: true },
    link: { state: 'online', reasonCode: 'REFRESH_SUCCEEDED', lastProbeAt: createdAt },
    ui: {
      freshness: kind === 'stale' ? 'stale' : 'fresh',
      lastRefreshAt: createdAt,
      sourceHashes: {},
      reasonCodes: kind === 'stale' ? ['SNAPSHOT_EXPIRED'] : [],
    },
    issueCounts: { error: 0, warning: 0, info: 0 },
  };
  await writeFile(join(root, '.yuanmeng-inspector', 'status.json'), JSON.stringify(status), 'utf8');
  await writeFile(join(root, '.yuanmeng-inspector', 'ui', 'current.json'), JSON.stringify(snapshot), 'utf8');
  await writeFile(
    join(root, '.yuanmeng-inspector', 'ui', 'snapshots', `${snapshot.snapshotId}.json`),
    JSON.stringify(snapshot),
    'utf8',
  );
  return root;
}

async function spawnCli(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync(process.execPath, [cliPath, ...argv], { encoding: 'utf8', env });
    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failed = error as { code: number; stdout: string; stderr: string };
    return { exitCode: failed.code, stdout: failed.stdout, stderr: failed.stderr };
  }
}

async function createApiExtensionsRoot(): Promise<{ root: string; extensionPath: string }> {
  const root = await mkdtemp(join(tmpdir(), 'ymai-api-extensions-'));
  const extensionPath = join(root, 'fixture.official-1.2.3');
  await mkdir(join(extensionPath, 'res', 'lib'), { recursive: true });
  await writeFile(join(extensionPath, 'package.json'), JSON.stringify({
    name: 'official',
    publisher: 'fixture',
    version: '1.2.3',
    contributes: {
      commands: [{ command: 'dreamhelper.GetCustomUIData', title: 'fixture' }],
    },
  }), 'utf8');
  await writeFile(
    join(extensionPath, 'res', 'lib', 'UI.d.lua'),
    await readFile(new URL('../fixtures/api/UI.d.lua', import.meta.url), 'utf8'),
    'utf8',
  );
  return { root, extensionPath };
}

function parseEnvelope(result: { stdout: string }): Record<string, unknown> {
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

async function waitForPendingRequest(project: string): Promise<{ path: string; request: Record<string, unknown> }> {
  const directory = join(project, '.yuanmeng-inspector', 'runtime', 'requests', 'pending');
  const deadline = Date.now() + 2000;
  while (Date.now() <= deadline) {
    try {
      const filename = (await readdir(directory)).find((name) => name.endsWith('.json'));
      if (filename !== undefined) {
        const path = join(directory, filename);
        return { path, request: JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown> };
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  throw new Error('CLI did not create an atomic refresh request');
}

describe('M1 CLI process contract', () => {
  it('resolves UI deterministically and serves exact P0 runtime evidence or a bound probe', async () => {
    const project = await createProject('fresh');
    const snapshot = JSON.parse(await readFile(join(project, '.yuanmeng-inspector', 'ui', 'current.json'), 'utf8')) as UiSnapshot;

    const resolved = await spawnCli(['resolve-ui', '经验', '--project', project, '--json']);
    expect(parseEnvelope(resolved)).toMatchObject({ code: 'OK', data: { node: { id: '101', path: '/HUD/经验' } } });

    const missingPoint = await spawnCli(['ui-inspect-point', '320', '240', '--project', project, '--json']);
    expect(missingPoint.exitCode).toBe(9);
    expect(parseEnvelope(missingPoint)).toMatchObject({
      code: 'EVIDENCE_INSUFFICIENT', data: { reasonCode: 'UI_SCREEN_POINT_RUNTIME_REQUIRED', request: { x: 320, y: 240 } },
    });
    expect(missingPoint.stdout).toContain('UI:CheckWidgetByScreenPosition');

    const context = { projectInstanceId: projectId, uiSnapshotId: snapshot.snapshotId };
    const request = { x: 320, y: 240, includeGroup: false, groupId: '0' } as const;
    const pointToken = createUiScreenPointProbeToken(context, request);
    const point = parseUiScreenPointProbeLog(new TextEncoder().encode([
      `[YMAI_UI_SCREEN_POINT_ENV] token=${pointToken} snapshot=${snapshot.snapshotId} point=320,240 includeGroup=false group=0 status=ok screenSize=1280,720 uiSize=1280,720`,
      `[YMAI_UI_SCREEN_POINT] token=${pointToken} snapshot=${snapshot.snapshotId} point=320,240 includeGroup=false group=0 status=ok hit=101`,
      '',
    ].join('\n')), { snapshot, request });
    const pointDirectory = join(project, '.yuanmeng-inspector', 'ui', 'screen-points');
    await mkdir(pointDirectory, { recursive: true });
    await writeFile(join(pointDirectory, 'current.json'), JSON.stringify(point), 'utf8');
    expect(parseEnvelope(await spawnCli(['ui-inspect-point', '320', '240', '--project', project, '--json']))).toMatchObject({
      code: 'OK', data: { evidence: 'STANDALONE_LOG', hitId: '101', hit: { classification: 'static' } },
    });

    const missingTree = await spawnCli(['ui-runtime-widgets', '经验', '--project', project, '--json']);
    expect(missingTree.exitCode).toBe(9);
    expect(missingTree.stdout).toContain('UI:GetAllChildren');
    const treeToken = createUiRuntimeWidgetProbeToken(context, '101');
    const widgets = parseUiRuntimeWidgetProbeLog(new TextEncoder().encode([
      `[YMAI_UI_RUNTIME_TREE_ENV] token=${treeToken} snapshot=${snapshot.snapshotId} root=101 status=ok count=2 truncated=false`,
      `[YMAI_UI_RUNTIME_WIDGET] token=${treeToken} snapshot=${snapshot.snapshotId} root=101 id=101 parent=none name=%E7%BB%8F%E9%AA%8C zOrder=1`,
      `[YMAI_UI_DYNAMIC_DUPLICATE] token=${treeToken} snapshot=${snapshot.snapshotId} root=101 id=9001 template=101 parent=101`,
      '',
    ].join('\n')), { snapshot, rootId: '101' });
    const widgetsDirectory = join(project, '.yuanmeng-inspector', 'ui', 'runtime-widgets');
    await mkdir(widgetsDirectory, { recursive: true });
    await writeFile(join(widgetsDirectory, 'current.json'), JSON.stringify(widgets), 'utf8');
    expect(parseEnvelope(await spawnCli(['ui-runtime-widgets', '101', '--project', project, '--json']))).toMatchObject({
      code: 'OK', data: { root: { id: '101' }, entries: expect.arrayContaining([expect.objectContaining({ id: '9001', classification: 'dynamic' })]) },
    });

    expect(parseEnvelope(await spawnCli(['runtime-probe', 'ui-runtime-tree', '经验', '--project', project, '--json']))).toMatchObject({
      code: 'OK', data: { kind: 'ui-runtime-tree', rootId: '101', probeLua: expect.stringContaining('YMAI_UI_RUNTIME_TREE_ENV') },
    });
  });

  it('returns a bound UI geometry probe first, then serves imported runtime screen coordinates', async () => {
    const project = await createProject('fresh');
    const snapshot = JSON.parse(await readFile(
      join(project, '.yuanmeng-inspector', 'ui', 'current.json'),
      'utf8',
    )) as UiSnapshot;

    const missing = await spawnCli(['ui-screen-snapshot', '经验', '--project', project, '--json']);
    expect(missing.exitCode).toBe(9);
    expect(parseEnvelope(missing)).toMatchObject({
      code: 'EVIDENCE_INSUFFICIENT',
      data: { selectedIds: ['101'], snapshotId: snapshot.snapshotId, evidence: 'STATIC_LOCAL' },
    });
    expect(missing.stdout).toContain('[YMAI_UI_GEOMETRY]');

    const context = { projectInstanceId: projectId, uiSnapshotId: snapshot.snapshotId };
    const common = `token=${createUiGeometryProbeToken(context, ['101'])} snapshot=${snapshot.snapshotId} selection=101`;
    const runtime = parseUiGeometryProbeLog(new TextEncoder().encode([
      `[YMAI_UI_GEOMETRY_ENV] ${common} status=ok screenSize=1920,1080 uiSize=1920,1080`,
      `[YMAI_UI_GEOMETRY] ${common} id=101 status=ok position=10,20 size=100,40 anchored=10,20,0,0,0,0 screenRect=10,20,110,60 normalizedRect=0.005208333,0.018518519,0.057291667,0.055555556 angle=0 center=0.5,0.5 zOrder=3 parent=none centerHit=101`,
      '',
    ].join('\n')), { context, importedAt: '2026-08-23T00:00:00.000Z' });
    const runtimeDirectory = join(project, '.yuanmeng-inspector', 'ui', 'runtime');
    await mkdir(runtimeDirectory, { recursive: true });
    await writeFile(join(runtimeDirectory, 'current.json'), JSON.stringify(runtime), 'utf8');

    const ready = await spawnCli(['ui-screen-snapshot', '经验', '--project', project, '--json']);
    expect(ready.exitCode).toBe(0);
    expect(parseEnvelope(ready)).toMatchObject({
      code: 'OK',
      data: {
        evidence: 'STANDALONE_LOG',
        controls: [{ node: { id: '101' }, geometry: { status: 'ok', screenRect: { left: 10, top: 20, right: 110, bottom: 60 } } }],
      },
    });
    const readyById = await spawnCli(['ui-screen-snapshot', '101', '--project', project, '--json']);
    expect(readyById.exitCode).toBe(0);
    expect(parseEnvelope(readyById)).toMatchObject({
      code: 'OK', data: { controls: [{ node: { id: '101', name: '经验' } }] },
    });
  });

  it('selects a complete UI subtree from parent IDs instead of path prefixes', async () => {
    const project = await createProject('fresh');
    const snapshot = buildUiSnapshot({
      createdAt: new Date().toISOString(),
      projectInstanceId: projectId,
      mapFingerprint: null,
      sources: [],
      nodes: [
        { ...node('200', '弹窗', '/弹窗'), parentId: null, depth: 0 },
        { ...node('201', '按钮', '/弹窗/按钮'), parentId: '200', depth: 1 },
        { ...node('202', '文字', '/弹窗/按钮/文字'), parentId: '201', depth: 2 },
        // 路径元数据可能在导出边界短暂陈旧；真实 parentId 仍属于弹窗。
        { ...node('204', '图片', '/旧路径/图片'), parentId: '200', depth: 1 },
        // 路径相似但没有父子关系，不能误算成弹窗成员。
        { ...node('203', '伪子控件', '/弹窗/伪子控件'), parentId: null, depth: 0 },
      ],
    });
    await writeFile(join(project, '.yuanmeng-inspector', 'ui', 'current.json'), JSON.stringify(snapshot), 'utf8');

    const result = await spawnCli(['ui-tree-screen-snapshot', '/弹窗', '--path', '--project', project, '--json']);

    expect(result.exitCode).toBe(9);
    expect(parseEnvelope(result)).toMatchObject({
      code: 'EVIDENCE_INSUFFICIENT',
      data: { selectedIds: ['200', '201', '202', '204'] },
    });
  });

  it('rejects a cyclic UI parent graph instead of looping or returning a partial tree', async () => {
    const project = await createProject('fresh');
    const snapshot = buildUiSnapshot({
      createdAt: new Date().toISOString(),
      projectInstanceId: projectId,
      mapFingerprint: null,
      sources: [],
      nodes: [
        { ...node('300', '循环弹窗', '/循环弹窗'), parentId: '301', depth: 0 },
        { ...node('301', '循环子控件', '/循环弹窗/循环子控件'), parentId: '300', depth: 1 },
      ],
    });
    await writeFile(join(project, '.yuanmeng-inspector', 'ui', 'current.json'), JSON.stringify(snapshot), 'utf8');

    const result = await spawnCli(['ui-tree-screen-snapshot', '/循环弹窗', '--path', '--project', project, '--json']);

    expect(result.exitCode).toBe(6);
    expect(parseEnvelope(result)).toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('lets AI set and replace the project-local map display name', async () => {
    const project = await createProject('fresh');
    const first = await spawnCli(['set-map-name', '星光超市', '--project', project, '--json']);
    expect(first.exitCode).toBe(0);
    expect(parseEnvelope(first)).toMatchObject({ code: 'OK', data: { mapDisplayName: '星光超市' } });

    const second = await spawnCli(['set-map-name', '星光超市·夜间版', '--project', project, '--json']);
    expect(second.exitCode).toBe(0);
    const status = await spawnCli(['status', '--project', project, '--json']);
    expect(parseEnvelope(status)).toMatchObject({
      data: { mapDisplayName: '星光超市·夜间版', mapName: null },
    });
  });

  it('reports project-local plugin, launcher, bridge, and official command health', async () => {
    const project = await createProject('fresh');

    const status = await spawnCli(['status', '--project', project, '--json']);

    expect(parseEnvelope(status)).toMatchObject({
      data: {
        environment: {
          overall: 'degraded',
          launchers: {
            cli: { state: 'missing' },
            mcp: { state: 'missing' }
          },
          bridge: { state: 'missing' },
          official: {
            refreshUiAvailable: true,
            buildAvailable: false
          }
        }
      }
    });
  });

  it('keeps the project usable when only UI is stale and reports domain readiness plus a precise next action', async () => {
    const project = await createProject('stale');

    const status = await spawnCli(['status', '--project', project, '--json']);

    expect(status.exitCode).toBe(0);
    expect(parseEnvelope(status)).toMatchObject({
      code: 'OK',
      warnings: ['需要当前 UI 控件信息时运行 yuanmeng_ui_refresh；场景/Lua 等无关只读任务可继续。'],
      data: {
        freshness: 'stale',
        readiness: {
          ui: { state: 'stale', usable: true },
          scene: { state: 'missing', usable: false },
          lua: { state: 'ready', usable: true },
          codeDelivery: { state: 'blocked', usable: false }
        },
        nextActions: ['需要当前 UI 控件信息时运行 yuanmeng_ui_refresh；场景/Lua 等无关只读任务可继续。']
      }
    });
  });

  it.each([
    ['offline', ['status'], 2, 'OFFLINE'],
    ['stale', ['find-ui', '经验'], 3, 'STALE'],
    ['duplicate', ['find-ui', '经验'], 4, 'AMBIGUOUS'],
    ['fresh', ['find-ui', '不存在'], 5, 'NOT_FOUND'],
  ] as const)('returns stable %s envelope and exit code', async (kind, command, exitCode, code) => {
    const project = await createProject(kind);
    const result = await spawnCli([...command, '--project', project, '--json']);

    expect(result.exitCode).toBe(exitCode);
    expect(result.stderr).toBe('');
    expect(parseEnvelope(result)).toMatchObject({ schemaVersion: 1, code });
  });

  it('allows stale data only when acknowledged and keeps the warning and freshness', async () => {
    const project = await createProject('stale');
    const result = await spawnCli(['find-ui', '经验', '--project', project, '--allow-stale', '--json']);

    expect(result.exitCode).toBe(0);
    expect(parseEnvelope(result)).toMatchObject({
      code: 'OK',
      warnings: ['UI 数据陈旧'],
      data: { freshness: 'stale', node: { id: '101', name: '经验' } },
    });
  });

  it('queues refresh-ui for the bound project and waits for the extension result', async () => {
    const project = await createProject('fresh');
    const runtimeRoot = join(project, '.yuanmeng-inspector', 'runtime');
    await mkdir(runtimeRoot, { recursive: true });
    await writeFile(join(runtimeRoot, 'session.json'), JSON.stringify({
      schemaVersion: 1,
      token: 'a'.repeat(64),
      projectInstanceId: projectId,
      createdAt: new Date(Date.now() - 1000).toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }), 'utf8');

    const resultPromise = spawnCli(['refresh-ui', '--timeout', '3', '--project', project, '--json']);
    const { request } = await waitForPendingRequest(project);
    expect(request).toMatchObject({
      schemaVersion: 1,
      token: 'a'.repeat(64),
      projectInstanceId: projectId,
      action: 'refresh-ui',
    });
    const resultsDirectory = join(runtimeRoot, 'requests', 'results');
    await mkdir(resultsDirectory, { recursive: true });
    const temporary = join(resultsDirectory, `${String(request.requestId)}.tmp`);
    const target = join(resultsDirectory, `${String(request.requestId)}.json`);
    await writeFile(temporary, JSON.stringify({
      schemaVersion: 1,
      requestId: request.requestId,
      status: 'completed',
      code: 'OK',
      message: 'synthetic extension completion',
      completedAt: new Date().toISOString(),
    }), 'utf8');
    await rename(temporary, target);

    const result = await resultPromise;
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(parseEnvelope(result)).toMatchObject({
      code: 'OK',
      data: { requestId: request.requestId },
    });
  });

  it('supports diff and export without leaking the absolute project root', async () => {
    const project = await createProject('fresh');
    const snapshot = JSON.parse(await readFile(
      join(project, '.yuanmeng-inspector', 'ui', 'current.json'),
      'utf8',
    )) as UiSnapshot;
    const newer = buildUiSnapshot({
      createdAt: new Date(Date.now() + 1000).toISOString(),
      projectInstanceId: projectId,
      mapFingerprint: null,
      sources: [],
      nodes: [node('101', '经验值', '/HUD/经验值')],
    });
    await writeFile(join(project, '.yuanmeng-inspector', 'ui', 'current.json'), JSON.stringify(newer), 'utf8');
    await writeFile(
      join(project, '.yuanmeng-inspector', 'ui', 'snapshots', `${newer.snapshotId}.json`),
      JSON.stringify(newer),
      'utf8',
    );

    const diffResult = await spawnCli([
      'diff-ui', '--from', snapshot.snapshotId, '--to', newer.snapshotId, '--project', project, '--json',
    ]);
    expect(diffResult.exitCode).toBe(0);
    expect(parseEnvelope(diffResult)).toMatchObject({ data: { renamed: [{ to: { name: '经验值' } }] } });
    expect(diffResult.stdout).not.toContain(project);

    const output = join(project, 'reports', 'ui.csv');
    const exportResult = await spawnCli([
      'export', 'ui', '--format', 'csv', '--out', output, '--project', project, '--json',
    ]);
    expect(exportResult.exitCode).toBe(0);
    expect(await readFile(output, 'utf8')).toContain('经验值');
    expect(exportResult.stdout).not.toContain(project);
  });

  it('lists registry records with independent environment and validity filters', async () => {
    const project = await createProject('fresh');
    const registry: RegistryDocument = {
      schemaVersion: 1,
      records: [{
        recordId: 'test-confirmed',
        kind: 'ui-control',
        name: '经验',
        value: '41001',
        scope: 'workspace',
        projectInstanceId: projectId,
        mapFingerprint: null,
        layerId: null,
        environment: 'test',
        validity: 'confirmed',
        source: {
          kind: 'user-entry',
          relativePath: null,
          sha256: 'c'.repeat(64),
          observedAt: new Date().toISOString(),
          officialExtensionVersion: null,
          evidence: 'UNIT_E2E',
        },
        lastConfirmedAt: null,
        notes: '',
      }],
    };
    await mkdir(join(project, '.yuanmeng-inspector', 'registry'), { recursive: true });
    await writeFile(join(project, '.yuanmeng-inspector', 'registry', 'registry.json'), JSON.stringify(registry), 'utf8');

    const result = await spawnCli([
      'list-ids',
      '--environment', 'test',
      '--validity', 'confirmed',
      '--allow-stale',
      '--project', project,
      '--json',
    ]);

    expect(result.exitCode).toBe(0);
    expect(parseEnvelope(result)).toMatchObject({
      code: 'OK',
      data: { records: [{ recordId: 'test-confirmed', environment: 'test', validity: 'confirmed' }] },
    });
  });

  it('reports where-used without absolute project paths or arbitrary numeric noise', async () => {
    const project = await createProject('fresh');
    await writeFile(join(project, 'src', 'GameEntry.lua'), [
      'local retry = 3',
      'UI:SetText(41001, "经验")',
      'Event:Send("round_started")',
      'return {}',
      '',
    ].join('\n'), 'utf8');
    const registry: RegistryDocument = {
      schemaVersion: 1,
      records: [{
        recordId: 'ui-experience',
        kind: 'ui-control',
        name: '经验',
        value: '41001',
        scope: 'workspace',
        projectInstanceId: projectId,
        mapFingerprint: null,
        layerId: null,
        environment: 'test',
        validity: 'confirmed',
        source: {
          kind: 'user-entry',
          relativePath: null,
          sha256: 'c'.repeat(64),
          observedAt: new Date().toISOString(),
          officialExtensionVersion: null,
          evidence: 'UNIT_E2E',
        },
        lastConfirmedAt: null,
        notes: '',
      }],
    };
    await mkdir(join(project, '.yuanmeng-inspector', 'registry'), { recursive: true });
    await writeFile(join(project, '.yuanmeng-inspector', 'registry', 'registry.json'), JSON.stringify(registry), 'utf8');

    const result = await spawnCli(['where-used', '41001', '--kind', 'ui', '--project', project, '--json']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain(project);
    expect(parseEnvelope(result)).toMatchObject({
      code: 'OK',
      data: {
        query: '41001',
        kind: 'ui',
        results: [expect.objectContaining({ path: 'src/GameEntry.lua', value: '41001' })],
        impact: {
          scope: 'direct-references-only',
          affectedFiles: ['src/GameEntry.lua'],
          registry: [expect.objectContaining({ value: '41001', name: '经验' })],
        },
      },
    });
    expect(result.stdout).not.toContain('"value":"3"');
  });

  it('searches derived official API metadata and returns NOT_FOUND without inventing APIs', async () => {
    const project = await createProject('fresh');
    const extension = await createApiExtensionsRoot();
    const env = { ...process.env, VSCODE_EXTENSIONS: extension.root };

    const found = await spawnCli(['api-search', '控件名称', '--project', project, '--json'], env);
    expect(found.exitCode).toBe(0);
    expect(found.stderr).toBe('');
    expect(found.stdout).not.toContain(extension.extensionPath);
    const foundEnvelope = parseEnvelope(found) as {
      code: string;
      data: { officialExtensionVersion: string; results: Array<Record<string, unknown>> };
    };
    expect(foundEnvelope).toMatchObject({
      code: 'OK',
      data: { officialExtensionVersion: '1.2.3' },
    });
    expect(foundEnvelope.data.results[0]).toMatchObject({
      module: 'UI',
      name: 'GetUIName',
      signature: 'UI:GetUIName(WidgetId)',
      source: { relativePath: 'res/lib/UI.d.lua' },
    });

    const missing = await spawnCli(['api-search', 'MakeEverythingWork', '--project', project, '--json'], env);
    expect(missing.exitCode).toBe(5);
    expect(parseEnvelope(missing)).toMatchObject({ code: 'NOT_FOUND', data: { results: [] } });
  });

  it('audits registered IDs and known official API calls with stable diagnostics', async () => {
    const project = await createProject('fresh');
    const extension = await createApiExtensionsRoot();
    await writeFile(join(project, 'src', 'GameEntry.lua'), [
      'UI:SetVisible(49999)',
      'return {}',
      '',
    ].join('\n'), 'utf8');

    const audit = await spawnCli(
      ['audit', '--project', project, '--json'],
      { ...process.env, VSCODE_EXTENSIONS: extension.root },
    );

    expect(audit.exitCode).toBe(0);
    expect(audit.stdout).not.toContain(project);
    expect(audit.stdout).not.toContain(extension.extensionPath);
    expect(parseEnvelope(audit)).toMatchObject({
      code: 'OK',
      data: {
        issueCounts: { error: 1, warning: 1, info: 0 },
        diagnostics: expect.arrayContaining([
          expect.objectContaining({ code: 'API_ARGUMENT_COUNT', runtimeVerified: false }),
          expect.objectContaining({ code: 'UNREGISTERED_ID_REFERENCE', runtimeVerified: false }),
        ]),
      },
    });
  });

  it('runs a targeted errors-only audit without treating it as full-project evidence', async () => {
    const project = await createProject('fresh');
    const extension = await createApiExtensionsRoot();
    await mkdir(join(project, 'src', 'Client'), { recursive: true });
    await writeFile(join(project, 'src', 'GameEntry.lua'), [
      'UI:SetVisible(49999)',
      'return {}',
      '',
    ].join('\n'), 'utf8');
    await writeFile(join(project, 'src', 'Client', 'GameClient_backup.lua'), [
      'UI:SetVisible(59999)',
      'return {}',
      '',
    ].join('\n'), 'utf8');

    const full = await spawnCli(
      ['audit', '--project', project, '--json'],
      { ...process.env, VSCODE_EXTENSIONS: extension.root },
    );
    expect(full.exitCode).toBe(0);
    expect(parseEnvelope(full)).toMatchObject({
      data: {
        scope: { mode: 'full', files: [] },
        issueCounts: { error: 2, warning: 2, info: 0 },
        presentation: { errorsOnly: false, returnedDiagnostics: 4, omittedDiagnostics: 0 },
      },
    });

    const targeted = await spawnCli(
      ['audit', '--file', 'src/GameEntry.lua', '--errors-only', '--project', project, '--json'],
      { ...process.env, VSCODE_EXTENSIONS: extension.root },
    );
    expect(targeted.exitCode).toBe(0);
    expect(targeted.stdout).not.toContain('GameClient_backup.lua');
    expect(targeted.stdout).not.toContain('59999');
    expect(parseEnvelope(targeted)).toMatchObject({
      code: 'OK',
      data: {
        scope: {
          mode: 'targeted',
          files: ['src/GameEntry.lua'],
          fullProjectEvidence: false,
        },
        issueCounts: { error: 1, warning: 1, info: 0 },
        diagnostics: [expect.objectContaining({ code: 'API_ARGUMENT_COUNT', severity: 'error' })],
        presentation: { errorsOnly: true, returnedDiagnostics: 1, omittedDiagnostics: 1 },
      },
    });
  });

  it('rejects a conflicting launcher-bound project as validation failure', async () => {
    const project = await createProject('fresh');
    const other = await createProject('fresh');
    const extensionRoot = await realpath(dirname(dirname(cliPath)));
    const canonicalCli = await realpath(cliPath);
    const manifestPath = join(project, '.yuanmeng-inspector', 'bin', 'cli-launcher.json');
    await mkdir(dirname(manifestPath), { recursive: true });
    await writeFile(manifestPath, JSON.stringify({
      schemaVersion: 1,
      extensionId: 'bujianxingguang.yuanmeng-ai-dev-assistant',
      extensionVersion: '0.1.0',
      extensionRootHash: sha256Hex(normalizedRoot(extensionRoot)),
      cliPath: canonicalCli,
      cliSha256: sha256Hex(await readFile(canonicalCli)),
      projectInstanceId: projectId,
      projectRootHash: sha256Hex(normalizedRoot(await realpath(project))),
      generatedAt: new Date().toISOString(),
    }), 'utf8');

    const result = await spawnCli([
      'status', '--launcher-manifest', manifestPath, '--project', other, '--json',
    ]);
    expect(result.exitCode).toBe(6);
    expect(parseEnvelope(result)).toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('returns usage rather than an internal error when project discovery has no candidate', async () => {
    const missing = join(tmpdir(), `ymai-missing-${Date.now()}`);
    const result = await spawnCli(['status', '--project', missing, '--json']);

    expect(result.exitCode).toBe(7);
    expect(parseEnvelope(result)).toMatchObject({ code: 'USAGE_ERROR' });
  });

  it('returns validation failure for a missing launcher manifest', async () => {
    const project = await createProject('fresh');
    const missingManifest = join(project, '.yuanmeng-inspector', 'bin', 'missing.json');
    const result = await spawnCli(['status', '--launcher-manifest', missingManifest, '--json']);

    expect(result.exitCode).toBe(6);
    expect(parseEnvelope(result)).toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('keeps human errors on stderr and stdout empty', async () => {
    const project = await createProject('offline');
    const result = await spawnCli(['status', '--project', project]);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('离线');
  });
});
