import type { FileIO } from '../fs.js';
import { readSceneContainer } from './container.js';
import { createSceneIndex, type SceneIndex } from './index.js';
import { normalizeObservedScene, SCENE_ADAPTER_ID } from './normalize.js';
import {
  loadSceneHeadsOrEmpty,
  loadSceneSnapshotIfValid,
  saveSceneSnapshot,
  setPreferredSceneSnapshot,
  type SceneHeads,
} from './store.js';
import type { SceneSnapshot } from './types.js';
import type {
  SceneWorkerPhase,
  SceneWorkerProcessInput,
  SceneWorkerProcessResult,
} from './worker-protocol.js';
import { readStableSceneSource, type SceneSourceBinding } from '../../integrations/scene/source.js';

export interface RefreshSceneOptions {
  io: FileIO;
  preferred: boolean;
  sampleMilliseconds?: number;
  stableSampleCount?: number;
  totalTimeoutMilliseconds?: number;
  observedAt?: string;
  signal?: AbortSignal;
  processSource?(input: SceneWorkerProcessInput, callbacks: {
    signal?: AbortSignal;
    onProgress?(phase: SceneWorkerPhase): void;
  }): Promise<SceneWorkerProcessResult>;
  onProgress?(phase: SceneWorkerPhase): void;
  commitGuard?(): void;
}

export interface RefreshSceneResult {
  snapshot: SceneSnapshot;
  index: SceneIndex | null;
  heads: SceneHeads;
  elapsedMilliseconds: number;
}

export interface SceneRefreshGeneration {
  generation: number;
  signal: AbortSignal;
}

type SceneRefreshOperation<T> = (generation: SceneRefreshGeneration) => Promise<T>;

interface SceneRefreshCurrent {
  lane: string;
  generation: number;
  controller: AbortController;
  promise: Promise<unknown>;
}

interface SceneRefreshPending {
  operation: SceneRefreshOperation<unknown>;
  promise: Promise<unknown>;
  resolve(value: unknown): void;
  reject(error: unknown): void;
}

interface SceneRefreshRoot {
  current: SceneRefreshCurrent | null;
  pending: Map<string, SceneRefreshPending>;
}

export class SceneRefreshGenerationQueue {
  readonly #roots = new Map<string, SceneRefreshRoot>();
  readonly #generations = new Map<string, number>();
  readonly #rootBarriers = new Map<string, Promise<void>>();
  #cancelBarrier: Promise<void> | null = null;

  start<T>(root: string, lane: string, operation: SceneRefreshOperation<T>): Promise<T> {
    const barrier = this.#cancelBarrier ?? this.#rootBarriers.get(root);
    if (barrier !== undefined && barrier !== null) {
      return barrier.then(() => this.start(root, lane, operation));
    }
    const state = this.#root(root);
    if (state.current === null) {
      return this.#begin(root, state, lane, operation as SceneRefreshOperation<unknown>) as Promise<T>;
    }
    if (state.current.lane === lane) {
      const pending = this.#pending(state, lane, operation as SceneRefreshOperation<unknown>);
      pending.operation = operation as SceneRefreshOperation<unknown>;
      state.current.controller.abort();
      return pending.promise as Promise<T>;
    }
    const pending = this.#pending(state, lane, operation as SceneRefreshOperation<unknown>);
    pending.operation = operation as SceneRefreshOperation<unknown>;
    return pending.promise as Promise<T>;
  }

  markDirty<T>(root: string, lane: string, operation: SceneRefreshOperation<T>): void {
    const barrier = this.#cancelBarrier ?? this.#rootBarriers.get(root);
    if (barrier !== undefined && barrier !== null) {
      void barrier.then(() => this.markDirty(root, lane, operation));
      return;
    }
    const state = this.#root(root);
    if (state.current === null) {
      void this.#begin(root, state, lane, operation as SceneRefreshOperation<unknown>).catch(() => undefined);
      return;
    }
    const pending = this.#pending(state, lane, operation as SceneRefreshOperation<unknown>);
    pending.operation = operation as SceneRefreshOperation<unknown>;
    void pending.promise.catch(() => undefined);
    if (state.current.lane === lane) state.current.controller.abort();
  }

  isCurrent(root: string, generation: SceneRefreshGeneration): boolean {
    const current = this.#roots.get(root)?.current;
    return current?.generation === generation.generation
      && current.controller.signal === generation.signal
      && !generation.signal.aborted;
  }

  isRunning(root: string): boolean {
    return this.#roots.get(root)?.current !== null && this.#roots.get(root)?.current !== undefined;
  }

  hasPending(root: string): boolean {
    return (this.#roots.get(root)?.pending.size ?? 0) > 0;
  }

  cancel(root: string): void {
    const state = this.#roots.get(root);
    if (state === undefined) return;
    this.#roots.delete(root);
    state.current?.controller.abort();
    const error = this.#abortError();
    for (const pending of state.pending.values()) pending.reject(error);
  }

  async cancelLane(root: string, lane: string): Promise<{ rootIdle: boolean }> {
    const barrier = this.#rootBarriers.get(root);
    if (barrier !== undefined) {
      await barrier;
      return this.cancelLane(root, lane);
    }
    const state = this.#roots.get(root);
    if (state === undefined) return { rootIdle: true };
    const pending = state.pending.get(lane);
    if (pending !== undefined) {
      state.pending.delete(lane);
      pending.reject(this.#abortError());
    }
    const current = state.current?.lane === lane ? state.current : null;
    if (current !== null) {
      current.controller.abort();
      await current.promise.catch(() => undefined);
    }
    const remaining = this.#roots.get(root);
    return {
      rootIdle: remaining === undefined
        || (remaining.current === null && remaining.pending.size === 0),
    };
  }

  cancelAll(): Promise<void> {
    if (this.#cancelBarrier !== null) return this.#cancelBarrier;
    const roots = [...this.#roots.keys()];
    const settled = Promise.all(roots.map(async (root) => this.cancelRoot(root))).then(() => undefined);
    const barrier: Promise<void> = settled.finally(() => {
      if (this.#cancelBarrier === barrier) this.#cancelBarrier = null;
    });
    this.#cancelBarrier = barrier;
    return barrier;
  }

  cancelRoot(root: string): Promise<void> {
    const existing = this.#rootBarriers.get(root);
    if (existing !== undefined) return existing;
    const current = this.#roots.get(root)?.current?.promise;
    if (current === undefined) return Promise.resolve();
    const settled = Promise.allSettled([current]).then(() => undefined);
    const barrier: Promise<void> = settled.finally(() => {
      if (this.#rootBarriers.get(root) === barrier) this.#rootBarriers.delete(root);
    });
    this.#rootBarriers.set(root, barrier);
    this.cancel(root);
    return barrier;
  }

  async cancelRoots(roots: Iterable<string>): Promise<void> {
    await Promise.all([...new Set(roots)].map(async (root) => this.cancelRoot(root)));
  }

  async waitForRoots(roots: Iterable<string>): Promise<void> {
    if (this.#cancelBarrier !== null) await this.#cancelBarrier;
    await Promise.all([...new Set(roots)].map(async (root) => this.#rootBarriers.get(root)));
  }

  #root(root: string): SceneRefreshRoot {
    const current = this.#roots.get(root);
    if (current !== undefined) return current;
    const created: SceneRefreshRoot = { current: null, pending: new Map() };
    this.#roots.set(root, created);
    return created;
  }

  #pending(
    state: SceneRefreshRoot,
    lane: string,
    operation: SceneRefreshOperation<unknown>,
  ): SceneRefreshPending {
    const current = state.pending.get(lane);
    if (current !== undefined) return current;
    let resolve!: (value: unknown) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<unknown>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    const pending = { operation, promise, resolve, reject };
    state.pending.set(lane, pending);
    return pending;
  }

  #begin(
    root: string,
    state: SceneRefreshRoot,
    lane: string,
    operation: SceneRefreshOperation<unknown>,
  ): Promise<unknown> {
    const generation = (this.#generations.get(root) ?? 0) + 1;
    this.#generations.set(root, generation);
    const controller = new AbortController();
    const token = { generation, signal: controller.signal };
    const current: SceneRefreshCurrent = {
      lane,
      generation,
      controller,
      promise: Promise.resolve(),
    };
    state.current = current;
    let operationPromise: Promise<unknown>;
    try {
      operationPromise = operation(token);
    } catch (error) {
      operationPromise = Promise.reject(error);
    }
    current.promise = operationPromise;
    void operationPromise.then(
      () => this.#finished(root, state, current),
      () => this.#finished(root, state, current),
    );
    return operationPromise;
  }

  #finished(root: string, state: SceneRefreshRoot, current: SceneRefreshCurrent): void {
    if (this.#roots.get(root) !== state || state.current !== current) return;
    state.current = null;
    const nextEntry = state.pending.entries().next().value as [string, SceneRefreshPending] | undefined;
    if (nextEntry === undefined) {
      this.#roots.delete(root);
      return;
    }
    const [lane, pending] = nextEntry;
    state.pending.delete(lane);
    const next = this.#begin(root, state, lane, pending.operation);
    void next.then(pending.resolve, pending.reject);
  }

  #abortError(): Error {
    const error = new Error('场景刷新已取消。');
    error.name = 'AbortError';
    return error;
  }
}

export interface SceneWatcherEpoch<T extends object> {
  key: string;
  epoch: number;
  binding: T;
}

export interface SceneWatcherEvent<T extends object> {
  watcher: SceneWatcherEpoch<T>;
  sequence: number;
}

interface SceneWatcherEpochState<T extends object> {
  token: SceneWatcherEpoch<T>;
  eventSequence: number;
}

export class SceneWatcherEpochRegistry<T extends object> {
  readonly #current = new Map<string, SceneWatcherEpochState<T>>();
  #nextEpoch = 0;

  replace(key: string, binding: T): SceneWatcherEpoch<T> {
    const token = { key, epoch: this.#nextEpoch += 1, binding };
    this.#current.set(key, { token, eventSequence: 0 });
    return token;
  }

  isCurrent(token: SceneWatcherEpoch<T>, binding: T): boolean {
    const current = this.#current.get(token.key);
    return current?.token.epoch === token.epoch
      && current.token.binding === binding
      && token.binding === binding;
  }

  nextEvent(token: SceneWatcherEpoch<T>, binding: T): SceneWatcherEvent<T> | null {
    if (!this.isCurrent(token, binding)) return null;
    const current = this.#current.get(token.key)!;
    current.eventSequence += 1;
    return { watcher: token, sequence: current.eventSequence };
  }

  isCurrentEvent(event: SceneWatcherEvent<T>, binding: T): boolean {
    const current = this.#current.get(event.watcher.key);
    return this.isCurrent(event.watcher, binding) && current?.eventSequence === event.sequence;
  }

  invalidate(key: string): void {
    this.#current.delete(key);
  }

  clear(): void {
    this.#current.clear();
  }
}

export const sharedSceneRefreshScheduler = new SceneRefreshGenerationQueue();

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  if (signal.reason !== undefined) throw signal.reason;
  const error = new Error('场景刷新已取消。');
  error.name = 'AbortError';
  throw error;
}

function roleHead(heads: SceneHeads, role: SceneSourceBinding['role']): string | null {
  if (role === 'manual-dat') return heads.manualSnapshotId;
  if (role === 'auto-dat') return heads.autoSnapshotId;
  return heads.rawSnapshotId;
}

async function processSceneSourceLocally(
  input: SceneWorkerProcessInput,
  callbacks: { signal?: AbortSignal; onProgress?(phase: SceneWorkerPhase): void },
): Promise<SceneWorkerProcessResult> {
  const startedAt = performance.now();
  callbacks.onProgress?.('container');
  throwIfAborted(callbacks.signal);
  const container = readSceneContainer(input.bytes, input.role);
  callbacks.onProgress?.('wire');
  throwIfAborted(callbacks.signal);
  callbacks.onProgress?.('normalize');
  const snapshot = normalizeObservedScene(container.payload, {
    bindingId: input.bindingId,
    role: input.role,
    sourceSha256: input.sourceSha256,
    observedAt: input.observedAt,
  });
  callbacks.onProgress?.('index');
  throwIfAborted(callbacks.signal);
  const index = createSceneIndex(snapshot);
  callbacks.onProgress?.('complete');
  return {
    snapshot,
    index,
    metrics: {
      elapsedMilliseconds: performance.now() - startedAt,
      peakHeapUsedBytes: process.memoryUsage().heapUsed,
    },
  };
}

export async function refreshSceneFromBinding(
  projectRoot: string,
  binding: SceneSourceBinding,
  options: RefreshSceneOptions,
): Promise<RefreshSceneResult> {
  const stable = await readStableSceneSource(binding, {
    io: options.io,
    ...(options.sampleMilliseconds === undefined ? {} : { sampleMilliseconds: options.sampleMilliseconds }),
    ...(options.stableSampleCount === undefined ? {} : { stableSampleCount: options.stableSampleCount }),
    ...(options.totalTimeoutMilliseconds === undefined ? {} : { totalTimeoutMilliseconds: options.totalTimeoutMilliseconds }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  throwIfAborted(options.signal);
  const currentHeads = await loadSceneHeadsOrEmpty(projectRoot, options.io);
  const currentHeadId = roleHead(currentHeads, binding.role);
  if (currentHeadId !== null) {
    const current = await loadSceneSnapshotIfValid(projectRoot, currentHeadId, options.io);
    throwIfAborted(options.signal);
    if (
      current !== null
      && current.bindingId === binding.bindingId
      && current.role === binding.role
      && current.sourceSha256 === stable.sha256
      && current.adapterId === SCENE_ADAPTER_ID
    ) {
      const heads = options.preferred && currentHeads.preferredSnapshotId !== currentHeadId
        ? await setPreferredSceneSnapshot(projectRoot, currentHeadId, options.io, {
          heads: currentHeads,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
          ...(options.commitGuard === undefined ? {} : { commitGuard: options.commitGuard }),
        })
        : currentHeads;
      return { snapshot: current, index: null, heads, elapsedMilliseconds: stable.elapsedMilliseconds };
    }
  }
  throwIfAborted(options.signal);
  const processSource = options.processSource ?? processSceneSourceLocally;
  const processed = await processSource({
    bytes: stable.bytes,
    bindingId: binding.bindingId,
    role: binding.role,
    sourceSha256: stable.sha256,
    observedAt: options.observedAt ?? new Date().toISOString(),
  }, {
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
  });
  throwIfAborted(options.signal);
  const heads = await saveSceneSnapshot(projectRoot, processed.snapshot, options.io, {
    preferred: options.preferred,
    heads: currentHeads,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.commitGuard === undefined ? {} : { commitGuard: options.commitGuard }),
  });
  return { snapshot: processed.snapshot, index: processed.index, heads, elapsedMilliseconds: stable.elapsedMilliseconds };
}
