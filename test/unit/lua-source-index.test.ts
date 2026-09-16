import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import type { RegistryDocument, RegistryRecord } from '../../src/core/model.js';
import {
  buildLuaSourceIndex,
  whereUsed,
  type LuaApiKnowledge,
  type LuaSourceFile,
} from '../../src/core/lua/source-index.js';

const PROJECT_ID = '00000000-0000-4000-8000-000000000801';

function registryRecord(overrides: Partial<RegistryRecord> = {}): RegistryRecord {
  return {
    recordId: 'ui-experience',
    kind: 'ui-control',
    name: '经验',
    value: '41001',
    scope: 'workspace',
    projectInstanceId: PROJECT_ID,
    mapFingerprint: null,
    layerId: null,
    environment: 'test',
    validity: 'confirmed',
    source: {
      kind: 'user-entry',
      relativePath: null,
      sha256: 'a'.repeat(64),
      observedAt: '2026-08-20T00:00:00.000Z',
      officialExtensionVersion: null,
      evidence: 'UNIT_E2E',
    },
    lastConfirmedAt: '2026-08-20T00:00:00.000Z',
    notes: '',
    ...overrides,
  };
}

const emptyRegistry: RegistryDocument = { schemaVersion: 1, records: [] };
const registry: RegistryDocument = {
  schemaVersion: 1,
  records: [
    registryRecord(),
    registryRecord({
      recordId: 'signal-round-started',
      kind: 'signal',
      name: '回合开始',
      value: 'round_started',
    }),
  ],
};
const api: LuaApiKnowledge = {
  calls: [
    { qualifiedName: 'UI:SetText', idParameterIndexes: [0], side: 'client' },
    { qualifiedName: 'Event:Send', signalParameterIndexes: [0], side: 'client' },
    { qualifiedName: 'Event:Listen', signalParameterIndexes: [0], side: 'client' },
  ],
  configuredIdFields: ['buttonId'],
};

async function fixtureFiles(): Promise<LuaSourceFile[]> {
  return Promise.all(['GameEntry.lua', 'Feature.lua'].map(async (name) => ({
    path: `src/${name}`,
    source: await readFile(new URL(`../fixtures/source-project/src/${name}`, import.meta.url), 'utf8'),
  })));
}

describe('Lua source index', () => {
  it('accepts UTF-8 BOM emitted at the start of official Lua project files', () => {
    const index = buildLuaSourceIndex(
      [{ path: 'src/GameEntry.lua', source: '\uFEFFlocal GameEntry = {}\nreturn GameEntry\n' }],
      emptyRegistry,
      { calls: [], configuredIdFields: [] },
    );

    expect(index.files).toEqual([
      expect.objectContaining({ path: 'src/GameEntry.lua' }),
    ]);
    expect(index.returnedModules).toContainEqual(expect.objectContaining({
      path: 'src/GameEntry.lua',
      value: 'GameEntry',
    }));
  });

  it('does not classify arbitrary numbers as IDs', () => {
    const index = buildLuaSourceIndex(
      [{ path: 'src/GameServer.lua', source: 'local retry = 3\n' }],
      emptyRegistry,
      { calls: [], configuredIdFields: [] },
    );

    expect(index.idReferences).toEqual([]);
    expect(index.files[0]?.side).toEqual({ value: 'unknown', evidence: null });
  });

  it('finds registered UI IDs and signal references with 1-based source ranges', async () => {
    const index = buildLuaSourceIndex(await fixtureFiles(), registry, api);

    expect(index.idReferences).toContainEqual(expect.objectContaining({
      value: '41001',
      confidence: 'confirmed',
      kind: 'ui',
      path: 'src/Feature.lua',
      line: 8,
      column: 16,
      evidence: { source: 'registry', recordId: 'ui-experience' },
    }));
    expect(index.signalReferences).toHaveLength(2);
    expect(index.signalReferences).toContainEqual(expect.objectContaining({
      value: 'round_started',
      role: 'send',
      line: 9,
    }));
    expect(index.stringLiterals).toContainEqual(expect.objectContaining({
      value: 'round_started',
      path: 'src/Feature.lua',
    }));
  });

  it('indexes modules, functions, calls, requires, config fields and annotation evidence', async () => {
    const index = buildLuaSourceIndex(await fixtureFiles(), registry, api);

    expect(index.returnedModules).toContainEqual(expect.objectContaining({
      path: 'src/GameEntry.lua',
      value: 'Feature',
    }));
    expect(index.requires).toEqual([
      expect.objectContaining({ path: 'src/GameEntry.lua', module: 'Feature' }),
    ]);
    expect(index.functions.map((item) => item.name)).toEqual(['Feature.Refresh', 'Feature.Listen']);
    expect(index.calls.map((item) => item.qualifiedName)).toEqual(expect.arrayContaining([
      'require',
      'UI:SetText',
      'Event:Send',
      'Event:Listen',
    ]));
    expect(index.configFields).toContainEqual(expect.objectContaining({ key: 'buttonId', value: '41001' }));
    expect(index.files.find((file) => file.path === 'src/Feature.lua')?.side).toEqual({
      value: 'client',
      evidence: 'annotation:---@ymai-side client',
    });
  });

  it('supports Lua string-call syntax and does not treat string contents as side annotations', () => {
    const index = buildLuaSourceIndex([{
      path: 'src/GameClient.lua',
      source: [
        'local marker = "---@ymai-side server"',
        'local Other = require "Other"',
        'return Other',
        '',
      ].join('\n'),
    }], emptyRegistry, api);

    expect(index.requires).toEqual([
      expect.objectContaining({ module: 'Other', line: 2 }),
    ]);
    expect(index.calls).toContainEqual(expect.objectContaining({ qualifiedName: 'require' }));
    expect(index.files[0]?.side).toEqual({ value: 'unknown', evidence: null });
  });

  it('indexes a multiline official event registration and its concrete signal-box guard', () => {
    const index = buildLuaSourceIndex([{
      path: 'src/GameServer.lua',
      source: [
        '---@ymai-side server',
        'local TEST_SIGNAL_BOX_ID = 517',
        'local function OnEnter(playerId, signalBoxId)',
        '  if signalBoxId ~= TEST_SIGNAL_BOX_ID then',
        '    return',
        '  end',
        'end',
        'System:RegisterEvent(',
        '  Events.ON_CHARACTER_ENTER_SIGNAL_BOX,',
        '  OnEnter',
        ')',
        '',
      ].join('\n'),
    }], emptyRegistry, api);

    const registration = index.calls.find((call) => call.qualifiedName === 'System:RegisterEvent');
    expect(registration?.arguments[0]?.qualifiedName).toBe('Events.ON_CHARACTER_ENTER_SIGNAL_BOX');
    expect(registration?.sceneInstanceGuards).toEqual(['517']);
    expect(registration?.side.value).toBe('server');
  });

  it('infers a registered callback as server-side from an immediate non-server return guard', () => {
    const index = buildLuaSourceIndex([{
      path: 'src/GameEntry.lua',
      source: [
        'local TEST_SIGNAL_BOX_ID = 517',
        'local function OnEnter(playerId, signalBoxId)',
        '  if not System:IsServer() or signalBoxId ~= TEST_SIGNAL_BOX_ID then',
        '    return',
        '  end',
        'end',
        'System:RegisterEvent(',
        '  Events.ON_CHARACTER_ENTER_SIGNAL_BOX,',
        '  OnEnter',
        ')',
        '',
      ].join('\n'),
    }], emptyRegistry, api);

    const registration = index.calls.find((call) => call.qualifiedName === 'System:RegisterEvent');
    expect(registration?.side).toEqual({
      value: 'server',
      evidence: 'callback-guard:not System:IsServer() then return',
    });
    expect(registration?.sceneInstanceGuards).toEqual(['517']);
  });

  it('returns relative where-used results and separates id, ui and signal kinds', async () => {
    const index = buildLuaSourceIndex(await fixtureFiles(), registry, api);

    const ids = whereUsed(index, { value: '41001', kind: 'id' });
    const ui = whereUsed(index, { value: '41001', kind: 'ui' });
    const signals = whereUsed(index, { value: 'round_started', kind: 'signal' });

    expect(ids.length).toBeGreaterThanOrEqual(2);
    expect(ui).toEqual(ids);
    expect(signals).toHaveLength(2);
    expect([...ids, ...signals].every((item) => (
      item.path.startsWith('src/')
      && item.line >= 1
      && item.column >= 1
      && item.context.length > 0
    ))).toBe(true);
  });

  it('preserves every registry record for one literal and filters scene registry kinds exactly', () => {
    const sharedValue = '84001';
    const records = [
      registryRecord({ recordId: 'shared-ui', value: sharedValue }),
      registryRecord({ recordId: 'shared-instance', kind: 'scene-instance', value: sharedValue }),
      registryRecord({ recordId: 'shared-type', kind: 'element-type', value: sharedValue }),
      registryRecord({ recordId: 'shared-layer', kind: 'scene-layer', value: sharedValue }),
      registryRecord({ recordId: 'shared-signal', kind: 'signal', value: sharedValue }),
    ];
    const index = buildLuaSourceIndex([{
      path: 'src/GameEntry.lua',
      source: 'local target = "84001"\nlocal retry = 84002\n',
    }], { schemaVersion: 1, records }, { calls: [], configuredIdFields: [] });

    expect(whereUsed(index, { value: sharedValue, kind: 'id' })).toHaveLength(4);
    expect(whereUsed(index, { value: sharedValue, kind: 'ui' })).toEqual([
      expect.objectContaining({ evidence: { source: 'registry', recordId: 'shared-ui' } }),
    ]);
    for (const kind of ['scene-instance', 'element-type', 'scene-layer'] as const) {
      expect(whereUsed(index, { value: sharedValue, kind })).toEqual([
        expect.objectContaining({ registryKind: kind }),
      ]);
    }
    expect(whereUsed(index, { value: sharedValue, kind: 'signal' })).toEqual([
      expect.objectContaining({ evidence: { source: 'registry', recordId: 'shared-signal' } }),
    ]);
    expect(whereUsed(index, { value: '84002', kind: 'id' })).toEqual([]);
  });

  it('rejects unsafe absolute paths and damaged Lua instead of executing it', () => {
    expect(() => buildLuaSourceIndex(
      [{ path: 'C:/private/Feature.lua', source: 'return {}' }],
      emptyRegistry,
      api,
    )).toThrowError(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
    expect(() => buildLuaSourceIndex(
      [{ path: 'src/Feature.lua', source: 'local =' }],
      emptyRegistry,
      api,
    )).toThrowError(expect.objectContaining({ code: 'INVALID_LUA_SYNTAX' }));
  });
});
