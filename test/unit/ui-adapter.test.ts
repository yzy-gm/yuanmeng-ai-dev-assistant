import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { parseLuaLiteralDocument } from '../../src/core/lua/literal-parser.js';
import {
  adaptOfficialUiTables,
  adaptSyntheticUiTablesForTests,
  parseOfficialUiExportFiles,
  type ParsedUiPart,
} from '../../src/core/ui/adapter.js';

async function fixture(name: 'part1.lua' | 'part2.lua'): Promise<ParsedUiPart> {
  const sourceFile = name === 'part1.lua'
    ? 'src/Data/CustomUIData.lua'
    : 'src/Data/CustomUIData2.lua';
  const source = await readFile(new URL(`../fixtures/ui/${name}`, import.meta.url), 'utf8');
  return { document: parseLuaLiteralDocument(source), sourceFile };
}

describe('synthetic UI adapter contract', () => {
  it('merges two explicit parts and retains hierarchy and source ranges', async () => {
    const nodes = adaptSyntheticUiTablesForTests([await fixture('part1.lua'), await fixture('part2.lua')]);

    expect(nodes).toEqual([
      expect.objectContaining({ id: '41001', name: 'HUD', path: '/HUD', parentId: null, depth: 0 }),
      expect.objectContaining({ id: '41002', name: '经验', path: '/HUD/经验', parentId: '41001', depth: 1 }),
      expect.objectContaining({ id: '41003', name: '结算', path: '/结算', parentId: null, depth: 0 }),
    ]);
    expect(nodes[1]?.sourceFile).toBe('src/Data/CustomUIData.lua');
    expect(nodes[1]?.sourceRange).toEqual(expect.objectContaining({ startLine: 10, startColumn: 9 }));
  });

  it('escapes slash and tilde in stable paths', () => {
    const document = parseLuaLiteralDocument(
      'return { schemaVersion = 1, roots = { { id = 41001, name = "A/B~C", type = "Panel", children = {} } } }',
    );

    expect(adaptSyntheticUiTablesForTests([{ document, sourceFile: 'src/Data/CustomUIData.lua' }])[0]?.path).toBe('/A~1B~0C');
  });

  it('rejects duplicate IDs instead of overwriting a node', () => {
    const document = parseLuaLiteralDocument(
      'return { schemaVersion = 1, roots = { { id = 41001, name = "A", type = "Panel", children = {} }, { id = 41001, name = "B", type = "Panel", children = {} } } }',
    );

    expect(() => adaptSyntheticUiTablesForTests([{ document, sourceFile: 'src/Data/CustomUIData.lua' }])).toThrowError(
      expect.objectContaining({ code: 'DUPLICATE_UI_ID' }),
    );
  });

  it('rejects unknown shapes with a key summary and anonymous structure hash', () => {
    const document = parseLuaLiteralDocument('return { widgets = { { uid = 41001 } } }');

    expect(() => adaptSyntheticUiTablesForTests([{ document, sourceFile: 'src/Data/CustomUIData.lua' }])).toThrowError(
      expect.objectContaining({
        code: 'UNSUPPORTED_UI_SCHEMA',
        message: expect.stringMatching(/keys=widgets; structure=[a-f0-9]{64}/u),
      }),
    );
  });
});

describe('calibrated Dream Helper 1.4.7 UI adapter', () => {
  it('uses the duplicate-safe indexed projection and never parses duplicate keyed siblings', async () => {
    const [keyed, indexed] = await Promise.all([
      readFile(new URL('../fixtures/ui/official-v1-keyed.lua', import.meta.url), 'utf8'),
      readFile(new URL('../fixtures/ui/official-v1-indexed.lua', import.meta.url), 'utf8'),
    ]);

    const parts = parseOfficialUiExportFiles([
      { sourceFile: 'src/Data/CustomUIData.lua', content: keyed },
      { sourceFile: 'src/Data/CustomUIData2.lua', content: indexed },
    ]);
    const nodes = adaptOfficialUiTables(parts);

    expect(parts.map((part) => part.sourceFile)).toEqual(['src/Data/CustomUIData2.lua']);
    expect(nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: '41002', name: 'RepeatedLabel', path: '/AlphaGroup/RepeatedLabel', type: 'unknown', siblingIndex: 0,
      }),
      expect.objectContaining({
        id: '41003', name: 'RepeatedLabel', path: '/AlphaGroup/RepeatedLabel', type: 'unknown', siblingIndex: 1,
      }),
    ]));
    expect(nodes.every((node) => node.sourceFile === 'src/Data/CustomUIData2.lua')).toBe(true);
    expect(nodes.every((node) => node.sourceRange !== null)).toBe(true);
  });

  it('rejects a missing indexed projection and unknown indexed fields without guessing', async () => {
    const keyed = await readFile(new URL('../fixtures/ui/official-v1-keyed.lua', import.meta.url), 'utf8');
    expect(() => parseOfficialUiExportFiles([
      { sourceFile: 'src/Data/CustomUIData.lua', content: keyed },
    ])).toThrowError(expect.objectContaining({ code: 'UNSUPPORTED_UI_SCHEMA' }));

    const document = parseLuaLiteralDocument(
      'return { _1 = { _uid = 41001, _name = "Alpha", _type = "Panel" } }',
    );
    expect(() => adaptOfficialUiTables([{
      document,
      sourceFile: 'src/Data/CustomUIData2.lua',
    }])).toThrowError(expect.objectContaining({
      code: 'UNSUPPORTED_UI_SCHEMA',
      message: expect.stringMatching(/structure=[a-f0-9]{64}/u),
    }));
  });

  it('rejects non-consecutive child indexes and duplicate UI IDs', () => {
    const skipped = parseLuaLiteralDocument(
      'return { _1 = { _uid = 41001, _name = "Alpha", _2 = { _uid = 41002, _name = "Child" } } }',
    );
    expect(() => adaptOfficialUiTables([{
      document: skipped,
      sourceFile: 'src/Data/CustomUIData2.lua',
    }])).toThrowError(expect.objectContaining({ code: 'UNSUPPORTED_UI_SCHEMA' }));

    const duplicate = parseLuaLiteralDocument([
      'return {',
      '  _1 = { _uid = 41001, _name = "Alpha" },',
      '  _2 = { _uid = 41001, _name = "Beta" },',
      '}',
    ].join('\n'));
    expect(() => adaptOfficialUiTables([{
      document: duplicate,
      sourceFile: 'src/Data/CustomUIData2.lua',
    }])).toThrowError(expect.objectContaining({ code: 'DUPLICATE_UI_ID' }));
  });
});
