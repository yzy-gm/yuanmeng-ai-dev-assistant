import { parentPort } from 'node:worker_threads';

import { ProductError, type ErrorCode, type EvidenceLevel } from '../errors.js';
import { readSceneContainer } from './container.js';
import { diffSceneSnapshots } from './diff.js';
import { createSceneIndex } from './index.js';
import { normalizeObservedScene } from './normalize.js';
import {
  SCENE_WORKER_PROTOCOL_VERSION,
  parseSceneWorkerRequest,
  type SceneWorkerPhase,
  type SceneWorkerRequest,
  type SceneWorkerResponse,
} from './worker-protocol.js';

function post(response: SceneWorkerResponse): void {
  parentPort?.postMessage(response);
}

function progress(requestId: string, phase: SceneWorkerPhase): void {
  post({ protocolVersion: SCENE_WORKER_PROTOCOL_VERSION, kind: 'progress', requestId, phase });
}

function yieldToMessagePort(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function sanitizedError(error: unknown): { code: ErrorCode; message: string; nextActions: string[]; evidence: EvidenceLevel } {
  if (error instanceof ProductError) {
    return {
      code: error.code,
      message: `场景后台任务失败（${error.code}）。`,
      nextActions: ['检查场景源与任务参数后重试。'],
      evidence: error.evidence,
    };
  }
  return {
    code: 'INTERNAL_ERROR',
    message: '场景后台任务发生内部错误。',
    nextActions: ['重新刷新场景源；若持续失败，请保留匿名诊断信息。'],
    evidence: 'STATIC_LOCAL',
  };
}

async function execute(request: SceneWorkerRequest): Promise<void> {
  if (request.kind === 'process') {
    const startedAt = performance.now();
    let peakHeapUsedBytes = process.memoryUsage().heapUsed;
    const sampleHeap = (): void => {
      peakHeapUsedBytes = Math.max(peakHeapUsedBytes, process.memoryUsage().heapUsed);
    };
    progress(request.requestId, 'container');
    await yieldToMessagePort();
    const container = readSceneContainer(request.input.bytes, request.input.role);
    sampleHeap();
    progress(request.requestId, 'wire');
    await yieldToMessagePort();
    progress(request.requestId, 'normalize');
    const snapshot = normalizeObservedScene(container.payload, {
      bindingId: request.input.bindingId,
      role: request.input.role,
      sourceSha256: request.input.sourceSha256,
      observedAt: request.input.observedAt,
    });
    sampleHeap();
    progress(request.requestId, 'index');
    const index = createSceneIndex(snapshot);
    sampleHeap();
    progress(request.requestId, 'complete');
    post({
      protocolVersion: SCENE_WORKER_PROTOCOL_VERSION,
      kind: 'result',
      requestId: request.requestId,
      operation: request.kind,
      value: {
        snapshot,
        index,
        metrics: {
          elapsedMilliseconds: performance.now() - startedAt,
          peakHeapUsedBytes,
        },
      },
    });
    return;
  }
  if (request.kind === 'index') {
    progress(request.requestId, 'index');
    await yieldToMessagePort();
    const index = createSceneIndex(request.snapshot);
    progress(request.requestId, 'complete');
    post({
      protocolVersion: SCENE_WORKER_PROTOCOL_VERSION,
      kind: 'result',
      requestId: request.requestId,
      operation: request.kind,
      value: index,
    });
    return;
  }
  progress(request.requestId, 'diff');
  await yieldToMessagePort();
  const diff = diffSceneSnapshots(request.before, request.after, request.options);
  progress(request.requestId, 'complete');
  post({
    protocolVersion: SCENE_WORKER_PROTOCOL_VERSION,
    kind: 'result',
    requestId: request.requestId,
    operation: request.kind,
    value: diff,
  });
}

if (parentPort === null) throw new Error('Scene worker requires a parent port.');

parentPort.once('message', (raw: unknown) => {
  let requestId = 'invalid';
  try {
    if (typeof raw === 'object' && raw !== null && 'requestId' in raw && typeof raw.requestId === 'string') {
      requestId = /^[A-Za-z0-9_-]{1,128}$/u.test(raw.requestId) ? raw.requestId : 'invalid';
    }
    const request = parseSceneWorkerRequest(raw);
    void execute(request).catch((error: unknown) => {
      post({
        protocolVersion: SCENE_WORKER_PROTOCOL_VERSION,
        kind: 'error',
        requestId,
        ...sanitizedError(error),
      });
    });
  } catch (error) {
    post({
      protocolVersion: SCENE_WORKER_PROTOCOL_VERSION,
      kind: 'error',
      requestId,
      ...sanitizedError(error),
    });
  }
});
