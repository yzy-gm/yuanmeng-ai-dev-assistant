import { describe, expect, it } from 'vitest';

import type { ResolvedEventMetadata } from '../../src/core/api/event-doc-index.js';
import { autoPrepareGameplay } from '../../src/core/gameplay/auto-prepare.js';
import { reviewGameplayModel } from '../../src/core/gameplay/model.js';
import { buildLuaSourceIndex, type LuaSourceFile, type LuaSourceIndex } from '../../src/core/lua/source-index.js';
import type { RegistryDocument } from '../../src/core/model.js';
import type { SceneSnapshot } from '../../src/core/scene/types.js';

const registry: RegistryDocument = { schemaVersion: 1, records: [] };
const api = { calls: [], configuredIdFields: [] };
const project = {
  projectInstanceId: '22222222-2222-4222-8222-222222222222',
  mapFingerprint: null,
  sceneSnapshotId: 'b'.repeat(64),
  knowledgeFingerprint: 'a'.repeat(64),
};

function metadata(name: string, scope: ResolvedEventMetadata['scope']): ResolvedEventMetadata {
  return {
    name, description: '', scope, scopeRaw: null, callbackParameters: [], callbackState: 'confirmed',
    registrationConstant: name, warnings: [], conflicts: [],
    source: { sourceId: 'fixture/Events.md', sha256: 'c'.repeat(64), lineStart: 1, lineEnd: 1 },
    availability: 'matched', declaration: null, generationEligibility: 'allowed',
  };
}

function triggerScene(ids: string[]): SceneSnapshot {
  const evidence = { state: 'confirmed-calibration' as const, source: 'anonymous-auto-fixture', confidence: 1 };
  return {
    schemaVersion: 1,
    snapshotId: 'b'.repeat(64),
    bindingId: 'binding',
    role: 'raw-pbin',
    sourceSha256: 'd'.repeat(64),
    observedAt: '2026-08-26T00:00:00.000Z',
    adapterId: 'ym-layerdata-observed-v6',
    instances: ids.map((instanceId) => ({
      instanceId,
      elementTypeId: '1105000000000087',
      ownerId: null,
      variant: 'component6-oneof-1' as const,
      evidence,
      transform: { state: 'absent' as const },
      customProperties: { state: 'absent' as const },
      signals: { state: 'absent' as const },
      resources: { state: 'absent' as const },
      bounds: { state: 'absent' as const },
      unknownFields: [],
    })),
    groups: [], issues: [], unknownFields: [],
  };
}

function prepare(
  luaFiles: LuaSourceFile[],
  eventMetadata: ReadonlyMap<string, ResolvedEventMetadata>,
  sceneSnapshot: SceneSnapshot,
  sourceIndex: LuaSourceIndex = buildLuaSourceIndex(luaFiles, registry, api),
) {
  return autoPrepareGameplay({
    project,
    luaFiles,
    productionSourceIndex: sourceIndex,
    eventMetadata,
    registry,
    uiSnapshot: null,
    sceneSnapshot,
    runtimeCapabilities: new Map(),
  });
}

describe('automatic gameplay preparation', () => {
  it('does not bind 43 unrelated trigger boxes and generates only nonempty 1/2-player scenarios', () => {
    const luaFiles = [{
      path: 'src/GameEntry.lua',
      source: [
        '---@ymai-side server',
        'System:RegisterEvent(Events.ON_BEGIN_PLAY, function()',
        '  UI:Show()',
        'end)',
      ].join('\n'),
    }];
    const prepared = prepare(luaFiles, new Map([['ON_BEGIN_PLAY', metadata('ON_BEGIN_PLAY', 'server')]]),
      triggerScene(Array.from({ length: 43 }, (_, index) => String(500 + index))));

    expect(prepared.model.sceneEventBindings ?? []).toEqual([]);
    expect(prepared.model.handlers).toHaveLength(1);
    expect(prepared.scenarios.length).toBeGreaterThanOrEqual(4);
    expect(prepared.scenarios.every((scenario) => scenario.steps.length > 0)).toBe(true);
    expect(new Set(prepared.scenarios.flatMap((scenario) => scenario.players.length))).toEqual(new Set([1, 2, 4, 8]));
    expect(prepared.scenarios.map((scenario) => scenario.scenarioId).join(' ')).toMatch(/single.*duplicate.*interleav.*rejoin/u);
    expect(prepared.findings.some((finding) => finding.severity === 'fatal')).toBe(false);
  });

  it('keeps the automatic observation marker local to a client handler', () => {
    const luaFiles: LuaSourceFile[] = [
      { path: 'src/GameEntry.lua', source: 'return require("Client.GameClient")' },
      {
        path: 'src/Client/GameClient.lua',
        source: [
          'System:RegisterEvent(Events.ON_TOUCH_SCREEN_PRESSED, function(x, y)',
          '  UI:Show()',
          'end)',
        ].join('\n'),
      },
    ];
    const prepared = prepare(
      luaFiles,
      new Map([['ON_TOUCH_SCREEN_PRESSED', metadata('ON_TOUCH_SCREEN_PRESSED', 'client')]]),
      triggerScene([]),
    );

    expect(prepared.model.handlers).toContainEqual(expect.objectContaining({
      event: 'Events.ON_TOUCH_SCREEN_PRESSED',
      side: 'client',
    }));
    expect(reviewGameplayModel(prepared.model)).not.toContainEqual(expect.objectContaining({
      code: 'CLIENT_WRITES_SERVER_STATE', severity: 'error',
    }));
    expect(prepared.scenarios.length).toBeGreaterThan(0);
  });

  it('adds a root-event scenario for a statically provable emitted event chain', () => {
    const luaFiles = [{
      path: 'src/GameEntry.lua',
      source: [
        '---@ymai-side server',
        'System:RegisterEvent("CHAIN_START", function() System:SendToServer("CHAIN_NEXT", {}) end)',
        'System:RegisterEvent("CHAIN_NEXT", function() UI:Show() end)',
      ].join('\n'),
    }];
    const prepared = prepare(luaFiles, new Map(), triggerScene([]));
    expect(prepared.model.handlers).toHaveLength(2);
    expect(prepared.scenarios).toContainEqual(expect.objectContaining({
      scenarioId: expect.stringMatching(/^auto-chain-/u),
      name: expect.stringContaining('事件链路'),
      steps: [expect.objectContaining({ kind: 'dispatch', event: 'CHAIN_START' })],
    }));
  });

  it('does not turn configuration ID references into automatic event-binding obligations', () => {
    const luaFiles: LuaSourceFile[] = [{
      path: 'src/GameEntry.lua',
      source: [
        '---@ymai-side server',
        'System:RegisterEvent(Events.ON_BEGIN_PLAY, function()',
        '  UI:Show()',
        'end)',
        'Element:SetPosition(517, { X = 0 }, Element.COORDINATE.World)',
      ].join('\n'),
    }];
    const sourceIndex = buildLuaSourceIndex(luaFiles, registry, {
      calls: [{
        qualifiedName: 'Element:SetPosition',
        idParameterDomains: [{ parameterIndex: 0, domain: 'scene-instance' }],
      }],
      configuredIdFields: [],
    });
    const prepared = prepare(
      luaFiles,
      new Map([['ON_BEGIN_PLAY', metadata('ON_BEGIN_PLAY', 'server')]]),
      triggerScene(['517']),
      sourceIndex,
    );

    expect(prepared.model.sceneEventBindings ?? []).toEqual([]);
    expect(prepared.findings).not.toContainEqual(expect.objectContaining({
      code: 'GAMEPLAY_RELEVANT_TRIGGER_UNMODELED',
    }));
    expect(prepared.scenarios.length).toBeGreaterThan(0);
  });

  it('creates a complete event-bound contract only for an explicitly guarded trigger', () => {
    const luaFiles = [{
      path: 'src/GameEntry.lua',
      source: [
        '---@ymai-side server',
        'System:RegisterEvent(Events.ON_CHARACTER_ENTER_SIGNAL_BOX, function(actorRef, triggerRef)',
        '  if triggerRef ~= 517 then return end',
        '  UI:Show()',
        'end)',
      ].join('\n'),
    }];
    const prepared = prepare(luaFiles, new Map([[
      'ON_CHARACTER_ENTER_SIGNAL_BOX', metadata('ON_CHARACTER_ENTER_SIGNAL_BOX', 'both'),
    ]]), triggerScene(['517', '518']));

    expect(prepared.model.sceneEventBindings).toEqual([{
      instanceId: '517',
      status: 'event-bound',
      interaction: 'character-enter-trigger',
      eventName: 'Events.ON_CHARACTER_ENTER_SIGNAL_BOX',
      handlerId: prepared.model.handlers[0]!.handlerId,
    }]);
    expect(prepared.model.sceneEventBindings).not.toContainEqual(expect.objectContaining({ instanceId: '518' }));
  });

  it('makes an unmodeled sole trigger flow fatal but skips it when an independent flow remains', () => {
    const trigger: LuaSourceFile = {
      path: 'src/Trigger.lua',
      source: [
        'System:RegisterEvent(Events.ON_CHARACTER_ENTER_SIGNAL_BOX, function(actorRef, triggerRef)',
        '  if triggerRef ~= 517 then return end',
        '  UI:Show()',
        'end)',
      ].join('\n'),
    };
    const soleFiles: LuaSourceFile[] = [
      { path: 'src/GameEntry.lua', source: 'return require("Trigger")' },
      trigger,
    ];
    const events = new Map([[
      'ON_CHARACTER_ENTER_SIGNAL_BOX', metadata('ON_CHARACTER_ENTER_SIGNAL_BOX', 'both'),
    ]]);
    const sole = prepare(soleFiles, events, triggerScene(['517']));
    expect(sole.findings).toContainEqual(expect.objectContaining({
      code: 'GAMEPLAY_RELEVANT_TRIGGER_UNMODELED', severity: 'fatal',
    }));
    expect(sole.scenarios).toEqual([]);

    const independentFiles: LuaSourceFile[] = [
      { path: 'src/GameEntry.lua', source: 'require("Trigger")\nreturn require("Other")' },
      trigger,
      {
        path: 'src/Other.lua',
        source: '---@ymai-side server\nSystem:RegisterEvent(Events.ON_BEGIN_PLAY, function() UI:Show() end)',
      },
    ];
    const independent = prepare(independentFiles, new Map([
      ...events,
      ['ON_BEGIN_PLAY', metadata('ON_BEGIN_PLAY', 'server')],
    ]), triggerScene(['517']));
    expect(independent.findings).toContainEqual(expect.objectContaining({
      code: 'GAMEPLAY_RELEVANT_TRIGGER_UNMODELED', severity: 'partial',
    }));
    expect(independent.skippedFlows).toContainEqual(expect.objectContaining({
      reasonCode: 'GAMEPLAY_RELEVANT_TRIGGER_UNMODELED', needsEditor: true,
    }));
    expect(independent.scenarios.every((scenario) => scenario.steps.length > 0)).toBe(true);
  });
});
