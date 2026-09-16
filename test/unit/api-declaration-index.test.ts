import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import {
  buildApiIndex,
  diffApiIndexes,
  parseDeclarationFile,
  searchApi,
  searchApiSymbols,
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

  it('indexes official constants and enum members instead of silently dropping them', () => {
    const parsed = parseDeclarationFile({
      relativePath: 'res/lib/MiscService.d.lua',
      source: `--- 其他服务
--- @module "MiscService"
local MiscService_module = {}
--- 可查询对象类型
---@enum MiscService.EQueryableObjectType
local EQueryableObjectType = {
  Element = "Element",
  LogicElement = "LogicElement",
  TriggerBox = "TriggerBox",
}
MiscService_module.EQueryableObjectType = EQueryableObjectType
---@const MiscService.TEST_CONSTANT
MiscService_module.TEST_CONSTANT = "TEST_CONSTANT"
function MiscService_module:IsObjectExist(ObjType, ObjID) end
`,
    });
    const index = buildApiIndex([parsed], { officialExtensionVersion: '1.4.7-test' });

    expect(index.constants).toEqual([
      expect.objectContaining({
        key: 'MiscService:constant:TEST_CONSTANT',
        module: 'MiscService',
        name: 'TEST_CONSTANT',
        value: 'TEST_CONSTANT',
      }),
    ]);
    expect(index.enums).toEqual([
      expect.objectContaining({
        key: 'MiscService:enum:EQueryableObjectType',
        name: 'EQueryableObjectType',
        members: [
          { name: 'Element', value: 'Element' },
          { name: 'LogicElement', value: 'LogicElement' },
          { name: 'TriggerBox', value: 'TriggerBox' },
        ],
      }),
    ]);
    expect(searchApiSymbols(index, 'TriggerBox')).toEqual([
      expect.objectContaining({ kind: 'enum', name: 'EQueryableObjectType' }),
    ]);
  });

  it('finds official event constants while keeping function-only search backward compatible', () => {
    const parsed = parseDeclarationFile({
      relativePath: 'res/lib/Events.d.lua',
      source: `--- 事件系统
--- @module "Events"
local Events_module = {}
---@const Events.ON_CHARACTER_ENTER_SIGNAL_BOX
Events_module.ON_CHARACTER_ENTER_SIGNAL_BOX = "ON_CHARACTER_ENTER_SIGNAL_BOX"
`,
    });
    const index = buildApiIndex([parsed], { officialExtensionVersion: '1.4.7-test' });

    expect(searchApi(index, 'ON_CHARACTER_ENTER_SIGNAL_BOX')).toEqual([]);
    expect(searchApiSymbols(index, 'ON_CHARACTER_ENTER_SIGNAL_BOX')).toEqual([
      expect.objectContaining({
        kind: 'constant',
        module: 'Events',
        name: 'ON_CHARACTER_ENTER_SIGNAL_BOX',
        value: 'ON_CHARACTER_ENTER_SIGNAL_BOX',
      }),
    ]);
  });

  it('supports an explicit result limit for broad API searches', () => {
    const declarations = ['One', 'Two', 'Three'].map((name) => parseDeclarationFile({
      relativePath: `res/lib/${name}.d.lua`,
      source: `--- shared match\n--- @module "${name}"\nlocal ${name}_module = {}\n---@const ${name}.SHARED\n${name}_module.SHARED = "shared"\n`,
    }));
    const index = buildApiIndex(declarations, { officialExtensionVersion: '1.0.0-test' });
    expect(searchApiSymbols(index, 'shared', 2)).toHaveLength(2);
  });

  it('rejects mismatched constant assignments and executable enum values', () => {
    expect(() => parseDeclarationFile({
      relativePath: 'res/lib/Events.d.lua',
      source: '--- @module "Events"\nlocal Events_module = {}\n---@const Events.EXPECTED\nEvents_module.OTHER = "EXPECTED"\n',
    })).toThrowError(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
    expect(() => parseDeclarationFile({
      relativePath: 'res/lib/Unsafe.d.lua',
      source: '--- @module "Unsafe"\nlocal Unsafe_module = {}\n---@enum Unsafe.Kind\nlocal Kind = { Bad = os.execute("no") }\nUnsafe_module.Kind = Kind\n',
    })).toThrowError(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
  });

  it('diffs constants and enums as well as functions when the official extension changes', () => {
    const parse = (constant: string, triggerBox: string) => parseDeclarationFile({
      relativePath: 'res/lib/Events.d.lua',
      source: `--- @module "Events"
local Events_module = {}
---@const Events.SAMPLE
Events_module.SAMPLE = "${constant}"
---@enum Events.Kind
local Kind = {
  TriggerBox = "${triggerBox}",
}
Events_module.Kind = Kind
`,
    });
    const before = buildApiIndex([parse('OLD', 'TriggerBox')], { officialExtensionVersion: '1.0.0' });
    const after = buildApiIndex([parse('NEW', 'SignalBox')], { officialExtensionVersion: '2.0.0' });
    const diff = diffApiIndexes(before, after);
    expect(diff.constants.changed).toEqual([expect.objectContaining({ key: 'Events:constant:SAMPLE' })]);
    expect(diff.enums.changed).toEqual([expect.objectContaining({ key: 'Events:enum:Kind' })]);
  });

  it('preserves spaced callback parameter annotations and rejects malformed known annotations', () => {
    const parsed = parseDeclarationFile({
      relativePath: 'res/lib/LogicElement.d.lua',
      source: `--- @module "LogicElement"
local LogicElement_module = {}
---@param ElementId number
---@param Callback fun(elementId: number, bOpen: boolean) -- 状态回调
function LogicElement_module:AddListener(ElementId, Callback) end
`,
    });
    expect(parsed.declarations[0]?.params).toEqual([
      { name: 'ElementId', type: 'number', description: '' },
      { name: 'Callback', type: 'fun(elementId: number, bOpen: boolean)', description: '状态回调' },
    ]);
    expect(() => parseDeclarationFile({
      relativePath: 'res/lib/Broken.d.lua',
      source: '--- @module "Broken"\nlocal Broken_module = {}\n---@param Callback fun(one: number\nfunction Broken_module:Run(Callback) end\n',
    })).toThrowError(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
  });

  it('marks parameters documented as omitted or defaulted as optional', () => {
    const parsed = parseDeclarationFile({
      relativePath: 'res/lib/System.d.lua',
      source: `--- 信号系统
--- @module "System"
local System_module = {}
---@param EventName string -- 信号事件名称
---@param PlayerIDs number[] -- 不传时只会在当前端触发
function System_module:FireSignEvent(EventName, PlayerIDs) end
---@param ListItemUID number[] -- 控件 UID
---@param NewText string -- 文本
---@param IsRichText boolean -- 默认为 false
function System_module:SetText(ListItemUID, NewText, IsRichText) end
`,
    });

    expect(parsed.declarations.map((declaration) => declaration.params)).toEqual([
      [
        { name: 'EventName', type: 'string', description: '信号事件名称' },
        { name: 'PlayerIDs', type: 'number[]', description: '不传时只会在当前端触发', optional: true },
      ],
      [
        { name: 'ListItemUID', type: 'number[]', description: '控件 UID' },
        { name: 'NewText', type: 'string', description: '文本' },
        { name: 'IsRichText', type: 'boolean', description: '默认为 false', optional: true },
      ],
    ]);
  });
});
