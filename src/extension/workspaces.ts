import { basename, join } from 'node:path';

import * as vscode from 'vscode';

import { ProductError, type EvidenceLevel } from '../core/errors.js';
import { atomicWriteJson, nodeFileIO } from '../core/fs.js';
import { sha256Hex } from '../core/hash.js';
import type {
  InspectorStatus,
  RegistryRecord,
  SourceEvidence,
  UiNode,
  UiSnapshot,
  UiSourceFile,
} from '../core/model.js';
import { discoverProjects, type ProjectCandidate } from '../core/project/context.js';
import { reduceStatus } from '../core/status/status.js';
import {
  RegistryStore,
  type RegistryImportFormat,
  type RegistryImportPreview,
} from '../core/registry/store.js';
import {
  type ParsedUiPart,
  type RawUiExportFile,
} from '../core/ui/adapter.js';
import { buildUiSnapshot, findUi, type UiSearchResult } from '../core/ui/index.js';
import {
  OfficialCommandAdapter,
  type CommandHost,
  type OfficialCapabilities,
} from '../integrations/official/commands.js';
import { waitForStableExport } from '../integrations/official/files.js';
import { discoverOfficialCommandProvider } from '../integrations/official/provider.js';

export interface WorkspaceContextSummary {
  root: string;
  projectInstanceId: string;
  snapshotId: string | null;
}

export interface ManagedWorkspaceContext {
  project: ProjectCandidate;
  snapshot: UiSnapshot | null;
  status: InspectorStatus;
}

export interface UiRefreshResult {
  reasonCode: 'REFRESH_SUCCEEDED' | 'REFRESH_SUCCEEDED_UNCHANGED';
}

export interface WorkspaceContextManagerOptions {
  uiAdapter(parts: readonly ParsedUiPart[]): UiNode[];
  uiPartParser(files: readonly RawUiExportFile[]): ParsedUiPart[];
  sourceEvidence: EvidenceLevel;
}

function validateSnapshot(value: unknown): asserts value is UiSnapshot {
  if (
    typeof value !== 'object'
    || value === null
    || Array.isArray(value)
    || (value as Partial<UiSnapshot>).schemaVersion !== 1
    || typeof (value as Partial<UiSnapshot>).snapshotId !== 'string'
    || !Array.isArray((value as Partial<UiSnapshot>).nodes)
  ) {
    throw new ProductError('VALIDATION_FAILED', 'UI 快照字段无效。', ['在元梦编辑器更新 VSCode 工程后重新获取 UI 结构。'], 'STATIC_LOCAL');
  }
}

function validateStatus(value: unknown): asserts value is InspectorStatus {
  if (
    typeof value !== 'object'
    || value === null
    || Array.isArray(value)
    || (value as Partial<InspectorStatus>).schemaVersion !== 1
    || typeof (value as Partial<InspectorStatus>).link?.state !== 'string'
  ) {
    throw new ProductError('VALIDATION_FAILED', '状态数据字段无效。', ['重新刷新工程状态。'], 'STATIC_LOCAL');
  }
}

async function readOptionalJson<T>(path: string, validate: (value: unknown) => asserts value is T): Promise<T | null> {
  try {
    const value: unknown = JSON.parse(await nodeFileIO.readFile(path, 'utf8'));
    validate(value);
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

async function optionalHash(path: string): Promise<string | null> {
  try {
    return sha256Hex(await nodeFileIO.readBytes(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

async function optionalSignature(path: string): Promise<string | null> {
  try {
    const value = await nodeFileIO.stat(path);
    return value.isFile() ? `${value.size}:${value.mtimeMs}` : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

function initialStatus(project: ProjectCandidate): InspectorStatus {
  return reduceStatus({ commandsPresent: false, refreshAttempt: null, snapshot: null, project });
}

function snapshotOfficialExtensionVersion(snapshot: UiSnapshot): string | null {
  const versions = [...new Set(snapshot.sources
    .map((source) => source.officialExtensionVersion)
    .filter((version): version is string => version !== null))];
  return versions.length === 1 ? versions[0]! : null;
}

function snapshotSourceHashes(snapshot: UiSnapshot): Record<string, string> {
  return Object.fromEntries(snapshot.sources
    .filter((source) => source.relativePath !== null)
    .map((source) => [source.relativePath!, source.sha256]));
}

function sameHashes(left: Readonly<Record<string, string>>, right: Readonly<Record<string, string>>): boolean {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key]);
}

async function currentSnapshotHashes(projectRoot: string, snapshot: UiSnapshot): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const source of snapshot.sources) {
    if (source.relativePath !== 'src/Data/CustomUIData.lua' && source.relativePath !== 'src/Data/CustomUIData2.lua') {
      continue;
    }
    const hash = await optionalHash(join(projectRoot, ...source.relativePath.split('/')));
    if (hash !== null) {
      result[source.relativePath] = hash;
    }
  }
  return result;
}

function commandHost(): CommandHost {
  return {
    getCommands: async (includeInternal) => vscode.commands.getCommands(includeInternal),
    executeCommand: async (command, ...args) => vscode.commands.executeCommand(command, ...args),
  };
}

export class WorkspaceContextManager implements vscode.Disposable {
  readonly #contexts = new Map<string, ManagedWorkspaceContext>();
  readonly #changeEmitter = new vscode.EventEmitter<void>();
  readonly #uiAdapter: WorkspaceContextManagerOptions['uiAdapter'];
  readonly #uiPartParser: WorkspaceContextManagerOptions['uiPartParser'];
  readonly #sourceEvidence: EvidenceLevel;
  #officialExtensionVersion: string | null = null;
  readonly onDidChange = this.#changeEmitter.event;

  private constructor(options: WorkspaceContextManagerOptions) {
    this.#uiAdapter = options.uiAdapter;
    this.#uiPartParser = options.uiPartParser;
    this.#sourceEvidence = options.sourceEvidence;
  }

  static async create(
    folders: readonly vscode.WorkspaceFolder[],
    options: WorkspaceContextManagerOptions,
  ): Promise<WorkspaceContextManager> {
    const manager = new WorkspaceContextManager(options);
    await manager.reload(folders);
    return manager;
  }

  dispose(): void {
    this.#changeEmitter.dispose();
  }

  async reload(folders: readonly vscode.WorkspaceFolder[]): Promise<void> {
    this.#officialExtensionVersion = discoverOfficialCommandProvider(vscode.extensions.all.map((extension) => ({
      id: extension.id,
      packageJSON: extension.packageJSON,
    })))?.version ?? null;
    const projects = await discoverProjects(folders.map((folder) => folder.uri.fsPath), nodeFileIO);
    const next = new Map<string, ManagedWorkspaceContext>();
    for (const project of projects) {
      const previous = this.#contexts.get(project.root);
      const snapshotPath = join(project.root, '.yuanmeng-inspector', 'ui', 'current.json');
      const statusPath = join(project.root, '.yuanmeng-inspector', 'status.json');
      const snapshot = await readOptionalJson(snapshotPath, validateSnapshot);
      const storedStatus = await readOptionalJson(statusPath, validateStatus);
      const currentSnapshot = snapshot?.projectInstanceId === project.projectInstanceId ? snapshot : null;
      const matchingStoredStatus = storedStatus?.project.projectInstanceId === project.projectInstanceId
        ? storedStatus
        : previous?.status;
      const status = currentSnapshot === null
        ? matchingStoredStatus ?? initialStatus(project)
        : reduceStatus({
          commandsPresent: matchingStoredStatus?.officialCommands ?? false,
          refreshAttempt: null,
          snapshot: {
            lastRefreshAt: currentSnapshot.createdAt,
            sourceHashes: snapshotSourceHashes(currentSnapshot),
            mapFingerprint: currentSnapshot.mapFingerprint,
            officialExtensionVersion: snapshotOfficialExtensionVersion(currentSnapshot),
            verifiedFresh: currentSnapshot.sources.every((source) => source.evidence !== 'UNIT_E2E')
              && !matchingStoredStatus?.ui.reasonCodes.includes('UNVERIFIED_SNAPSHOT'),
          },
          project,
          currentSourceHashes: await currentSnapshotHashes(project.root, currentSnapshot),
          currentMapFingerprint: project.mapFingerprint,
          ...(this.#officialExtensionVersion === null
            ? {}
            : { currentOfficialExtensionVersion: this.#officialExtensionVersion }),
          ...(matchingStoredStatus === undefined ? {} : { issueCounts: matchingStoredStatus.issueCounts }),
        });
      await atomicWriteJson(nodeFileIO, statusPath, status, validateStatus);
      next.set(project.root, {
        project,
        snapshot: currentSnapshot,
        status,
      });
    }
    this.#contexts.clear();
    for (const [root, context] of next) {
      this.#contexts.set(root, context);
    }
    this.#changeEmitter.fire();
  }

  list(): ManagedWorkspaceContext[] {
    return [...this.#contexts.values()];
  }

  summaries(): WorkspaceContextSummary[] {
    return this.list().map((context) => ({
      root: context.project.root,
      projectInstanceId: context.project.projectInstanceId,
      snapshotId: context.snapshot?.snapshotId ?? null,
    }));
  }

  get(root: string): ManagedWorkspaceContext {
    const context = this.list().find((candidate) => candidate.project.root === root);
    if (context === undefined) {
      throw new ProductError('VALIDATION_FAILED', '目标工程不在当前工作区中。', ['选择一个有效的元梦工程。'], 'STATIC_LOCAL');
    }
    return context;
  }

  async choose(root?: string): Promise<ManagedWorkspaceContext> {
    if (root !== undefined) {
      return this.get(root);
    }
    const activeUri = vscode.window.activeTextEditor?.document.uri;
    if (activeUri !== undefined) {
      const folder = vscode.workspace.getWorkspaceFolder(activeUri);
      const active = folder === undefined ? undefined : this.list().find((item) => item.project.root === folder.uri.fsPath);
      if (active !== undefined) {
        return active;
      }
    }
    const contexts = this.list();
    if (contexts.length === 1) {
      return contexts[0]!;
    }
    if (contexts.length === 0) {
      throw new ProductError('VALIDATION_FAILED', '当前工作区没有可用的元梦工程。', ['打开包含 src/GameEntry.lua 的工程。'], 'STATIC_LOCAL');
    }
    const selected = await vscode.window.showQuickPick(contexts.map((context) => ({
      label: basename(context.project.root),
      description: context.project.root,
      context,
    })), { placeHolder: '选择目标元梦工程' });
    if (selected === undefined) {
      throw new ProductError('USAGE_ERROR', '未选择目标工程。', ['重新运行命令并选择工程。'], 'STATIC_LOCAL');
    }
    return selected.context;
  }

  async detectOfficialCapabilities(): Promise<OfficialCapabilities> {
    return new OfficialCommandAdapter(commandHost()).detect();
  }

  async #openRegistry(root: string, create: boolean): Promise<RegistryStore | null> {
    this.get(root);
    const path = join(root, '.yuanmeng-inspector', 'registry', 'registry.json');
    try {
      return await RegistryStore.open(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
      if (!create) {
        return null;
      }
      const store = new RegistryStore({ schemaVersion: 1, records: [] }, path);
      await store.save();
      return store;
    }
  }

  async listRegistry(root: string): Promise<RegistryRecord[]> {
    return (await this.#openRegistry(root, false))?.list() ?? [];
  }

  async previewRegistryImport(
    root: string,
    input: string,
    format: RegistryImportFormat,
  ): Promise<RegistryImportPreview> {
    const store = await this.#openRegistry(root, true);
    return store!.previewImport(input, format);
  }

  async commitRegistryImport(root: string, preview: RegistryImportPreview): Promise<void> {
    const store = await this.#openRegistry(root, true);
    await store!.commitImport(preview);
    this.#changeEmitter.fire();
  }

  async refreshUi(root: string): Promise<UiRefreshResult> {
    const context = this.get(root);
    const sourcePaths = [
      join(root, 'src', 'Data', 'CustomUIData.lua'),
      join(root, 'src', 'Data', 'CustomUIData2.lua'),
    ] as const;
    const baselineHashes: Record<string, string | null> = {};
    const baselineSignatures: Record<string, string | null> = {};
    for (const path of sourcePaths) {
      baselineHashes[path] = await optionalHash(path);
      baselineSignatures[path] = await optionalSignature(path);
    }
    const adapter = new OfficialCommandAdapter(commandHost());
    const capabilities = await adapter.detect();
    await adapter.execute('refreshUi');
    const configuration = vscode.workspace.getConfiguration('yuanmengAi');
    const stable = await waitForStableExport({
      io: nodeFileIO,
      paths: sourcePaths,
      baselineHashes,
      baselineSignatures,
      acceptUnchangedStableFiles: true,
      sampleMilliseconds: configuration.get<number>('fileStableSampleMilliseconds', 150),
      stableSampleCount: configuration.get<number>('fileStableSampleCount', 3),
      totalTimeoutMilliseconds: configuration.get<number>('uiRefreshTimeoutSeconds', 15) * 1000,
    });
    const observedAt = new Date().toISOString();
    const sources: SourceEvidence[] = stable.files.map((file) => ({
      kind: 'official-export',
      relativePath: file.path.endsWith('CustomUIData2.lua')
        ? 'src/Data/CustomUIData2.lua'
        : 'src/Data/CustomUIData.lua',
      sha256: file.sha256,
      observedAt,
      officialExtensionVersion: this.#officialExtensionVersion,
      evidence: this.#sourceEvidence,
    }));
    const parts = this.#uiPartParser(stable.files.map((file) => ({
      content: file.content,
      sourceFile: (file.path.endsWith('CustomUIData2.lua')
        ? 'src/Data/CustomUIData2.lua'
        : 'src/Data/CustomUIData.lua') as UiSourceFile,
    })));
    let nodes: UiNode[];
    try {
      nodes = this.#uiAdapter(parts);
    } catch (error) {
      if (error instanceof ProductError && error.code === 'OFFICIAL_SCHEMA_UNVERIFIED') {
        const status = reduceStatus({
          commandsPresent: Object.fromEntries(Object.entries(capabilities)) as Record<string, boolean>,
          refreshAttempt: { outcome: 'schema-unverified', completedAt: observedAt },
          snapshot: context.snapshot === null ? null : {
            lastRefreshAt: context.snapshot.createdAt,
            sourceHashes: Object.fromEntries(context.snapshot.sources
              .filter((source) => source.relativePath !== null)
              .map((source) => [source.relativePath!, source.sha256])),
            mapFingerprint: context.snapshot.mapFingerprint,
            officialExtensionVersion: snapshotOfficialExtensionVersion(context.snapshot),
            verifiedFresh: false,
          },
          project: context.project,
        });
        await atomicWriteJson(nodeFileIO, join(root, '.yuanmeng-inspector', 'status.json'), status, validateStatus);
        context.status = status;
        this.#changeEmitter.fire();
      }
      throw error;
    }
    const candidateSnapshot = buildUiSnapshot({
      createdAt: observedAt,
      projectInstanceId: context.project.projectInstanceId,
      mapFingerprint: context.project.mapFingerprint,
      sources,
      nodes,
    });
    const candidateHashes = snapshotSourceHashes(candidateSnapshot);
    const retainExistingSnapshot = stable.reasonCode === 'REFRESH_SUCCEEDED_UNCHANGED'
      && context.snapshot !== null
      && sameHashes(snapshotSourceHashes(context.snapshot), candidateHashes);
    const snapshot = retainExistingSnapshot ? context.snapshot! : candidateSnapshot;
    if (!retainExistingSnapshot) {
      const snapshotRoot = join(root, '.yuanmeng-inspector', 'ui');
      await atomicWriteJson(nodeFileIO, join(snapshotRoot, 'snapshots', `${snapshot.snapshotId}.json`), snapshot, validateSnapshot);
      await atomicWriteJson(nodeFileIO, join(snapshotRoot, 'current.json'), snapshot, validateSnapshot);
    }
    const verifiedFresh = stable.reasonCode === 'REFRESH_SUCCEEDED'
      || (retainExistingSnapshot && !context.status.ui.reasonCodes.includes('UNVERIFIED_SNAPSHOT'));
    const status = reduceStatus({
      commandsPresent: Object.fromEntries(Object.entries(capabilities)) as Record<string, boolean>,
      refreshAttempt: {
        outcome: 'success',
        completedAt: observedAt,
        reasonCode: stable.reasonCode,
        observedStableNewFiles: stable.observedSignatureChange,
        parseSucceeded: true,
        mapFingerprint: context.project.mapFingerprint,
      },
      snapshot: {
        lastRefreshAt: snapshot.createdAt,
        sourceHashes: snapshotSourceHashes(snapshot),
        mapFingerprint: snapshot.mapFingerprint,
        officialExtensionVersion: snapshotOfficialExtensionVersion(snapshot),
        verifiedFresh,
      },
      project: context.project,
      currentSourceHashes: candidateHashes,
      staleAfterMinutes: configuration.get<number>('staleAfterMinutes', 30),
    });
    await atomicWriteJson(nodeFileIO, join(root, '.yuanmeng-inspector', 'status.json'), status, validateStatus);
    const registry = await this.#openRegistry(root, true);
    registry!.syncUiSnapshot(snapshot, { fresh: status.ui.freshness === 'fresh' });
    await registry!.save();
    context.snapshot = snapshot;
    context.status = status;
    this.#changeEmitter.fire();
    return { reasonCode: stable.reasonCode };
  }

  findUi(root: string, query: string): UiSearchResult {
    const snapshot = this.get(root).snapshot;
    return snapshot === null ? { kind: 'not-found' } : findUi(snapshot, query, { mode: 'exact-name' });
  }
}
