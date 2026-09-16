import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';

import { ProductError } from '../errors.js';
import type { SceneDiff, SceneDiffOptions } from './diff.js';
import type { SceneIndex } from './index.js';
import type { SceneSnapshot } from './types.js';
import {
  SCENE_WORKER_PROTOCOL_VERSION,
  parseSceneWorkerRequest,
  parseSceneWorkerResponse,
  type SceneWorkerPhase,
  type SceneWorkerProcessInput,
  type SceneWorkerProcessResult,
  type SceneWorkerRequest,
} from './worker-protocol.js';

export interface SceneWorkerClientOptions {
  workerPath?: string;
  signal?: AbortSignal;
  onProgress?(phase: SceneWorkerPhase): void;
  timeoutMilliseconds?: number;
}

function abortError(signal: AbortSignal | undefined): unknown {
  if (signal?.reason !== undefined) return signal.reason;
  const error = new Error('场景后台任务已取消。');
  error.name = 'AbortError';
  return error;
}

function workerPath(options: SceneWorkerClientOptions): string {
  return options.workerPath ?? join(__dirname, 'scene-worker.cjs');
}

function timeout(value: number | undefined): number {
  const resolved = value ?? 120_000;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > 900_000) {
    throw new ProductError('VALIDATION_FAILED', '场景后台任务超时必须是 1 到 900000 毫秒。', ['修正超时设置。'], 'STATIC_LOCAL');
  }
  return resolved;
}

async function runWorker<T>(
  request: SceneWorkerRequest,
  expectedOperation: SceneWorkerRequest['kind'],
  options: SceneWorkerClientOptions,
  transferList: ArrayBuffer[] = [],
): Promise<T> {
  parseSceneWorkerRequest(request);
  if (options.signal?.aborted === true) throw abortError(options.signal);
  const maximumDuration = timeout(options.timeoutMilliseconds);
  return new Promise<T>((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(workerPath(options));
    } catch {
      reject(new ProductError('INTERNAL_ERROR', '无法启动场景后台任务。', ['重新构建或安装私有插件。'], 'STATIC_LOCAL'));
      return;
    }
    let settled = false;
    const timer = setTimeout(() => {
      finish(new ProductError('INTERNAL_ERROR', '场景后台任务超时。', ['降低场景规模或重新刷新。'], 'STATIC_LOCAL'));
    }, maximumDuration);
    const onAbort = (): void => finish(abortError(options.signal));
    const cleanup = (): void => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      worker.removeAllListeners();
      void worker.terminate();
    };
    const finish = (error?: unknown, value?: T): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error !== undefined) reject(error);
      else resolve(value as T);
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    worker.on('message', (raw: unknown) => {
      try {
        const response = parseSceneWorkerResponse(raw);
        if (response.requestId !== request.requestId) throw new Error('mismatched worker response');
        if (response.kind === 'progress') {
          options.onProgress?.(response.phase);
          return;
        }
        if (response.kind === 'error') {
          finish(new ProductError(response.code, response.message, response.nextActions, response.evidence));
          return;
        }
        if (response.operation !== expectedOperation) throw new Error('mismatched worker operation');
        finish(undefined, response.value as T);
      } catch {
        finish(new ProductError('VALIDATION_FAILED', '场景后台任务返回了无效响应。', ['重新构建或安装私有插件。'], 'STATIC_LOCAL'));
      }
    });
    worker.once('error', () => {
      finish(new ProductError('INTERNAL_ERROR', '场景后台任务异常退出。', ['重新刷新场景源。'], 'STATIC_LOCAL'));
    });
    worker.once('exit', () => {
      if (!settled) {
        finish(new ProductError('INTERNAL_ERROR', '场景后台任务未完成。', ['重新刷新场景源。'], 'STATIC_LOCAL'));
      }
    });
    try {
      worker.postMessage(request, transferList);
    } catch {
      finish(new ProductError('VALIDATION_FAILED', '无法发送场景后台任务。', ['降低场景规模后重试。'], 'STATIC_LOCAL'));
    }
  });
}

export function processSceneSourceInWorker(
  input: SceneWorkerProcessInput,
  options: SceneWorkerClientOptions = {},
): Promise<SceneWorkerProcessResult> {
  const request: SceneWorkerRequest = {
    protocolVersion: SCENE_WORKER_PROTOCOL_VERSION,
    kind: 'process',
    requestId: randomUUID(),
    input,
  };
  const transferable = input.bytes.buffer instanceof ArrayBuffer ? [input.bytes.buffer] : [];
  return runWorker(request, 'process', options, transferable);
}

export function indexSceneSnapshotInWorker(
  snapshot: SceneSnapshot,
  options: SceneWorkerClientOptions = {},
): Promise<SceneIndex> {
  return runWorker({
    protocolVersion: SCENE_WORKER_PROTOCOL_VERSION,
    kind: 'index',
    requestId: randomUUID(),
    snapshot,
  }, 'index', options);
}

export function diffSceneSnapshotsInWorker(
  before: SceneSnapshot,
  after: SceneSnapshot,
  diffOptions: SceneDiffOptions = {},
  options: SceneWorkerClientOptions = {},
): Promise<SceneDiff> {
  return runWorker({
    protocolVersion: SCENE_WORKER_PROTOCOL_VERSION,
    kind: 'diff',
    requestId: randomUUID(),
    before,
    after,
    options: diffOptions,
  }, 'diff', options);
}
