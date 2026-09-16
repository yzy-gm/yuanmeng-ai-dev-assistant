import { describe, expect, it, vi } from 'vitest';

import { UiExportWatcher, UiRefreshLifecycleQueue } from '../../src/integrations/ui/watcher.js';

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

describe('UI export watcher coordination', () => {
  it('debounces each project independently and keeps only the latest pending refresh', async () => {
    const calls: string[] = [];
    const watcher = new UiExportWatcher({
      debounceMilliseconds: 15,
      refresh: async (root) => { calls.push(root); },
    });
    try {
      watcher.changed('project-a');
      watcher.changed('project-a');
      watcher.changed('project-b');
      watcher.changed('project-a');
      await delay(50);

      expect(calls.sort()).toEqual(['project-a', 'project-b']);
    } finally {
      watcher.dispose();
    }
  });

  it('cancels a pending project refresh without affecting another project', async () => {
    const refresh = vi.fn(async () => undefined);
    const watcher = new UiExportWatcher({ debounceMilliseconds: 15, refresh });
    try {
      watcher.changed('project-a');
      watcher.changed('project-b');
      watcher.cancel('project-a');
      await delay(50);

      expect(refresh).toHaveBeenCalledTimes(1);
      expect(refresh.mock.calls[0]?.[0]).toBe('project-b');
      expect(refresh.mock.calls[0]?.[1]).toMatchObject({ signal: expect.any(AbortSignal), isCurrent: expect.any(Function) });
    } finally {
      watcher.dispose();
    }
  });

  it('coalesces changes received during a refresh into one follow-up run', async () => {
    const releases: Array<() => void> = [];
    const calls: string[] = [];
    const watcher = new UiExportWatcher({
      debounceMilliseconds: 5,
      refresh: async (root) => {
        calls.push(root);
        await new Promise<void>((resolve) => { releases.push(resolve); });
      },
    });
    try {
      watcher.changed('project-a');
      await delay(20);
      watcher.changed('project-a');
      watcher.changed('project-a');
      releases.shift()?.();
      await delay(20);
      expect(calls).toEqual(['project-a', 'project-a']);
      releases.shift()?.();
      await delay(5);
    } finally {
      watcher.dispose();
    }
  });

  it('reports refresh failures and remains usable for a later change', async () => {
    const errors: Array<{ root: string; error: unknown }> = [];
    let fail = true;
    const watcher = new UiExportWatcher({
      debounceMilliseconds: 5,
      refresh: async () => {
        if (fail) throw new Error('anonymous failure');
      },
      onError: (root, error) => { errors.push({ root, error }); },
    });
    try {
      watcher.changed('project-a');
      await delay(20);
      fail = false;
      watcher.changed('project-a');
      await delay(20);

      expect(errors).toHaveLength(1);
      expect(errors[0]?.root).toBe('project-a');
    } finally {
      watcher.dispose();
    }
  });

  it('invalidates a running refresh on cancel so stale work cannot commit', async () => {
    const commits: string[] = [];
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let observedAbort = false;
    const watcher = new UiExportWatcher({
      debounceMilliseconds: 5,
      refresh: async (root: string, context: { signal: AbortSignal; isCurrent(): boolean } | undefined) => {
        context?.signal.addEventListener('abort', () => { observedAbort = true; }, { once: true });
        await blocked;
        if (context?.isCurrent() ?? true) commits.push(root);
      },
    } as never);
    watcher.changed('project-a');
    await delay(20);
    watcher.cancel('project-a');
    release();
    await delay(10);
    watcher.dispose();
    expect(observedAbort).toBe(true);
    expect(commits).toEqual([]);
  });

  it('invalidates every running refresh on dispose', async () => {
    const commits: string[] = [];
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const watcher = new UiExportWatcher({
      debounceMilliseconds: 5,
      refresh: async (root: string, context: { signal: AbortSignal; isCurrent(): boolean } | undefined) => {
        await blocked;
        if (context?.isCurrent() ?? true) commits.push(root);
      },
    } as never);
    watcher.changed('project-a');
    await delay(20);
    watcher.dispose();
    release();
    await delay(10);
    expect(commits).toEqual([]);
  });
});

describe('UI refresh lifecycle queue', () => {
  it('aborts and waits for old work before a replacement lifecycle can commit', async () => {
    const queue = new UiRefreshLifecycleQueue();
    const commits: string[] = [];
    const old = queue.start('project-a', async (generation) => {
      await new Promise<void>((resolve) => generation.signal.addEventListener('abort', resolve, { once: true }));
      if (queue.isCurrent(generation)) commits.push('old');
    });
    await queue.invalidate();
    await old;
    await queue.start('project-a', async (generation) => {
      if (queue.isCurrent(generation)) commits.push('new');
    });
    expect(commits).toEqual(['new']);
  });

  it('preserves an external cancellation while a replacement waits behind the reload barrier', async () => {
    const queue = new UiRefreshLifecycleQueue();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const old = queue.start('project-a', async () => blocked);
    const invalidating = queue.invalidate();
    const external = new AbortController();
    const commits: string[] = [];
    const replacement = queue.start('project-a', async () => { commits.push('replacement'); }, external.signal);
    external.abort();
    release();
    await old;
    await invalidating;
    await expect(replacement).rejects.toMatchObject({ name: 'AbortError' });
    expect(commits).toEqual([]);
  });
});
