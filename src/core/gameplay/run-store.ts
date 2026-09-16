import { readdir, rename, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

import { ProductError } from '../errors.js';
import { atomicWriteJson, atomicWriteText, type FileIO } from '../fs.js';
import { sha256Hex, stableJson } from '../hash.js';
import type {
  GameplayLatestPointer,
  GameplayModel,
  GameplayRunClassification,
  GameplayRunManifest,
  GameplayRunMode,
  GameplayScenario,
  GameplayTestReport,
} from './types.js';

const RUN_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,127}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const FIXED_ARTIFACT_PATHS = [
  'generated-spec.json',
  'strict-review.json',
  'strict-review.md',
  'simulation-report.json',
  'simulation-report.md',
] as const;

export interface GameplayRunStoreIO {
  fileIO: FileIO;
  readdir(path: string): Promise<Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>>;
  renameDirectory(from: string, to: string): Promise<void>;
  removeDirectory(path: string): Promise<void>;
}

export type GameplayRunCommitPhase =
  | { phase: 'before-artifact-write'; index: number; path: string }
  | { phase: 'before-run-rename' }
  | { phase: 'after-run-rename' }
  | { phase: 'before-latest-write' };

export interface GameplayRunCommitInput {
  root: string;
  mode: GameplayRunMode;
  project: GameplayModel['project'];
  model: GameplayModel;
  scenarios: readonly GameplayScenario[];
  strictReview: unknown;
  strictReviewMarkdown: string;
  simulationReport: GameplayTestReport | unknown | null;
  simulationReportMarkdown: string;
  strictStaticGate: 'pass' | 'blocked';
  simulationGate: 'pass' | 'blocked';
  classification: GameplayRunClassification;
  signal?: AbortSignal;
}

export interface GameplayStoredRun {
  latest: GameplayLatestPointer;
  manifest: GameplayRunManifest;
  artifacts: Readonly<Record<string, unknown | string>>;
}

export interface GameplayRunHistorySummary {
  count: number;
  bytes: number;
}

export function createNodeGameplayRunStoreIO(fileIO: FileIO): GameplayRunStoreIO {
  return {
    fileIO,
    readdir: async (path) => readdir(path, { withFileTypes: true }),
    renameDirectory: rename,
    removeDirectory: async (path) => rm(path, { recursive: true, force: true }),
  };
}

function validation(message: string, cause?: unknown): ProductError {
  return new ProductError('VALIDATION_FAILED', message, ['删除损坏的玩法运行包或重新运行玩法模拟。'], 'STATIC_LOCAL', cause);
}

function assertJsonValue(_value: unknown): asserts _value is unknown {
  // JSON serialization and the read-back parse below are the actual envelope checks.
}

function assertRunId(runId: string): void {
  if (!RUN_ID_PATTERN.test(runId)) throw validation('玩法运行 ID 无效。');
}

function assertLatestPointer(value: unknown): asserts value is GameplayLatestPointer {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw validation('玩法 latest 指针不是对象。');
  const pointer = value as Partial<GameplayLatestPointer>;
  if (pointer.schemaVersion !== 1 || typeof pointer.runId !== 'string' || !RUN_ID_PATTERN.test(pointer.runId)
    || typeof pointer.projectInstanceId !== 'string' || typeof pointer.knowledgeFingerprint !== 'string'
    || (pointer.mode !== 'auto' && pointer.mode !== 'manual')
    || !['model-pass', 'model-fail', 'partial-needs-editor', 'not-run-fatal'].includes(pointer.classification ?? '')) {
    throw validation('玩法 latest 指针无效。');
  }
}

function assertManifest(value: unknown): asserts value is GameplayRunManifest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw validation('玩法运行 manifest 不是对象。');
  const manifest = value as Partial<GameplayRunManifest>;
  if (manifest.schemaVersion !== 1 || typeof manifest.runId !== 'string' || !RUN_ID_PATTERN.test(manifest.runId)
    || manifest.completed !== true || (manifest.mode !== 'auto' && manifest.mode !== 'manual')
    || typeof manifest.project !== 'object' || manifest.project === null
    || !SHA256_PATTERN.test(manifest.modelFingerprint ?? '') || !SHA256_PATTERN.test(manifest.scenarioFingerprint ?? '')
    || (manifest.strictStaticGate !== 'pass' && manifest.strictStaticGate !== 'blocked')
    || (manifest.simulationGate !== 'pass' && manifest.simulationGate !== 'blocked')
    || !['model-pass', 'model-fail', 'partial-needs-editor', 'not-run-fatal'].includes(manifest.classification ?? '')
    || typeof manifest.artifactSha256 !== 'object' || manifest.artifactSha256 === null) {
    throw validation('玩法运行 manifest 无效。');
  }
  for (const [path, hash] of Object.entries(manifest.artifactSha256)) {
    if (!safeArtifactPath(path) || !SHA256_PATTERN.test(hash)) throw validation('玩法运行 manifest 的产物摘要无效。');
  }
}

function safeArtifactPath(path: string): boolean {
  if (path === '' || isAbsolute(path) || path.includes('\\')) return false;
  const normalized = relative('.', path).replace(/\\/gu, '/');
  return normalized === path && !normalized.startsWith('../') && normalized !== '..';
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  if (signal.reason !== undefined) throw signal.reason;
  const error = new Error('玩法模拟运行包提交已取消。');
  error.name = 'AbortError';
  throw error;
}

function assertStagingPath(runsRoot: string, stagingPath: string, runId: string): void {
  const resolvedRuns = resolve(runsRoot);
  const resolvedStaging = resolve(stagingPath);
  if (dirname(resolvedStaging) !== resolvedRuns || basename(resolvedStaging) !== `.staging-${runId}`) {
    throw validation('拒绝清理不属于本次玩法运行的目录。');
  }
}

async function readJson(io: FileIO, path: string): Promise<unknown> {
  return JSON.parse(await io.readFile(path, 'utf8')) as unknown;
}

export class GameplayRunStore {
  readonly #io: GameplayRunStoreIO;
  readonly #clock: () => Date;
  readonly #runIdFactory: (now: Date) => string;
  readonly #commitGuard: ((phase: GameplayRunCommitPhase) => void) | undefined;

  constructor(options: {
    io: GameplayRunStoreIO;
    clock?: () => Date;
    runIdFactory?: (now: Date) => string;
    commitGuard?: (phase: GameplayRunCommitPhase) => void;
  }) {
    this.#io = options.io;
    this.#clock = options.clock ?? (() => new Date());
    this.#runIdFactory = options.runIdFactory ?? ((now) => `${now.getTime().toString(36)}-${sha256Hex(`${now.toISOString()}-${Math.random()}`).slice(0, 16)}`);
    this.#commitGuard = options.commitGuard;
  }

  #guard(input: GameplayRunCommitInput, phase: GameplayRunCommitPhase): void {
    throwIfAborted(input.signal);
    this.#commitGuard?.(phase);
  }

  async commit(input: GameplayRunCommitInput): Promise<{ manifest: GameplayRunManifest; latest: GameplayLatestPointer }> {
    const runId = this.#runIdFactory(this.#clock());
    assertRunId(runId);
    const gameplayRoot = join(input.root, '.yuanmeng-inspector', 'gameplay');
    const runsRoot = join(gameplayRoot, 'runs');
    const stagingPath = join(runsRoot, `.staging-${runId}`);
    const finalPath = join(runsRoot, runId);
    assertStagingPath(runsRoot, stagingPath, runId);
    await this.#io.fileIO.mkdir(stagingPath, { recursive: true });

    const scenarioArtifacts = input.scenarios.length === 0
      ? [{ path: 'generated-scenarios/index.json', value: [] as unknown, json: true }]
      : input.scenarios.map((scenario, index) => ({
        path: `generated-scenarios/${String(index + 1).padStart(3, '0')}-${sha256Hex(scenario.scenarioId).slice(0, 12)}.json`,
        value: scenario as unknown,
        json: true,
      }));
    const artifacts: Array<{ path: string; value: unknown | string; json: boolean }> = [
      { path: 'generated-spec.json', value: input.model, json: true },
      ...scenarioArtifacts,
      { path: 'strict-review.json', value: input.strictReview, json: true },
      { path: 'strict-review.md', value: input.strictReviewMarkdown, json: false },
      { path: 'simulation-report.json', value: input.simulationReport, json: true },
      { path: 'simulation-report.md', value: input.simulationReportMarkdown, json: false },
    ];
    const artifactSha256: Record<string, string> = {};

    try {
      for (const [index, artifact] of artifacts.entries()) {
        this.#guard(input, { phase: 'before-artifact-write', index: index + 1, path: artifact.path });
        const target = join(stagingPath, artifact.path);
        if (artifact.json) await atomicWriteJson(this.#io.fileIO, target, artifact.value, assertJsonValue);
        else await atomicWriteText(this.#io.fileIO, target, artifact.value as string);
        const persisted = await this.#io.fileIO.readFile(target, 'utf8');
        if (artifact.json) JSON.parse(persisted);
        artifactSha256[artifact.path] = sha256Hex(persisted);
      }

      const manifest: GameplayRunManifest = {
        schemaVersion: 1,
        runId,
        mode: input.mode,
        project: input.project,
        modelFingerprint: sha256Hex(stableJson(input.model)),
        scenarioFingerprint: sha256Hex(stableJson(input.scenarios)),
        strictStaticGate: input.strictStaticGate,
        simulationGate: input.simulationGate,
        classification: input.classification,
        completed: true,
        artifactSha256,
      };
      await atomicWriteJson(this.#io.fileIO, join(stagingPath, 'manifest.json'), manifest, assertManifest);
      const checkedManifest = await readJson(this.#io.fileIO, join(stagingPath, 'manifest.json'));
      assertManifest(checkedManifest);
      await this.#verifyArtifacts(stagingPath, checkedManifest);

      this.#guard(input, { phase: 'before-run-rename' });
      await this.#io.renameDirectory(stagingPath, finalPath);
      this.#guard(input, { phase: 'after-run-rename' });

      const latest: GameplayLatestPointer = {
        schemaVersion: 1,
        runId,
        projectInstanceId: input.project.projectInstanceId,
        knowledgeFingerprint: input.project.knowledgeFingerprint,
        mode: input.mode,
        classification: input.classification,
      };
      this.#guard(input, { phase: 'before-latest-write' });
      await atomicWriteJson(this.#io.fileIO, join(gameplayRoot, 'latest.json'), latest, assertLatestPointer);
      return { manifest, latest };
    } catch (error) {
      assertStagingPath(runsRoot, stagingPath, runId);
      await this.#io.removeDirectory(stagingPath).catch(() => undefined);
      throw error;
    }
  }

  async #verifyArtifacts(runPath: string, manifest: GameplayRunManifest): Promise<Record<string, unknown | string>> {
    const paths = Object.keys(manifest.artifactSha256).sort((left, right) => left.localeCompare(right, 'en'));
    if (paths.length < 6 || FIXED_ARTIFACT_PATHS.some((path) => !paths.includes(path))
      || !paths.some((path) => path.startsWith('generated-scenarios/') && path.endsWith('.json'))) {
      throw validation('玩法运行包缺少必需产物。');
    }
    const artifacts: Record<string, unknown | string> = {};
    for (const path of paths) {
      if (!safeArtifactPath(path)) throw validation('玩法运行包包含越界产物路径。');
      const persisted = await this.#io.fileIO.readFile(join(runPath, path), 'utf8');
      if (sha256Hex(persisted) !== manifest.artifactSha256[path]) throw validation(`玩法运行产物 ${path} 摘要不一致。`);
      artifacts[path] = path.endsWith('.json') ? JSON.parse(persisted) as unknown : persisted;
    }
    return artifacts;
  }

  async readCurrent(root: string, project: GameplayModel['project']): Promise<GameplayStoredRun | null> {
    try {
      const gameplayRoot = join(root, '.yuanmeng-inspector', 'gameplay');
      const latestValue = await readJson(this.#io.fileIO, join(gameplayRoot, 'latest.json'));
      assertLatestPointer(latestValue);
      if (latestValue.projectInstanceId !== project.projectInstanceId || latestValue.knowledgeFingerprint !== project.knowledgeFingerprint) return null;
      const runPath = join(gameplayRoot, 'runs', latestValue.runId);
      const manifestValue = await readJson(this.#io.fileIO, join(runPath, 'manifest.json'));
      assertManifest(manifestValue);
      if (manifestValue.runId !== latestValue.runId || manifestValue.mode !== latestValue.mode
        || manifestValue.classification !== latestValue.classification
        || manifestValue.project.projectInstanceId !== project.projectInstanceId
        || manifestValue.project.knowledgeFingerprint !== project.knowledgeFingerprint) return null;
      const artifacts = await this.#verifyArtifacts(runPath, manifestValue);
      return { latest: latestValue, manifest: manifestValue, artifacts };
    } catch {
      return null;
    }
  }

  async summarizeHistory(root: string): Promise<GameplayRunHistorySummary> {
    const runsRoot = join(root, '.yuanmeng-inspector', 'gameplay', 'runs');
    let entries: Awaited<ReturnType<GameplayRunStoreIO['readdir']>>;
    try {
      entries = await this.#io.readdir(runsRoot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { count: 0, bytes: 0 };
      throw error;
    }
    const directories = entries.filter((entry) => entry.isDirectory() && RUN_ID_PATTERN.test(entry.name));
    let bytes = 0;
    const visit = async (path: string): Promise<void> => {
      for (const entry of await this.#io.readdir(path)) {
        const child = join(path, entry.name);
        if (entry.isDirectory()) await visit(child);
        else if (entry.isFile()) bytes += (await this.#io.fileIO.stat(child)).size;
      }
    };
    for (const entry of directories) await visit(join(runsRoot, entry.name));
    return { count: directories.length, bytes };
  }
}
