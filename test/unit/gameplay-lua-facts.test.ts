import { describe, expect, it } from 'vitest';

import type { ResolvedEventMetadata } from '../../src/core/api/event-doc-index.js';
import { extractGameplayLuaFacts } from '../../src/core/gameplay/lua-facts.js';

function metadata(
  name: string,
  scope: ResolvedEventMetadata['scope'],
  parameterNames: string[] = [],
): ResolvedEventMetadata {
  return {
    name,
    description: '',
    scope,
    scopeRaw: null,
    callbackParameters: parameterNames.map((parameterName, index) => ({
      index, name: parameterName, typeText: 'unknown', description: '',
    })),
    callbackState: 'confirmed',
    registrationConstant: name,
    warnings: [],
    conflicts: [],
    source: { sourceId: 'fixture/Events.md', sha256: 'a'.repeat(64), lineStart: 1, lineEnd: 1 },
    availability: 'matched',
    declaration: null,
    generationEligibility: 'allowed',
  };
}

describe('gameplay Lua fact extraction', () => {
  it('extracts inline callbacks, state increments, emissions, timers, and observable calls', () => {
    const facts = extractGameplayLuaFacts({
      files: [{ path: 'src/Client/Feature.lua', source: [
        '---@ymai-side client',
        'System:RegisterEvent(Events.ON_CLICK, function(actorRef, itemRef)',
        '  State.count = State.count + 1',
        '  System:SendToServer(NetEvents.PURCHASE, { item = itemRef })',
        '  TimerManager:AddFrame(5, function()',
        '    System:SendToServer(NetEvents.RETRY, {})',
        '  end)',
        '  UI:Show(itemRef)',
        'end)',
      ].join('\n') }],
      eventMetadata: new Map([['ON_CLICK', metadata('ON_CLICK', 'client', ['actorRef', 'itemRef'])]]),
    });

    expect(facts.events).toHaveLength(1);
    expect(facts.events[0]).toMatchObject({
      event: 'Events.ON_CLICK',
      side: 'client',
      callbackParameters: ['actorRef', 'itemRef'],
      writes: [{ target: 'State.count', operation: 'add', value: 1, delay: null }],
      emits: [
        { event: 'NetEvents.PURCHASE', targetSide: 'server', routing: 'without-player', playerParameterIndex: null, delay: null },
        { event: 'NetEvents.RETRY', targetSide: 'server', routing: 'without-player', playerParameterIndex: null, delay: { unit: 'frames', value: 5 } },
      ],
    });
    expect(facts.events[0]!.observableCalls).toEqual([
      expect.objectContaining({ path: 'src/Client/Feature.lua', line: 8, kind: 'observable-call' }),
    ]);
    for (const evidence of facts.events[0]!.evidence) {
      expect(evidence.path).toBe('src/Client/Feature.lua');
      expect(evidence.line).toBeGreaterThan(0);
      expect(evidence.column).toBeGreaterThan(0);
    }
  });

  it('resolves a unique named callback and proves server and scene guards structurally', () => {
    const facts = extractGameplayLuaFacts({
      files: [{ path: 'src/Server/Feature.lua', source: [
        'local function OnEnter(actorRef, triggerRef)',
        '  if not System:IsServer() then return end',
        '  if triggerRef ~= 517 then return end',
        '  State.total = 10',
        'end',
        'System:RegisterEvent(Events.ON_CHARACTER_ENTER_SIGNAL_BOX, OnEnter)',
      ].join('\n') }],
      eventMetadata: new Map([[
        'ON_CHARACTER_ENTER_SIGNAL_BOX',
        metadata('ON_CHARACTER_ENTER_SIGNAL_BOX', 'both', ['actorRef', 'triggerRef']),
      ]]),
    });

    expect(facts.events).toEqual([
      expect.objectContaining({
        event: 'Events.ON_CHARACTER_ENTER_SIGNAL_BOX',
        side: 'server',
        callbackParameters: ['actorRef', 'triggerRef'],
        sceneInstanceGuards: ['517'],
        writes: [expect.objectContaining({ target: 'State.total', operation: 'set', value: 10 })],
      }),
    ]);
  });

  it('uses canonical Client and Server source folders as side evidence when event metadata is both-sided', () => {
    const clientFacts = extractGameplayLuaFacts({
      files: [{ path: 'src/Client/GameClient.lua', source: [
        'System:RegisterEvent(Events.ON_CHARACTER_ENTER_SIGNAL_BOX, function(playerId, signalBoxId)',
        '  UI:Show()',
        'end)',
      ].join('\n') }],
      eventMetadata: new Map([[
        'ON_CHARACTER_ENTER_SIGNAL_BOX',
        metadata('ON_CHARACTER_ENTER_SIGNAL_BOX', 'both', ['playerId', 'signalBoxId']),
      ]]),
    });
    expect(clientFacts.events[0]?.side).toBe('client');

    const conflictingFacts = extractGameplayLuaFacts({
      files: [{ path: 'src/Client/ServerOnly.lua', source: [
        'System:RegisterEvent(Events.ON_SERVER_ONLY, function()',
        '  UI:Show()',
        'end)',
      ].join('\n') }],
      eventMetadata: new Map([['ON_SERVER_ONLY', metadata('ON_SERVER_ONLY', 'server')]]),
    });
    expect(conflictingFacts.events[0]?.side).toBe('unknown');
    expect(conflictingFacts.unmodeled).toContainEqual(expect.objectContaining({ code: 'GAMEPLAY_SIDE_CONFLICT' }));
  });

  it('keeps duplicate registrations and marks conflicting side evidence unknown', () => {
    const facts = extractGameplayLuaFacts({
      files: [{ path: 'src/Feature.lua', source: [
        '---@ymai-side client',
        'System:RegisterEvent(Events.ON_SERVER_ONLY, function() UI:Show() end)',
        'System:RegisterEvent(Events.ON_SERVER_ONLY, function() UI:Hide() end)',
      ].join('\n') }],
      eventMetadata: new Map([['ON_SERVER_ONLY', metadata('ON_SERVER_ONLY', 'server')]]),
    });

    expect(facts.events).toHaveLength(2);
    expect(facts.events.every((fact) => fact.side === 'unknown')).toBe(true);
    expect(facts.unmodeled.filter((entry) => entry.code === 'GAMEPLAY_SIDE_CONFLICT')).toHaveLength(2);
    expect(facts.findings).toContainEqual(expect.objectContaining({
      code: 'GAMEPLAY_EVENT_REGISTRATION_DUPLICATE', severity: 'partial',
    }));
  });

  it('records dynamic events and callbacks without inventing handlers', () => {
    const facts = extractGameplayLuaFacts({
      files: [{ path: 'src/Feature.lua', source: [
        'local selectedEvent = Events.ON_CLICK',
        'local function Handler() end',
        'System:RegisterEvent(selectedEvent, Handler)',
        'System:RegisterEvent(Events.ON_CLICK, SelectHandler())',
      ].join('\n') }],
      eventMetadata: new Map([['ON_CLICK', metadata('ON_CLICK', 'client')]]),
    });

    expect(facts.events).toEqual([]);
    expect(facts.unmodeled.map((entry) => entry.code)).toEqual([
      'GAMEPLAY_DYNAMIC_EVENT_UNMODELED',
      'GAMEPLAY_DYNAMIC_CALLBACK_UNMODELED',
    ]);
  });

  it('retains timer evidence but does not model dynamic delay or callback effects', () => {
    const facts = extractGameplayLuaFacts({
      files: [{ path: 'src/Feature.lua', source: [
        'System:RegisterEvent(Events.ON_CLICK, function()',
        '  TimerManager:AddFrame(delayFrames, function()',
        '    System:SendToServer(NetEvents.UNKNOWN_DELAY, {})',
        '  end)',
        '  TimerManager:AddFrame(5, SelectTimerCallback())',
        'end)',
      ].join('\n') }],
      eventMetadata: new Map([['ON_CLICK', metadata('ON_CLICK', 'client')]]),
    });

    expect(facts.events[0]!.emits).toEqual([]);
    expect(facts.events[0]!.evidence.filter((entry) => entry.kind === 'timer')).toHaveLength(2);
    expect(facts.unmodeled.map((entry) => entry.code)).toEqual([
      'GAMEPLAY_DYNAMIC_TIMER_DELAY_UNMODELED',
      'GAMEPLAY_DYNAMIC_TIMER_CALLBACK_UNMODELED',
    ]);
  });

  it('bounds source input and never serializes an absolute source path into facts', () => {
    const facts = extractGameplayLuaFacts({
      files: [
        { path: 'C:/private/map/Feature.lua', source: 'System:RegisterEvent(Events.ON_CLICK, function() end)' },
        { path: 'src/Huge.lua', source: `--${'x'.repeat(4 * 1024 * 1024)}` },
      ],
      eventMetadata: new Map(),
    });

    expect(facts.events).toEqual([]);
    expect(facts.findings.map((finding) => finding.code)).toEqual([
      'GAMEPLAY_SOURCE_PATH_INVALID',
      'GAMEPLAY_LUA_LIMIT_EXCEEDED',
    ]);
    expect(JSON.stringify(facts)).not.toContain('C:/private/map');
  });
});
