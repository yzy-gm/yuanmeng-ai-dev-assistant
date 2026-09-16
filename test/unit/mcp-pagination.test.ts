import { describe, expect, it } from 'vitest';

import type { CursorError } from '../../src/mcp/pagination.js';
import {
  decodeCursor,
  encodeCursor,
  paginateItems,
  parsePageLimit
} from '../../src/mcp/pagination.js';

const SECRET = Buffer.from('project-bound-test-secret');
const context = {
  projectInstanceId: 'project-1',
  snapshotId: 'snapshot-1',
  tool: 'yuanmeng_ids_list',
  query: 'kind=scene-instance'
};

describe('MCP pagination', () => {
  it('defaults to 100 and accepts limits through 500', () => {
    expect(parsePageLimit(undefined)).toBe(100);
    expect(parsePageLimit(1)).toBe(1);
    expect(parsePageLimit(500)).toBe(500);
    expect(() => parsePageLimit(0)).toThrow();
    expect(() => parsePageLimit(501)).toThrow();
  });

  it('binds a cursor to project, snapshot, tool, query, and offset', () => {
    const cursor = encodeCursor({ ...context, offset: 100 }, SECRET);
    expect(decodeCursor(cursor, context, SECRET)).toEqual({ offset: 100 });
  });

  it('returns STALE when a cursor belongs to an older snapshot', () => {
    const cursor = encodeCursor({ ...context, offset: 100 }, SECRET);
    expect(() => decodeCursor(cursor, { ...context, snapshotId: 'snapshot-2' }, SECRET))
      .toThrowError(expect.objectContaining<Partial<CursorError>>({ code: 'STALE' }));
  });

  it('returns VALIDATION_FAILED for a tampered cursor', () => {
    const cursor = encodeCursor({ ...context, offset: 100 }, SECRET);
    const tampered = `${cursor.slice(0, -1)}${cursor.endsWith('a') ? 'b' : 'a'}`;
    expect(() => decodeCursor(tampered, context, SECRET))
      .toThrowError(expect.objectContaining<Partial<CursorError>>({ code: 'VALIDATION_FAILED' }));
  });

  it('paginates rather than silently truncating a result over 64 KiB', () => {
    const items = Array.from({ length: 40 }, (_, index) => ({
      id: String(index).padStart(3, '0'),
      payload: '中'.repeat(1600)
    }));

    const page = paginateItems(items, {
      ...context,
      secret: SECRET,
      limit: 100,
      offset: 0,
      sortKey: (item) => item.id
    });

    expect(page.items.length).toBeGreaterThan(0);
    expect(page.items.length).toBeLessThan(items.length);
    expect(Buffer.byteLength(JSON.stringify(page.items), 'utf8')).toBeLessThanOrEqual(64 * 1024);
    expect(page.page).toMatchObject({ count: page.items.length, total: 40 });
    expect(page.page.nextCursor).toBeTypeOf('string');
    const next = decodeCursor(page.page.nextCursor!, context, SECRET);
    expect(next.offset).toBe(page.items.length);
  });
});
