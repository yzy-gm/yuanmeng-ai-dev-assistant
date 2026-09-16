import { createHmac, timingSafeEqual } from 'node:crypto';

export type CursorErrorCode = 'STALE' | 'VALIDATION_FAILED';

export class CursorError extends Error {
  readonly code: CursorErrorCode;

  constructor(code: CursorErrorCode, message: string) {
    super(message);
    this.name = 'CursorError';
    this.code = code;
  }
}

export interface CursorContext {
  readonly projectInstanceId: string;
  readonly snapshotId: string;
  readonly tool: string;
  readonly query: string;
}

interface CursorPayload extends CursorContext {
  readonly offset: number;
}

const MAX_STRUCTURED_BYTES = 64 * 1024;

export function parsePageLimit(value: unknown): number {
  if (value === undefined) return 100;
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 500) {
    throw new CursorError('VALIDATION_FAILED', 'limit 必须是 1 到 500 的整数。');
  }
  return value as number;
}

function cursorMac(encodedPayload: string, secret: Uint8Array): string {
  return createHmac('sha256', secret).update(encodedPayload, 'utf8').digest('base64url');
}

function validatePayload(value: unknown): asserts value is CursorPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CursorError('VALIDATION_FAILED', 'cursor payload 无效。');
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expected = ['offset', 'projectInstanceId', 'query', 'snapshotId', 'tool'];
  if (
    keys.length !== expected.length
    || keys.some((key, index) => key !== expected[index])
    || typeof record.projectInstanceId !== 'string'
    || typeof record.snapshotId !== 'string'
    || typeof record.tool !== 'string'
    || typeof record.query !== 'string'
    || !Number.isSafeInteger(record.offset)
    || (record.offset as number) < 0
  ) {
    throw new CursorError('VALIDATION_FAILED', 'cursor 字段无效。');
  }
}

export function encodeCursor(payload: CursorPayload, secret: Uint8Array): string {
  validatePayload(payload);
  const encoded = Buffer.from(JSON.stringify({
    projectInstanceId: payload.projectInstanceId,
    snapshotId: payload.snapshotId,
    tool: payload.tool,
    query: payload.query,
    offset: payload.offset
  }), 'utf8').toString('base64url');
  return `${encoded}.${cursorMac(encoded, secret)}`;
}

export function decodeCursor(cursor: string, expected: CursorContext, secret: Uint8Array): { offset: number } {
  const parts = cursor.split('.');
  if (parts.length !== 2 || parts[0] === '' || parts[1] === '') {
    throw new CursorError('VALIDATION_FAILED', 'cursor 格式无效。');
  }
  const [encoded, signature] = parts as [string, string];
  const expectedSignature = cursorMac(encoded, secret);
  const actualBytes = Buffer.from(signature, 'base64url');
  const expectedBytes = Buffer.from(expectedSignature, 'base64url');
  if (
    actualBytes.toString('base64url') !== signature
    || actualBytes.length !== expectedBytes.length
    || !timingSafeEqual(actualBytes, expectedBytes)
  ) {
    throw new CursorError('VALIDATION_FAILED', 'cursor 签名无效。');
  }

  let payload: unknown;
  try {
    const bytes = Buffer.from(encoded, 'base64url');
    if (bytes.toString('base64url') !== encoded) throw new Error('non-canonical base64url');
    payload = JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    throw new CursorError('VALIDATION_FAILED', 'cursor payload 无法解析。');
  }
  validatePayload(payload);

  if (payload.projectInstanceId !== expected.projectInstanceId
    || payload.tool !== expected.tool
    || payload.query !== expected.query) {
    throw new CursorError('VALIDATION_FAILED', 'cursor 不属于当前工程或查询。');
  }
  if (payload.snapshotId !== expected.snapshotId) {
    throw new CursorError('STALE', 'cursor 对应的快照已经变化。');
  }
  return { offset: payload.offset };
}

export interface PaginateOptions<T> extends CursorContext {
  readonly secret: Uint8Array;
  readonly limit?: number;
  readonly offset?: number;
  readonly sortKey: (item: T) => string;
}

export interface PaginatedItems<T> {
  readonly items: readonly T[];
  readonly page: {
    readonly count: number;
    readonly total: number;
    readonly nextCursor?: string;
  };
}

export function paginateItems<T>(items: readonly T[], options: PaginateOptions<T>): PaginatedItems<T> {
  const limit = parsePageLimit(options.limit);
  const offset = options.offset ?? 0;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > items.length) {
    throw new CursorError('VALIDATION_FAILED', 'offset 超出当前结果范围。');
  }
  const sorted = [...items].sort((left, right) => options.sortKey(left).localeCompare(options.sortKey(right), 'en'));
  const pageItems: T[] = [];
  for (const item of sorted.slice(offset, offset + limit)) {
    const candidate = [...pageItems, item];
    if (Buffer.byteLength(JSON.stringify(candidate), 'utf8') > MAX_STRUCTURED_BYTES) break;
    pageItems.push(item);
  }
  if (pageItems.length === 0 && offset < sorted.length) {
    throw new CursorError('VALIDATION_FAILED', '单条结果超过 64 KiB，无法安全分页。');
  }
  const nextOffset = offset + pageItems.length;
  return {
    items: pageItems,
    page: {
      count: pageItems.length,
      total: sorted.length,
      ...(nextOffset < sorted.length ? {
        nextCursor: encodeCursor({
          projectInstanceId: options.projectInstanceId,
          snapshotId: options.snapshotId,
          tool: options.tool,
          query: options.query,
          offset: nextOffset
        }, options.secret)
      } : {})
    }
  };
}
