import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { ZodError } from 'zod';

import { runCli as defaultRunCli, type CliDependencies } from '../cli/main.js';
import type { CliRunResult } from '../cli/output.js';
import type { Clock } from '../core/clock.js';
import type {
  McpEvidenceLevel,
  McpFreshness,
  McpNextAction,
  McpResultCode,
  YuanmengMcpEnvelope,
  YuanmengMcpToolName,
  YuanmengMcpToolProfile
} from './contracts.js';
import { toolsForMcpProfile } from './contracts.js';
import { toolToCliArgs } from './tool-schemas.js';
import { MCP_TOOL_INPUT_SCHEMAS } from './tool-schemas.js';
import { FileCodeDeliveryClient } from './code-delivery.js';
import type { CodeDeliveryResult } from '../extension/code-delivery.js';
import { stableJson } from '../core/hash.js';
import { nodeFileIO } from '../core/fs.js';
import { createNodeGameplayRunStoreIO, GameplayRunStore } from '../core/gameplay/run-store.js';
import type { GameplayModel, GameplayRunClassification } from '../core/gameplay/types.js';
import { inspectOfficialSources, type OfficialSourceIndex } from '../core/environment/official-sources.js';
import { CursorError, decodeCursor, paginateItems } from './pagination.js';

type RunCli = (argv: readonly string[], dependencies?: Partial<CliDependencies>) => Promise<CliRunResult>;

const TASK_CONTEXT_CACHE_MILLISECONDS = 1_500;

interface TaskContextSources {
  status: CliRunResult;
  gameplay: YuanmengMcpEnvelope<unknown>;
  official: OfficialSourceIndex;
}

export interface McpGatewayOptions {
  readonly projectRoot: string;
  readonly projectInstanceId: string;
  readonly displayName: string | null;
  readonly currentCliPath: string;
  readonly projectRootHash?: string;
  readonly toolProfile?: YuanmengMcpToolProfile;
  readonly clock?: Clock;
  readonly runCli?: RunCli;
  readonly codeDelivery?: { deliver(signal: AbortSignal): Promise<CodeDeliveryResult> };
}

function objectData(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function evidenceLevel(value: unknown): McpEvidenceLevel {
  switch (value) {
    case 'STATIC_LOCAL': return 'STATIC_LOCAL';
    case 'EXTENSION_HOST': return 'EXTENSION_HOST';
    case 'STANDALONE_LOG': return 'STANDALONE_LOG';
    case 'OFFICIAL_EDITOR_SINGLE': return 'OFFICIAL_EDITOR_SINGLE';
    case 'OFFICIAL_EDITOR_MULTI': return 'MULTIPLAYER_RUNTIME';
    default: return 'UNKNOWN';
  }
}

function freshness(code: string, value: unknown): McpFreshness {
  if (value === 'fresh' || value === 'stale' || value === 'missing' || value === 'unknown') return value;
  if (code === 'STALE') return 'stale';
  if (code === 'OFFLINE') return 'missing';
  return 'unknown';
}

function nextActions(value: unknown): McpNextAction[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string' && item.length > 0)
    .slice(0, 20)
    .map((label) => ({ kind: 'run-vscode-command' as const, label }));
}

function shortSha(value: unknown): string | null {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value) ? value.slice(0, 12) : null;
}

function compactReadiness(value: unknown): Record<string, unknown> {
  const source = objectData(value);
  if (source === null) return {};
  const output: Record<string, unknown> = {};
  for (const key of ['ui', 'scene', 'lua', 'api', 'codeDelivery', 'gameplay']) {
    const item = objectData(source[key]);
    if (item === null) continue;
    output[key] = {
      ...(typeof item.state === 'string' ? { state: item.state } : {}),
      ...(typeof item.usable === 'boolean' ? { usable: item.usable } : {}),
      ...(typeof item.freshness === 'string' ? { freshness: item.freshness } : {}),
    };
  }
  return output;
}

function compactCache(value: unknown): Record<string, unknown> | null {
  const source = objectData(value);
  if (source === null) return null;
  const areas = Array.isArray(source.areas)
    ? source.areas
      .map((entry) => objectData(entry))
      .filter((entry): entry is Record<string, unknown> => entry !== null && typeof entry.area === 'string' && typeof entry.fileCount === 'number' && typeof entry.bytes === 'number' && entry.bytes > 0)
      .slice(0, 12)
      .map((entry) => ({ area: entry.area, fileCount: entry.fileCount, bytes: entry.bytes }))
    : [];
  const largestFiles = Array.isArray(source.largestFiles)
    ? source.largestFiles
      .map((entry) => objectData(entry))
      .filter((entry): entry is Record<string, unknown> => entry !== null && typeof entry.relativePath === 'string' && entry.relativePath.startsWith('.yuanmeng-inspector/') && typeof entry.bytes === 'number')
      .slice(0, 5)
      .map((entry) => ({ relativePath: entry.relativePath, bytes: entry.bytes }))
    : [];
  const protectedValue = objectData(source.protected);
  const gameplayRuns = objectData(protectedValue?.gameplayRuns);
  return {
    ...(typeof source.fileCount === 'number' ? { fileCount: source.fileCount } : {}),
    ...(typeof source.totalBytes === 'number' ? { totalBytes: source.totalBytes } : {}),
    ...(typeof source.warning === 'string' || source.warning === null ? { warning: source.warning } : {}),
    areas,
    largestFiles,
    ...(gameplayRuns === null ? {} : {
      protectedGameplayRuns: {
        ...(typeof gameplayRuns.fileCount === 'number' ? { fileCount: gameplayRuns.fileCount } : {}),
        ...(typeof gameplayRuns.bytes === 'number' ? { bytes: gameplayRuns.bytes } : {}),
      },
    }),
  };
}

function compactGameplayStatus(value: unknown): Record<string, unknown> {
  const source = objectData(value);
  if (source === null) return { status: 'unavailable' };
  const run = objectData(source.run);
  if (run === null) return { status: typeof source.status === 'string' ? source.status : 'unavailable' };
  return {
    status: typeof source.status === 'string' ? source.status : 'current',
    run: {
      ...(typeof run.runId === 'string' ? { runId: run.runId } : {}),
      ...(typeof run.mode === 'string' ? { mode: run.mode } : {}),
      ...(typeof run.classification === 'string' ? { classification: run.classification } : {}),
      ...(typeof run.strictStaticGate === 'string' ? { strictStaticGate: run.strictStaticGate } : {}),
      ...(typeof run.simulationGate === 'string' ? { simulationGate: run.simulationGate } : {}),
      ...(shortSha(run.modelFingerprint) === null ? {} : { modelFingerprintPrefix: shortSha(run.modelFingerprint) }),
      ...(shortSha(run.scenarioFingerprint) === null ? {} : { scenarioFingerprintPrefix: shortSha(run.scenarioFingerprint) }),
      ...(shortSha(run.knowledgeFingerprint) === null ? {} : { knowledgeFingerprintPrefix: shortSha(run.knowledgeFingerprint) }),
      ...(typeof run.artifactCount === 'number' ? { artifactCount: run.artifactCount } : {}),
    },
  };
}

function compactOfficialSources(value: OfficialSourceIndex): Record<string, unknown> {
  return {
    extension: {
      state: value.extension.state,
      id: value.extension.id,
      version: value.extension.version,
      declarationCount: value.extension.declarationCount,
      hasEventsDeclaration: value.extension.hasEventsDeclaration,
      commands: value.extension.commands.slice(0, 64),
    },
    game: {
      state: value.game.state,
      version: value.game.version,
      versionSource: value.game.versionSource,
      staticConfig: {
        fileCount: value.game.staticConfig.fileCount,
        archiveCount: value.game.staticConfig.archiveCount,
        names: value.game.staticConfig.names.slice(0, 20),
      },
    },
    ugc: {
      state: value.ugc.state,
      projectRecordCount: value.ugc.projectRecordCount,
      usedBlockKeys: value.ugc.usedBlockKeys.slice(0, 20),
      scriptArchiveCount: value.ugc.scriptArchiveCount,
    },
    warnings: value.warnings.slice(0, 6),
  };
}

export class McpGateway {
  readonly #projectRoot: string;
  readonly #projectInstanceId: string;
  #displayName: string | null;
  readonly #currentCliPath: string;
  readonly #clock: Clock | undefined;
  readonly #runCli: RunCli;
  readonly #codeDelivery: { deliver(signal: AbortSignal): Promise<CodeDeliveryResult> };
  readonly #toolProfile: YuanmengMcpToolProfile;
  readonly #paginationSecret: Uint8Array;
  readonly #failureCounts = new Map<string, number>();
  readonly #recordedFailures = new Set<string>();
  #taskContextSourcesPromise: Promise<TaskContextSources> | null = null;
  #taskContextSourcesExpiresAt = 0;

  constructor(options: McpGatewayOptions) {
    this.#projectRoot = options.projectRoot;
    this.#projectInstanceId = options.projectInstanceId;
    this.#displayName = options.displayName;
    this.#currentCliPath = options.currentCliPath;
    this.#toolProfile = options.toolProfile ?? 'full';
    this.#clock = options.clock;
    this.#runCli = options.runCli ?? defaultRunCli;
    this.#paginationSecret = createHash('sha256')
      .update(`ymai-mcp-page-v1\0${options.projectInstanceId}\0${options.projectRootHash ?? options.projectRoot}`)
      .digest();
    this.#codeDelivery = options.codeDelivery ?? new FileCodeDeliveryClient({
      projectRoot: options.projectRoot,
      projectInstanceId: options.projectInstanceId,
      projectRootHash: options.projectRootHash ?? ''
    });
  }

  async call(
    tool: YuanmengMcpToolName,
    input: unknown,
    signal: AbortSignal
  ): Promise<YuanmengMcpEnvelope<unknown>> {
    const requestId = randomUUID();
    if (signal.aborted) return this.#cancelled(tool, requestId);

    // A separate tool may refresh or mutate project evidence. Do not let a
    // short task-context cache hide that change from the next context call.
    if (tool !== 'yuanmeng_task_context') {
      this.#taskContextSourcesPromise = null;
      this.#taskContextSourcesExpiresAt = 0;
    }

    if (tool === 'yuanmeng_task_context') {
      try {
        const parsed = MCP_TOOL_INPUT_SCHEMAS[tool].parse(input) as {
          focus?: string;
          changedFiles?: string[];
        };
        return await this.#taskContext(requestId, parsed, signal);
      } catch (error) {
        if (signal.aborted) return this.#cancelled(tool, requestId);
        const summary = error instanceof ZodError
          ? `工具输入校验失败：${error.issues[0]?.message ?? '输入无效。'}`
          : '读取紧凑任务上下文时发生未预期错误。';
        return this.#base(tool, requestId, false, error instanceof ZodError ? 'VALIDATION_FAILED' : 'INTERNAL_ERROR', summary, null, 'unknown');
      }
    }

    if (tool === 'yuanmeng_gameplay_status') {
      try {
        MCP_TOOL_INPUT_SCHEMAS[tool].parse(input);
        return await this.#gameplayStatus(requestId);
      } catch (error) {
        if (signal.aborted) return this.#cancelled(tool, requestId);
        const summary = error instanceof ZodError
          ? `工具输入校验失败：${error.issues[0]?.message ?? '输入无效。'}`
          : '读取玩法证据时发生未预期错误。';
        return this.#base(tool, requestId, false, error instanceof ZodError ? 'VALIDATION_FAILED' : 'INTERNAL_ERROR', summary, null, 'unknown');
      }
    }

    if (tool === 'yuanmeng_task_completion_check') {
      try {
        const parsed = MCP_TOOL_INPUT_SCHEMAS[tool].parse(input) as {
          taskClass: 'small' | 'complex' | 'multiplayer';
          failureCount: number;
          focus?: string;
          changedFiles?: string[];
        };
        return await this.#taskCompletionCheck(requestId, parsed, signal);
      } catch (error) {
        if (signal.aborted) return this.#cancelled(tool, requestId);
        const summary = error instanceof ZodError
          ? `工具输入校验失败：${error.issues[0]?.message ?? '输入无效。'}`
          : '任务完成检查发生未预期错误。';
        return this.#base(tool, requestId, false, error instanceof ZodError ? 'VALIDATION_FAILED' : 'INTERNAL_ERROR', summary, null, 'unknown');
      }
    }

    if (tool === 'yuanmeng_build_and_send_code') {
      try {
        MCP_TOOL_INPUT_SCHEMAS[tool].parse(input);
        const data = await this.#codeDelivery.deliver(signal);
        const code: McpResultCode = data.status === 'LINK_OFFLINE' ? 'LINK_OFFLINE'
          : data.status === 'COMMAND_UNAVAILABLE' ? 'COMMAND_UNAVAILABLE'
            : data.status === 'CHECK_FAILED' ? 'CHECK_FAILED'
              : data.status === 'EVIDENCE_INSUFFICIENT' ? 'EVIDENCE_INSUFFICIENT'
                : data.status === 'BUILT' || data.status === 'SENT' ? 'OK' : 'VALIDATION_FAILED';
        return {
          schemaVersion: 1,
          requestId,
          tool,
          ok: code === 'OK',
          code,
          summary: data.status === 'SENT' ? '官方输出明确报告工程代码已经发送。'
            : data.status === 'BUILT' ? '已观察到工程代码构建产物变化。'
              : data.nextAction,
          project: { projectInstanceId: this.#projectInstanceId, displayName: this.#displayName },
          evidence: { level: data.evidenceLevel, freshness: code === 'LINK_OFFLINE' ? 'missing' : 'fresh' },
          data,
          warnings: ['该流程不证明地图保存、地图发布或游戏内共享成功。'],
          nextActions: [{ kind: 'run-vscode-command', label: data.nextAction }]
        };
      } catch (error) {
        const summary = error instanceof ZodError
          ? `工具输入校验失败：${error.issues[0]?.message ?? '输入无效。'}`
          : '自动交付桥接发生未预期错误。';
        return this.#base(tool, requestId, false, error instanceof ZodError ? 'VALIDATION_FAILED' : 'INTERNAL_ERROR', summary, null, 'unknown');
      }
    }

    let cliArgs: readonly string[];
    let parsedInput: Record<string, unknown>;
    try {
      parsedInput = MCP_TOOL_INPUT_SCHEMAS[tool].parse(input) as Record<string, unknown>;
      cliArgs = toolToCliArgs(tool, parsedInput);
    } catch (error) {
      const summary = error instanceof ZodError
        ? `工具输入校验失败：${error.issues[0]?.message ?? '输入无效。'}`
        : '工具输入校验失败。';
      return this.#base(tool, requestId, false, 'VALIDATION_FAILED', summary, null, 'unknown');
    }

    try {
      const dependencies: Partial<CliDependencies> = {
        cwd: this.#projectRoot,
        currentCliPath: this.#currentCliPath,
        signal
      };
      if (this.#clock !== undefined) dependencies.clock = this.#clock;
      const result = await this.#runCli(
        ['--project', this.#projectRoot, ...cliArgs],
        dependencies
      );
      if (signal.aborted) return this.#cancelled(tool, requestId);

      const data = objectData(result.envelope.data);
      if (tool === 'yuanmeng_set_map_display_name' && result.envelope.ok && data !== null && typeof data.mapDisplayName === 'string') {
        this.#displayName = data.mapDisplayName;
      }
      const snapshotId = typeof data?.snapshotId === 'string' ? data.snapshotId : undefined;
      const envelope: YuanmengMcpEnvelope<unknown> = {
        schemaVersion: 1,
        requestId,
        tool,
        ok: result.envelope.ok,
        code: result.envelope.code,
        summary: result.envelope.message,
        project: {
          projectInstanceId: this.#projectInstanceId,
          displayName: this.#displayName
        },
        evidence: {
          level: evidenceLevel(data?.evidence),
          freshness: freshness(result.envelope.code, data?.freshness),
          ...(snapshotId === undefined ? {} : { snapshotId })
        },
        data: result.envelope.data,
        warnings: [...result.envelope.warnings],
        nextActions: nextActions(data?.nextActions)
      };
      const paged = this.#paginateEnvelope(tool, parsedInput, envelope);
      await this.#recordRepeatedFailure(paged);
      return paged;
    } catch (error) {
      if (signal.aborted) return this.#cancelled(tool, requestId);
      if (error instanceof CursorError) {
        return this.#base(tool, requestId, false, error.code, error.message, null, error.code === 'STALE' ? 'stale' : 'unknown');
      }
      return this.#base(tool, requestId, false, 'INTERNAL_ERROR', 'MCP 调用发生未预期错误。', null, 'unknown');
    }
  }

  #paginateEnvelope(
    tool: YuanmengMcpToolName,
    input: Readonly<Record<string, unknown>>,
    envelope: YuanmengMcpEnvelope<unknown>
  ): YuanmengMcpEnvelope<unknown> {
    const field = tool === 'yuanmeng_ids_list' ? 'records'
      : tool === 'yuanmeng_scene_types' ? 'entries'
        : tool === 'yuanmeng_scene_find' ? 'matches'
          : tool === 'yuanmeng_feedback_list' ? 'entries'
            : null;
    if (field === null || !envelope.ok) return envelope;
    const data = objectData(envelope.data);
    const items = data?.[field];
    if (!Array.isArray(items)) return envelope;
    const queryInput = { ...input };
    delete queryInput.cursor;
    const query = stableJson(queryInput);
    const snapshotId = typeof data?.snapshotId === 'string'
      ? data.snapshotId
      : createHash('sha256').update(stableJson(items)).digest('hex');
    const context = {
      projectInstanceId: this.#projectInstanceId,
      snapshotId,
      tool,
      query
    };
    const offset = typeof input.cursor === 'string'
      ? decodeCursor(input.cursor, context, this.#paginationSecret).offset
      : 0;
    const page = paginateItems(items, {
      ...context,
      secret: this.#paginationSecret,
      ...(typeof input.limit === 'number' ? { limit: input.limit } : {}),
      offset,
      sortKey: (item) => {
        const record = objectData(item);
        for (const key of ['recordId', 'elementTypeId', 'instanceId', 'feedbackId', 'id', 'value']) {
          if (typeof record?.[key] === 'string') return `${key}:${record[key]}`;
        }
        return stableJson(item);
      }
    });
    const nextData: Record<string, unknown> = { ...data, [field]: page.items };
    if (tool === 'yuanmeng_scene_types' && Array.isArray(data?.pendingCalibration)) {
      nextData.pendingCalibrationCount = data.pendingCalibration.length;
      const pageTypeKeys = new Set(page.items.map((item) => objectData(item)?.typeId ?? null));
      nextData.pendingCalibration = data.pendingCalibration.filter((value) => pageTypeKeys.has(objectData(value)?.typeId ?? null));
    }
    return { ...envelope, data: nextData, page: page.page };
  }

  async #recordRepeatedFailure(envelope: YuanmengMcpEnvelope<unknown>): Promise<void> {
    if (envelope.ok
      || envelope.tool.startsWith('yuanmeng_feedback_')
      || envelope.tool === 'yuanmeng_task_completion_check'
      || !['VALIDATION_FAILED', 'CHECK_FAILED', 'LINK_OFFLINE', 'COMMAND_UNAVAILABLE', 'INTERNAL_ERROR'].includes(envelope.code)) {
      return;
    }
    const reasonValue = objectData(envelope.data)?.reasonCode;
    const reason = typeof reasonValue === 'string' && /^[A-Z0-9_]{1,80}$/u.test(reasonValue)
      ? reasonValue
      : envelope.code;
    const key = `${envelope.tool}/${envelope.code}/${reason}`;
    const count = (this.#failureCounts.get(key) ?? 0) + 1;
    this.#failureCounts.set(key, count);
    if (count < 2 || this.#recordedFailures.has(key)) return;
    this.#recordedFailures.add(key);
    try {
      await this.#runCliCommand([
        'feedback', 'add', 'bug',
        `MCP 重复失败：${envelope.tool}/${envelope.code}`,
        '--message',
        `tool=${envelope.tool}; code=${envelope.code}; reason=${reason}; count=${count}`
      ]);
    } catch {
      // 反馈采集不能改变原始工具结果，也不能递归制造新反馈。
    }
  }

  async #runCliCommand(args: readonly string[], signal?: AbortSignal): Promise<CliRunResult> {
    const dependencies: Partial<CliDependencies> = {
      cwd: this.#projectRoot,
      currentCliPath: this.#currentCliPath
    };
    if (this.#clock !== undefined) dependencies.clock = this.#clock;
    if (signal !== undefined) dependencies.signal = signal;
    return this.#runCli(['--project', this.#projectRoot, ...args], dependencies);
  }

  async #gameplayStatus(requestId: string): Promise<YuanmengMcpEnvelope<unknown>> {
    const gameplayRoot = join(this.#projectRoot, '.yuanmeng-inspector', 'gameplay');
    let latestValue: unknown;
    try {
      latestValue = JSON.parse(await readFile(join(gameplayRoot, 'latest.json'), 'utf8')) as unknown;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return {
        schemaVersion: 1,
        requestId,
        tool: 'yuanmeng_gameplay_status',
        ok: false,
        code: 'STALE',
        summary: '当前玩法 latest 指针损坏，不能作为本次工程证据。',
        project: { projectInstanceId: this.#projectInstanceId, displayName: this.#displayName },
        evidence: { level: 'STATIC_LOCAL', freshness: 'stale' },
        data: { status: 'stale', reasonCode: 'GAMEPLAY_LATEST_INVALID' },
        warnings: [],
        nextActions: [{ kind: 'call-tool', label: '重新运行自动玩法模拟。', tool: 'yuanmeng_gameplay_test' }]
      };
      return {
        schemaVersion: 1,
        requestId,
        tool: 'yuanmeng_gameplay_status',
        ok: false,
        code: 'EVIDENCE_INSUFFICIENT',
        summary: '当前工程没有玩法审查或模拟报告。',
        project: { projectInstanceId: this.#projectInstanceId, displayName: this.#displayName },
        evidence: { level: 'STATIC_LOCAL', freshness: 'missing' },
        data: { status: 'missing', run: null },
        warnings: [],
        nextActions: [{ kind: 'call-tool', label: '运行自动玩法模拟。', tool: 'yuanmeng_gameplay_test' }]
      };
    }

    const latest = objectData(latestValue);
    const runId = typeof latest?.runId === 'string' && /^[a-z0-9][a-z0-9-]{0,127}$/u.test(latest.runId) ? latest.runId : null;
    if (runId === null || latest?.projectInstanceId !== this.#projectInstanceId) return {
      schemaVersion: 1,
      requestId,
      tool: 'yuanmeng_gameplay_status',
      ok: false,
      code: 'STALE',
      summary: '玩法 latest 指针不属于当前工程或格式无效。',
      project: { projectInstanceId: this.#projectInstanceId, displayName: this.#displayName },
      evidence: { level: 'STATIC_LOCAL', freshness: 'stale' },
      data: { status: 'stale', reasonCode: 'GAMEPLAY_PROJECT_BINDING_MISMATCH' },
      warnings: [],
      nextActions: [{ kind: 'call-tool', label: '在当前工程重新运行自动玩法模拟。', tool: 'yuanmeng_gameplay_test' }]
    };

    let manifestValue: unknown;
    try {
      manifestValue = JSON.parse(await readFile(join(gameplayRoot, 'runs', runId, 'manifest.json'), 'utf8')) as unknown;
    } catch {
      manifestValue = null;
    }
    const manifest = objectData(manifestValue);
    const project = objectData(manifest?.project);
    const expectedProject: GameplayModel['project'] | null = project !== null
      && typeof project.projectInstanceId === 'string'
      && (project.mapFingerprint === null || typeof project.mapFingerprint === 'string')
      && (project.sceneSnapshotId === null || typeof project.sceneSnapshotId === 'string')
      && typeof project.knowledgeFingerprint === 'string'
      ? {
        projectInstanceId: project.projectInstanceId,
        mapFingerprint: project.mapFingerprint as string | null,
        sceneSnapshotId: project.sceneSnapshotId as string | null,
        knowledgeFingerprint: project.knowledgeFingerprint,
      }
      : null;
    const store = new GameplayRunStore({ io: createNodeGameplayRunStoreIO(nodeFileIO) });
    const stored = expectedProject === null ? null : await store.readCurrent(this.#projectRoot, expectedProject);
    if (stored === null || expectedProject?.projectInstanceId !== this.#projectInstanceId) return {
      schemaVersion: 1,
      requestId,
      tool: 'yuanmeng_gameplay_status',
      ok: false,
      code: 'STALE',
      summary: '最新玩法运行包不完整、摘要不一致或已跨工程/知识指纹失配。',
      project: { projectInstanceId: this.#projectInstanceId, displayName: this.#displayName },
      evidence: { level: 'STATIC_LOCAL', freshness: 'stale' },
      data: { status: 'stale', reasonCode: 'GAMEPLAY_RUN_INTEGRITY_FAILED', runId },
      warnings: [],
      nextActions: [{ kind: 'call-tool', label: '重新运行自动玩法模拟以生成完整运行包。', tool: 'yuanmeng_gameplay_test' }]
    };
    return {
      schemaVersion: 1,
      requestId,
      tool: 'yuanmeng_gameplay_status',
      ok: true,
      code: 'OK',
      summary: '已校验当前工程最新玩法运行包及全部产物摘要。',
      project: { projectInstanceId: this.#projectInstanceId, displayName: this.#displayName },
      evidence: { level: 'STATIC_LOCAL', freshness: 'fresh' },
      data: {
        status: 'current',
        run: {
          runId: stored.manifest.runId,
          mode: stored.manifest.mode,
          classification: stored.manifest.classification,
          strictStaticGate: stored.manifest.strictStaticGate,
          simulationGate: stored.manifest.simulationGate,
          modelFingerprint: stored.manifest.modelFingerprint,
          scenarioFingerprint: stored.manifest.scenarioFingerprint,
          knowledgeFingerprint: stored.manifest.project.knowledgeFingerprint,
          artifactCount: Object.keys(stored.manifest.artifactSha256).length,
        },
      },
      warnings: ['模型模拟不等于官方编辑器或真实多人实测。'],
      nextActions: []
    };
  }

  async #taskContext(
    requestId: string,
    input: { focus?: string; changedFiles?: string[] },
    signal: AbortSignal,
  ): Promise<YuanmengMcpEnvelope<unknown>> {
    const { status, gameplay, official } = await this.#taskContextSources(signal, requestId);
    if (signal.aborted) return this.#cancelled('yuanmeng_task_context', requestId);
    const statusData = objectData(status.envelope.data);
    const readinessData = objectData(statusData?.readiness);
    const scene = objectData(statusData?.scene) ?? objectData(readinessData?.scene);
    const sceneSnapshotId = shortSha(scene?.snapshotId);
    const nextLabels = [
      ...(Array.isArray(statusData?.nextActions) ? statusData.nextActions : []),
      ...gameplay.nextActions.map((action) => action.label),
    ].filter((value): value is string => typeof value === 'string' && value.length > 0);
    const warnings = [...new Set([
      ...status.envelope.warnings,
      ...gameplay.warnings,
      ...official.warnings,
      '这是有界只读上下文；需要修改、刷新或运行测试时必须单独调用对应工具。',
    ])].slice(0, 8);
    const code: McpResultCode = status.envelope.ok
      ? 'OK'
      : status.envelope.code === 'STALE' ? 'STALE'
        : status.envelope.code === 'OFFLINE' ? 'OFFLINE'
          : 'EVIDENCE_INSUFFICIENT';
    return {
      schemaVersion: 1,
      requestId,
      tool: 'yuanmeng_task_context',
      ok: code === 'OK',
      code,
      summary: code === 'OK' ? '已读取当前工程的紧凑任务上下文。' : '已读取紧凑上下文，但工程状态仍需先处理。',
      project: { projectInstanceId: this.#projectInstanceId, displayName: this.#displayName },
      evidence: { level: 'STATIC_LOCAL', freshness: freshness(status.envelope.code, statusData?.freshness) },
      data: {
        schemaVersion: 1,
        focus: {
          text: input.focus ?? null,
          changedFiles: [...new Set((input.changedFiles ?? []).map((file) => file.replace(/\\/gu, '/')))].slice(0, 100),
        },
        readiness: compactReadiness(statusData?.readiness),
        scene: {
          available: scene?.usable === true || typeof scene?.instances === 'number',
          ...(sceneSnapshotId === null ? {} : { snapshotIdPrefix: sceneSnapshotId }),
          ...(typeof scene?.instances === 'number' ? { instances: scene.instances } : {}),
          ...(typeof scene?.groups === 'number' ? { groups: scene.groups } : {}),
          ...(typeof scene?.issues === 'number' ? { issues: scene.issues } : {}),
        },
        cache: compactCache(statusData?.cache),
        official: compactOfficialSources(official),
        gameplay: compactGameplayStatus(gameplay.data),
        status: {
          code: status.envelope.code,
          link: objectData(statusData?.link)?.state ?? null,
          linkEvidence: typeof statusData?.linkEvidence === 'string' ? statusData.linkEvidence : null,
          uiFreshness: typeof statusData?.freshness === 'string' ? statusData.freshness : null,
        },
        recommendedTools: ([
          'yuanmeng_project_status',
          'yuanmeng_scene_status',
          'yuanmeng_project_audit',
          'yuanmeng_ui_resolve',
          'yuanmeng_scene_find',
          'yuanmeng_gameplay_test',
        ] as YuanmengMcpToolName[]).filter((tool) => toolsForMcpProfile(this.#toolProfile).includes(tool)),
      },
      warnings,
      nextActions: [...new Set(nextLabels)].slice(0, 8).map((label) => ({ kind: 'call-tool' as const, label })),
    };
  }

  async #taskContextSources(signal: AbortSignal, requestId: string): Promise<TaskContextSources> {
    const now = this.#clock?.now().getTime() ?? Date.now();
    if (this.#taskContextSourcesPromise !== null && now < this.#taskContextSourcesExpiresAt) {
      return this.#taskContextSourcesPromise;
    }
    const promise = Promise.all([
      this.#runCliCommand(['status'], signal),
      this.#gameplayStatus(`${requestId}-gameplay`),
      inspectOfficialSources({
        ...(process.env.VSCODE_EXTENSIONS === undefined ? {} : { extensionsRoot: process.env.VSCODE_EXTENSIONS }),
        officialExtensionPath: process.env.YMAI_OFFICIAL_EXTENSION_PATH ?? null,
        gameInstallPath: process.env.YMAI_GAME_INSTALL_PATH ?? null,
        ugcDataPath: process.env.YMAI_UGC_DATA_PATH ?? null,
      }),
    ]).then(([status, gameplay, official]) => ({ status, gameplay, official }));
    this.#taskContextSourcesPromise = promise;
    this.#taskContextSourcesExpiresAt = now + TASK_CONTEXT_CACHE_MILLISECONDS;
    void promise.then(
      () => undefined,
      () => {
        if (this.#taskContextSourcesPromise === promise) {
          this.#taskContextSourcesPromise = null;
          this.#taskContextSourcesExpiresAt = 0;
        }
      },
    );
    return promise;
  }

  async #taskCompletionCheck(
    requestId: string,
    input: { taskClass: 'small' | 'complex' | 'multiplayer'; failureCount: number; focus?: string; changedFiles?: string[] },
    signal: AbortSignal
  ): Promise<YuanmengMcpEnvelope<unknown>> {
    const status = await this.#runCliCommand(['status'], signal);
    if (signal.aborted) return this.#cancelled('yuanmeng_task_completion_check', requestId);
    const statusData = objectData(status.envelope.data);
    if (!status.envelope.ok) {
      return {
        schemaVersion: 1,
        requestId,
        tool: 'yuanmeng_task_completion_check',
        ok: false,
        code: status.envelope.code as McpResultCode,
        summary: status.envelope.message,
        project: { projectInstanceId: this.#projectInstanceId, displayName: this.#displayName },
        evidence: { level: evidenceLevel(statusData?.evidence), freshness: freshness(status.envelope.code, statusData?.freshness) },
        data: { classification: 'gameplay-not-run', packaged: false, projectStatus: status.envelope },
        warnings: [...status.envelope.warnings],
        nextActions: nextActions(statusData?.nextActions)
      };
    }
    const audit = await this.#runCliCommand(['audit'], signal);
    if (signal.aborted) return this.#cancelled('yuanmeng_task_completion_check', requestId);
    const auditData = objectData(audit.envelope.data);
    const staticAudit = { code: audit.envelope.code, ok: audit.envelope.ok, summary: audit.envelope.message, data: audit.envelope.data };
    const repeatedFailure = input.failureCount >= 2;
    const gameplayRequired = repeatedFailure || input.taskClass !== 'small';
    if (!audit.envelope.ok && !gameplayRequired) {
      return {
        schemaVersion: 1,
        requestId,
        tool: 'yuanmeng_task_completion_check',
        ok: false,
        code: 'CHECK_FAILED',
        summary: '全量静态审计未通过；本次小型任务不满足自动玩法模拟升级条件。',
        project: { projectInstanceId: this.#projectInstanceId, displayName: this.#displayName },
        evidence: { level: evidenceLevel(auditData?.evidence), freshness: 'fresh' },
        data: { classification: 'gameplay-not-run', packaged: false, staticAudit },
        warnings: [...audit.envelope.warnings],
        nextActions: nextActions(auditData?.nextActions)
      };
    }
    if (!gameplayRequired) {
      return {
        schemaVersion: 1,
        requestId,
        tool: 'yuanmeng_task_completion_check',
        ok: true,
        code: 'OK',
        summary: '工程状态与全量静态审计已通过；本次小型非玩法修改记录为跳过玩法模拟。',
        project: { projectInstanceId: this.#projectInstanceId, displayName: this.#displayName },
        evidence: { level: 'STATIC_LOCAL', freshness: 'fresh' },
        data: { classification: 'gameplay-skipped', requiredBy: null, packaged: false, focus: input.focus ?? null, changedFiles: input.changedFiles ?? [], staticAudit },
        warnings: ['未运行官方编辑器或多人测试。'],
        nextActions: []
      };
    }
    const gameplayArgs = ['gameplay-test'];
    if (input.focus !== undefined) gameplayArgs.push('--focus', input.focus);
    for (const file of input.changedFiles ?? []) gameplayArgs.push('--file', file);
    const tested = await this.#runCliCommand(gameplayArgs, signal);
    if (signal.aborted) return this.#cancelled('yuanmeng_task_completion_check', requestId);
    const testedData = objectData(tested.envelope.data);
    const rawClassification = testedData?.classification;
    const classification: GameplayRunClassification = rawClassification === 'model-pass'
      || rawClassification === 'partial-needs-editor'
      || rawClassification === 'model-fail'
      || rawClassification === 'not-run-fatal'
      ? rawClassification
      : 'not-run-fatal';
    const gameplayPassed = classification === 'model-pass' || classification === 'partial-needs-editor';
    return {
      schemaVersion: 1,
      requestId,
      tool: 'yuanmeng_task_completion_check',
      ok: gameplayPassed,
      code: gameplayPassed ? 'OK' : 'CHECK_FAILED',
      summary: gameplayPassed
        ? audit.envelope.ok
          ? '全量静态审计和自动玩法模型自检均已完成；仍需官方编辑器/多人证据。'
          : '全量静态审计仍有问题，但可建模生产流程已完成自动模拟；两类结果均已保留。'
        : '自动玩法准备或模型自检未通过。',
      project: { projectInstanceId: this.#projectInstanceId, displayName: this.#displayName },
      evidence: { level: 'STATIC_LOCAL', freshness: 'fresh' },
      data: {
        classification,
        requiredBy: repeatedFailure ? 'repeated-failure' : input.taskClass,
        packaged: false,
        staticAudit,
        gameplayTest: tested.envelope,
      },
      warnings: [...audit.envelope.warnings, ...tested.envelope.warnings, '模型模拟不替代官方编辑器或真实多人实测。'],
      nextActions: nextActions(testedData?.nextActions)
    };
  }

  #cancelled(tool: YuanmengMcpToolName, requestId: string): YuanmengMcpEnvelope<null> {
    return this.#base(tool, requestId, false, 'VALIDATION_FAILED', '请求已取消；未返回可能过期的结果。', null, 'unknown');
  }

  #base(
    tool: YuanmengMcpToolName,
    requestId: string,
    ok: boolean,
    code: McpResultCode,
    summary: string,
    data: null,
    currentFreshness: McpFreshness
  ): YuanmengMcpEnvelope<null> {
    return {
      schemaVersion: 1,
      requestId,
      tool,
      ok,
      code,
      summary,
      project: {
        projectInstanceId: this.#projectInstanceId,
        displayName: this.#displayName
      },
      evidence: {
        level: 'UNKNOWN',
        freshness: currentFreshness
      },
      data,
      warnings: [],
      nextActions: []
    };
  }
}
