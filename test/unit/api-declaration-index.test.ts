import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import {
  buildApiIndex,
  diffApiIndexes,
  parseDeclarationFile,
  searchApi,
} from '../../src/core/api/declaration-index.js';

async function fixture(name: 'UI.d.lua' | 'UI-v2.d.lua') {
  return {
    relativePath: `res/lib/${name}`,
    source: await readFile(new URL(`../fixtures/api/${name}`, import.meta.url), 'utf8'),
  };
}

describe('official declaration metadata index', () => {
  it('indexes module, call style, signature, params, returns, source hash and version', async () => {
    const file = await fixture('UI.d.lua');
    const parsed = parseDeclarationFile(file);
    const index = buildApiIndex([parsed], { officialExtensionVersion: '9.9.9-test' });
    const result = searchApi(index, '控件名称');

    expect(result[0]).toMatchObject({
      module: 'UI',
      name: 'GetUIName',
      callStyle: 'colon',
      signature: 'UI:GetUIName(WidgetId)',
      params: [{ name: 'WidgetId', type: 'number', description: '控件 ID' }],
      returns: [{ name: 'name', type: 'string', description: '控件名称' }],
      officialExtensionVersion: '9.9.9-test',
      source: {
        relativePath: 'res/lib/UI.d.lua',
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      },
    });
  });

  it('supports English exact lookup and returns no invented unknown API', async () => {
    const index = buildApiIndex([
      parseDeclarationFile(await fixture('UI.d.lua')),
    ], { officialExtensionVersion: '9.9.9-test' });

    expect(searchApi(index, 'GetUIName')).toHaveLength(1);
    expect(searchApi(index, 'MakeEverythingWork')).toEqual([]);
  });

  it('reports added, removed and parameter changes by module, call style and name', async () => {
    const before = buildApiIndex([
      parseDeclarationFile(await fixture('UI.d.lua')),
    ], { officialExtensionVersion: '1.0.0' });
    const after = buildApiIndex([
      parseDeclarationFile(await fixture('UI-v2.d.lua')),
    ], { officialExtensionVersion: '2.0.0' });

    const diff = diffApiIndexes(before, after);

    expect(diff.added).toEqual([expect.objectContaining({ name: 'SetText' })]);
    expect(diff.removed).toEqual([expect.objectContaining({ name: 'SetVisible' })]);
    expect(diff.changed).toEqual([
      expect.objectContaining({
        key: 'UI:colon:GetUIName',
        changes: ['params', 'returns'],
      }),
    ]);
  });

  it('rejects executable function bodies and duplicate declaration keys', async () => {
    expect(() => parseDeclarationFile({
      relativePath: 'res/lib/Unsafe.d.lua',
      source: '--- @module "Unsafe"\nfunction Unsafe_module:Run() os.execute("no") end\n',
    })).toThrowError(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
    const parsed = parseDeclarationFile(await fixture('UI.d.lua'));
    expect(() => buildApiIndex([parsed, parsed], { officialExtensionVersion: '1.0.0' })).toThrowError(
      expect.objectContaining({ code: 'VALIDATION_FAILED' }),
    );
  });
});
