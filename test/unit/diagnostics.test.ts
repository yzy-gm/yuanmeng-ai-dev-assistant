import { describe, expect, it } from 'vitest';

import type { ApiIndex } from '../../src/core/api/declaration-index.js';
import { analyzeProject } from '../../src/core/diagnostics/analyzer.js';
import { buildLuaSourceIndex } from '../../src/core/lua/source-index.js';
import type {
  InspectorStatus,
  RegistryDocument,
  RegistryEnvironment,
  RegistryRecord,
  RegistryValidity,
  UiSnapshot,
} from '../../src/core/model.js';

const projectInstanceId = '00000000-0000-4000-8000-000000000801';
const currentMap = 'a'.repeat(64);

function record(
  value: string,
  environment: RegistryEnvironment,
  validity: RegistryValidity,
  mapFingerprint: string | null = currentMap,
): RegistryRecord {
  return {
    recordId: `record-${value}`,
    kind: 'ui-control',
    name: `Control ${value}`,
    value,
    scope: 'map',
    projectInstanceId,
    mapFingerprint,
    layerId: null,
    environment,
    validity,
    source: {
      kind: 'user-entry',
      relativePath: null,
      sha256: 'c'.repeat(64),
      observedAt: '2026-08-20T00:00:00.000Z',
      officialExtensionVersion: null,
      evidence: 'UNIT_E2E',
    },
    lastConfirmedAt: validity === 'confirmed' ? '2026-08-20T00:00:00.000Z' : null,
    notes: '',
  };
}

const registry: RegistryDocument = {
  schemaVersion: 1,
  records: [
    record('41001', 'test', 'confirmed'),
    record('41002', 'formal', 'suspected-change'),
    record('41003', 'formal', 'invalid'),
    record('41004', 'test', 'pending'),
    record('41005', 'formal', 'confirmed', 'b'.repeat(64)),
  ],
};

const api: ApiIndex = {
  schemaVersion: 1,
  officialExtensionVersion: '9.9.9-test',
  declarations: [{
    key: 'UI:colon:SetText',
    module: 'UI',
    name: 'SetText',
    callStyle: 'colon',
    description: 'Set text.',
    signature: 'UI:SetText(WidgetId, Text)',
    params: [
      { name: 'WidgetId', type: 'number', description: '' },
      { name: 'Text', type: 'string', description: '' },
    ],
    returns: [],
    officialExtensionVersion: '9.9.9-test',
    source: { relativePath: 'res/lib/UI.d.lua', sha256: 'd'.repeat(64) },
  }],
};

const uiSnapshot: UiSnapshot = {
  schemaVersion: 1,
  snapshotId: 'e'.repeat(64),
  createdAt: '2026-08-20T00:00:00.000Z',
  projectInstanceId,
  mapFingerprint: currentMap,
  sources: [],
  nodes: [
    { id: '70001', name: 'Repeated', type: 'unknown', parentId: null, path: '/A/Repeated', depth: 1, siblingIndex: 0, sourceFile: 'src/Data/CustomUIData2.lua', sourceRange: null },
    { id: '70001', name: 'Repeated', type: 'unknown', parentId: null, path: '/B/Repeated', depth: 1, siblingIndex: 0, sourceFile: 'src/Data/CustomUIData2.lua', sourceRange: null },
  ],
  duplicateNames: [{ name: 'Repeated', paths: ['/A/Repeated', '/B/Repeated'] }],
};

const status: InspectorStatus = {
  schemaVersion: 1,
  project: {
    schemaVersion: 1,
    projectInstanceId,
    projectRootHash: 'f'.repeat(64),
    hasSrc: true,
    hasGameEntry: true,
    mapFingerprint: currentMap,
    mapName: null,
    currentLayerId: null,
    layers: [],
  },
  officialCommands: {},
  link: { state: 'online', reasonCode: 'OK', lastProbeAt: null },
  ui: { freshness: 'stale', lastRefreshAt: null, sourceHashes: {}, reasonCodes: ['SNAPSHOT_EXPIRED'] },
  issueCounts: { error: 0, warning: 0, info: 0 },
};

function diagnostics() {
  const sourceIndex = buildLuaSourceIndex([{
    path: 'src/GameEntry.lua',
    source: [
      'local ordinaryNumber = 3',
      'UI:SetText(41001, "ok")',
      'UI:SetText(41002, "ok")',
      'UI:SetText(41003, "ok")',
      'UI:SetText(41004, "ok")',
      'UI:SetText(41005, "ok")',
      'UI:SetText(49999, "unregistered")',
      'UI:SetText(41001)',
      'UI:SetText(41001, 99)',
      'UI:Missing(41001)',
      'Unknown:Missing(41001)',
      'return ordinaryNumber',
      '',
    ].join('\n'),
  }], registry, {
    calls: [{ qualifiedName: 'UI:SetText', idParameterIndexes: [0] }],
    configuredIdFields: [],
  });
  return analyzeProject({
    sourceIndex,
    registry,
    apiIndex: api,
    uiSnapshot,
    status,
    projectInstanceId,
    mapFingerprint: currentMap,
  });
}

describe('project diagnostics', () => {
  it('keeps registry environment and validity orthogonal', () => {
    const results = diagnostics();
    expect(results).toContainEqual(expect.objectContaining({
      code: 'TEST_ID_REFERENCE',
      severity: 'info',
      registry: expect.objectContaining({ environment: 'test', validity: 'confirmed' }),
    }));
    expect(results.find((item) => item.code === 'TEST_ID_REFERENCE')?.message).not.toContain('正式');
    expect(results).toContainEqual(expect.objectContaining({
      code: 'SUSPECTED_ID_CHANGE',
      registry: expect.objectContaining({ environment: 'formal', validity: 'suspected-change' }),
    }));
    expect(results).toContainEqual(expect.objectContaining({ code: 'INVALID_ID_REFERENCE', severity: 'error' }));
    expect(results).toContainEqual(expect.objectContaining({ code: 'PENDING_ID_REFERENCE', severity: 'warning' }));
    expect(results).toContainEqual(expect.objectContaining({ code: 'CROSS_MAP_ID_REFERENCE', severity: 'error' }));
    expect(results).toContainEqual(expect.objectContaining({ code: 'UNREGISTERED_ID_REFERENCE', severity: 'warning' }));
  });

  it('checks only known official modules, argument count and confirmable literal types', () => {
    const results = diagnostics();
    expect(results).toContainEqual(expect.objectContaining({ code: 'UNKNOWN_OFFICIAL_API', message: expect.stringContaining('UI:Missing') }));
    expect(results.some((item) => item.code === 'UNKNOWN_OFFICIAL_API' && item.message.includes('Unknown:Missing'))).toBe(false);
    expect(results).toContainEqual(expect.objectContaining({ code: 'API_ARGUMENT_COUNT', severity: 'error' }));
    expect(results).toContainEqual(expect.objectContaining({ code: 'API_LITERAL_TYPE', severity: 'error' }));
  });

  it('accepts omission of trailing official varargs while still checking required arguments', () => {
    const variadicApi: ApiIndex = {
      schemaVersion: 2,
      officialExtensionVersion: '1.4.7-test',
      constants: [],
      enums: [],
      declarations: [
        {
          key: 'System:colon:RegisterEvent', module: 'System', name: 'RegisterEvent', callStyle: 'colon',
          description: 'Register event.', signature: 'System:RegisterEvent(EventName, Callback, ...)',
          params: [
            { name: 'EventName', type: 'string', description: '' },
            { name: 'Callback', type: 'function()', description: '' },
            { name: '...', type: 'any', description: '可变参数' },
          ],
          returns: [], officialExtensionVersion: '1.4.7-test',
          source: { relativePath: 'res/lib/System.d.lua', sha256: 'e'.repeat(64) },
        },
        {
          key: 'TimerManager:colon:AddFrame', module: 'TimerManager', name: 'AddFrame', callStyle: 'colon',
          description: 'Add frame timer.', signature: 'TimerManager:AddFrame(Delay, Callback, ...)',
          params: [
            { name: 'Delay', type: 'number', description: '' },
            { name: 'Callback', type: 'function()', description: '' },
            { name: '...', type: 'any', description: '可变参数' },
          ],
          returns: [], officialExtensionVersion: '1.4.7-test',
          source: { relativePath: 'res/lib/TimerManager.d.lua', sha256: 'f'.repeat(64) },
        },
      ],
    };
    const sourceIndex = buildLuaSourceIndex([{
      path: 'src/GameServer.lua',
      source: [
        'System:RegisterEvent(Events.ON_BEGIN_PLAY, function() end)',
        'System:RegisterEvent(Events.ON_BEGIN_PLAY, function() end, "extra", 2)',
        'TimerManager:AddFrame(5, function() end)',
        'TimerManager:AddFrame(5)',
      ].join('\n'),
    }], { schemaVersion: 1, records: [] }, { calls: [], configuredIdFields: [] });

    const results = analyzeProject({
      sourceIndex,
      registry: { schemaVersion: 1, records: [] },
      apiIndex: variadicApi,
      uiSnapshot: null,
      status: null,
      projectInstanceId,
      mapFingerprint: null,
    });

    expect(results.filter((item) => item.code === 'API_ARGUMENT_COUNT')).toEqual([
      expect.objectContaining({ message: expect.stringContaining('TimerManager:AddFrame'), severity: 'error' }),
    ]);
  });

  it('accepts omitted trailing parameters marked optional by official metadata', () => {
    const optionalApi: ApiIndex = {
      schemaVersion: 2,
      officialExtensionVersion: '1.4.7-test',
      constants: [],
      enums: [],
      declarations: [{
        key: 'System:colon:FireSignEvent', module: 'System', name: 'FireSignEvent', callStyle: 'colon',
        description: 'Fire signal.', signature: 'System:FireSignEvent(EventName, PlayerIDs)',
        params: [
          { name: 'EventName', type: 'string', description: '' },
          { name: 'PlayerIDs', type: 'number[]', description: '不传时只会在当前端触发', optional: true },
        ],
        returns: [], officialExtensionVersion: '1.4.7-test',
        source: { relativePath: 'res/lib/System.d.lua', sha256: 'e'.repeat(64) },
      }],
    };
    const sourceIndex = buildLuaSourceIndex([{
      path: 'src/GameClient.lua',
      source: 'System:FireSignEvent("收银指引")\n',
    }], { schemaVersion: 1, records: [] }, { calls: [], configuredIdFields: [] });

    const results = analyzeProject({
      sourceIndex,
      registry: { schemaVersion: 1, records: [] },
      apiIndex: optionalApi,
      uiSnapshot: null,
      status: null,
      projectInstanceId,
      mapFingerprint: null,
    });

    expect(results.filter((item) => item.code === 'API_ARGUMENT_COUNT')).toEqual([]);
  });

  it('reports duplicate UI data and stale evidence without treating arbitrary numbers as IDs', () => {
    const results = diagnostics();
    expect(results).toContainEqual(expect.objectContaining({ code: 'DUPLICATE_UI_NAME' }));
    expect(results).toContainEqual(expect.objectContaining({ code: 'DUPLICATE_UI_ID', severity: 'error' }));
    expect(results).toContainEqual(expect.objectContaining({ code: 'STALE_UI_SNAPSHOT' }));
    expect(results.some((item) => item.message.includes('ordinaryNumber') || item.message.includes(' 3'))).toBe(false);
    expect(results.every((item) => item.runtimeVerified === false)).toBe(true);
    expect(results.filter((item) => item.path !== null).every((item) => item.range !== null)).toBe(true);
  });

  it('does not demand scene-registry records for player and resource ID domains', () => {
    const sourceIndex = buildLuaSourceIndex([{
      path: 'src/GameServer.lua',
      source: 'TriggerBox:Contains(517)\nPlayer:Teleport(2001)\nProp:Use(3001)\n',
    }], { schemaVersion: 1, records: [] }, {
      calls: [
        { qualifiedName: 'TriggerBox:Contains', idParameterDomains: [{ parameterIndex: 0, domain: 'scene-instance' }] },
        { qualifiedName: 'Player:Teleport', idParameterDomains: [{ parameterIndex: 0, domain: 'player' }] },
        { qualifiedName: 'Prop:Use', idParameterDomains: [{ parameterIndex: 0, domain: 'prop' }] },
      ],
      configuredIdFields: [],
    });
    const results = analyzeProject({
      sourceIndex,
      registry: { schemaVersion: 1, records: [] },
      apiIndex: { ...api, declarations: [] },
      uiSnapshot: null,
      status: null,
      projectInstanceId,
      mapFingerprint: currentMap,
    });

    expect(results.filter((item) => item.code === 'UNREGISTERED_ID_REFERENCE')).toEqual([
      expect.objectContaining({ message: expect.stringContaining('517') }),
    ]);
  });
});
