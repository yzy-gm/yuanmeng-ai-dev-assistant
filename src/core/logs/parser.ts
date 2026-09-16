import { TextDecoder } from 'node:util';

import { ProductError, type EvidenceLevel } from '../errors.js';
import { sha256Hex } from '../hash.js';

export type ImportedLogLevel = 'TRACE' | 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'FATAL';
export type ImportedLogKind = 'structured' | 'unknown' | 'malformed-prefix';

export interface ImportedLogEntry {
  line: number;
  kind: ImportedLogKind;
  timestamp: string | null;
  level: ImportedLogLevel | null;
  player: string | null;
  request: string | null;
  signal: string | null;
  stage: string | null;
  message: string;
}

export interface ParsedImportedLog {
  schemaVersion: 1;
  sourceHash: string;
  evidence: Extract<EvidenceLevel, 'STATIC_LOCAL'>;
  entries: ImportedLogEntry[];
}

export interface LogParseOptions {
  from?: string;
  to?: string;
}

export interface LogAggregate {
  levels: Record<string, number>;
  players: Record<string, number>;
  requests: Record<string, number>;
  signals: Record<string, number>;
  stages: Record<string, number>;
  unknownLines: number;
}

const MAX_PERSISTED_MESSAGE_CHARACTERS = 512;
const REDACTED_UNKNOWN_MESSAGE = '未识别日志内容（原文未保存）';

function safeMessage(value: string): string {
  const redacted = value
    .replace(/\b[A-Za-z]:\\[^\r\n，。；;]*/gu, '[本机路径]')
    .replace(/(?:https?:\/\/|file:\/\/)[^\s，。；;]+/giu, '[本机地址]')
    .replace(/\b(?:password|passwd|pwd|token|secret|authorization)\s*[:=]\s*[^\s，。；;]+/giu, '$1=[已隐藏]');
  return redacted.length <= MAX_PERSISTED_MESSAGE_CHARACTERS
    ? redacted
    : `${redacted.slice(0, MAX_PERSISTED_MESSAGE_CHARACTERS - 1)}…`;
}

function parseBoundary(value: string | undefined, label: string): number | null {
  if (value === undefined) return null;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) {
    throw new ProductError('VALIDATION_FAILED', `${label} 必须是 ISO 时间。`, ['检查日志时间范围。'], 'STATIC_LOCAL');
  }
  return time;
}

function decode(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/u, '');
  } catch (error) {
    throw new ProductError('INVALID_UTF8', '导入日志不是有效 UTF-8。', ['将日志转为 UTF-8 后重新选择。'], 'STATIC_LOCAL', error);
  }
}

/** 官方编辑器日志使用无时区的本机时间；ISO 日志仍按其自带时区解析。 */
export function parseLogTimestamp(value: string): number | null {
  if (/^\d{4}-\d{2}-\d{2}T/u.test(value)) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/u.exec(value);
  if (match === null) return null;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, millisecondText = '0'] = match;
  const values = [yearText, monthText, dayText, hourText, minuteText, secondText].map(Number);
  const [year, month, day, hour, minute, second] = values;
  const millisecond = Number(millisecondText.padEnd(3, '0'));
  if ([year, month, day, hour, minute, second, millisecond].some((part) => !Number.isInteger(part))) return null;
  const date = new Date(year!, month! - 1, day!, hour!, minute!, second!, millisecond);
  return date.getFullYear() === year && date.getMonth() === month! - 1 && date.getDate() === day
    && date.getHours() === hour && date.getMinutes() === minute && date.getSeconds() === second
    ? date.getTime()
    : null;
}

function emptyEntry(line: number, kind: Exclude<ImportedLogKind, 'structured'>): ImportedLogEntry {
  return {
    line, kind, timestamp: null, level: null, player: null, request: null,
    signal: null, stage: null, message: REDACTED_UNKNOWN_MESSAGE,
  };
}

function parseLine(raw: string, line: number): ImportedLogEntry {
  const header = /^\[([^\]]+)\]\s+\[(TRACE|DEBUG|INFO|WARN|ERROR|FATAL)\]:?\s*(.*)$/u.exec(raw);
  if (header === null) return emptyEntry(line, raw.startsWith('[') ? 'malformed-prefix' : 'unknown');
  const timestamp = header[1]!;
  if (parseLogTimestamp(timestamp) === null) {
    return emptyEntry(line, 'malformed-prefix');
  }
  let remainder = header[3]!;
  let officialChannel = '';
  const channel = /^\[(Standalone|Client|Server)\]\s*/u.exec(remainder);
  if (channel !== null) {
    officialChannel = `[${channel[1]}] `;
    remainder = remainder.slice(channel[0].length);
  }
  const metadata: Record<'player' | 'request' | 'signal' | 'stage', string | null> = {
    player: null, request: null, signal: null, stage: null,
  };
  while (remainder.startsWith('[')) {
    const tag = /^\[(player|request|signal|stage)=([^\]\r\n]+)\]\s*/u.exec(remainder);
    if (tag === null) break;
    metadata[tag[1] as keyof typeof metadata] = tag[2]!;
    remainder = remainder.slice(tag[0].length);
  }
  return {
    line,
    kind: 'structured',
    timestamp,
    level: header[2] as ImportedLogLevel,
    ...metadata,
    message: safeMessage(`${officialChannel}${remainder}`),
  };
}

export function parseImportedLog(bytes: Uint8Array, options: LogParseOptions = {}): ParsedImportedLog {
  const from = parseBoundary(options.from, 'from');
  const to = parseBoundary(options.to, 'to');
  if (from !== null && to !== null && from > to) {
    throw new ProductError('VALIDATION_FAILED', '日志开始时间不能晚于结束时间。', ['调整时间范围。'], 'STATIC_LOCAL');
  }
  const text = decode(bytes).replace(/\r\n?/gu, '\n');
  const lines = text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n');
  const entries = lines.map((raw, index) => parseLine(raw, index + 1)).filter((entry) => {
    if (entry.timestamp === null) return from === null && to === null;
    const time = parseLogTimestamp(entry.timestamp)!;
    return (from === null || time >= from) && (to === null || time <= to);
  });
  return { schemaVersion: 1, sourceHash: sha256Hex(bytes), evidence: 'STATIC_LOCAL', entries };
}

function increment(target: Record<string, number>, key: string | null): void {
  if (key !== null) target[key] = (target[key] ?? 0) + 1;
}

function sorted(record: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(record).sort(([left], [right]) => left.localeCompare(right, 'en')));
}

export function aggregateLog(parsed: ParsedImportedLog): LogAggregate {
  const levels: Record<string, number> = {};
  const players: Record<string, number> = {};
  const requests: Record<string, number> = {};
  const signals: Record<string, number> = {};
  const stages: Record<string, number> = {};
  let unknownLines = 0;
  for (const entry of parsed.entries) {
    increment(levels, entry.level);
    increment(players, entry.player);
    increment(requests, entry.request);
    increment(signals, entry.signal);
    increment(stages, entry.stage);
    if (entry.kind !== 'structured') unknownLines += 1;
  }
  return {
    levels: sorted(levels), players: sorted(players), requests: sorted(requests),
    signals: sorted(signals), stages: sorted(stages), unknownLines,
  };
}
