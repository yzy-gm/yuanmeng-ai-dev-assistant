import type { YuanmengMcpEnvelope } from './contracts.js';

const MAX_TEXT_BYTES = 2048;
export const MAX_STRUCTURED_BYTES = 64 * 1024;
const COMPACT_STRING_BYTES = 1_024;
const COMPACT_ARRAY_ITEMS = 40;
const COMPACT_OBJECT_KEYS = 60;
const COMPACT_DEPTH = 6;

function removePrivatePaths(value: string): string {
  return value
    .replace(/\b[A-Za-z]:\\[^\r\n，。；;]*/gu, '[本机私有路径]')
    .replace(/(?:^|\s)\/(?:[^\s/]+\/)+[^\s，。；;]*/gu, ' [本机私有路径]');
}

function boundedUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  const suffix = '…';
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(`${value.slice(0, middle)}${suffix}`, 'utf8') <= maxBytes) low = middle;
    else high = middle - 1;
  }
  let result = value.slice(0, low);
  // Do not leave a dangling UTF-16 high surrogate at the cut point.
  if (/[\uD800-\uDBFF]$/u.test(result)) result = result.slice(0, -1);
  return `${result}${suffix}`;
}

function jsonBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

interface CompactValue {
  value: unknown;
  truncated: boolean;
}

function compactValue(value: unknown, depth = 0): CompactValue {
  if (typeof value === 'string') {
    const compacted = boundedUtf8(value, COMPACT_STRING_BYTES);
    return { value: compacted, truncated: compacted !== value };
  }
  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    return { value, truncated: false };
  }
  if (depth >= COMPACT_DEPTH) return { value: '[内容已省略]', truncated: true };
  if (Array.isArray(value)) {
    const output: unknown[] = [];
    let truncated = value.length > COMPACT_ARRAY_ITEMS;
    for (const item of value.slice(0, COMPACT_ARRAY_ITEMS)) {
      const compacted = compactValue(item, depth + 1);
      output.push(compacted.value);
      truncated ||= compacted.truncated;
    }
    return { value: output, truncated };
  }
  if (typeof value === 'object') {
    const output: Record<string, unknown> = {};
    const entries = Object.entries(value as Record<string, unknown>);
    let truncated = entries.length > COMPACT_OBJECT_KEYS;
    for (const [key, item] of entries.slice(0, COMPACT_OBJECT_KEYS)) {
      const compacted = compactValue(item, depth + 1);
      output[key] = compacted.value;
      truncated ||= compacted.truncated;
    }
    return { value: output, truncated };
  }
  return { value: '[内容已省略]', truncated: true };
}

/**
 * MCP clients receive structuredContent as well as the short text block. Keep
 * the original envelope when it fits, but fail safe at the protocol boundary
 * when a diagnostic or audit result is unexpectedly large.
 */
export function boundMcpEnvelope(envelope: YuanmengMcpEnvelope<unknown>): YuanmengMcpEnvelope<unknown> {
  if (jsonBytes(envelope) <= MAX_STRUCTURED_BYTES) return envelope;
  const compacted = compactValue(envelope.data);
  const warning = 'MCP 返回内容已压缩到 64 KiB 上限；如需完整结果，请使用分页或缩小查询范围。';
  const nextActions = envelope.nextActions.slice(0, 6).map((action) => ({
    kind: action.kind,
    label: boundedUtf8(action.label, 512),
    ...(action.tool === undefined ? {} : { tool: action.tool }),
    ...(action.commandId === undefined ? {} : { commandId: action.commandId }),
  }));
  let bounded: YuanmengMcpEnvelope<unknown> = {
    ...envelope,
    summary: boundedUtf8(envelope.summary, 2_048),
    data: compacted.value,
    warnings: [...envelope.warnings.slice(0, 6), warning],
    nextActions,
  };
  if (jsonBytes(bounded) > MAX_STRUCTURED_BYTES) {
    bounded = {
      ...bounded,
      data: { truncated: true, originalBytes: jsonBytes(envelope) },
      warnings: [warning],
      nextActions: bounded.nextActions.slice(0, 2),
    };
  }
  return bounded;
}

export function toCallToolResult(envelope: YuanmengMcpEnvelope<unknown>) {
  const bounded = boundMcpEnvelope(envelope);
  const lines = [removePrivatePaths(bounded.summary)];
  for (const warning of bounded.warnings.slice(0, 3)) {
    lines.push(`警告：${removePrivatePaths(warning)}`);
  }
  for (const action of bounded.nextActions.slice(0, 3)) {
    lines.push(`下一步：${removePrivatePaths(action.label)}`);
  }
  return {
    content: [{ type: 'text' as const, text: boundedUtf8(lines.join('\n'), MAX_TEXT_BYTES - 1) }],
    structuredContent: bounded,
    isError: !bounded.ok
  };
}
