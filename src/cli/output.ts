import { ProductError } from '../core/errors.js';
import { stableJson } from '../core/hash.js';
import type { CliCode, CliEnvelope } from '../core/model.js';

export const CLI_EXIT_CODES: Readonly<Record<CliCode, number>> = {
  OK: 0,
  OFFLINE: 2,
  STALE: 3,
  AMBIGUOUS: 4,
  NOT_FOUND: 5,
  VALIDATION_FAILED: 6,
  USAGE_ERROR: 7,
  INTERNAL_ERROR: 8,
};

export interface CliRunResult<T = unknown> {
  exitCode: number;
  envelope: CliEnvelope<T>;
}

export function result<T>(
  code: CliCode,
  message: string,
  data: T | null = null,
  warnings: string[] = [],
): CliRunResult<T> {
  return {
    exitCode: CLI_EXIT_CODES[code],
    envelope: {
      schemaVersion: 1,
      ok: code === 'OK',
      code,
      message,
      data,
      warnings,
    },
  };
}

export function resultFromError(error: unknown): CliRunResult {
  if (error instanceof ProductError) {
    const code: CliCode = error.code === 'USAGE_ERROR'
      ? 'USAGE_ERROR'
      : error.code === 'VALIDATION_FAILED'
        ? 'VALIDATION_FAILED'
        : error.code === 'OFFLINE'
          ? 'OFFLINE'
          : 'INTERNAL_ERROR';
    return result(code, error.message, { nextActions: [...error.nextActions], evidence: error.evidence });
  }
  return result('INTERNAL_ERROR', 'CLI 发生未预期错误。', null);
}

export function renderCliResult(value: CliRunResult, json: boolean): { stdout: string; stderr: string } {
  if (json) {
    return { stdout: stableJson(value.envelope), stderr: '' };
  }
  const lines = [value.envelope.message];
  for (const warning of value.envelope.warnings) {
    lines.push(`警告：${warning}`);
  }
  const rendered = `${lines.join('\n')}\n`;
  return value.exitCode === 0 ? { stdout: rendered, stderr: '' } : { stdout: '', stderr: rendered };
}
