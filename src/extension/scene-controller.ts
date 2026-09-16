import { basename, dirname, join } from 'node:path';

import * as vscode from 'vscode';

import { ProductError } from '../core/errors.js';
import { nodeFileIO } from '../core/fs.js';
import { stableJson } from '../core/hash.js';
import { mutateRegistry } from '../core/registry/store.js';
import { queryScene, type SceneIndex, type SceneQuery, type SceneQueryResult } from '../core/scene/index.js';
import { sceneSnapshotNeedsAdapterRefresh } from '../core/scene/normalize.js';
import {
  loadStoredCapabilityEvidenceIndex,
  type CapabilityEvidenceResolution,
} from '../core/scene/probe-evidence.js';
import { loadSceneHeads, loadSceneSnapshot, type SceneHeads } from '../core/scene/store.js';
import type { SceneSnapshot } from '../core/scene/types.js';
import type { SceneWorkerPhase } from '../core/scene/worker-protocol.js';
import { indexSceneSnapshotInWorker, processSceneSourceInWorker } from '../core/scene/worker-client.js';
import {
  refreshSceneFromBinding,
  SceneWatcherEpochRegistry,
  sharedSceneRefreshScheduler,
  type SceneRefreshGeneration,
  type SceneWatcherEpoch,
  type SceneWatcherEvent,
} from '../core/scene/workflow.js';
import {
  createSceneSourceBinding,
  loadSceneSourceBindings,
  restoreSceneSourceBindingIfCurrent,
  saveSceneSourceBinding,
  type SceneSourceBinding,
} from '../integrations/scene/source.js';
import type { SceneSourceRole } from '../core/scene/container.js';
import type { WorkspaceContextManager } from './workspaces.js';

export interface SceneProjectState {
  root: string;
  bindings: SceneSourceBinding[];
  heads: SceneHeads;
  snapshot: SceneSnapshot | null;
  runtimeCapabilities: ReadonlyMap<string, CapabilityEvidenceResolution>;
  refreshing: boolean;
  refreshPhase: SceneWorkerPhase | null;
  lastError: string | null;
  /** 已由用户显式登记的场景实例数量；不等于完整场景枚举。 */
  registeredSceneInstances?: number;
}

function emptyHeads(): SceneHeads {
  return { schemaVersion: 1, manualSnapshotId: null, autoSnapshotId: null, rawSnapshotId: null, preferredSnapshotId: null };
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : '未知场景读取错误';
}

export class SceneController implements vscode.Disposable {
  readonly #manager: WorkspaceContextManager;
  readonly #states = new Map<string, SceneProjectState>();
  readonly #indexes = new Map<string, SceneIndex>();
  readonly #watchers = new Map<string, vscode.Disposable>();
  readonly #watchEpochs = new SceneWatcherEpochRegistry<SceneSourceBinding>();
  readonly #refreshes = sharedSceneRefreshScheduler;
  readonly #timers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.#changeEmitter.event;
  #reloadBarrier: Promise<void> = Promise.resolve();
  #disposed = false;
  #lifecycleEpoch = 0;

  private constructor(manager: WorkspaceContextManager) {
    this.#manager = manager;
  }

  static async create(manager: WorkspaceContextManager): Promise<SceneController> {
    const controller = new SceneController(manager);
    await controller.reload();
    return controller;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#lifecycleEpoch += 1;
    this.#disposeWatchRuntime();
    void this.#refreshes.cancelRoots(this.#states.keys());
    this.#changeEmitter.dispose();
  }

  list(): SceneProjectState[] {
    return [...this.#states.values()];
  }

  get(root: string): SceneProjectState {
    const state = this.#states.get(root);
    if (state === undefined) throw new ProductError('VALIDATION_FAILED', '场景目标工程不在当前工作区。', ['选择有效的元梦工程。'], 'STATIC_LOCAL');
    return state;
  }

  reload(): Promise<void> {
    const lifecycleEpoch = this.#lifecycleEpoch += 1;
    const task = this.#reloadBarrier.catch(() => undefined).then(async () => this.#reloadNow(lifecycleEpoch));
    this.#reloadBarrier = task;
    return task;
  }

  async #reloadNow(lifecycleEpoch: number): Promise<void> {
    this.#assertLifecycle(lifecycleEpoch);
    this.#disposeWatchRuntime();
    const contexts = this.#manager.list();
    const roots = new Set([...this.#states.keys(), ...contexts.map((context) => context.project.root)]);
    await this.#refreshes.cancelRoots(roots);
    this.#assertLifecycle(lifecycleEpoch);
    this.#states.clear();
    this.#indexes.clear();
    const adapterUpgrades: Array<{ root: string; role: SceneSourceRole }> = [];
    for (const context of contexts) {
      this.#assertLifecycle(lifecycleEpoch);
      const state: SceneProjectState = {
        root: context.project.root,
        bindings: [],
        heads: emptyHeads(),
        snapshot: null,
        runtimeCapabilities: new Map(),
        refreshing: false,
        refreshPhase: null,
        lastError: null,
        registeredSceneInstances: 0,
      };
      try {
        state.registeredSceneInstances = (await this.#manager.listRegistry(context.project.root))
          .filter((record) => record.kind === 'scene-instance').length;
        state.bindings = (await loadSceneSourceBindings(context.project.root, nodeFileIO)).filter((binding) => (
          binding.projectInstanceId === context.project.projectInstanceId
          && binding.projectRootHash === context.project.projectRootHash
        ));
        this.#assertLifecycle(lifecycleEpoch);
        state.heads = await loadSceneHeads(context.project.root, nodeFileIO);
        this.#assertLifecycle(lifecycleEpoch);
        if (state.heads.preferredSnapshotId !== null) {
          state.snapshot = await loadSceneSnapshot(context.project.root, state.heads.preferredSnapshotId, nodeFileIO);
          this.#assertLifecycle(lifecycleEpoch);
          if (sceneSnapshotNeedsAdapterRefresh(state.snapshot)) {
            const staleAdapter = state.snapshot.adapterId;
            const staleRole = state.snapshot.role;
            state.snapshot = null;
            state.runtimeCapabilities = new Map();
            state.lastError = `场景解析器已升级（旧 ${staleAdapter}），正在重新读取当前来源。`;
            if (state.bindings.some((binding) => binding.role === staleRole)) {
              adapterUpgrades.push({ root: context.project.root, role: staleRole });
            }
          } else {
            state.runtimeCapabilities = await this.#loadRuntimeCapabilities(context.project.root, state.snapshot);
            this.#assertLifecycle(lifecycleEpoch);
            this.#indexes.set(context.project.root, await indexSceneSnapshotInWorker(state.snapshot));
            this.#assertLifecycle(lifecycleEpoch);
          }
        }
      } catch (error) {
        state.lastError = messageFor(error);
      }
      this.#assertLifecycle(lifecycleEpoch);
      this.#states.set(context.project.root, state);
      this.#watchBindingStore(context.project.root);
      for (const binding of state.bindings) this.#watch(context.project.root, binding);
    }
    this.#assertLifecycle(lifecycleEpoch);
    this.#changeEmitter.fire();
    if (adapterUpgrades.length > 0) queueMicrotask(() => {
      if (!this.#lifecycleIsCurrent(lifecycleEpoch)) return;
      for (const upgrade of adapterUpgrades) void this.refresh(upgrade.root, upgrade.role).catch(() => undefined);
    });
  }

  async bind(root: string, role: SceneSourceRole, sourcePath: string): Promise<SceneSnapshot> {
    const lifecycleEpoch = await this.#awaitReady();
    const state = this.get(root);
    const previous = state.bindings.find((candidate) => candidate.role === role) ?? null;
    return this.#refreshes.start(root, role, async (generation) => {
      let saved = false;
      let attempted: SceneSourceBinding | null = null;
      try {
        this.#assertLifecycle(lifecycleEpoch);
        const context = this.#manager.get(root);
        const binding = await createSceneSourceBinding({
          io: nodeFileIO,
          projectInstanceId: context.project.projectInstanceId,
          projectRootHash: context.project.projectRootHash,
          role,
          sourcePath,
        });
        attempted = binding;
        this.#assertBindCurrent(root, generation, lifecycleEpoch);
        await saveSceneSourceBinding(root, binding, nodeFileIO, {
          signal: generation.signal,
          commitGuard: () => this.#assertBindCurrent(root, generation, lifecycleEpoch),
        });
        saved = true;
        this.#assertBindCurrent(root, generation, lifecycleEpoch);
        state.bindings = [...state.bindings.filter((candidate) => candidate.role !== role), binding];
        this.#replaceWatcher(root, binding, false);
        this.#changeEmitter.fire();
        return await this.#refreshNow(root, binding, generation);
      } catch (error) {
        const stale = !this.#lifecycleIsCurrent(lifecycleEpoch) || !this.#refreshes.isCurrent(root, generation);
        if (saved && attempted !== null && stale) {
          const restored = await restoreSceneSourceBindingIfCurrent(root, attempted, previous, nodeFileIO);
          const current = state.bindings.find((candidate) => candidate.role === role);
          if (
            restored
            && this.#lifecycleIsCurrent(lifecycleEpoch)
            && current?.bindingId === attempted.bindingId
          ) {
            state.bindings = previous === null
              ? state.bindings.filter((candidate) => candidate.role !== role)
              : [...state.bindings.filter((candidate) => candidate.role !== role), previous];
            if (previous === null) this.#removeWatcher(root, role);
            else this.#replaceWatcher(root, previous, false);
            this.#changeEmitter.fire();
          }
        }
        throw error;
      }
    });
  }

  preferredBinding(root: string, role?: SceneSourceRole): SceneSourceBinding {
    const state = this.get(root);
    const selectedRole = role ?? state.snapshot?.role;
    const binding = selectedRole === undefined
      ? state.bindings.find((candidate) => candidate.role === 'manual-dat')
        ?? state.bindings.find((candidate) => candidate.role === 'raw-pbin')
        ?? state.bindings.find((candidate) => candidate.role === 'auto-dat')
      : state.bindings.find((candidate) => candidate.role === selectedRole);
    if (binding === undefined) throw new ProductError(
      'NOT_FOUND',
      '当前工程尚未绑定官方场景源文件。',
      ['AI 应先检查 scene-status；已唯一确认当前地图 LayerData 路径时直接绑定并校验已知 ID，只有路径无法唯一确认时才让用户选择一次。编辑器尚未落盘时暂时跳过场景索引。'],
      'STATIC_LOCAL',
    );
    return binding;
  }

  async refresh(root: string, role?: SceneSourceRole): Promise<SceneSnapshot> {
    await this.#awaitReady();
    await this.#synchronizeBindingsFromDisk(root);
    const binding = this.preferredBinding(root, role);
    return this.#refreshes.start(root, binding.role, async (generation) => (
      this.#refreshNow(root, binding, generation)
    ));
  }

  async reloadRuntimeEvidence(root: string): Promise<void> {
    await this.#awaitReady();
    const state = this.get(root);
    if (state.snapshot === null) return;
    state.runtimeCapabilities = await this.#loadRuntimeCapabilities(root, state.snapshot);
    this.#changeEmitter.fire();
  }

  runtimeCapability(root: string, instanceId: string): CapabilityEvidenceResolution | null {
    return this.get(root).runtimeCapabilities.get(instanceId) ?? null;
  }

  async #refreshNow(
    root: string,
    binding: SceneSourceBinding,
    generation: SceneRefreshGeneration,
  ): Promise<SceneSnapshot> {
    const state = this.get(root);
    state.refreshing = true;
    state.refreshPhase = null;
    state.lastError = null;
    this.#changeEmitter.fire();
    try {
      const configuration = vscode.workspace.getConfiguration('yuanmengAi', vscode.Uri.file(root));
      const result = await refreshSceneFromBinding(root, binding, {
        io: nodeFileIO,
        preferred: binding.role !== 'auto-dat' || state.heads.preferredSnapshotId === null,
        sampleMilliseconds: configuration.get<number>('sceneStableSampleMilliseconds', 200),
        stableSampleCount: configuration.get<number>('sceneStableSampleCount', 3),
        totalTimeoutMilliseconds: configuration.get<number>('sceneRefreshTimeoutSeconds', 30) * 1000,
        signal: generation.signal,
        commitGuard: () => this.#assertCurrent(root, generation),
        processSource: (input, callbacks) => processSceneSourceInWorker(input, callbacks),
        onProgress: (phase) => {
          if (this.#refreshes.isCurrent(root, generation)) {
            state.refreshPhase = phase;
            this.#changeEmitter.fire();
          }
        },
      });
      this.#assertCurrent(root, generation);
      state.heads = result.heads;
      if (result.heads.preferredSnapshotId === result.snapshot.snapshotId) {
        state.snapshot = result.snapshot;
        state.runtimeCapabilities = await this.#loadRuntimeCapabilities(root, result.snapshot);
        this.#assertCurrent(root, generation);
        const currentIndex = this.#indexes.get(root);
        if (result.index !== null) this.#indexes.set(root, result.index);
        else if (currentIndex?.snapshot.snapshotId !== result.snapshot.snapshotId) {
          this.#indexes.set(root, await indexSceneSnapshotInWorker(result.snapshot, { signal: generation.signal }));
          this.#assertCurrent(root, generation);
        }
      }
      const project = this.#manager.get(root).project;
      const registryPath = join(root, '.yuanmeng-inspector', 'registry', 'registry.json');
      this.#assertCurrent(root, generation);
      await mutateRegistry(
        registryPath,
        (registry) => {
          registry.syncSceneSnapshot(result.snapshot, {
            projectInstanceId: project.projectInstanceId,
            mapFingerprint: project.mapFingerprint,
            authoritative: result.heads.preferredSnapshotId === result.snapshot.snapshotId,
          });
        },
        { signal: generation.signal, commitGuard: () => this.#assertCurrent(root, generation) },
      );
      this.#assertCurrent(root, generation);
      return result.snapshot;
    } catch (error) {
      if (this.#refreshes.isCurrent(root, generation)) state.lastError = messageFor(error);
      throw error;
    } finally {
      if (this.#refreshes.isCurrent(root, generation) && !this.#refreshes.hasPending(root)) {
        state.refreshing = false;
        state.refreshPhase = null;
        this.#changeEmitter.fire();
      }
    }
  }

  find(root: string, query: SceneQuery): SceneQueryResult {
    this.get(root);
    const index = this.#indexes.get(root);
    return index === undefined ? { kind: 'not-found', matches: [] } : queryScene(index, query);
  }

  async #loadRuntimeCapabilities(
    root: string,
    snapshot: SceneSnapshot,
  ): Promise<Map<string, CapabilityEvidenceResolution>> {
    const project = this.#manager.get(root).project;
    return loadStoredCapabilityEvidenceIndex(root, {
      projectInstanceId: project.projectInstanceId,
      bindingId: snapshot.bindingId,
      snapshotId: snapshot.snapshotId,
      sceneSourceSha256: snapshot.sourceSha256,
    }, nodeFileIO);
  }

  async #synchronizeBindingsFromDisk(root: string): Promise<void> {
    const state = this.get(root);
    const project = this.#manager.get(root).project;
    const bindings = (await loadSceneSourceBindings(root, nodeFileIO)).filter((binding) => (
      binding.projectInstanceId === project.projectInstanceId
      && binding.projectRootHash === project.projectRootHash
    ));
    if (stableJson(bindings) === stableJson(state.bindings)) return;
    await this.reload();
  }

  #watchBindingStore(root: string): void {
    const key = `${root}\0binding-store`;
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(root), '.yuanmeng-inspector/scene/bindings/*.json'),
      false,
      false,
      false,
    );
    const schedule = (): void => {
      const current = this.#timers.get(key);
      if (current !== undefined) clearTimeout(current);
      this.#timers.set(key, setTimeout(() => {
        this.#timers.delete(key);
        void this.#synchronizeBindingsFromDisk(root).catch((error) => {
          const state = this.#states.get(root);
          if (state === undefined) return;
          state.lastError = messageFor(error);
          this.#changeEmitter.fire();
        });
      }, 250));
    };
    this.#watchers.set(key, vscode.Disposable.from(
      watcher,
      watcher.onDidCreate(schedule),
      watcher.onDidChange(schedule),
      watcher.onDidDelete(schedule),
    ));
  }

  #watch(root: string, binding: SceneSourceBinding): void {
    const key = `${root}\0${binding.role}`;
    const epoch = this.#watchEpochs.replace(key, binding);
    const pattern = new vscode.RelativePattern(dirname(binding.sourcePath), basename(binding.sourcePath));
    const watcher = vscode.workspace.createFileSystemWatcher(pattern, false, false, false);
    const schedule = (): void => {
      const event = this.#watchEpochs.nextEvent(epoch, binding);
      if (event === null || !this.#watchEventIsCurrent(root, binding, event)) return;
      if (this.#refreshes.isRunning(root)) {
        this.#refreshes.markDirty(root, binding.role, async (generation) => (
          this.#refreshNow(root, binding, generation)
        ));
        return;
      }
      const current = this.#timers.get(key);
      if (current !== undefined) clearTimeout(current);
      this.#timers.set(key, setTimeout(() => {
        this.#timers.delete(key);
        if (this.#watchEventIsCurrent(root, binding, event)) void this.refresh(root, binding.role).catch(() => undefined);
      }, 400));
    };
    this.#watchers.set(key, vscode.Disposable.from(
      watcher,
      watcher.onDidCreate(schedule),
      watcher.onDidChange(schedule),
      watcher.onDidDelete(() => {
        const event = this.#watchEpochs.nextEvent(epoch, binding);
        if (event !== null) void this.#sourceDeleted(root, binding, key, event).catch(() => undefined);
      }),
    ));
  }

  #replaceWatcher(root: string, binding: SceneSourceBinding, cancelCurrent = true): void {
    const key = `${root}\0${binding.role}`;
    this.#watchEpochs.invalidate(key);
    this.#watchers.get(key)?.dispose();
    this.#watchers.delete(key);
    const timer = this.#timers.get(key);
    if (timer !== undefined) clearTimeout(timer);
    this.#timers.delete(key);
    if (cancelCurrent) void this.#refreshes.cancelLane(root, binding.role);
    this.#watch(root, binding);
  }

  #removeWatcher(root: string, role: SceneSourceRole): void {
    const key = `${root}\0${role}`;
    this.#watchEpochs.invalidate(key);
    this.#watchers.get(key)?.dispose();
    this.#watchers.delete(key);
    const timer = this.#timers.get(key);
    if (timer !== undefined) clearTimeout(timer);
    this.#timers.delete(key);
  }

  async #sourceDeleted(
    root: string,
    binding: SceneSourceBinding,
    key: string,
    event: SceneWatcherEvent<SceneSourceBinding>,
  ): Promise<void> {
    if (!this.#watchEventIsCurrent(root, binding, event)) return;
    const timer = this.#timers.get(key);
    if (timer !== undefined) clearTimeout(timer);
    this.#timers.delete(key);
    const cancelled = await this.#refreshes.cancelLane(root, binding.role);
    if (!this.#watchEventIsCurrent(root, binding, event)) return;
    try {
      await nodeFileIO.stat(binding.sourcePath);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (!this.#watchEventIsCurrent(root, binding, event)) return;
    const currentState = this.#states.get(root);
    if (currentState === undefined) return;
    currentState.lastError = `${basename(binding.sourcePath)} 已删除；保留上一份可用快照。`;
    if (cancelled.rootIdle) currentState.refreshing = false;
    this.#changeEmitter.fire();
  }

  #disposeWatchRuntime(): void {
    this.#watchEpochs.clear();
    for (const watcher of this.#watchers.values()) watcher.dispose();
    this.#watchers.clear();
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
  }

  #watchIsCurrent(
    root: string,
    binding: SceneSourceBinding,
    epoch: SceneWatcherEpoch<SceneSourceBinding>,
  ): boolean {
    const currentBinding = this.#states.get(root)?.bindings.find((candidate) => candidate.role === binding.role);
    return currentBinding === binding && this.#watchEpochs.isCurrent(epoch, binding);
  }

  #watchEventIsCurrent(
    root: string,
    binding: SceneSourceBinding,
    event: SceneWatcherEvent<SceneSourceBinding>,
  ): boolean {
    return this.#watchIsCurrent(root, binding, event.watcher)
      && this.#watchEpochs.isCurrentEvent(event, binding);
  }

  async #awaitReady(): Promise<number> {
    for (;;) {
      const lifecycleEpoch = this.#lifecycleEpoch;
      const barrier = this.#reloadBarrier;
      await barrier;
      this.#assertActive();
      if (lifecycleEpoch === this.#lifecycleEpoch && barrier === this.#reloadBarrier) return lifecycleEpoch;
    }
  }

  #lifecycleIsCurrent(lifecycleEpoch: number): boolean {
    return !this.#disposed && lifecycleEpoch === this.#lifecycleEpoch;
  }

  #assertLifecycle(lifecycleEpoch: number): void {
    this.#assertActive();
    if (lifecycleEpoch !== this.#lifecycleEpoch) {
      throw new ProductError('VALIDATION_FAILED', '场景控制器生命周期已更新。', ['等待重新加载完成后重试。'], 'STATIC_LOCAL');
    }
  }

  #assertBindCurrent(
    root: string,
    generation: SceneRefreshGeneration,
    lifecycleEpoch: number,
  ): void {
    this.#assertLifecycle(lifecycleEpoch);
    this.#assertCurrent(root, generation);
  }

  #assertActive(): void {
    if (!this.#disposed) return;
    throw new ProductError('VALIDATION_FAILED', '场景控制器已释放。', ['重新加载扩展后重试。'], 'STATIC_LOCAL');
  }

  #assertCurrent(root: string, generation: SceneRefreshGeneration): void {
    if (this.#refreshes.isCurrent(root, generation)) return;
    if (generation.signal.reason !== undefined) throw generation.signal.reason;
    const error = new Error('场景刷新已被更新一代替代。');
    error.name = 'AbortError';
    throw error;
  }
}

export interface SceneStatusPresentation {
  text: string;
  tooltip: string;
}

const SCENE_PHASE_LABELS: Readonly<Record<SceneWorkerPhase, string>> = {
  container: '读取容器',
  wire: '解析数据',
  normalize: '规范化',
  index: '建立索引',
  diff: '计算差异',
  complete: '完成',
};

export function renderSceneStatus(
  states: readonly SceneProjectState[],
  activeRoot: string | null,
  uiControlCount: number | null = null,
): SceneStatusPresentation {
  const uiText = uiControlCount === null ? 'UI:未读取' : `UI:${uiControlCount} 个控件`;
  const withUi = (text: string, tooltip: string): SceneStatusPresentation => ({
    text: `${text} | ${uiText}`,
    tooltip: `${tooltip}\n${uiControlCount === null ? 'UI 控件数量尚未读取。' : `UI 控件 ${uiControlCount} 个。`}`,
  });
  const active = activeRoot === null ? undefined : states.find((state) => state.root === activeRoot);
  const state = active ?? (states.length === 1 ? states[0] : undefined);
  if (state !== undefined) {
    if (state.bindings.length === 0 && state.snapshot === null && (state.registeredSceneInstances ?? 0) > 0) {
      const count = state.registeredSceneInstances!;
      return withUi(
        `$(symbol-structure) 场景:${count} 个元件`,
        `当前没有完整场景快照，但已有 ${count} 个用户显式登记的场景实例 ID。可用于单个元件属性读取和只读运行时校准；不代表全场景已枚举。`,
      );
    }
    if (state.bindings.length === 0 && state.snapshot === null) {
      return withUi(
        '$(symbol-structure) 场景:未接入',
        '当前工程没有已绑定的官方场景文件。插件只读取已落盘的 LayerData.dat、LayerData-Auto.dat 或 LayerData.pbin，不读取官方编辑器内存；没有这些文件时请跳过场景索引。',
      );
    }
    if (state.refreshing) {
      const phase = state.refreshPhase;
      const sceneText = state.snapshot === null
        ? '场景:读取中'
        : `场景:${state.snapshot.instances.length} 个元件 · 读取中`;
      return withUi(
        `$(sync~spin) ${sceneText}${phase === null ? '' : ` · ${SCENE_PHASE_LABELS[phase]}`}`,
        phase === null ? '正在等待文件稳定并刷新场景索引。' : `后台阶段：${SCENE_PHASE_LABELS[phase]}。`,
      );
    }
    if (state.lastError !== null) return withUi('$(warning) 场景:错误', state.lastError);
    if (state.snapshot === null) return withUi('$(warning) 场景:无快照', '运行“刷新场景元件与 ID”。');
    return withUi(
      `$(symbol-structure) 场景:${state.snapshot.instances.length} 个元件`,
      `来源 ${state.snapshot.role}\n快照 ${state.snapshot.observedAt}\n编组 ${state.snapshot.groups.length}\n问题 ${state.snapshot.issues.length}`,
    );
  }
  if (states.length === 0) return withUi('$(symbol-structure) 场景:无工程', '当前工作区没有可用的元梦工程。');
  const refreshing = states.filter((candidate) => candidate.refreshing).length;
  const errors = states.filter((candidate) => candidate.lastError !== null).length;
  const instances = states.reduce((total, candidate) => total + (candidate.snapshot?.instances.length ?? 0), 0);
  return withUi(
    `$(symbol-structure) 场景:${instances} 个元件`,
    `未明确选择活动工程；当前聚合 ${states.length} 个工程，${refreshing} 个读取中，${errors} 个错误。点击刷新时将要求选择目标工程。`,
  );
}

function resolveUiControlCount(
  manager: WorkspaceContextManager,
  states: readonly SceneProjectState[],
  activeRoot: string | null,
): number | null {
  const selectedRoot = activeRoot ?? (states.length === 1 ? states[0]?.root ?? null : null);
  if (selectedRoot !== null) {
    return manager.list().find((context) => context.project.root === selectedRoot)?.snapshot?.nodes.length ?? null;
  }
  const contexts = manager.list();
  if (contexts.length === 0 || contexts.some((context) => context.snapshot === null)) return null;
  return contexts.reduce((total, context) => total + context.snapshot!.nodes.length, 0);
}

export function createSceneStatusBar(controller: SceneController, manager: WorkspaceContextManager): vscode.Disposable {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 19);
  item.command = 'yuanmengAi.refreshScene';
  const update = (): void => {
    const activeUri = vscode.window.activeTextEditor?.document.uri;
    const activeFolder = activeUri === undefined ? undefined : vscode.workspace.getWorkspaceFolder(activeUri);
    const activeRoot = activeFolder?.uri.fsPath ?? null;
    const states = controller.list();
    const presentation = renderSceneStatus(states, activeRoot, resolveUiControlCount(manager, states, activeRoot));
    item.text = presentation.text;
    item.tooltip = presentation.tooltip;
    item.show();
  };
  update();
  return vscode.Disposable.from(item, controller.onDidChange(update), vscode.window.onDidChangeActiveTextEditor(update));
}
