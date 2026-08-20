import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_LUA_PARSE_LIMITS,
  decodeLuaUtf8,
  parseLuaLiteralDocument,
} from '../../src/core/lua/literal-parser.js';

describe('literal-only Lua parsing', () => {
  it('parses a returned nested literal table and records source ranges', async () => {
    const source = await readFile(new URL('../fixtures/lua/literal-ui.lua', import.meta.url), 'utf8');

    const document = parseLuaLiteralDocument(source);

    expect(document.value).toEqual({
      name: '经验',
      id: 41001,
      visible: true,
      offset: -2,
      children: [{ name: '虚构按钮', id: 41002 }],
    });
    expect(document.entries).toContainEqual(expect.objectContaining({
      path: '/name',
      key: 'name',
      entryRange: expect.objectContaining({ startLine: 2, startColumn: 3 }),
      valueRange: expect.objectContaining({ startLine: 2, startColumn: 10 }),
    }));
    expect(document.literals).toContainEqual(expect.objectContaining({
      path: '/offset',
      kind: 'number',
      value: -2,
    }));
  });

  it.each([
    'return os.execute("fictional-command")',
    'return factory()',
    'local x = 1; return {x}',
    'return { value = a.b }',
    'return { value = 1 + 2 }',
    'return function() end',
  ])('rejects executable or referenced Lua: %s', (source) => {
    expect(() => parseLuaLiteralDocument(source)).toThrowError(expect.objectContaining({ code: 'UNSAFE_LUA_NODE' }));
  });

  it('requires exactly one return statement and one value', () => {
    expect(() => parseLuaLiteralDocument('return 1, 2')).toThrowError(expect.objectContaining({
      code: 'UNSAFE_LUA_NODE',
    }));
    expect(() => parseLuaLiteralDocument('')).toThrowError(expect.objectContaining({ code: 'UNSAFE_LUA_NODE' }));
  });

  it('decodes quoted, escaped, long-bracket, and BOM-prefixed Unicode strings', () => {
    const document = parseLuaLiteralDocument('\uFEFFreturn { "经验\\n值", [[长文本]], [=[另一段]=], "\\u{7ECF}\\u{9A8C}" }');

    expect(document.value).toEqual(['经验\n值', '长文本', '另一段', '经验']);
  });

  it('rejects duplicate canonical table keys', () => {
    expect(() => parseLuaLiteralDocument('return { name = "a", ["name"] = "b" }')).toThrowError(
      expect.objectContaining({ code: 'DUPLICATE_LUA_KEY' }),
    );
  });

  it('rejects non-finite numeric literals and damaged syntax', async () => {
    const damaged = await readFile(new URL('../fixtures/lua/damaged.lua', import.meta.url), 'utf8');

    expect(() => parseLuaLiteralDocument('return 1e9999')).toThrowError(expect.objectContaining({
      code: 'NON_FINITE_NUMBER',
    }));
    expect(() => parseLuaLiteralDocument(damaged)).toThrowError(expect.objectContaining({
      code: 'INVALID_LUA_SYNTAX',
    }));
  });

  it('rejects invalid UTF-8 before parsing', () => {
    expect(() => decodeLuaUtf8(Uint8Array.from([0x72, 0x65, 0x74, 0x75, 0x72, 0x6e, 0x20, 0xc3, 0x28]))).toThrowError(
      expect.objectContaining({ code: 'INVALID_UTF8' }),
    );
  });
});

describe('Lua parser resource limits', () => {
  it('declares the production source, node, depth, and string limits', () => {
    expect(DEFAULT_LUA_PARSE_LIMITS).toEqual({
      maxSourceBytes: 16 * 1024 * 1024,
      maxNodes: 200_000,
      maxDepth: 256,
      maxStringBytes: 4 * 1024 * 1024,
    });
  });

  it.each([
    ['source bytes', 'return "12345"', { maxSourceBytes: 4 }],
    ['node count', 'return { 1, 2, 3 }', { maxNodes: 3 }],
    ['depth', 'return { value = { value = { value = 1 } } }', { maxDepth: 2 }],
    ['string bytes', 'return "经验"', { maxStringBytes: 5 }],
  ])('rejects %s above its configured limit', (_name, source, limits) => {
    expect(() => parseLuaLiteralDocument(source, limits)).toThrowError(expect.objectContaining({
      code: 'LUA_LIMIT_EXCEEDED',
    }));
  });

  it('enforces the default 16 MiB source limit before AST parsing', () => {
    const source = ' '.repeat(DEFAULT_LUA_PARSE_LIMITS.maxSourceBytes + 1);

    expect(() => parseLuaLiteralDocument(source)).toThrowError(expect.objectContaining({
      code: 'LUA_LIMIT_EXCEEDED',
    }));
  });

  it('enforces the default 200,000 AST node limit', () => {
    const source = `return {${'nil,'.repeat(100_000)}nil}`;

    expect(() => parseLuaLiteralDocument(source)).toThrowError(expect.objectContaining({
      code: 'LUA_LIMIT_EXCEEDED',
    }));
  });

  it('enforces the default depth of 256', () => {
    let value = '1';
    for (let depth = 0; depth < DEFAULT_LUA_PARSE_LIMITS.maxDepth + 1; depth += 1) {
      value = `{${value}}`;
    }

    expect(() => parseLuaLiteralDocument(`return ${value}`)).toThrowError(expect.objectContaining({
      code: 'LUA_LIMIT_EXCEEDED',
    }));
  });

  it('enforces the default 4 MiB decoded string limit', () => {
    const source = `return "${'a'.repeat(DEFAULT_LUA_PARSE_LIMITS.maxStringBytes + 1)}"`;

    expect(() => parseLuaLiteralDocument(source)).toThrowError(expect.objectContaining({
      code: 'LUA_LIMIT_EXCEEDED',
    }));
  });
});
