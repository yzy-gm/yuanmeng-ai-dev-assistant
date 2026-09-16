import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { aggregateLog, parseImportedLog } from '../../src/core/logs/parser.js';

describe('imported local log parsing', () => {
  it('parses BOM, time range, level, player, request, signal and stage', async () => {
    const bytes = await readFile('test/fixtures/logs/structured.txt');
    const parsed = parseImportedLog(bytes, {
      from: '2026-08-20T01:00:01.000Z',
      to: '2026-08-20T01:00:02.000Z',
    });
    expect(parsed.entries).toHaveLength(2);
    expect(parsed.entries[0]).toMatchObject({
      timestamp: '2026-08-20T01:00:01.000Z', level: 'WARN', player: null,
      request: 'req-1', signal: null, stage: 'load', kind: 'structured',
    });
    expect(parsed.entries[1]).toMatchObject({ level: 'ERROR', player: 'p2', signal: 'round.end', stage: 'finish' });
    expect(parsed.evidence).toBe('STATIC_LOCAL');
  });

  it('retains unknown and malformed-prefix lines without inventing fields', async () => {
    const parsed = parseImportedLog(await readFile('test/fixtures/logs/mixed.txt'));
    expect(parsed.entries.map((entry) => entry.kind)).toEqual(['unknown', 'malformed-prefix', 'structured']);
    expect(parsed.entries[0]).toMatchObject({ message: '未识别日志内容（原文未保存）', player: null, request: null, signal: null, stage: null });
    expect(parsed.entries[0]).not.toHaveProperty('raw');
    const aggregate = aggregateLog(parsed);
    expect(aggregate.players).toEqual({});
    expect(aggregate.stages).toEqual({ test: 1 });
    expect(aggregate.unknownLines).toBe(2);
  });

  it('parses the official editor local timestamp and INFO colon prefix', () => {
    const parsed = parseImportedLog(new TextEncoder().encode(
      '[2026-8-21 15:33:24] [INFO]: [Standalone] [player=100] 信号盒已贴地\n',
    ));
    expect(parsed.entries).toEqual([expect.objectContaining({
      kind: 'structured', timestamp: '2026-8-21 15:33:24', level: 'INFO', player: '100',
      message: '[Standalone] 信号盒已贴地',
    })]);
  });

  it('bounds and redacts structured message text before it can enter the private cache', () => {
    const privatePath = ['C:', 'private', 'map', 'src', 'GameEntry.lua'].join('\\');
    const parsed = parseImportedLog(new TextEncoder().encode(
      `[2026-8-21 15:33:24] [ERROR]: password=TOP_SECRET ${privatePath} ` + 'x'.repeat(2_000) + '\n',
    ));
    const message = parsed.entries[0]?.message ?? '';
    expect(message).not.toContain('TOP_SECRET');
    expect(message).not.toContain(privatePath);
    expect(message.length).toBeLessThanOrEqual(512);
  });

  it('fails explicitly on invalid UTF-8', () => {
    expect(() => parseImportedLog(Uint8Array.from([0xff, 0xfe, 0xfd]))).toThrowError(
      expect.objectContaining({ code: 'INVALID_UTF8' }),
    );
  });
});
