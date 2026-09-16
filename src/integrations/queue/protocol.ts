import { randomBytes, randomUUID } from 'node:crypto';
import { basename, extname, join } from 'node:path';

import type { Clock } from '../../core/clock.js';
import { ProductError } from '../../core/errors.js';
import { atomicWriteJson, type FileIO } from '../../core/fs.js';
import { decodeLuaUtf8 } from '../../core/lua/literal-parser.js';

export interface QueueSession {
  schemaVersion: 1;
  token: string;
  projectInstanceId: string;
  createdAt: string;
  expiresAt: string;
}

export interface RefreshUiRequest {
  schemaVersion: 1;
  requestId: string;
  token: string;
  projectInstanceId: string;
  action: 'refresh-ui';
  createdAt: string;
  expiresAt: string;
}

export type QueueResultStatus = 'completed' | 'rejected' | 'failed';
export type QueueResultCode =
  | 'OK'
  | 'QUEUE_TOKEN_INVALID'
  | 'QUEUE_SESSION_EXPIRED'
  | 'QUEUE_REQUEST_EXPIRED'
  | 'QUEUE_PROJECT_MISMATCH'
  | 'QUEUE_ACTION_REJECTED'
  | 'QUEUE_NON_ATOMIC_REQUEST'
  | 'QUEUE_DUPLICATE_REQUEST'
  | 'QUEUE_REQUEST_INVALID'
  | 'INTERNAL_ERROR';

export interface QueueResult {
  schemaVersion: 1;
  requestId: string;
  status: QueueResultStatus;
  code: QueueResultCode;
  message: string;
  completedAt: string;
}

export interface RequestQueueHostOptions {
  clock: Clock;
  io: FileIO;
  runtimeRoot: string;
  session: QueueSession;
  refreshUi: () => Promise<{ reasonCode: 'REFRESH_SUCCEEDED' | 'REFRESH_SUCCEEDED_UNCHANGED' } | void>;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const TOKEN_PATTERN = /^[a-f0-9]{64}$/u;

function isoAt(date: Date): string {
  return date.toISOString();
}

export function createQueueSession(projectInstanceId: string, clock: Clock): QueueSession {
  const created = clock.now();
  return {
    schemaVersion: 1,
    token: randomBytes(32).toString('hex'),
    projectInstanceId,
    createdAt: isoAt(created),
    expiresAt: isoAt(new Date(created.getTime() + 8 * 60 * 60_000)),
  };
}

export function createRefreshUiRequest(session: QueueSession, clock: Clock): RefreshUiRequest {
  const created = clock.now();
  return {
    schemaVersion: 1,
    requestId: randomUUID(),
    token: session.token,
    projectInstanceId: session.projectInstanceId,
    action: 'refresh-ui',
    createdAt: isoAt(created),
    expiresAt: isoAt(new Date(created.getTime() + 60_000)),
  };
}

function requestIdFrom(value: unknown, path: string): string {
  if (typeof value === 'object' && value !== null && 'requestId' in value && typeof value.requestId === 'string') {
    return value.requestId;
  }
  return basename(path, extname(path));
}

function validateResult(value: unknown): asserts value is QueueResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ProductError('VALIDATION_FAILED', '队列结果必须是对象。', ['重试刷新。'], 'STATIC_LOCAL');
  }
  const record = value as Record<string, unknown>;
  if (
    record.schemaVersion !== 1
    || typeof record.requestId !== 'string'
    || typeof record.status !== 'string'
    || typeof record.code !== 'string'
    || typeof record.message !== 'string'
    || typeof record.completedAt !== 'string'
  ) {
    throw new ProductError('VALIDATION_FAILED', '队列结果字段无效。', ['重试刷新。'], 'STATIC_LOCAL');
  }
}

function recordAt(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export class RequestQueueHost {
  readonly #options: RequestQueueHostOptions;
  readonly #processed = new Set<string>();

  constructor(options: RequestQueueHostOptions) {
    this.#options = options;
  }

  async #writeResult(result: QueueResult): Promise<void> {
    const path = join(this.#options.runtimeRoot, 'requests', 'results', `${result.requestId}.json`);
    await atomicWriteJson(this.#options.io, path, result, validateResult);
  }

  async #reject(requestId: string, code: QueueResultCode, message: string): Promise<QueueResult> {
    const result: QueueResult = {
      schemaVersion: 1,
      requestId,
      status: 'rejected',
      code,
      message,
      completedAt: this.#options.clock.now().toISOString(),
    };
    await this.#writeResult(result);
    return result;
  }

  async processFile(path: string): Promise<QueueResult> {
    let value: unknown;
    try {
      value = JSON.parse(decodeLuaUtf8(await this.#options.io.readBytes(path)));
    } catch {
      return this.#reject(basename(path, extname(path)), 'QUEUE_REQUEST_INVALID', '请求 JSON 无效。');
    }
    const requestId = requestIdFrom(value, path);
    if (extname(path).toLowerCase() !== '.json') {
      return this.#reject(requestId, 'QUEUE_NON_ATOMIC_REQUEST', '只处理已原子重命名的 .json 请求。');
    }
    if (this.#processed.has(requestId)) {
      return this.#reject(requestId, 'QUEUE_DUPLICATE_REQUEST', '请求 ID 已处理。');
    }
    const request = recordAt(value);
    if (
      request === null
      || request.schemaVersion !== 1
      || typeof request.requestId !== 'string'
      || !UUID_PATTERN.test(request.requestId)
      || typeof request.token !== 'string'
      || typeof request.projectInstanceId !== 'string'
      || typeof request.action !== 'string'
      || typeof request.createdAt !== 'string'
      || typeof request.expiresAt !== 'string'
    ) {
      return this.#reject(requestId, 'QUEUE_REQUEST_INVALID', '请求字段无效。');
    }
    if (!TOKEN_PATTERN.test(request.token) || request.token !== this.#options.session.token) {
      return this.#reject(requestId, 'QUEUE_TOKEN_INVALID', '请求令牌无效。');
    }
    const now = this.#options.clock.now().getTime();
    if (now > Date.parse(this.#options.session.expiresAt)) {
      return this.#reject(requestId, 'QUEUE_SESSION_EXPIRED', '扩展会话已过期。');
    }
    if (!Number.isFinite(Date.parse(request.expiresAt)) || now > Date.parse(request.expiresAt)) {
      return this.#reject(requestId, 'QUEUE_REQUEST_EXPIRED', '刷新请求已过期。');
    }
    if (request.projectInstanceId !== this.#options.session.projectInstanceId) {
      return this.#reject(requestId, 'QUEUE_PROJECT_MISMATCH', '请求工程与会话不匹配。');
    }
    if (request.action !== 'refresh-ui') {
      return this.#reject(requestId, 'QUEUE_ACTION_REJECTED', '队列只允许 refresh-ui。');
    }
    this.#processed.add(requestId);
    try {
      const refresh = await this.#options.refreshUi();
      const unchanged = refresh?.reasonCode === 'REFRESH_SUCCEEDED_UNCHANGED';
      const result: QueueResult = {
        schemaVersion: 1,
        requestId,
        status: 'completed',
        code: 'OK',
        message: unchanged ? '已检查 UI，内容未变化；现有快照仍为最新。' : '已完成 UI 结构更新请求。',
        completedAt: this.#options.clock.now().toISOString(),
      };
      await this.#writeResult(result);
      return result;
    } catch (error) {
      const result: QueueResult = {
        schemaVersion: 1,
        requestId,
        status: 'failed',
        code: 'INTERNAL_ERROR',
        message: error instanceof Error ? error.message : '刷新失败。',
        completedAt: this.#options.clock.now().toISOString(),
      };
      await this.#writeResult(result);
      return result;
    }
  }
}
