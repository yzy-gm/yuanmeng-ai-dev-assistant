import { basename, join } from 'node:path';

import * as vscode from 'vscode';

import { ProductError, type EvidenceLevel } from '../core/errors.js';
import { atomicWriteJson, atomicWriteText, nodeFileIO } from '../core/fs.js';
import { sha256Hex, stableJson } from '../core/hash.js';
import type {
  InspectorStatus,
  RegistryDocument,
  RegistryRecord,
  SourceEvidence,
  UiNode,
  UiSnapshot,
  UiSourceFile,
} from '../core/model.js';
import type { OfficialConnectionObservation } from '../core/logs/official-connection.js';
import { discoverProjects, type ProjectCandidate } from '../core/project/context.js';
import {
  readProjectDisplayProfile,
  writeProjectDisplayProfile,
} from '../core/project/display-profile.js';
import { reduceStatus } from '../core/status/status.js';
import { writeLiveOfficialConnection } from '../core/status/live-connection.js';
import {
  commitRegistryImportTransaction,
  mutateRegistry,
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
  type UiLayerOrderGuardStatus,
  updateUiLayerOrderGuard,
} from '../core/ui/layer-order-guard.js';
import {
  OfficialCommandAdapter,
  type CommandHost,
  type OfficialCapabilities,
} from '../integrations/official/commands.js';
import { waitForStableExport } from '../integrations/official/files.js';
import { discoverOfficialCommandProvider } from '../integrations/official/provider.js';
import {
  UiExportWatcher,
  UiRefreshLifecycleQueue,
  type UiExportRefreshContext,
  type UiRefreshGeneration,
} from '../integrations/ui/watcher.js';

export interface WorkspaceContextSummary {
  root: string;
  projectInstanceId: string;
  snapshotId: string | null;
  mapDisplayName: string | null;
}

export interface ManagedWorkspaceContext {
  project: ProjectCandidate;
  mapDisplayName: string | null;
  snapshot: UiSnapshot | null;
  status: InspectorStatus;
}

export interface UiRefreshResult {
  reasonCode: 'REFRESH_SUCCEEDED' | 'REFRESH_SUCCEEDED_UNCHANGED';
  layerOrderGuard: UiLayerOrderGuardStatus;
  layerOrderIncidentRelativePath: string | null;
}

export interface ClipboardSceneRegistrationPreview extends RegistryImportPreview {
  record: RegistryRecord;
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

export async function guardedAtomicWriteJson<T>(
  path: string,
  value: T,
  validate: (value: unknown) => asserts value is T,
  guard: () => void,
): Promise<void> {
  let previous: string | null;
  try {
    previous = await nodeFileIO.readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    previous = null;
  }
  const attempted = stableJson(value);
  guard();
  try {
    await atomicWriteJson(nodeFileIO, path, value, validate, { commitGuard: guard });
    guard();
  } catch (error) {
    let current: string | null = null;
    try {
      current = await nodeFileIO.readFile(path, 'utf8');
    } catch (readError) {
      if ((readError as NodeJS.ErrnoException).code !== 'ENOENT') throw readError;
    }
    if (current === attempted) {
      if (previous === null) await nodeFileIO.unlink(path);
      else await atomicWriteText(nodeFileIO, path, previous);
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

function withOfficialConnection(
  status: InspectorStatus,
  observation: OfficialConnectionObservation | undefined,
): InspectorStatus {
  if (observation === undefined || observation.state === 'unknown' || observation.observedAt === null) {
    return status;
  }
  return {
    ...status,
    link: {
      ...status.link,
      state: observation.state,
      reasonCode: observation.state === 'online'
        ? 'OFFICIAL_OUTPUT_CONNECTED'
        : 'OFFICIAL_OUTPUT_DISCONNECTED',
      lastProbeAt: observation.observedAt,
    },
  };
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

function layerOrderWarning(result: UiRefreshResult): string | null {
  if (result.layerOrderGuard.state !== 'reversal-detected') return null;
  const groups = result.layerOrderGuard.reversedGroups
    .map((group) => group.parentPath)
    .slice(0, 3)
    .join('、');
  const suffix = result.layerOrderIncidentRelativePath === null
    ? ''
    : ` 证据：${result.layerOrderIncidentRelativePath}`;
  return `检测到 ${result.layerOrderGuard.reversedGroups.length} 个控件组疑似整体完全倒序（${groups}）。`
    + `插件已保留上一份可信层级基线，不会自动改写元梦地图；请先暂停保存并检查编辑器层级。${suffix}`;
}

export class WorkspaceContextManager implements vscode.Disposable {
  readonly #contexts = new Map<string, ManagedWorkspaceContext>();
  readonly #baseStatuses = new Map<string, InspectorStatus>();
  readonly #officialConnections = new Map<string, OfficialConnectionObservation>();
  readonly #liveConnectionWriteTails = new Map<string, Promise<void>>();
  readonly #changeEmitter = new vscode.EventEmitter<void>();
  readonly #uiAdapter: WorkspaceContextManagerOptions['uiAdapter'];
  readonly #uiPartParser: WorkspaceContextManagerOptions['uiPartParser'];
  readonly #sourceEvidence: EvidenceLevel;
  readonly #uiExportWatcher: UiExportWatcher;
  readonly #uiFileWatchers = new Map<string, vscode.Disposable[]>();
  readonly #projectDisplayWatchers = new Map<string, vscode.Disposable>();
  readonly #uiRefreshLifecycle = new UiRefreshLifecycleQueue();
  #officialExtensionVersion: string | null = null;
  #reloadTail: Promise<void> = Promise.resolve();
  #disposed = false;
  readonly onDidChange = this.#changeEmitter.event;

  private constructor(options: WorkspaceContextManagerOptions) {
    this.#uiAdapter = options.uiAdapter;
    this.#uiPartParser = options.uiPartParser;
    this.#sourceEvidence = options.sourceEvidence;
    this.#uiExportWatcher = new UiExportWatcher({
      debounceMilliseconds: 250,
      refresh: async (root, watch) => {
        const result = await this.#queueUiRefresh(
          root,
          async (generation) => this.#refreshUiFromFiles(root, generation),
          watch,
        );
        const warning = layerOrderWarning(result);
        if (warning !== null) void vscode.window.showWarningMessage(warning);
      },
      onError: (root, error) => {
        const context = this.#contexts.get(root);
        if (context === undefined) return;
        const reason = error instanceof Error ? error.message : String(error);
        void vscode.window.showWarningMessage(`UI 结构文件自动刷新失败，已保留上一份可用快照：${reason}`);
      },
    });
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
    if (this.#disposed) return;
    this.#disposed = true;
    this.#disposeUiFileWatchers();
    this.#disposeProjectDisplayWatchers();
    this.#uiExportWatcher.dispose();
    this.#uiRefreshLifecycle.dispose();
    this.#baseStatuses.clear();
    this.#officialConnections.clear();
    this.#liveConnectionWriteTails.clear();
    this.#changeEmitter.dispose();
  }

  reload(folders: readonly vscode.WorkspaceFolder[]): Promise<void> {
    const current = this.#reloadTail.catch(() => undefined).then(async () => this.#reloadNow(folders));
    this.#reloadTail = current;
    return current;
  }

  async #reloadNow(folders: readonly vscode.WorkspaceFolder[]): Promise<void> {
    if (this.#disposed) throw new ProductError('VALIDATION_FAILED', '工作区管理器已释放。', ['重新加载扩展。'], 'STATIC_LOCAL');
    this.#disposeUiFileWatchers();
    this.#disposeProjectDisplayWatchers();
    await this.#uiRefreshLifecycle.invalidate();
    if (this.#disposed) throw new ProductError('VALIDATION_FAILED', '工作区管理器已释放。', ['重新加载扩展。'], 'STATIC_LOCAL');
    this.#officialExtensionVersion = discoverOfficialCommandProvider(vscode.extensions.all.map((extension) => ({
      id: extension.id,
      packageJSON: extension.packageJSON,
    })))?.version ?? null;
    const projects = await discoverProjects(folders.map((folder) => folder.uri.fsPath), nodeFileIO);
    const projectRoots = new Set(projects.map((project) => project.root));
    for (const root of this.#baseStatuses.keys()) {
      if (!projectRoots.has(root)) this.#baseStatuses.delete(root);
    }
    for (const root of this.#officialConnections.keys()) {
      if (!projectRoots.has(root)) this.#officialConnections.delete(root);
    }
    const next = new Map<string, ManagedWorkspaceContext>();
    for (const project of projects) {
      const previous = this.#contexts.get(project.root);
      const snapshotPath = join(project.root, '.yuanmeng-inspector', 'ui', 'current.json');
      const statusPath = join(project.root, '.yuanmeng-inspector', 'status.json');
      const snapshot = await readOptionalJson(snapshotPath, validateSnapshot);
      const storedStatus = await readOptionalJson(statusPath, validateStatus);
      const displayProfile = await readProjectDisplayProfile(project.root, project.projectInstanceId, nodeFileIO);
      const currentSnapshot = snapshot?.projectInstanceId === project.projectInstanceId ? snapshot : null;
      const matchingStoredStatus = storedStatus?.project.projectInstanceId === project.projectInstanceId
        ? storedStatus
        : this.#baseStatuses.get(project.root) ?? previous?.status;
      const baseStatus = currentSnapshot === null
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
      this.#baseStatuses.set(project.root, baseStatus);
      const status = withOfficialConnection(baseStatus, this.#officialConnections.get(project.root));
      // The disk status remains based on UI/file evidence. Official output-log
      // evidence is a live, window-local overlay and is never persisted.
      await atomicWriteJson(nodeFileIO, statusPath, baseStatus, validateStatus);
      next.set(project.root, {
        project,
        mapDisplayName: displayProfile?.mapDisplayName ?? null,
        snapshot: currentSnapshot,
        status,
      });
    }
    this.#contexts.clear();
    for (const [root, context] of next) {
      this.#contexts.set(root, context);
    }
    this.#resetUiFileWatchers();
    this.#resetProjectDisplayWatchers();
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
      mapDisplayName: context.mapDisplayName,
    }));
  }

  get(root: string): ManagedWorkspaceContext {
    const context = this.list().find((candidate) => candidate.project.root === root);
    if (context === undefined) {
      throw new ProductError('VALIDATION_FAILED', '目标工程不在当前工作区中。', ['选择一个有效的元梦工程。'], 'STATIC_LOCAL');
    }
    return context;
  }

  setOfficialConnectionObservation(root: string, observation: OfficialConnectionObservation): void {
    const context = this.#contexts.get(root);
    if (context === undefined) return;
    const previous = this.#officialConnections.get(root);
    if (
      previous?.state === observation.state
      && previous?.observedAt === observation.observedAt
      && previous?.projectName === observation.projectName
      && previous?.source === observation.source
    ) {
      this.#persistLiveConnection(root, context.project.projectInstanceId, context.project.projectRootHash, observation);
      return;
    }
    this.#officialConnections.set(root, observation);
    const baseStatus = this.#baseStatuses.get(root) ?? context.status;
    context.status = withOfficialConnection(baseStatus, observation);
    this.#persistLiveConnection(root, context.project.projectInstanceId, context.project.projectRootHash, observation);
    this.#changeEmitter.fire();
  }

  #persistLiveConnection(
    root: string,
    projectInstanceId: string,
    projectRootHash: string,
    observation: OfficialConnectionObservation,
  ): void {
    const previous = this.#liveConnectionWriteTails.get(root) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => writeLiveOfficialConnection(
        root,
        projectInstanceId,
        projectRootHash,
        observation,
        nodeFileIO,
      ));
    this.#liveConnectionWriteTails.set(root, next);
    void next.then(
      () => { if (this.#liveConnectionWriteTails.get(root) === next) this.#liveConnectionWriteTails.delete(root); },
      () => { if (this.#liveConnectionWriteTails.get(root) === next) this.#liveConnectionWriteTails.delete(root); },
    );
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

  #disposeUiFileWatchers(): void {
    for (const [root, watchers] of this.#uiFileWatchers) {
      this.#uiExportWatcher.cancel(root);
      for (const watcher of watchers) watcher.dispose();
    }
    this.#uiFileWatchers.clear();
  }

  #resetUiFileWatchers(): void {
    this.#disposeUiFileWatchers();
    for (const root of this.#contexts.keys()) {
      const watchers = ['CustomUIData.lua', 'CustomUIData2.lua'].map((filename) => {
        const watcher = vscode.workspace.createFileSystemWatcher(
          new vscode.RelativePattern(root, `src/Data/${filename}`),
        );
        const notify = (): void => { this.#uiExportWatcher.changed(root); };
        watcher.onDidCreate(notify);
        watcher.onDidChange(notify);
        watcher.onDidDelete(notify);
        return watcher;
      });
      this.#uiFileWatchers.set(root, watchers);
    }
  }

  #disposeProjectDisplayWatchers(): void {
    for (const watcher of this.#projectDisplayWatchers.values()) watcher.dispose();
    this.#projectDisplayWatchers.clear();
  }

  #resetProjectDisplayWatchers(): void {
    this.#disposeProjectDisplayWatchers();
    for (const root of this.#contexts.keys()) {
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(root, '.yuanmeng-inspector/project-display.json'),
      );
      const refresh = (): void => {
        void this.#refreshProjectDisplay(root).catch((error) => {
          const reason = error instanceof Error ? error.message : String(error);
          void vscode.window.showWarningMessage(`地图名称自动刷新失败：${reason}`);
        });
      };
      watcher.onDidCreate(refresh);
      watcher.onDidChange(refresh);
      watcher.onDidDelete(refresh);
      this.#projectDisplayWatchers.set(root, watcher);
    }
  }

  async #refreshProjectDisplay(root: string): Promise<void> {
    const context = this.get(root);
    const profile = await readProjectDisplayProfile(root, context.project.projectInstanceId, nodeFileIO);
    const next = profile?.mapDisplayName ?? null;
    if (context.mapDisplayName === next) return;
    context.mapDisplayName = next;
    this.#changeEmitter.fire();
  }

  async setMapDisplayName(root: string, mapDisplayName: string): Promise<string> {
    const context = this.get(root);
    const profile = await writeProjectDisplayProfile(
      root,
      context.project.projectInstanceId,
      mapDisplayName,
      nodeFileIO,
    );
    context.mapDisplayName = profile.mapDisplayName;
    this.#changeEmitter.fire();
    return profile.mapDisplayName;
  }

  async #queueUiRefresh<T>(
    root: string,
    operation: (generation: UiRefreshGeneration) => Promise<T>,
    watch?: UiExportRefreshContext,
  ): Promise<T> {
    return this.#uiRefreshLifecycle.start(root, operation, watch?.signal);
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
      await mutateRegistry(path, () => undefined);
      return RegistryStore.open(path);
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
    this.get(root);
    const path = join(root, '.yuanmeng-inspector', 'registry', 'registry.json');
    await commitRegistryImportTransaction(path, preview);
    this.#changeEmitter.fire();
  }

  async previewClipboardSceneId(
    root: string,
    value: string,
    name: string,
  ): Promise<ClipboardSceneRegistrationPreview> {
    if (!/^[1-9]\d*$/u.test(value)) {
      throw new ProductError('VALIDATION_FAILED', '剪贴板内容不是有效的十进制场景实例 ID。', ['在元梦编辑器复制实例 ID 后重新运行此命令。'], 'STATIC_LOCAL');
    }
    const normalizedName = name.trim();
    if (normalizedName === '') {
      throw new ProductError('VALIDATION_FAILED', '登记名称不能为空。', ['填写便于识别的元件名称。'], 'STATIC_LOCAL');
    }
    const context = this.get(root);
    const store = await this.#openRegistry(root, true);
    const observedAt = new Date().toISOString();
    const identity = `${context.project.projectInstanceId}\0${context.project.mapFingerprint ?? ''}\0${value}`;
    const record: RegistryRecord = {
      recordId: `manual-scene-${sha256Hex(identity)}`,
      kind: 'scene-instance',
      name: normalizedName,
      value,
      scope: context.project.mapFingerprint === null ? 'workspace' : 'map',
      projectInstanceId: context.project.projectInstanceId,
      mapFingerprint: context.project.mapFingerprint,
      layerId: null,
      environment: 'unspecified',
      validity: 'pending',
      source: {
        kind: 'user-entry',
        relativePath: null,
        sha256: sha256Hex(`explicit-clipboard\0${identity}`),
        observedAt,
        officialExtensionVersion: null,
        evidence: 'USER_ATTESTED',
      },
      lastConfirmedAt: null,
      notes: '由用户显式执行剪贴板导入命令登记；插件不在后台读取剪贴板。',
    };
    const retained = store!.list().filter((candidate) => !(
      candidate.kind === 'scene-instance'
      && candidate.projectInstanceId === record.projectInstanceId
      && candidate.mapFingerprint === record.mapFingerprint
      && candidate.value === record.value
    ));
    const document: RegistryDocument = { schemaVersion: 1, records: [...retained, record] };
    return { ...(await store!.previewImport(JSON.stringify(document), 'json')), record };
  }

  async refreshUi(root: string): Promise<UiRefreshResult> {
    return this.#queueUiRefresh(root, async (generation) => this.#refreshUiNow(root, true, generation));
  }

  async #refreshUiFromFiles(root: string, generation: UiRefreshGeneration): Promise<UiRefreshResult> {
    return this.#refreshUiNow(root, false, generation);
  }

  async #refreshUiNow(root: string, executeOfficialCommand: boolean, generation: UiRefreshGeneration): Promise<UiRefreshResult> {
    const context = this.get(root);
    const guard = (): void => {
      this.#uiRefreshLifecycle.assertCurrent(generation);
      if (this.#contexts.get(root) !== context) {
        const error = new Error('UI 刷新工作区上下文已被替代。');
        error.name = 'AbortError';
        throw error;
      }
    };
    guard();
    const sourcePaths = [
      join(root, 'src', 'Data', 'CustomUIData.lua'),
      join(root, 'src', 'Data', 'CustomUIData2.lua'),
    ] as const;
    const baselineHashes: Record<string, string | null> = {};
    const baselineSignatures: Record<string, string | null> = {};
    for (const path of sourcePaths) {
      guard();
      const relativePath = path.endsWith('CustomUIData2.lua')
        ? 'src/Data/CustomUIData2.lua'
        : 'src/Data/CustomUIData.lua';
      baselineHashes[path] = executeOfficialCommand
        ? await optionalHash(path)
        : context.snapshot?.sources.find((source) => source.relativePath === relativePath)?.sha256 ?? null;
      baselineSignatures[path] = executeOfficialCommand ? await optionalSignature(path) : null;
    }
    const adapter = new OfficialCommandAdapter(commandHost());
    const capabilities = await adapter.detect();
    guard();
    if (executeOfficialCommand) await adapter.execute('refreshUi');
    guard();
    const configuration = vscode.workspace.getConfiguration('yuanmengAi');
    const stable = await waitForStableExport({
      io: nodeFileIO,
      paths: sourcePaths,
      baselineHashes,
      baselineSignatures,
      acceptUnchangedStableFiles: true,
      requireSignatureChangeForUnchanged: executeOfficialCommand,
      sampleMilliseconds: configuration.get<number>('fileStableSampleMilliseconds', 150),
      stableSampleCount: configuration.get<number>('fileStableSampleCount', 3),
      totalTimeoutMilliseconds: configuration.get<number>('uiRefreshTimeoutSeconds', 15) * 1000,
      signal: generation.signal,
    });
    guard();
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
        const baseStatus = reduceStatus({
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
        this.#baseStatuses.set(root, baseStatus);
        await guardedAtomicWriteJson(join(root, '.yuanmeng-inspector', 'status.json'), baseStatus, validateStatus, guard);
        context.status = withOfficialConnection(baseStatus, this.#officialConnections.get(root));
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
    const layerOrderGuard = await updateUiLayerOrderGuard(
      root,
      candidateSnapshot,
      observedAt,
      nodeFileIO,
      guard,
    );
    guard();
    const candidateHashes = snapshotSourceHashes(candidateSnapshot);
    const retainExistingSnapshot = stable.reasonCode === 'REFRESH_SUCCEEDED_UNCHANGED'
      && context.snapshot !== null
      && sameHashes(snapshotSourceHashes(context.snapshot), candidateHashes);
    const snapshot = retainExistingSnapshot ? context.snapshot! : candidateSnapshot;
    if (!retainExistingSnapshot) {
      const snapshotRoot = join(root, '.yuanmeng-inspector', 'ui');
      await guardedAtomicWriteJson(join(snapshotRoot, 'snapshots', `${snapshot.snapshotId}.json`), snapshot, validateSnapshot, guard);
      await guardedAtomicWriteJson(join(snapshotRoot, 'current.json'), snapshot, validateSnapshot, guard);
    }
    const verifiedFresh = stable.reasonCode === 'REFRESH_SUCCEEDED'
      || (retainExistingSnapshot && !context.status.ui.reasonCodes.includes('UNVERIFIED_SNAPSHOT'));
    const baseStatus = reduceStatus({
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
        // 快照内容没有变化时保留原 snapshotId，但本次稳定读取仍然是一次成功检查。
        // “内容生成时间”和“最近成功核对时间”必须分开，否则使用旧快照超过
        // staleAfterMinutes 后，即使刚刚核对过也会立刻被错误标成陈旧。
        lastRefreshAt: observedAt,
        sourceHashes: snapshotSourceHashes(snapshot),
        mapFingerprint: snapshot.mapFingerprint,
        officialExtensionVersion: snapshotOfficialExtensionVersion(snapshot),
        verifiedFresh,
      },
      project: context.project,
      currentSourceHashes: candidateHashes,
      staleAfterMinutes: configuration.get<number>('staleAfterMinutes', 30),
    });
    this.#baseStatuses.set(root, baseStatus);
    await guardedAtomicWriteJson(join(root, '.yuanmeng-inspector', 'status.json'), baseStatus, validateStatus, guard);
    guard();
    const registryPath = join(root, '.yuanmeng-inspector', 'registry', 'registry.json');
    await mutateRegistry(
      registryPath,
      (registry) => { registry.syncUiSnapshot(snapshot, { fresh: baseStatus.ui.freshness === 'fresh' }); },
      { signal: generation.signal, commitGuard: guard },
    );
    guard();
    context.snapshot = snapshot;
    context.status = withOfficialConnection(baseStatus, this.#officialConnections.get(root));
    this.#changeEmitter.fire();
    return {
      reasonCode: stable.reasonCode,
      layerOrderGuard: layerOrderGuard.status,
      layerOrderIncidentRelativePath: layerOrderGuard.incidentRelativePath,
    };
  }

  findUi(root: string, query: string): UiSearchResult {
    const snapshot = this.get(root).snapshot;
    return snapshot === null ? { kind: 'not-found' } : findUi(snapshot, query, { mode: 'exact-name' });
  }
}
