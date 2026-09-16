import { describe, expect, it } from 'vitest';

import { runGameplayMultiplayerMatrix, runGameplayScenario } from '../../src/core/gameplay/simulator.js';
import { gameplayModelFingerprint } from '../../src/core/gameplay/model.js';
import type { GameplayModel, GameplayScenario } from '../../src/core/gameplay/types.js';

const shared = (path: string) => ({ scope: 'shared' as const, path });
const player = (path: string) => ({ scope: 'player' as const, path });
const client = (path: string) => ({ scope: 'client' as const, path });

function baseModel(): GameplayModel {
  return {
    schemaVersion: 1,
    modelId: 'routing-model',
    project: { projectInstanceId: '00000000-0000-4000-8000-000000000001', mapFingerprint: null, sceneSnapshotId: null, knowledgeFingerprint: 'c'.repeat(64) },
    externalEvents: [],
    initialState: { shared: { c: 0, bSawC: -1 }, player: { rewards: 0 }, client: { notices: 0 } },
    handlers: [],
    invariants: [],
    evidenceRequirements: [],
    multiplayer: { maximumPlayers: 8, rejoinPolicy: 'retain-player-reset-client' },
  };
}

function scenario(inputModel: GameplayModel, players: string[], steps: GameplayScenario['steps']): GameplayScenario {
  return {
    schemaVersion: 1,
    scenarioId: 'routing-scenario',
    name: 'routing',
    modelBinding: { modelId: inputModel.modelId, modelFingerprint: gameplayModelFingerprint(inputModel), ...inputModel.project },
    players,
    limits: { maxEvents: 100, maxVirtualMilliseconds: 10_000, maxVisitedStates: 100, maxBranches: 100 },
    steps,
  };
}

describe('gameplay event routing', () => {
  it('delivers an envelope only to its declared target side when both sides listen to the same event', () => {
    const model = baseModel();
    model.externalEvents.push('same.event');
    model.eventPolicies = [{
      event: 'same.event', authority: 'server-only', targetSide: 'server', playerRequired: true, duplicatePolicy: 'allow', observableEffectRequired: true,
    }];
    model.handlers.push(
      { handlerId: 'server-same', event: 'same.event', side: 'server', branches: [{ branchId: 'server', effects: [{ kind: 'add', target: player('rewards'), value: { kind: 'literal', value: 1 } }] }] },
      { handlerId: 'client-same', event: 'same.event', side: 'client', branches: [{ branchId: 'client', effects: [{ kind: 'add', target: client('notices'), value: { kind: 'literal', value: 1 } }] }] },
    );
    const result = runGameplayScenario(model, scenario(model, ['p1', 'p2'], [
      { kind: 'dispatch', event: 'same.event', source: 'server', playerId: 'p1' },
    ]));
    expect(result.status).toBe('pass');
    expect(result.finalState.players.p1?.rewards).toBe(1);
    expect(result.finalState.clients.p1?.notices).toBe(0);
    expect(result.trace[0]).toMatchObject({ source: 'server', targetSide: 'server' });
  });

  it('queues every selected parallel action before draining zero-delay child events', () => {
    const model = baseModel();
    model.externalEvents.push('A', 'B');
    model.eventPolicies = [
      { event: 'A', authority: 'server-only', playerRequired: true, duplicatePolicy: 'allow', targetSide: 'server', observableEffectRequired: true },
      { event: 'B', authority: 'server-only', playerRequired: true, duplicatePolicy: 'allow', targetSide: 'server', observableEffectRequired: true },
      { event: 'C', authority: 'server-only', playerRequired: true, duplicatePolicy: 'allow', targetSide: 'server', observableEffectRequired: true },
    ];
    model.handlers.push(
      { handlerId: 'A', event: 'A', side: 'server', branches: [{ branchId: 'emit-c', effects: [{ kind: 'emit', event: 'C', delayMilliseconds: 0, targetSide: 'server' }] }] },
      {
        handlerId: 'B', event: 'B', side: 'server', branches: [
          { branchId: 'before-c', when: { kind: 'compare', operator: 'eq', left: { kind: 'read', ref: shared('c') }, right: { kind: 'literal', value: 0 } }, effects: [{ kind: 'set', target: shared('bSawC'), value: { kind: 'literal', value: 0 } }] },
          { branchId: 'after-c', effects: [{ kind: 'set', target: shared('bSawC'), value: { kind: 'literal', value: 1 } }] },
        ],
      },
      { handlerId: 'C', event: 'C', side: 'server', branches: [{ branchId: 'set', effects: [{ kind: 'set', target: shared('c'), value: { kind: 'literal', value: 1 } }] }] },
    );
    const matrix = runGameplayMultiplayerMatrix(model, { ...scenario(model, ['p1', 'p2'], [{
      kind: 'parallel', exploreInterleavings: true,
      actions: [{ event: 'A', source: 'server', targetSide: 'server', playerId: 'p1' }, { event: 'B', source: 'server', targetSide: 'server', playerId: 'p2' }],
    }]), exploreReadyEventInterleavings: true });
    expect(matrix.schedulesExplored).toBe(3);
    expect(new Set(matrix.schedules.map((entry) => entry.result.finalState.shared.bSawC))).toEqual(new Set([0, 1]));
    expect(matrix.schedules.some((entry) => entry.result.trace.map((trace) => trace.event).join(',') === 'A,B,C')).toBe(true);
    expect(matrix.schedules.some((entry) => entry.result.trace.map((trace) => trace.event).join(',') === 'A,C,B')).toBe(true);
    expect(matrix.schedules.some((entry) => entry.result.readyInterleavings.branchWidths.length > 0)).toBe(true);
  });

  it('blocks undeclared participants and checks invariants before any event', () => {
    const model = baseModel();
    model.initialState.player.rewards = -1;
    model.invariants.push({ invariantId: 'rewards-non-negative', kind: 'non-negative', ref: player('rewards') });
    const undeclared = runGameplayScenario(model, scenario(model, ['p1', 'p2'], [{ kind: 'join', playerId: 'p3' }]));
    expect(undeclared.status).toBe('blocked');
    const initial = runGameplayScenario(model, scenario(model, ['p1', 'p2'], []));
    expect(initial.status).toBe('fail');
    expect(initial.failures).toContainEqual(expect.objectContaining({ code: 'INVARIANT_FAILED', stepIndex: -1 }));
  });

  it('does not let an unauthorized delivery poison the deduplication key for a later legal retry', () => {
    const model = baseModel();
    model.externalEvents.push('reward');
    model.eventPolicies = [{
      event: 'reward', authority: 'server-only', targetSide: 'server', playerRequired: true, duplicatePolicy: 'must-be-idempotent', observableEffectRequired: true,
    }];
    model.handlers.push({ handlerId: 'reward', event: 'reward', side: 'server', branches: [{
      branchId: 'grant', effects: [{ kind: 'add', target: player('rewards'), value: { kind: 'literal', value: 1 } }],
    }] });
    const result = runGameplayScenario(model, scenario(model, ['p1', 'p2'], [
      { kind: 'dispatch', event: 'reward', source: 'client', targetSide: 'server', playerId: 'p1', deliveryId: 'retry' },
      { kind: 'dispatch', event: 'reward', source: 'server', targetSide: 'server', playerId: 'p1', deliveryId: 'retry' },
    ]));
    expect(result.finalState.players.p1?.rewards).toBe(1);
    expect(result.failures).toContainEqual(expect.objectContaining({ code: 'UNAUTHORIZED_EVENT_SOURCE', stepIndex: 0 }));
    expect(result.failures).not.toContainEqual(expect.objectContaining({ code: 'DUPLICATE_EVENT_CHANGED_STATE', stepIndex: 1 }));
  });

  it('rejects a routed target without a handler and an observable-required no-op branch', () => {
    const model = baseModel();
    model.externalEvents.push('start', 'click');
    model.eventPolicies = [
      { event: 'start', authority: 'server-only', playerRequired: true, duplicatePolicy: 'allow', targetSide: 'server', observableEffectRequired: true },
      { event: 'click', authority: 'client-request', playerRequired: true, duplicatePolicy: 'allow', targetSide: 'client', observableEffectRequired: true },
    ];
    model.handlers.push(
      { handlerId: 'start', event: 'start', side: 'server', branches: [{ branchId: 'emit-dead', effects: [{ kind: 'emit', event: 'dead.client', delayMilliseconds: 0, targetSide: 'client' }] }] },
      { handlerId: 'click', event: 'click', side: 'client', branches: [{ branchId: 'no-result', effects: [] }] },
    );
    const result = runGameplayScenario(model, scenario(model, ['p1', 'p2'], [
      { kind: 'dispatch', event: 'start', source: 'server', playerId: 'p1' },
      { kind: 'dispatch', event: 'click', source: 'client', playerId: 'p1' },
    ]));
    expect(result.failures).toContainEqual(expect.objectContaining({ code: 'NO_HANDLER_FOR_TARGET' }));
    expect(result.failures).toContainEqual(expect.objectContaining({ code: 'NO_OBSERVABLE_EFFECT' }));
  });

  it('rejects a repeated join and a scenario bound to another model snapshot', () => {
    const model = baseModel();
    const repeatedJoin = runGameplayScenario(model, scenario(model, ['p1', 'p2'], [{ kind: 'join', playerId: 'p1' }]));
    expect(repeatedJoin.failures).toContainEqual(expect.objectContaining({ code: 'PLAYER_ALREADY_CONNECTED' }));

    const stale = scenario(model, ['p1'], []);
    stale.modelBinding = { ...stale.modelBinding, sceneSnapshotId: 'f'.repeat(64) };
    const mismatch = runGameplayScenario(model, stale);
    expect(mismatch.status).toBe('blocked');
    expect(mismatch.staticFindings).toContainEqual(expect.objectContaining({ code: 'SCENARIO_MODEL_BINDING_MISMATCH' }));
  });

  it('explores a second ready-event decision while retaining the default choice at the first decision', () => {
    const model = baseModel();
    model.externalEvents = ['root'];
    model.eventPolicies = ['root', 'A', 'B', 'C'].map((event) => ({
      event, authority: 'server-only' as const, playerRequired: true, duplicatePolicy: 'allow' as const,
      targetSide: 'server' as const, observableEffectRequired: true,
    }));
    model.handlers = [
      { handlerId: 'root', event: 'root', side: 'server', branches: [{ branchId: 'fanout', effects: [
        { kind: 'emit', event: 'A', delayMilliseconds: 0, targetSide: 'server' },
        { kind: 'emit', event: 'B', delayMilliseconds: 0, targetSide: 'server' },
      ] }] },
      { handlerId: 'A', event: 'A', side: 'server', branches: [{ branchId: 'emit-c', effects: [{ kind: 'emit', event: 'C', delayMilliseconds: 0, targetSide: 'server' }] }] },
      { handlerId: 'B', event: 'B', side: 'server', branches: [
        { branchId: 'before-c', when: { kind: 'compare', operator: 'eq', left: { kind: 'read', ref: shared('c') }, right: { kind: 'literal', value: 0 } }, effects: [{ kind: 'set', target: shared('bSawC'), value: { kind: 'literal', value: 0 } }] },
        { branchId: 'after-c', effects: [{ kind: 'set', target: shared('bSawC'), value: { kind: 'literal', value: 1 } }] },
      ] },
      { handlerId: 'C', event: 'C', side: 'server', branches: [{ branchId: 'set', effects: [{ kind: 'set', target: shared('c'), value: { kind: 'literal', value: 1 } }] }] },
    ];
    const matrix = runGameplayMultiplayerMatrix(model, { ...scenario(model, ['p1', 'p2'], [
      { kind: 'dispatch', event: 'root', source: 'server', playerId: 'p1' },
    ]), exploreReadyEventInterleavings: true });
    expect(matrix.schedulesExplored).toBe(3);
    expect(matrix.schedules.some((entry) => entry.result.readyInterleavings.choices.join(',') === '0,1')).toBe(true);
    expect(new Set(matrix.schedules.map((entry) => entry.result.trace.map((trace) => trace.event).join(',')))).toEqual(new Set([
      'root,A,B,C', 'root,A,C,B', 'root,B,A,C',
    ]));
  });

  it('blocks scenario target-side overrides and explores both policy-declared target sides', () => {
    const model = baseModel();
    model.externalEvents = ['dual'];
    model.eventPolicies = [{
      event: 'dual', authority: 'server-only', playerRequired: true, duplicatePolicy: 'allow', targetSide: 'both', observableEffectRequired: true,
    }];
    model.handlers = [
      { handlerId: 'dual-server', event: 'dual', side: 'server', branches: [{ branchId: 'server', effects: [{ kind: 'add', target: player('rewards'), value: { kind: 'literal', value: 1 } }] }] },
      { handlerId: 'dual-client', event: 'dual', side: 'client', branches: [{ branchId: 'client', effects: [{ kind: 'add', target: client('notices'), value: { kind: 'literal', value: 1 } }] }] },
    ];
    const overridden = runGameplayScenario(model, scenario(model, ['p1'], [
      { kind: 'dispatch', event: 'dual', source: 'server', playerId: 'p1', targetSide: 'client' },
    ]));
    expect(overridden.status).toBe('blocked');
    expect(overridden.staticFindings).toContainEqual(expect.objectContaining({ code: 'SCENARIO_TARGET_POLICY_CONFLICT' }));

    const matrix = runGameplayMultiplayerMatrix(model, { ...scenario(model, ['p1'], [
      { kind: 'dispatch', event: 'dual', source: 'server', playerId: 'p1' },
    ]), exploreReadyEventInterleavings: true });
    expect(matrix.schedulesExplored).toBe(2);
    expect(new Set(matrix.schedules.map((entry) => entry.result.trace.map((trace) => trace.targetSide).join(',')))).toEqual(new Set(['server,client', 'client,server']));
  });
});
