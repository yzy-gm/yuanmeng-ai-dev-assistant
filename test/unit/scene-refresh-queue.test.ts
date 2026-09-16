import { describe, expect, it } from 'vitest';

import {
  SceneRefreshGenerationQueue,
  SceneWatcherEpochRegistry,
} from '../../src/core/scene/workflow.js';
import * as workflow from '../../src/core/scene/workflow.js';

describe('scene refresh generation queue', () => {
  it('provides a generation-aware queue for controller refreshes', () => {
    expect(SceneRefreshGenerationQueue).toBeTypeOf('function');
  });

  it('aborts the current generation and runs only the latest dirty replacement', async () => {
    const queue = new SceneRefreshGenerationQueue();
    const runs: string[] = [];
    let finishLatest!: () => void;
    const latestFinished = new Promise<void>((resolve) => { finishLatest = resolve; });
    const first = queue.start('root', 'raw-pbin', async ({ signal }) => {
      runs.push('first');
      await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      return 'first';
    });
    queue.markDirty('root', 'raw-pbin', async () => {
      runs.push('stale-dirty');
      return 'stale';
    });
    queue.markDirty('root', 'raw-pbin', async ({ signal, generation }) => {
      expect(queue.isCurrent('root', { signal, generation })).toBe(true);
      runs.push('latest');
      finishLatest();
      return 'latest';
    });
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    await latestFinished;
    expect(runs).toEqual(['first', 'latest']);
  });

  it('cancels all current work without starting a queued dirty generation', async () => {
    const queue = new SceneRefreshGenerationQueue();
    let dirtyRan = false;
    const first = queue.start('root', 'manual-dat', async ({ signal }) => {
      await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    });
    queue.markDirty('root', 'manual-dat', async () => { dirtyRan = true; });
    const cancellation = queue.cancelAll();
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    await cancellation;
    await Promise.resolve();
    expect(dirtyRan).toBe(false);
    expect(queue.isRunning('root')).toBe(false);
  });

  it('serializes different role lanes without aborting the current role', async () => {
    const queue = new SceneRefreshGenerationQueue();
    const order: string[] = [];
    let head = '';
    let registry = '';
    let finishManual!: () => void;
    const manualGate = new Promise<void>((resolve) => { finishManual = resolve; });
    const manual = queue.start('root', 'manual-dat', async ({ signal }) => {
      order.push('manual-start');
      await manualGate;
      expect(signal.aborted).toBe(false);
      head = 'manual';
      registry = 'manual';
      order.push('manual-end');
      return 'manual';
    });
    const staleRaw = queue.start('root', 'raw-pbin', async () => {
      order.push('stale-raw');
      return 'stale';
    });
    const raw = queue.start('root', 'raw-pbin', async () => {
      order.push('raw-start');
      head = 'raw';
      registry = 'raw';
      return 'raw';
    });
    await Promise.resolve();
    expect(order).toEqual(['manual-start']);
    expect(queue.hasPending('root')).toBe(true);
    finishManual();
    await expect(manual).resolves.toBe('manual');
    await expect(staleRaw).resolves.toBe('raw');
    await expect(raw).resolves.toBe('raw');
    expect(order).toEqual(['manual-start', 'manual-end', 'raw-start']);
    expect({ head, registry }).toEqual({ head: 'raw', registry: 'raw' });
  });

  it('waits for a cancelled lane to settle and reports a truly idle root', async () => {
    const queue = new SceneRefreshGenerationQueue();
    let finishCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => { finishCleanup = resolve; });
    const current = queue.start('root', 'manual-dat', async ({ signal }) => {
      await new Promise<void>((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      await cleanup;
      throw signal.reason;
    });
    let cancellationFinished = false;
    const cancellation = queue.cancelLane('root', 'manual-dat').then((result) => {
      cancellationFinished = true;
      return result;
    });
    await Promise.resolve();
    expect(cancellationFinished).toBe(false);
    finishCleanup();
    await expect(current).rejects.toMatchObject({ name: 'AbortError' });
    await expect(cancellation).resolves.toEqual({ rootIdle: true });
  });

  it('starts a rebound lane only after the cancelled operation fully settles', async () => {
    const queue = new SceneRefreshGenerationQueue();
    const writes: string[] = [];
    let finalState = '';
    let finishOldWrite!: () => void;
    const oldWrite = new Promise<void>((resolve) => { finishOldWrite = resolve; });
    let finishNewWrite!: () => void;
    const newWrite = new Promise<void>((resolve) => { finishNewWrite = resolve; });
    const old = queue.start('root', 'raw-pbin', async ({ signal }) => {
      await new Promise<void>((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      await oldWrite;
      writes.push('old');
      finalState = 'old';
      throw signal.reason;
    });
    const cancellation = queue.cancelLane('root', 'raw-pbin');
    const rebound = queue.start('root', 'raw-pbin', async () => {
      writes.push('new');
      await newWrite;
      finalState = 'new';
      return 'new';
    });
    await Promise.resolve();
    expect(writes).toEqual([]);
    finishOldWrite();
    await expect(old).rejects.toMatchObject({ name: 'AbortError' });
    await expect(cancellation).resolves.toEqual({ rootIdle: false });
    expect(writes).toEqual(['old', 'new']);
    finishNewWrite();
    await expect(rebound).resolves.toBe('new');
    expect(writes).toEqual(['old', 'new']);
    expect(finalState).toBe('new');
  });

  it('supersedes an explicit same-role rebind and commits only the latest source path last', async () => {
    const queue = new SceneRefreshGenerationQueue();
    const commits: string[] = [];
    let releaseOld!: () => void;
    const oldWrite = new Promise<void>((resolve) => { releaseOld = resolve; });
    const first = queue.start('root', 'raw-pbin', async ({ signal }) => {
      await new Promise<void>((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      await oldWrite;
      commits.push('binding:first/LayerData.pbin', 'head:first', 'registry:first');
      throw signal.reason;
    });
    const second = queue.start('root', 'raw-pbin', async () => {
      commits.push('binding:second/LayerData.pbin', 'head:second', 'registry:second');
      return 'second';
    });
    await Promise.resolve();
    expect(commits).toEqual([]);
    releaseOld();
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    await expect(second).resolves.toBe('second');
    expect(commits.slice(-3)).toEqual([
      'binding:second/LayerData.pbin', 'head:second', 'registry:second',
    ]);
  });

  it('holds starts behind cancelAll until every old operation settles', async () => {
    const queue = new SceneRefreshGenerationQueue();
    const writes: string[] = [];
    let finishOldWrite!: () => void;
    const oldWrite = new Promise<void>((resolve) => { finishOldWrite = resolve; });
    const old = queue.start('root', 'manual-dat', async ({ signal }) => {
      await new Promise<void>((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      await oldWrite;
      writes.push('old');
      throw signal.reason;
    });
    const cancellation = queue.cancelAll();
    const next = queue.start('root', 'raw-pbin', async () => {
      writes.push('new');
      return 'new';
    });
    await Promise.resolve();
    expect(writes).toEqual([]);
    finishOldWrite();
    await expect(old).rejects.toMatchObject({ name: 'AbortError' });
    await cancellation;
    await expect(next).resolves.toBe('new');
    expect(writes).toEqual(['old', 'new']);
  });

  it('shares a per-root takeover barrier across controller owners', async () => {
    const sharedSceneRefreshScheduler = (workflow as unknown as {
      sharedSceneRefreshScheduler: SceneRefreshGenerationQueue;
    }).sharedSceneRefreshScheduler;
    expect(sharedSceneRefreshScheduler).toBeInstanceOf(SceneRefreshGenerationQueue);
    await sharedSceneRefreshScheduler.cancelAll();
    const writes: string[] = [];
    let finishOldWrite!: () => void;
    const oldWrite = new Promise<void>((resolve) => { finishOldWrite = resolve; });
    const controllerA = sharedSceneRefreshScheduler;
    const old = controllerA.start('takeover-root', 'manual-dat', async ({ signal }) => {
      await new Promise<void>((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      await oldWrite;
      writes.push('A-head:A-registry');
      throw signal.reason;
    });
    const disposeA = controllerA.cancelRoots(['takeover-root']);
    const controllerB = sharedSceneRefreshScheduler;
    const next = controllerB.start('takeover-root', 'raw-pbin', async () => {
      writes.push('B-head:B-registry');
      return 'B';
    });
    await Promise.resolve();
    expect(writes).toEqual([]);
    finishOldWrite();
    await expect(old).rejects.toMatchObject({ name: 'AbortError' });
    await disposeA;
    await expect(next).resolves.toBe('B');
    expect(writes).toEqual(['A-head:A-registry', 'B-head:B-registry']);
    await sharedSceneRefreshScheduler.cancelAll();
  });

  it('provides watcher epochs independent of persistent binding ids', () => {
    const epochs = (workflow as unknown as Record<string, unknown>).SceneWatcherEpochRegistry;
    expect(epochs).toBeTypeOf('function');
  });

  it('rejects late callbacks from a replaced watcher with the same binding id and path', async () => {
    const epochs = new SceneWatcherEpochRegistry<{ bindingId: string; sourcePath: string }>();
    const firstBinding = { bindingId: 'stable-id', sourcePath: 'same/LayerData.pbin' };
    const secondBinding = { bindingId: 'stable-id', sourcePath: 'same/LayerData.pbin' };
    const first = epochs.replace('root\0raw-pbin', firstBinding);
    const second = epochs.replace('root\0raw-pbin', secondBinding);
    let cancellations = 0;
    let lastError: string | null = null;
    let refreshing = true;
    const lateDelete = async (): Promise<void> => {
      if (!epochs.isCurrent(first, firstBinding)) return;
      cancellations += 1;
      await Promise.resolve();
      if (!epochs.isCurrent(first, firstBinding)) return;
      lastError = 'deleted';
      refreshing = false;
    };
    await lateDelete();
    expect(epochs.isCurrent(second, secondBinding)).toBe(true);
    expect({ cancellations, lastError, refreshing }).toEqual({ cancellations: 0, lastError: null, refreshing: true });
  });

  it('invalidates a pending delete result when a newer create event arrives', async () => {
    const epochs = new SceneWatcherEpochRegistry<{ bindingId: string }>();
    const binding = { bindingId: 'stable-id' };
    const watcher = epochs.replace('root\0raw-pbin', binding);
    const deleted = epochs.nextEvent(watcher, binding);
    expect(deleted).not.toBeNull();
    const created = epochs.nextEvent(watcher, binding);
    expect(created).not.toBeNull();
    expect(epochs.isCurrentEvent(deleted!, binding)).toBe(false);
    expect(epochs.isCurrentEvent(created!, binding)).toBe(true);
  });
});
