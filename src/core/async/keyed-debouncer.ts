export type DebouncedTask = () => void;

/** Small, dependency-free keyed debounce helper used by extension watchers. */
export class KeyedDebouncer {
  readonly #timers = new Map<string, ReturnType<typeof setTimeout>>();
  #disposed = false;

  schedule(key: string, task: DebouncedTask, delayMilliseconds: number): void {
    if (this.#disposed) return;
    this.cancel(key);
    if (delayMilliseconds <= 0) {
      task();
      return;
    }
    const timer = setTimeout(() => {
      this.#timers.delete(key);
      if (!this.#disposed) task();
    }, delayMilliseconds);
    this.#timers.set(key, timer);
  }

  cancel(key: string): void {
    const timer = this.#timers.get(key);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.#timers.delete(key);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
  }
}
