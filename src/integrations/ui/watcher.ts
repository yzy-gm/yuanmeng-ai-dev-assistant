export interface UiExportWatcherOptions {
  debounceMilliseconds: number;
  refresh(root: string, context: UiExportRefreshContext): Promise<void>;
  onError?: (root: string, error: unknown) => void;
}

interface ProjectWatchState {
  timer: ReturnType<typeof setTimeout> | null;
  running: boolean;
  dirty: boolean;
  controller: AbortController | null;
}

export interface UiExportRefreshContext {
  signal: AbortSignal;
  isCurrent(): boolean;
}

export interface UiRefreshGeneration {
  root: string;
  epoch: number;
  signal: AbortSignal;
}

export class UiRefreshLifecycleQueue {
  readonly #tails = new Map<string, Promise<unknown>>();
  readonly #controllers = new Set<AbortController>();
  #epoch = 0;
  #barrier: Promise<void> | null = null;
  #disposed = false;

  start<T>(
    root: string,
    operation: (generation: UiRefreshGeneration) => Promise<T>,
    externalSignal?: AbortSignal,
  ): Promise<T> {
    if (this.#disposed) return Promise.reject(this.#abortError('UI 刷新生命周期已释放。'));
    if (this.#barrier !== null) return this.#barrier.then(() => this.start(root, operation, externalSignal));
    const controller = new AbortController();
    const abortFromExternal = (): void => controller.abort(externalSignal?.reason ?? this.#abortError('UI 文件监听刷新已取消。'));
    if (externalSignal?.aborted === true) abortFromExternal();
    else externalSignal?.addEventListener('abort', abortFromExternal, { once: true });
    this.#controllers.add(controller);
    const generation: UiRefreshGeneration = { root, epoch: this.#epoch, signal: controller.signal };
    const run = async (): Promise<T> => {
      this.assertCurrent(generation);
      return operation(generation);
    };
    const previous = this.#tails.get(root);
    const current = previous === undefined ? run() : previous.catch(() => undefined).then(run);
    this.#tails.set(root, current);
    void current.finally(() => {
      this.#controllers.delete(controller);
      externalSignal?.removeEventListener('abort', abortFromExternal);
      if (this.#tails.get(root) === current) this.#tails.delete(root);
    }).catch(() => undefined);
    return current;
  }

  isCurrent(generation: UiRefreshGeneration): boolean {
    return !this.#disposed && generation.epoch === this.#epoch && !generation.signal.aborted;
  }

  assertCurrent(generation: UiRefreshGeneration): void {
    if (this.isCurrent(generation)) return;
    if (generation.signal.reason !== undefined) throw generation.signal.reason;
    throw this.#abortError('UI 刷新已被新的工作区生命周期替代。');
  }

  invalidate(): Promise<void> {
    if (this.#barrier !== null) return this.#barrier;
    this.#epoch += 1;
    for (const controller of this.#controllers) controller.abort(this.#abortError('UI 刷新已取消。'));
    const pending = [...this.#tails.values()];
    const settled = Promise.allSettled(pending).then(() => undefined);
    const barrier = settled.finally(() => {
      if (this.#barrier === barrier) this.#barrier = null;
    });
    this.#barrier = barrier;
    return barrier;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#epoch += 1;
    for (const controller of this.#controllers) controller.abort(this.#abortError('UI 刷新生命周期已释放。'));
  }

  #abortError(message: string): Error {
    const error = new Error(message);
    error.name = 'AbortError';
    return error;
  }
}

/**
 * Coalesces editor file-system notifications per project. This class does not
 * inspect the editor and does not read the clipboard; it only schedules the
 * caller-owned stable-file refresh after an explicit file notification.
 */
export class UiExportWatcher {
  readonly #options: UiExportWatcherOptions;
  readonly #states = new Map<string, ProjectWatchState>();
  #disposed = false;

  constructor(options: UiExportWatcherOptions) {
    if (!Number.isSafeInteger(options.debounceMilliseconds) || options.debounceMilliseconds < 1) {
      throw new TypeError('debounceMilliseconds must be a positive integer.');
    }
    this.#options = options;
  }

  changed(root: string): void {
    if (this.#disposed) return;
    const state = this.#states.get(root) ?? { timer: null, running: false, dirty: false, controller: null };
    state.dirty = true;
    this.#states.set(root, state);
    if (state.running) return;
    if (state.timer !== null) clearTimeout(state.timer);
    state.timer = setTimeout(() => { void this.#run(root, state); }, this.#options.debounceMilliseconds);
  }

  cancel(root: string): void {
    const state = this.#states.get(root);
    if (state === undefined) return;
    state.dirty = false;
    state.controller?.abort();
    if (state.timer !== null) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    if (!state.running) this.#states.delete(root);
  }

  dispose(): void {
    this.#disposed = true;
    for (const state of this.#states.values()) {
      if (state.timer !== null) clearTimeout(state.timer);
      state.timer = null;
      state.dirty = false;
      state.controller?.abort();
      state.controller = null;
    }
    this.#states.clear();
  }

  async #run(root: string, state: ProjectWatchState): Promise<void> {
    if (this.#disposed || this.#states.get(root) !== state || !state.dirty) return;
    state.timer = null;
    state.dirty = false;
    state.running = true;
    const controller = new AbortController();
    state.controller = controller;
    try {
      await this.#options.refresh(root, {
        signal: controller.signal,
        isCurrent: () => !this.#disposed && this.#states.get(root) === state && state.controller === controller && !controller.signal.aborted,
      });
    } catch (error) {
      this.#options.onError?.(root, error);
    } finally {
      state.running = false;
      if (state.controller === controller) state.controller = null;
      if (!this.#disposed && this.#states.get(root) === state) {
        if (state.dirty) {
          state.timer = setTimeout(() => { void this.#run(root, state); }, this.#options.debounceMilliseconds);
        } else {
          this.#states.delete(root);
        }
      }
    }
  }
}
