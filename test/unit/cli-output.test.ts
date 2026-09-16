import { describe, expect, it } from 'vitest';

import { resultFromError } from '../../src/cli/output.js';
import { ProductError } from '../../src/core/errors.js';

describe('CLI error mapping', () => {
  it.each([
    'INVALID_LUA_SYNTAX',
    'LUA_LIMIT_EXCEEDED',
  ] as const)('maps %s to validation and preserves the blocking Lua file', (errorCode) => {
    const error = Object.assign(new ProductError(
      errorCode,
      'Lua 静态审计失败。',
      ['修正 Lua 源文件或索引配置后重试。'],
      'STATIC_LOCAL',
    ), { details: { file: 'src/Client/Broken.lua' } });

    expect(resultFromError(error)).toMatchObject({
      exitCode: 6,
      envelope: {
        schemaVersion: 1,
        code: 'VALIDATION_FAILED',
        ok: false,
        data: {
          reasonCode: errorCode,
          file: 'src/Client/Broken.lua',
          nextActions: ['修正 Lua 源文件或索引配置后重试。'],
          evidence: 'STATIC_LOCAL',
        },
      },
    });
  });

  it.each([
    'UNSUPPORTED_SCENE_CONTAINER',
    'SCENE_INTEGRITY_FAILED',
    'SCENE_WIRE_INVALID',
    'UNSUPPORTED_SCENE_SCHEMA',
    'SCENE_LIMIT_EXCEEDED',
    'SCENE_SOURCE_CONFLICT',
    'SCENE_SOURCE_UNSTABLE',
    'SCENE_EVIDENCE_INSUFFICIENT',
  ] as const)('maps %s to the stable validation envelope', (errorCode) => {
    const result = resultFromError(new ProductError(
      errorCode,
      '场景输入无效。',
      ['检查场景源。'],
      'STATIC_LOCAL',
    ));

    expect(result).toMatchObject({
      exitCode: 6,
      envelope: {
        schemaVersion: 1,
        code: 'VALIDATION_FAILED',
        ok: false,
        data: { reasonCode: errorCode },
      },
    });
  });
});
