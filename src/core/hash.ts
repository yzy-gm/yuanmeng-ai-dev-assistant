import { createHash } from 'node:crypto';

import { ProductError } from './errors.js';

export function sha256Hex(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex');
}

function sortJsonValue(value: unknown, ancestors: Set<object>): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new ProductError('VALIDATION_FAILED', 'JSON 数字必须是有限值。', ['检查待写入数据。'], 'STATIC_LOCAL');
    }
    return value;
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) {
      throw new ProductError('VALIDATION_FAILED', 'JSON 数据不能包含循环引用。', ['检查待写入数据。'], 'STATIC_LOCAL');
    }
    ancestors.add(value);
    const result = value.map((item) => sortJsonValue(item, ancestors));
    ancestors.delete(value);
    return result;
  }
  if (typeof value === 'object') {
    if (ancestors.has(value)) {
      throw new ProductError('VALIDATION_FAILED', 'JSON 数据不能包含循环引用。', ['检查待写入数据。'], 'STATIC_LOCAL');
    }
    ancestors.add(value);
    const input = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(input).sort()) {
      const child = input[key];
      if (child !== undefined) {
        result[key] = sortJsonValue(child, ancestors);
      }
    }
    ancestors.delete(value);
    return result;
  }
  throw new ProductError('VALIDATION_FAILED', '数据包含不能写入 JSON 的值。', ['检查待写入数据。'], 'STATIC_LOCAL');
}

export function stableJson(value: unknown): string {
  return `${JSON.stringify(sortJsonValue(value, new Set()), null, 2)}\n`;
}
