import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as ChildProcessModule from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { nodeFileIO } from '../../src/core/fs.js';
import { gameplayModelFingerprint } from '../../src/core/gameplay/model.js';
import { createNodeGameplayRunStoreIO, GameplayRunStore } from '../../src/core/gameplay/run-store.js';
import type { GameplayModel, GameplayScenario } from '../../src/core/gameplay/types.js';
import { McpGateway } from '../../src/mcp/gateway.js';
import { toolToCliArgs } from '../../src/mcp/tool-schemas.js';
import type { YuanmengMcpToolName } from '../../src/mcp/contracts.js';
import type { CliCode } from '../../src/core/model.js';

const childProcessSpies = vi.hoisted(() => ({
  spawn: vi.fn(),
  exec: vi.fn(),
  fork: vi.fn()
}));

vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof ChildProcessModule>(),
  ...childProcessSpies
}));

const HASH = 'a'.repeat(64);
const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const temporaryRoots: string[] = [];

const mappings: ReadonlyArray<readonly [YuanmengMcpToolName, unknown, readonly string[]]> = [
  ['yuanmeng_project_status', {}, ['status']],
  ['yuanmeng_set_map_display_name', { displayName: '测试地图' }, ['set-map-name', '测试地图']],
  ['yuanmeng_ui_refresh', { timeoutSeconds: 45 }, ['refresh-ui', '--timeout', '45']],
  ['yuanmeng_ui_find', { query: '按钮', allowStale: true, fuzzy: true }, ['find-ui', '按钮', '--allow-stale', '--fuzzy']],
  ['yuanmeng_ui_resolve', { query: '/HUD/经验', allowStale: true }, ['resolve-ui', '/HUD/经验', '--allow-stale']],
  ['yuanmeng_ui_inspect_screen_point', { x: 320, y: 240, includeGroup: true, groupId: '1001', allowStale: true }, ['ui-inspect-point', '320', '240', '--include-group', '--group-id', '1001', '--allow-stale']],
  ['yuanmeng_ui_runtime_widgets', { query: '商品列表', allowStale: true }, ['ui-runtime-widgets', '商品列表', '--allow-stale']],
  ['yuanmeng_ui_screen_snapshot', { query: '按钮', allowStale: true }, ['ui-screen-snapshot', '按钮', '--allow-stale']],
  ['yuanmeng_ui_tree_screen_snapshot', { query: '/HUD', allowStale: true }, ['ui-tree-screen-snapshot', '/HUD', '--allow-stale', '--path']],
  ['yuanmeng_ui_layout_audit', { query: '/HUD', allowStale: true, includePotentialSiblingOverlap: true }, ['ui-layout-audit', '/HUD', '--allow-stale', '--path', '--include-overlaps']],
  ['yuanmeng_ui_diff', { from: HASH, to: HASH.replaceAll('a', 'b') }, ['diff-ui', '--from', HASH, '--to', HASH.replaceAll('a', 'b')]],
  ['yuanmeng_ids_list', { kind: 'scene-instance', environment: 'formal', validity: 'confirmed', allowStale: true }, ['list-ids', '--kind', 'scene-instance', '--environment', 'formal', '--validity', 'confirmed', '--allow-stale']],
  ['yuanmeng_where_used', { query: '123', kind: 'scene-instance' }, ['where-used', '123', '--kind', 'scene-instance']],
  ['yuanmeng_api_search', { query: 'GetPosition' }, ['api-search', 'GetPosition']],
  ['yuanmeng_api_search', { query: 'GetPosition', limit: 7 }, ['api-search', 'GetPosition', '--limit', '7']],
  ['yuanmeng_official_audit', {}, ['official-audit']],
  ['yuanmeng_official_audit', { saveBaseline: true }, ['official-audit', '--save-baseline']],
  ['yuanmeng_project_audit', {}, ['audit']],
  ['yuanmeng_project_audit', { files: ['src/Client/GameClient.lua', 'src/Server/GameServer.lua'], errorsOnly: true }, ['audit', '--file', 'src/Client/GameClient.lua', '--file', 'src/Server/GameServer.lua', '--errors-only']],
  ['yuanmeng_scene_status', {}, ['scene-status']],
  ['yuanmeng_scene_bind', { role: 'raw-pbin', sourcePath: 'C:\\ugc\\LayerData.pbin' }, ['bind-scene', 'raw-pbin', 'C:\\ugc\\LayerData.pbin']],
  ['yuanmeng_scene_refresh', { role: 'raw-pbin', timeoutSeconds: 60 }, ['refresh-scene', 'raw-pbin', '--timeout', '60']],
  ['yuanmeng_scene_find', { query: 'type:457' }, ['find-scene', 'type:457']],
  ['yuanmeng_scene_tree', { instanceId: '9007199254740993' }, ['scene-tree', '9007199254740993']],
  ['yuanmeng_scene_fields', { instanceId: '123' }, ['field-inspect', '123']],
  ['yuanmeng_group_members', { groupId: '508' }, ['group-members', '508']],
  ['yuanmeng_scene_diff', { from: HASH, to: HASH.replaceAll('a', 'b') }, ['scene-diff', '--from', HASH, '--to', HASH.replaceAll('a', 'b')]],
  ['yuanmeng_scene_near', { instanceId: '123', radius: 250, limit: 25 }, ['scene-near', '123', '--radius', '250', '--limit', '25']],
  ['yuanmeng_scene_audit', { detailed: true }, ['scene-audit', '--detailed']],
  ['yuanmeng_scene_types', {}, ['scene-types']],
  ['yuanmeng_scene_capability_describe', { instanceId: '517' }, ['scene-capabilities', '517']],
  ['yuanmeng_runtime_probe', { kind: 'scene-capability', instanceId: '517' }, ['runtime-probe', 'scene-capability', '517']],
  ['yuanmeng_scene_geometry', { operation: 'bounds', targetId: '513' }, ['scene-geometry', 'bounds', '513']],
  ['yuanmeng_scene_geometry', { operation: 'contact', targetId: '513', supportId: '509', tolerance: 0.1 }, ['scene-geometry', 'contact', '513', '509', '--tolerance', '0.1']],
  ['yuanmeng_scene_geometry', { operation: 'overlaps', targetIds: ['513', '600'] }, ['scene-geometry', 'overlaps', '513', '600']],
  ['yuanmeng_scene_plan', { operation: 'floor-align', supportId: '1', targetIds: ['2', '3'] }, ['scene-plan', 'floor-align', '1', '2', '3']],
  ['yuanmeng_scene_journal', { action: 'list', limit: 20 }, ['scene-journal', 'list', '--limit', '20']],
  ['yuanmeng_property_locate', { propertyName: 'price', propertyType: 'Number' }, ['property-locate', 'price', 'Number']],
  ['yuanmeng_gameplay_review', { modelPath: 'gameplay/spec.json', out: 'gameplay/reports' }, ['gameplay-review', 'gameplay/spec.json', '--out', 'gameplay/reports']],
  ['yuanmeng_gameplay_test', {}, ['gameplay-test']],
  ['yuanmeng_gameplay_test', { focus: '复核结算流程', changedFiles: ['src/GameEntry.lua'] }, ['gameplay-test', '--focus', '复核结算流程', '--file', 'src/GameEntry.lua']],
  ['yuanmeng_gameplay_test', { preview: true, focus: '只读预览', changedFiles: ['src/GameEntry.lua'] }, ['gameplay-test', '--preview', '--focus', '只读预览', '--file', 'src/GameEntry.lua']],
  ['yuanmeng_gameplay_test', { modelPath: 'gameplay/spec.json', scenarioDirectory: 'gameplay/scenarios', out: 'gameplay/reports' }, ['gameplay-test', 'gameplay/spec.json', 'gameplay/scenarios', '--out', 'gameplay/reports']],
  ['yuanmeng_feedback_add', { kind: 'bug', title: '问题', message: '复现说明' }, ['feedback', 'add', 'bug', '问题', '--message', '复现说明']],
  ['yuanmeng_feedback_list', { status: 'open', kind: 'bug' }, ['feedback', 'list', 'open', 'bug']],
  ['yuanmeng_feedback_resolve', { feedbackId: HASH, resolution: '已处理' }, ['feedback', 'resolve', HASH, '--message', '已处理']],
  ['yuanmeng_build_and_send_code', {}, []]
];

function createGateway(runCli = vi.fn().mockResolvedValue({
  exitCode: 0,
  envelope: {
    schemaVersion: 1 as const,
    ok: true,
    code: 'OK' as const,
    message: '工程状态可用。',
    data: { freshness: 'fresh', reasonCode: 'STATUS_READY', evidence: 'STATIC_LOCAL' },
    warnings: []
  }
})) {
  return new McpGateway({
    projectRoot: 'C:\\projects\\alpha',
    projectInstanceId: PROJECT_ID,
    displayName: 'Alpha',
    currentCliPath: 'C:\\extension\\out\\cli.cjs',
    runCli
  });
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('MCP tool schemas and CLI mapping', () => {
  it.each(mappings)('maps %s to deterministic in-process CLI arguments', (tool, input, expected) => {
    expect(toolToCliArgs(tool, input)).toEqual(expected);
  });

  it.each(mappings)('strictly rejects extra input fields for %s', (tool, input) => {
    expect(() => toolToCliArgs(tool, { ...(input as Record<string, unknown>), unexpected: true })).toThrow();
  });

  it('preserves decimal IDs beyond JavaScript safe integer precision', () => {
    expect(toolToCliArgs('yuanmeng_scene_tree', { instanceId: '9007199254740993' }))
      .toEqual(['scene-tree', '9007199254740993']);
  });

  it('rejects partial or mixed gameplay-test inputs before invoking the CLI', () => {
    for (const input of [
      { modelPath: 'gameplay/spec.json' },
      { out: 'gameplay/reports' },
      {
        modelPath: 'gameplay/spec.json',
        scenarioDirectory: 'gameplay/scenarios',
        out: 'gameplay/reports',
        changedFiles: ['src/GameEntry.lua']
      }
    ]) {
      expect(() => toolToCliArgs('yuanmeng_gameplay_test', input)).toThrow();
    }
  });
});

describe('MCP gateway', () => {
  it('returns one bounded task context call without exposing project paths or full fingerprints', async () => {
    const runCli = vi.fn().mockResolvedValue({
      exitCode: 0,
      envelope: {
        schemaVersion: 1,
        ok: true,
        code: 'OK',
        message: '工程状态可用。',
        data: {
          projectInstanceId: PROJECT_ID,
          freshness: 'fresh',
          readiness: {
            ui: { state: 'fresh', usable: true },
            scene: { state: 'snapshot-available', usable: true },
            lua: { state: 'ready', usable: true },
            api: { state: 'ready', usable: true },
            codeDelivery: { state: 'blocked', usable: false },
            gameplay: { state: 'unknown', usable: false },
          },
          scene: { snapshotId: 'a'.repeat(64), instances: 12, groups: 2, issues: 1 },
          cache: {
            fileCount: 9,
            totalBytes: 3_000_000_000,
            warning: 'over-budget',
            largestFiles: [{ relativePath: '.yuanmeng-inspector/scene/snapshots/a.json', bytes: 2_000_000_000 }],
          },
          nextActions: ['继续检查当前 Lua。'],
        },
        warnings: [],
      },
    });
    const gateway = createGateway(runCli);

    const result = await gateway.call('yuanmeng_task_context', {
      focus: '检查结算流程',
      changedFiles: ['src/GameEntry.lua'],
    }, new AbortController().signal);

    expect(runCli).toHaveBeenCalledTimes(1);
    expect(runCli.mock.calls[0]?.[0]).toEqual(['--project', 'C:\\projects\\alpha', 'status']);
    expect(result).toMatchObject({
      tool: 'yuanmeng_task_context',
      ok: true,
      code: 'OK',
      data: {
        focus: { text: '检查结算流程', changedFiles: ['src/GameEntry.lua'] },
        readiness: { ui: { state: 'fresh', usable: true }, lua: { state: 'ready', usable: true } },
        scene: { available: true, instances: 12, groups: 2 },
        cache: { fileCount: 9, warning: 'over-budget' },
      },
    });
    expect(JSON.stringify(result)).not.toMatch(/[A-Za-z]:\\/u);
    expect(JSON.stringify(result)).not.toContain('a'.repeat(64));
  });

  it('reuses the short-lived task-context source snapshot for adjacent calls', async () => {
    const runCli = vi.fn().mockResolvedValue({
      exitCode: 0,
      envelope: {
        schemaVersion: 1,
        ok: true,
        code: 'OK',
        message: '工程状态可用。',
        data: { freshness: 'fresh', readiness: { lua: { state: 'ready', usable: true } } },
        warnings: [],
      },
    });
    const gateway = createGateway(runCli);
    await gateway.call('yuanmeng_task_context', { focus: '第一次' }, new AbortController().signal);
    await gateway.call('yuanmeng_task_context', { focus: '第二次' }, new AbortController().signal);
    expect(runCli).toHaveBeenCalledTimes(1);
  });

  it('does not recommend tools hidden by the selected MCP profile', async () => {
    const runCli = vi.fn().mockResolvedValue({
      exitCode: 0,
      envelope: {
        schemaVersion: 1,
        ok: true,
        code: 'OK',
        message: '工程状态可用。',
        data: { freshness: 'fresh' },
        warnings: [],
      },
    });
    const gateway = new McpGateway({
      projectRoot: 'C:\\projects\\alpha',
      projectInstanceId: PROJECT_ID,
      displayName: 'Alpha',
      currentCliPath: 'C:\\extension\\out\\cli.cjs',
      runCli,
      toolProfile: 'scene',
    });
    const result = await gateway.call('yuanmeng_task_context', {}, new AbortController().signal);
    expect(result.data).toMatchObject({ recommendedTools: ['yuanmeng_project_status', 'yuanmeng_scene_status', 'yuanmeng_scene_find'] });
  });

  it('pages registry records with a cursor bound to the same project and query', async () => {
    const runCli = vi.fn().mockResolvedValue({
      exitCode: 0,
      envelope: {
        schemaVersion: 1,
        ok: true,
        code: 'OK',
        message: '三条记录',
        data: {
          freshness: 'fresh',
          records: [
            { recordId: 'c', value: '3' },
            { recordId: 'a', value: '1' },
            { recordId: 'b', value: '2' }
          ]
        },
        warnings: []
      }
    });
    const gateway = createGateway(runCli);

    const first = await gateway.call('yuanmeng_ids_list', { limit: 2 }, new AbortController().signal);
    expect(first).toMatchObject({
      data: { records: [{ recordId: 'a' }, { recordId: 'b' }] },
      page: { count: 2, total: 3, nextCursor: expect.any(String) }
    });
    const second = await gateway.call('yuanmeng_ids_list', {
      limit: 2,
      cursor: first.page?.nextCursor
    }, new AbortController().signal);
    expect(second).toMatchObject({
      data: { records: [{ recordId: 'c' }] },
      page: { count: 1, total: 3 }
    });
  });

  it('rejects a tampered pagination cursor instead of returning a mismatched page', async () => {
    const runCli = vi.fn().mockResolvedValue({
      exitCode: 0,
      envelope: { schemaVersion: 1, ok: true, code: 'OK', message: '记录', data: { freshness: 'fresh', records: [{ recordId: 'a' }, { recordId: 'b' }] }, warnings: [] }
    });
    const gateway = createGateway(runCli);
    const first = await gateway.call('yuanmeng_ids_list', { limit: 1 }, new AbortController().signal);
    const cursor = first.page?.nextCursor ?? '';
    const tampered = `${cursor.slice(0, -1)}${cursor.endsWith('a') ? 'b' : 'a'}`;

    const result = await gateway.call('yuanmeng_ids_list', { limit: 1, cursor: tampered }, new AbortController().signal);

    expect(result).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' });
  });

  it('records one sanitized local feedback item after the same actionable MCP failure repeats twice', async () => {
    const failure = {
      exitCode: 6,
      envelope: {
        schemaVersion: 1,
        ok: false,
        code: 'VALIDATION_FAILED',
        message: '具体路径和输入不得进入自动反馈',
        data: { reasonCode: 'BROKEN_CONTRACT', evidence: 'STATIC_LOCAL' },
        warnings: []
      }
    };
    const runCli = vi.fn()
      .mockResolvedValueOnce(failure)
      .mockResolvedValueOnce(failure)
      .mockResolvedValueOnce({ exitCode: 0, envelope: { schemaVersion: 1, ok: true, code: 'OK', message: '反馈已保存', data: {}, warnings: [] } })
      .mockResolvedValueOnce(failure);
    const gateway = createGateway(runCli);

    await gateway.call('yuanmeng_scene_tree', { instanceId: '517' }, new AbortController().signal);
    await gateway.call('yuanmeng_scene_tree', { instanceId: '517' }, new AbortController().signal);
    await gateway.call('yuanmeng_scene_tree', { instanceId: '517' }, new AbortController().signal);

    const feedbackCalls = runCli.mock.calls.filter((call) => (call[0] as string[]).includes('feedback'));
    expect(feedbackCalls).toHaveLength(1);
    expect(feedbackCalls[0]?.[0]).toEqual([
      '--project', 'C:\\projects\\alpha',
      'feedback', 'add', 'bug',
      'MCP 重复失败：yuanmeng_scene_tree/VALIDATION_FAILED',
      '--message', 'tool=yuanmeng_scene_tree; code=VALIDATION_FAILED; reason=BROKEN_CONTRACT; count=2'
    ]);
  });
  it('runs status and full audit for a small task, records gameplay-skipped, and never packages', async () => {
    const runCli = vi.fn()
      .mockResolvedValueOnce({
        exitCode: 0,
        envelope: { schemaVersion: 1, ok: true, code: 'OK', message: '状态可用', data: { evidence: 'STATIC_LOCAL', freshness: 'fresh' }, warnings: [] }
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        envelope: { schemaVersion: 1, ok: true, code: 'OK', message: '审计通过', data: { evidence: 'STATIC_LOCAL', issueCounts: { error: 0 } }, warnings: [] }
      });

    const result = await createGateway(runCli).call(
      'yuanmeng_task_completion_check' as YuanmengMcpToolName,
      { taskClass: 'small', failureCount: 0, focus: '只改文案' },
      new AbortController().signal
    );

    expect(result).toMatchObject({
      ok: true,
      code: 'OK',
      data: {
        classification: 'gameplay-skipped',
        packaged: false,
        staticAudit: { code: 'OK' }
      }
    });
    expect(runCli.mock.calls.map((call) => call[0])).toEqual([
      ['--project', 'C:\\projects\\alpha', 'status'],
      ['--project', 'C:\\projects\\alpha', 'audit']
    ]);
  });

  it('forces automatic gameplay after two failures without requiring confirmed input files', async () => {
    const runCli = vi.fn()
      .mockResolvedValueOnce({
        exitCode: 0,
        envelope: { schemaVersion: 1, ok: true, code: 'OK', message: '状态可用', data: { evidence: 'STATIC_LOCAL', freshness: 'fresh' }, warnings: [] }
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        envelope: { schemaVersion: 1, ok: true, code: 'OK', message: '审计通过', data: { evidence: 'STATIC_LOCAL' }, warnings: [] }
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        envelope: { schemaVersion: 1, ok: true, code: 'OK', message: '自动模拟完成', data: {
          mode: 'auto', classification: 'partial-needs-editor', strictStaticGate: 'pass', simulationGate: 'pass'
        }, warnings: ['仍需编辑器验证'] }
      });

    const result = await createGateway(runCli).call(
      'yuanmeng_task_completion_check' as YuanmengMcpToolName,
      { taskClass: 'small', failureCount: 2 },
      new AbortController().signal
    );

    expect(result).toMatchObject({
      ok: true,
      code: 'OK',
      data: {
        classification: 'partial-needs-editor',
        requiredBy: 'repeated-failure',
        packaged: false
      }
    });
    expect(runCli.mock.calls.map((call) => call[0])).toEqual([
      ['--project', 'C:\\projects\\alpha', 'status'],
      ['--project', 'C:\\projects\\alpha', 'audit'],
      ['--project', 'C:\\projects\\alpha', 'gameplay-test']
    ]);
  });

  it('continues automatic gameplay when the full audit is blocked and reports both outcomes', async () => {
    const runCli = vi.fn()
      .mockResolvedValueOnce({
        exitCode: 0,
        envelope: { schemaVersion: 1, ok: true, code: 'OK', message: '状态可用', data: { evidence: 'STATIC_LOCAL' }, warnings: [] }
      })
      .mockResolvedValueOnce({
        exitCode: 6,
        envelope: { schemaVersion: 1, ok: false, code: 'VALIDATION_FAILED', message: '备份文件有错误', data: { evidence: 'STATIC_LOCAL' }, warnings: ['strict blocked'] }
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        envelope: { schemaVersion: 1, ok: true, code: 'OK', message: '生产流程模型通过', data: {
          mode: 'auto', classification: 'model-pass', strictStaticGate: 'blocked', simulationGate: 'pass'
        }, warnings: [] }
      });

    const result = await createGateway(runCli).call(
      'yuanmeng_task_completion_check',
      { taskClass: 'complex', failureCount: 0, focus: '任务链', changedFiles: ['src/GameEntry.lua'] },
      new AbortController().signal
    );

    expect(result).toMatchObject({
      ok: true, code: 'OK',
      data: {
        classification: 'model-pass',
        staticAudit: { ok: false, code: 'VALIDATION_FAILED' },
        gameplayTest: { data: { strictStaticGate: 'blocked', simulationGate: 'pass' } },
      },
    });
    expect(runCli.mock.calls[2]?.[0]).toEqual([
      '--project', 'C:\\projects\\alpha', 'gameplay-test', '--focus', '任务链', '--file', 'src/GameEntry.lua'
    ]);
  });

  it.each([
    ['model-pass', true, 'OK'],
    ['partial-needs-editor', true, 'OK'],
    ['model-fail', false, 'CHECK_FAILED'],
    ['not-run-fatal', false, 'CHECK_FAILED'],
  ] as const)('uses the CLI gameplay classification %s without re-inferring it', async (classification, ok, code) => {
    const runCli = vi.fn()
      .mockResolvedValueOnce({ exitCode: 0, envelope: { schemaVersion: 1, ok: true, code: 'OK', message: '状态', data: {}, warnings: [] } })
      .mockResolvedValueOnce({ exitCode: 0, envelope: { schemaVersion: 1, ok: true, code: 'OK', message: '审计', data: {}, warnings: [] } })
      .mockResolvedValueOnce({
        exitCode: ok ? 0 : 6,
        envelope: { schemaVersion: 1, ok, code: ok ? 'OK' : 'VALIDATION_FAILED', message: '玩法', data: { classification }, warnings: [] },
      });
    const result = await createGateway(runCli).call(
      'yuanmeng_task_completion_check', { taskClass: 'multiplayer', failureCount: 0 }, new AbortController().signal,
    );
    expect(result).toMatchObject({ ok, code, data: { classification } });
  });

  it('validates latest and returns only a bounded current gameplay manifest summary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ymai-mcp-gameplay-status-'));
    temporaryRoots.push(root);
    const model: GameplayModel = {
      schemaVersion: 1, modelId: 'mcp-status-model',
      project: { projectInstanceId: PROJECT_ID, mapFingerprint: null, sceneSnapshotId: null, knowledgeFingerprint: 'b'.repeat(64) },
      externalEvents: ['status.event'],
      eventPolicies: [{ event: 'status.event', authority: 'server-only', playerRequired: false, duplicatePolicy: 'allow', targetSide: 'server', observableEffectRequired: true }],
      initialState: { shared: { done: false }, player: {}, client: {} },
      handlers: [{ handlerId: 'status-handler', event: 'status.event', side: 'server', branches: [{
        branchId: 'status-branch', effects: [{ kind: 'set', target: { scope: 'shared', path: 'done' }, value: { kind: 'literal', value: true } }],
      }] }],
      invariants: [], evidenceRequirements: [],
    };
    const scenario: GameplayScenario = {
      schemaVersion: 1, scenarioId: 'status-scenario', name: 'status',
      modelBinding: { modelId: model.modelId, modelFingerprint: gameplayModelFingerprint(model), ...model.project },
      players: ['p1'], limits: { maxEvents: 10, maxVirtualMilliseconds: 100, maxVisitedStates: 10, maxBranches: 10 },
      steps: [{ kind: 'dispatch', event: 'status.event', source: 'server', targetSide: 'server' }],
    };
    await new GameplayRunStore({
      io: createNodeGameplayRunStoreIO(nodeFileIO), runIdFactory: () => 'mcp-current-run',
    }).commit({
      root, mode: 'auto', project: model.project, model, scenarios: [scenario],
      strictReview: { safe: true }, strictReviewMarkdown: '# strict\n',
      simulationReport: { safe: true }, simulationReportMarkdown: '# report\n',
      strictStaticGate: 'blocked', simulationGate: 'pass', classification: 'partial-needs-editor',
    });
    const gateway = new McpGateway({
      projectRoot: root, projectInstanceId: PROJECT_ID, displayName: 'Alpha',
      currentCliPath: 'C:\\extension\\out\\cli.cjs', runCli: vi.fn(),
    });

    const current = await gateway.call('yuanmeng_gameplay_status', {}, new AbortController().signal);
    expect(current).toMatchObject({
      ok: true, code: 'OK', evidence: { freshness: 'fresh' },
      data: { status: 'current', run: {
        runId: 'mcp-current-run', classification: 'partial-needs-editor', strictStaticGate: 'blocked', simulationGate: 'pass', artifactCount: 6,
      } },
    });
    expect(JSON.stringify(current)).not.toContain(root);

    await writeFile(join(root, '.yuanmeng-inspector', 'gameplay', 'runs', 'mcp-current-run', 'simulation-report.md'), 'damaged', 'utf8');
    expect(await gateway.call('yuanmeng_gameplay_status', {}, new AbortController().signal)).toMatchObject({
      ok: false, code: 'STALE', data: { status: 'stale', reasonCode: 'GAMEPLAY_RUN_INTEGRITY_FAILED' },
    });
  });

  it('passes AbortSignal into automatic gameplay and leaves the previous latest byte-identical when cancelled', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ymai-mcp-gameplay-cancel-'));
    temporaryRoots.push(root);
    const latestPath = join(root, '.yuanmeng-inspector', 'gameplay', 'latest.json');
    await mkdir(join(root, '.yuanmeng-inspector', 'gameplay'), { recursive: true });
    await writeFile(latestPath, '{"old":true}\n', 'utf8');
    const before = await readFile(latestPath);
    const controller = new AbortController();
    const runCli = vi.fn()
      .mockResolvedValueOnce({ exitCode: 0, envelope: { schemaVersion: 1, ok: true, code: 'OK', message: '状态', data: {}, warnings: [] } })
      .mockResolvedValueOnce({ exitCode: 0, envelope: { schemaVersion: 1, ok: true, code: 'OK', message: '审计', data: {}, warnings: [] } })
      .mockImplementationOnce(async (_args: readonly string[], dependencies: { signal?: AbortSignal }) => {
        expect(dependencies.signal).toBe(controller.signal);
        controller.abort();
        return { exitCode: 6, envelope: { schemaVersion: 1, ok: false, code: 'VALIDATION_FAILED', message: '取消', data: null, warnings: [] } };
      });
    const gateway = new McpGateway({
      projectRoot: root, projectInstanceId: PROJECT_ID, displayName: 'Alpha', currentCliPath: 'C:\\extension\\out\\cli.cjs', runCli,
    });

    const result = await gateway.call('yuanmeng_task_completion_check', { taskClass: 'complex', failureCount: 0 }, controller.signal);
    expect(result).toMatchObject({ ok: false, code: 'VALIDATION_FAILED', summary: expect.stringMatching(/取消/u) });
    expect(await readFile(latestPath)).toEqual(before);
  });

  it('routes automatic code delivery through the Extension Host bridge, not runCli', async () => {
    const runCli = vi.fn();
    const codeDelivery = { deliver: vi.fn().mockResolvedValue({
      projectPath: 'C:\\projects\\alpha', savedFiles: [], dirtyBefore: [], dirtyAfter: [],
      commandAvailable: true, buildStartedAt: '2026-08-22T06:00:00.000Z', artifactChanges: [{}],
      officialOutputEvidence: [], status: 'BUILT', nextAction: '继续编辑器验证', evidenceLevel: 'EXTENSION_HOST'
    }) };
    const gateway = new McpGateway({
      projectRoot: 'C:\\projects\\alpha', projectInstanceId: PROJECT_ID, displayName: 'Alpha',
      currentCliPath: 'C:\\extension\\out\\cli.cjs', runCli, codeDelivery
    });

    const result = await gateway.call('yuanmeng_build_and_send_code', {}, new AbortController().signal);
    expect(result).toMatchObject({ ok: true, code: 'OK', data: { status: 'BUILT' } });
    expect(codeDelivery.deliver).toHaveBeenCalledOnce();
    expect(runCli).not.toHaveBeenCalled();
  });

  it('calls runCli in-process without spawn, exec, or fork', async () => {
    const runCli = vi.fn().mockResolvedValue({
      exitCode: 0,
      envelope: { schemaVersion: 1, ok: true, code: 'OK', message: '可用', data: null, warnings: [] }
    });

    const result = await createGateway(runCli).call('yuanmeng_project_status', {}, new AbortController().signal);

    expect(result.code).toBe('OK');
    expect(runCli).toHaveBeenCalledWith(
      ['--project', 'C:\\projects\\alpha', 'status'],
      expect.objectContaining({ cwd: 'C:\\projects\\alpha' })
    );
    expect(childProcessSpies.spawn).not.toHaveBeenCalled();
    expect(childProcessSpies.exec).not.toHaveBeenCalled();
    expect(childProcessSpies.fork).not.toHaveBeenCalled();
  });

  it.each<readonly [CliCode, boolean]>([
    ['OK', true],
    ['OFFLINE', false],
    ['STALE', false],
    ['AMBIGUOUS', false],
    ['NOT_FOUND', false],
    ['VALIDATION_FAILED', false],
    ['INTERNAL_ERROR', false]
  ])('preserves CLI code %s and success state', async (code, ok) => {
    const runCli = vi.fn().mockResolvedValue({
      exitCode: ok ? 0 : 8,
      envelope: {
        schemaVersion: 1,
        ok,
        code,
        message: `结果 ${code}`,
        data: {
          reasonCode: `REASON_${code}`,
          evidence: 'STATIC_LOCAL',
          freshness: code === 'STALE' ? 'stale' : 'fresh',
          nextActions: ['刷新当前工程']
        },
        warnings: ['保留警告']
      }
    });

    const result = await createGateway(runCli).call('yuanmeng_project_status', {}, new AbortController().signal);

    expect(result).toMatchObject({
      ok,
      code,
      warnings: ['保留警告'],
      evidence: { level: 'STATIC_LOCAL' },
      data: { reasonCode: `REASON_${code}` }
    });
    expect(result.nextActions).toEqual([
      expect.objectContaining({ label: '刷新当前工程' })
    ]);
  });

  it('faithfully forwards a structured Lua validation failure from project audit', async () => {
    const runCli = vi.fn().mockResolvedValue({
      exitCode: 6,
      envelope: {
        schemaVersion: 1,
        ok: false,
        code: 'VALIDATION_FAILED',
        message: 'Lua 语法无效：src/Client/Broken_backup.lua',
        data: {
          reasonCode: 'INVALID_LUA_SYNTAX',
          file: 'src/Client/Broken_backup.lua',
          nextActions: ['修正 Lua 源文件或索引配置后重试。'],
          evidence: 'STATIC_LOCAL'
        },
        warnings: []
      }
    });

    const result = await createGateway(runCli).call('yuanmeng_project_audit', {}, new AbortController().signal);

    expect(result).toMatchObject({
      ok: false,
      code: 'VALIDATION_FAILED',
      data: {
        reasonCode: 'INVALID_LUA_SYNTAX',
        file: 'src/Client/Broken_backup.lua'
      },
      evidence: { level: 'STATIC_LOCAL' }
    });
  });

  it('returns VALIDATION_FAILED without calling the CLI for invalid input', async () => {
    const runCli = vi.fn();
    const result = await createGateway(runCli).call(
      'yuanmeng_scene_tree',
      { instanceId: Number('9007199254740993') },
      new AbortController().signal
    );

    expect(result.code).toBe('VALIDATION_FAILED');
    expect(runCli).not.toHaveBeenCalled();
  });
});
