import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import * as vscode from 'vscode';

import type { ExtensionTestCase } from './index.js';
import type { UiSearchResult } from '../../src/core/ui/index.js';

interface TestContextSummary {
  root: string;
  projectInstanceId: string;
  snapshotId: string | null;
}

interface CompanionApi {
  listContexts(): TestContextSummary[];
  refreshUi(root: string): Promise<void>;
  findUi(root: string, query: string): Promise<UiSearchResult>;
  statusText(root: string): string;
  wizardSteps: readonly string[];
}

const execFileAsync = promisify(execFile);

async function runProjectLauncher(root: string, args: readonly string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const commandInterpreter = process.env.ComSpec ?? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe');
  const launcher = join(root, '.yuanmeng-inspector', 'bin', 'ymai.cmd');
  try {
    const result = await execFileAsync(commandInterpreter, ['/d', '/c', 'call', launcher, ...args], { encoding: 'utf8' });
    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failure = error as { code: number; stdout: string; stderr: string };
    return { exitCode: failure.code, stdout: failure.stdout, stderr: failure.stderr };
  }
}

async function waitForStatusText(api: CompanionApi, root: string, expected: RegExp): Promise<void> {
  const deadline = Date.now() + 3000;
  while (Date.now() <= deadline) {
    if (expected.test(api.statusText(root))) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  assert.match(api.statusText(root), expected);
}

function testRoot(name: 'A' | 'B'): string {
  const value = process.env[`YMAI_EXTENSION_TEST_ROOT_${name}`];
  assert.ok(value, `missing test root ${name}`);
  return value;
}

async function activateCompanion(): Promise<{ extension: vscode.Extension<CompanionApi>; api: CompanionApi }> {
  const extension = vscode.extensions.getExtension<CompanionApi>('bujianxingguang.yuanmeng-ai-dev-assistant');
  assert.ok(extension, 'companion extension is not installed in the development host');
  const api = await extension.activate();
  assert.ok(api, 'extension activation must return its local API');
  return { extension, api };
}

export const m1UiTests: ExtensionTestCase[] = [{
  name: 'M1 UI Extension Host simulation isolates two roots and exposes native contributions',
  run: async () => {
    const rootA = testRoot('A');
    const rootB = testRoot('B');
    let selectedRoot = rootA;
    let refreshCount = 0;
    let freezeOfficialOutput = false;
    let delayedOfficialWriteMilliseconds = 0;
    const pendingOfficialWrites: Promise<void>[] = [];
    const fakeOfficial = vscode.commands.registerCommand('dreamhelper.GetCustomUIData', async () => {
      refreshCount += 1;
      const dataDirectory = join(selectedRoot, 'src', 'Data');
      await mkdir(dataDirectory, { recursive: true });
      const idOffset = freezeOfficialOutput ? 100 : (refreshCount - 1) * 100;
      const writeOfficialData = async (): Promise<void> => {
        await writeFile(join(dataDirectory, 'CustomUIData.lua'), [
          'return { schemaVersion = 1, roots = {',
          `  { id = '${101 + idOffset}', name = '经验', type = 'Text', children = {} },`,
          `  { id = '${102 + idOffset}', name = '经验', type = 'Text', children = {} },`,
          '} }',
          '',
        ].join('\n'), 'utf8');
      };
      if (delayedOfficialWriteMilliseconds > 0) {
        const delayMilliseconds = delayedOfficialWriteMilliseconds;
        delayedOfficialWriteMilliseconds = 0;
        const pendingWrite = new Promise<void>((resolve, reject) => {
          setTimeout(() => {
            void writeOfficialData().then(resolve, reject);
          }, delayMilliseconds);
        });
        pendingOfficialWrites.push(pendingWrite);
        return;
      }
      await writeOfficialData();
    });
    try {
      const { extension, api } = await activateCompanion();
      const commands = extension.packageJSON.contributes?.commands as Array<{ command: string }> | undefined;
      const commandIds = new Set(commands?.map((entry) => entry.command));
      for (const command of [
        'yuanmengAi.refreshUi',
        'yuanmengAi.findUi',
        'yuanmengAi.openWizard',
        'yuanmengAi.setMapDisplayName',
        'yuanmengAi.copyCliCommand',
        'yuanmengAi.importRegistry',
        'yuanmengAi.importSceneIdFromClipboard',
        'yuanmengAi.previewScenePlan',
        'yuanmengAi.copySceneHierarchyPath',
        'yuanmengAi.copySceneLuaConstant',
        'yuanmengAi.copySceneJsonSnippet',
        'yuanmengAi.findSceneLuaReferences',
        'yuanmengAi.planSceneSelection',
      ]) {
        assert.ok(commandIds.has(command), `missing command contribution ${command}`);
      }
      assert.ok(extension.packageJSON.contributes?.viewsContainers?.activitybar?.length > 0);
      assert.ok(extension.packageJSON.contributes?.views?.yuanmengAi?.length >= 8);

      const contexts = api.listContexts();
      assert.equal(contexts.length, 2);
      assert.equal(new Set(contexts.map((context) => context.projectInstanceId)).size, 2);
      assert.deepEqual(new Set(contexts.map((context) => context.root)), new Set([rootA, rootB]));
      for (const root of [rootA, rootB]) {
        const initialStatus = JSON.parse(await readFile(
          join(root, '.yuanmeng-inspector', 'status.json'),
          'utf8',
        )) as { link: { state: string; reasonCode: string; lastProbeAt: string | null }; ui: { freshness: string } };
        assert.deepEqual(initialStatus.link, {
          state: 'offline',
          reasonCode: 'OFFICIAL_COMMANDS_MISSING',
          lastProbeAt: null,
        });
        assert.equal(initialStatus.ui.freshness, 'missing');
        const launcherText = await readFile(join(root, '.yuanmeng-inspector', 'bin', 'ymai.cmd'), 'utf8');
        assert.doesNotMatch(launcherText, /powershell|Get-FileHash/iu);
        assert.match(launcherText, /ymai\.cjs/iu);
        assert.match(await readFile(join(root, '.yuanmeng-inspector', 'bin', 'ymai.cjs'), 'utf8'), /createHash/u);
        const launcherManifest = JSON.parse(await readFile(
          join(root, '.yuanmeng-inspector', 'bin', 'cli-launcher.json'),
          'utf8',
        )) as Record<string, unknown>;
        assert.equal(launcherManifest.projectInstanceId, contexts.find((item) => item.root === root)?.projectInstanceId);
      }
      const sessions = await Promise.all([rootA, rootB].map(async (root) => JSON.parse(await readFile(
        join(root, '.yuanmeng-inspector', 'runtime', 'session.json'),
        'utf8',
      )) as Record<string, unknown>));
      assert.equal(new Set(sessions.map((session) => session.token)).size, 2);
      assert.deepEqual(sessions.map((session) => session.projectInstanceId), contexts.map((item) => item.projectInstanceId));

      selectedRoot = rootA;
      await api.refreshUi(rootA);
      const refreshed = api.listContexts();
      assert.ok(refreshed.find((context) => context.root === rootA)?.snapshotId);
      assert.equal(refreshed.find((context) => context.root === rootB)?.snapshotId, null);
      const snapshot = JSON.parse(await readFile(
        join(rootA, '.yuanmeng-inspector', 'ui', 'current.json'),
        'utf8',
      )) as { snapshotId: string; sources: Array<{ evidence: string; officialExtensionVersion: string | null }> };
      assert.deepEqual(snapshot.sources.map((source) => source.evidence), ['EXTENSION_HOST']);
      assert.deepEqual(snapshot.sources.map((source) => source.officialExtensionVersion), ['0.0.0-test']);
      const layerOrderBaseline = JSON.parse(await readFile(
        join(rootA, '.yuanmeng-inspector', 'ui', 'layer-order-baseline.json'),
        'utf8',
      )) as { snapshotId: string };
      const layerOrderStatus = JSON.parse(await readFile(
        join(rootA, '.yuanmeng-inspector', 'ui', 'layer-order-status.json'),
        'utf8',
      )) as { state: string; writesOfficialMap: boolean };
      assert.equal(layerOrderBaseline.snapshotId, snapshot.snapshotId);
      assert.equal(layerOrderStatus.state, 'baseline-created');
      assert.equal(layerOrderStatus.writesOfficialMap, false);
      const registry = JSON.parse(await readFile(
        join(rootA, '.yuanmeng-inspector', 'registry', 'registry.json'),
        'utf8',
      )) as { records: Array<{ environment: string; validity: string; projectInstanceId: string }> };
      assert.equal(registry.records.length, 2);
      assert.ok(registry.records.every((record) => record.environment === 'unspecified'));
      assert.ok(registry.records.every((record) => record.validity === 'pending'));
      assert.ok(registry.records.every((record) => (
        record.projectInstanceId === contexts.find((item) => item.root === rootA)?.projectInstanceId
      )));

      const search = await api.findUi(rootA, '经验');
      assert.equal(search.kind, 'ambiguous');
      if (search.kind === 'ambiguous') {
        assert.deepEqual(search.candidates.map((candidate) => candidate.path), ['/经验', '/经验']);
        assert.deepEqual(search.candidates.map((candidate) => candidate.id), ['101', '102']);
      }
      selectedRoot = rootA;
      // The real official command can resolve before its UI files land. The
      // companion refresh must wait for that post-command export instead of
      // accepting the pre-command files as an unchanged successful refresh.
      delayedOfficialWriteMilliseconds = 1_000;
      const cliRefresh = await runProjectLauncher(rootA, ['refresh-ui', '--timeout', '8', '--json']);
      assert.equal(cliRefresh.exitCode, 0, cliRefresh.stderr);
      assert.equal((JSON.parse(cliRefresh.stdout) as { code: string }).code, 'OK');
      assert.deepEqual(api.listContexts().find((context) => context.root === rootB)?.snapshotId, null);
      const refreshedSearch = await api.findUi(rootA, '经验');
      assert.equal(refreshedSearch.kind, 'ambiguous');
      if (refreshedSearch.kind === 'ambiguous') {
        assert.deepEqual(refreshedSearch.candidates.map((candidate) => candidate.id), ['201', '202']);
      }
      await Promise.all(pendingOfficialWrites);
      freezeOfficialOutput = true;
      const snapshotBeforeUnchanged = api.listContexts().find((context) => context.root === rootA)?.snapshotId;
      const snapshotCreatedAtBeforeUnchanged = (JSON.parse(await readFile(
        join(rootA, '.yuanmeng-inspector', 'ui', 'current.json'),
        'utf8',
      )) as { createdAt: string }).createdAt;
      const unchangedRefresh = await runProjectLauncher(rootA, ['refresh-ui', '--timeout', '8', '--json']);
      assert.equal(unchangedRefresh.exitCode, 0, unchangedRefresh.stderr);
      const unchangedPayload = JSON.parse(unchangedRefresh.stdout) as { code: string; message: string };
      assert.equal(unchangedPayload.code, 'OK');
      assert.equal(unchangedPayload.message, '已检查 UI，内容未变化；现有快照仍为最新。');
      const unchangedStatus = JSON.parse(await readFile(
        join(rootA, '.yuanmeng-inspector', 'status.json'),
        'utf8',
      )) as { link: { state: string; reasonCode: string }; ui: { freshness: string; lastRefreshAt: string } };
      assert.deepEqual({
        state: unchangedStatus.link.state,
        reasonCode: unchangedStatus.link.reasonCode,
      }, {
        state: 'unknown',
        reasonCode: 'REFRESH_SUCCEEDED_UNCHANGED',
      });
      assert.equal(unchangedStatus.ui.freshness, 'fresh');
      assert.ok(
        Date.parse(unchangedStatus.ui.lastRefreshAt) > Date.parse(snapshotCreatedAtBeforeUnchanged),
        '成功检查但内容未变化时，最近检查时间也必须推进，不能再次显示成陈旧数据',
      );
      assert.equal(api.listContexts().find((context) => context.root === rootA)?.snapshotId, snapshotBeforeUnchanged);
      const listedIds = await runProjectLauncher(rootA, [
        'list-ids',
        '--environment',
        'unspecified',
        '--validity',
        'pending',
        '--allow-stale',
        '--json',
      ]);
      assert.equal(listedIds.exitCode, 0, listedIds.stderr);
      const listedPayload = JSON.parse(listedIds.stdout) as {
        code: string;
        data: { records: Array<{ value: string; environment: string; validity: string }> };
      };
      assert.equal(listedPayload.code, 'OK');
      assert.deepEqual(listedPayload.data.records.map((record) => record.value).sort(), ['201', '202']);
      assert.ok(listedPayload.data.records.every((record) => (
        record.environment === 'unspecified' && record.validity === 'pending'
      )));
      for (const root of [rootA, rootB]) {
        const fields = api.statusText(root).split('|').map((field) => field.trim());
        assert.equal(fields.length, 5);
        assert.ok(fields.every((field) => field.length > 0));
      }
      assert.deepEqual(api.wizardSteps, [
        '选择目标工程',
        'UI：获取结构并查找控件',
        '场景：可选的本地只读快照',
        '台账：核对 ID 与信号',
        'Lua：检查引用并预览修改',
        'API：查询官方公开签名',
        '属性：读取或预览单元件修改',
        '构建：确认后调用官方合成',
      ]);
      await vscode.commands.executeCommand('yuanmengAi.setMapDisplayName', rootA, '  星光超市  ');
      assert.match(api.statusText(rootA), /地图:星光超市/u);
      await vscode.commands.executeCommand('yuanmengAi.setMapDisplayName', rootA, '星光超市·夜间版');
      assert.match(api.statusText(rootA), /地图:星光超市·夜间版/u);
      const cliRename = await runProjectLauncher(rootA, ['set-map-name', 'AI自动填写地图名', '--json']);
      assert.equal(cliRename.exitCode, 0, cliRename.stderr);
      await waitForStatusText(api, rootA, /地图:AI自动填写地图名/u);
      await vscode.commands.executeCommand('yuanmengAi.copyCliCommand', rootA);
      assert.equal(await vscode.env.clipboard.readText(), '& ".\\.yuanmeng-inspector\\bin\\ymai.cmd" status --json');
    } finally {
      fakeOfficial.dispose();
    }
  },
}];
