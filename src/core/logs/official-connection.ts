import type { LinkState } from '../model.js';

/**
 * The official Dream Helper output is not a public VS Code API.  This module
 * only understands the small, stable connection markers that are useful for
 * the status indicator; it never returns an original log line, endpoint, or
 * path.
 */
// The official extension logs a successful login once and may remain silent
// for a long editing session. A generous upper bound avoids flipping a live
// session to unknown during normal work; the monitor is additionally scoped
// to the current VS Code extension-host session and honors explicit disconnect
// markers.
export const OFFICIAL_OUTPUT_CONNECTION_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_LOG_CHARACTERS = 256 * 1024;
const MAX_LOG_LINES = 4_000;
const PROJECT_HINT_WINDOW_MS = 5 * 60 * 1000;
const FUTURE_CLOCK_SKEW_MS = 2 * 60 * 1000;

export interface OfficialConnectionLogDocument {
  name: string;
  content: string;
  modifiedAt?: number;
}

export interface OfficialConnectionEvent {
  state: 'online' | 'offline';
  observedAt: string;
  projectName: string | null;
}

export interface OfficialConnectionObservation {
  state: LinkState;
  observedAt: string | null;
  projectName: string | null;
  source: 'official-output-log';
}

export interface OfficialConnectionSelectionOptions {
  projectName: string | null;
  now?: Date | number;
  maxAgeMilliseconds?: number;
}

interface InternalEvent extends OfficialConnectionEvent {
  timestampMilliseconds: number;
  order: number;
}

interface ProjectHint {
  timestampMilliseconds: number;
  projectName: string;
  order: number;
}

interface TimestampMatch {
  timestampMilliseconds: number;
  body: string;
}

const LOG_TIMESTAMP = /^\s*\[(\d{4})-(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{1,2}):(\d{1,2})\]\s*/u;
const SUCCESS_MARKER = /\[[^\]\r\n]{1,128}\]\s*连接成功(?:\s*)$/u;
const PROJECT_ACTIVATION_MARKER = /默认激活第一个工程\s*:\s*(.*?)\s*$/u;
const PROJECT_SENT_MARKER = /^(.*?)\s+工程代码已经发送\s*$/u;
const DISCONNECT_MARKERS = [
  '没有联动设备连接',
  '结束联动环境成功',
  '联动环境未开启',
  '连接断开',
  '连接失败',
] as const;

function normalizeProjectName(value: string): string | null {
  let candidate = value.trim().replace(/^['"]|['"]$/gu, '').trim();
  candidate = candidate.replace(/[\\/]+$/u, '');
  const separator = Math.max(candidate.lastIndexOf('/'), candidate.lastIndexOf('\\'));
  if (separator >= 0) candidate = candidate.slice(separator + 1).trim();
  if (
    candidate === ''
    || candidate === '.'
    || candidate === '..'
    || candidate.length > 160
    || [...candidate].some((character) => character.charCodeAt(0) < 0x20)
    || /[<>:"|?*]/u.test(candidate)
  ) {
    return null;
  }
  return candidate;
}

function timestampAndBody(line: string, fallbackMilliseconds: number | null): TimestampMatch | null {
  const match = line.match(LOG_TIMESTAMP);
  if (match === null) {
    return fallbackMilliseconds === null
      ? null
      : { timestampMilliseconds: fallbackMilliseconds, body: line.trim() };
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const date = new Date(year, month - 1, day, hour, minute, second, 0);
  if (
    !Number.isFinite(date.getTime())
    || date.getFullYear() !== year
    || date.getMonth() !== month - 1
    || date.getDate() !== day
    || date.getHours() !== hour
    || date.getMinutes() !== minute
    || date.getSeconds() !== second
  ) {
    return null;
  }
  return {
    timestampMilliseconds: date.getTime(),
    body: line.slice(match[0].length).trim(),
  };
}

function projectHint(body: string): string | null {
  const activation = body.match(PROJECT_ACTIVATION_MARKER);
  if (activation !== null) return normalizeProjectName(activation[1] ?? '');
  const sent = body.match(PROJECT_SENT_MARKER);
  if (sent !== null) return normalizeProjectName(sent[1] ?? '');
  return null;
}

function eventState(body: string): 'online' | 'offline' | null {
  if (SUCCESS_MARKER.test(body)) return 'online';
  return DISCONNECT_MARKERS.some((marker) => body.includes(marker)) ? 'offline' : null;
}

function safeDocumentContent(content: string): string {
  if (content.length <= MAX_LOG_CHARACTERS) return content;
  return content.slice(-MAX_LOG_CHARACTERS);
}

function officialLogName(name: string): boolean {
  return /dreamhelper/iu.test(name) && /\.log$/iu.test(name);
}

function nearestProjectHint(
  timestampMilliseconds: number,
  hints: readonly ProjectHint[],
): string | null {
  let selected: ProjectHint | null = null;
  let selectedDistance = Number.POSITIVE_INFINITY;
  for (const hint of hints) {
    const distance = Math.abs(hint.timestampMilliseconds - timestampMilliseconds);
    if (distance > PROJECT_HINT_WINDOW_MS) continue;
    const isBetter = distance < selectedDistance
      || (distance === selectedDistance && selected !== null && hint.timestampMilliseconds <= timestampMilliseconds
        && selected.timestampMilliseconds > timestampMilliseconds)
      || (distance === selectedDistance && selected !== null && hint.order > selected.order);
    if (isBetter || selected === null) {
      selected = hint;
      selectedDistance = distance;
    }
  }
  return selected?.projectName ?? null;
}

function observation(
  state: LinkState,
  event: OfficialConnectionEvent | null,
): OfficialConnectionObservation {
  return {
    state,
    observedAt: event?.observedAt ?? null,
    projectName: event?.projectName ?? null,
    source: 'official-output-log',
  };
}

function normalizedSelectionName(value: string | null): string | null {
  return value === null ? null : normalizeProjectName(value);
}

/** Parse only official Dream Helper log files into redacted connection events. */
export function parseOfficialConnectionEvents(
  documents: readonly OfficialConnectionLogDocument[],
): OfficialConnectionEvent[] {
  const events: InternalEvent[] = [];
  const hints: ProjectHint[] = [];
  let order = 0;
  for (const document of documents) {
    if (!officialLogName(document.name)) continue;
    const modifiedAt = typeof document.modifiedAt === 'number' && Number.isFinite(document.modifiedAt)
      ? document.modifiedAt
      : null;
    const lines = safeDocumentContent(document.content).split(/\r?\n/u).slice(-MAX_LOG_LINES);
    for (const line of lines) {
      const parsed = timestampAndBody(line, modifiedAt);
      if (parsed === null) continue;
      const hint = projectHint(parsed.body);
      if (hint !== null) {
        hints.push({ timestampMilliseconds: parsed.timestampMilliseconds, projectName: hint, order });
      }
      const state = eventState(parsed.body);
      if (state !== null) {
        events.push({
          state,
          observedAt: new Date(parsed.timestampMilliseconds).toISOString(),
          projectName: hint,
          timestampMilliseconds: parsed.timestampMilliseconds,
          order,
        });
      }
      order += 1;
    }
  }
  return events
    .map((event) => ({
      state: event.state,
      observedAt: event.observedAt,
      projectName: event.projectName ?? nearestProjectHint(event.timestampMilliseconds, hints),
      timestampMilliseconds: event.timestampMilliseconds,
      order: event.order,
    }))
    .sort((left, right) => left.timestampMilliseconds - right.timestampMilliseconds || left.order - right.order)
    .map(({ state, observedAt, projectName }) => ({ state, observedAt, projectName }));
}

/** Select a fresh event for one project without exposing raw official output. */
export function selectOfficialConnectionObservation(
  events: readonly OfficialConnectionEvent[],
  options: OfficialConnectionSelectionOptions,
): OfficialConnectionObservation {
  const nowMilliseconds = typeof options.now === 'number'
    ? options.now
    : (options.now ?? new Date()).getTime();
  const maxAgeMilliseconds = options.maxAgeMilliseconds ?? OFFICIAL_OUTPUT_CONNECTION_MAX_AGE_MS;
  const targetProject = normalizedSelectionName(options.projectName);
  const candidates = events
    .map((event, order) => ({
      event,
      order,
      timestampMilliseconds: Date.parse(event.observedAt),
    }))
    .filter(({ event, timestampMilliseconds }) => (
      Number.isFinite(timestampMilliseconds)
      && (targetProject === null
        || event.projectName === null
        || normalizedSelectionName(event.projectName) === targetProject)
    ));
  const latest = candidates.at(-1);
  if (latest === undefined) return observation('unknown', null);
  const ageMilliseconds = nowMilliseconds - latest.timestampMilliseconds;
  if (
    !Number.isFinite(ageMilliseconds)
    || ageMilliseconds > maxAgeMilliseconds
    || ageMilliseconds < -FUTURE_CLOCK_SKEW_MS
  ) {
    return observation('unknown', latest.event);
  }
  return observation(latest.event.state, latest.event);
}
