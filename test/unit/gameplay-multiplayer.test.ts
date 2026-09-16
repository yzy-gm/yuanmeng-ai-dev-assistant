import { describe, expect, it } from 'vitest';

import { gameplayModelFingerprint, reviewGameplayModel } from '../../src/core/gameplay/model.js';
import { runGameplayMultiplayerMatrix, runGameplayPopulationMatrix, runGameplayScenario } from '../../src/core/gameplay/simulator.js';
import type { GameplayModel, GameplayScenario } from '../../src/core/gameplay/types.js';

const playerRef = (path: string, playerId?: string) => ({ scope: 'player' as const, path, ...(playerId === undefined ? {} : { playerId }) });
const clientRef = (path: string, playerId?: string) => ({ scope: 'client' as const, path, ...(playerId === undefined ? {} : { playerId }) });
const sharedRef = (path: string) => ({ scope: 'shared' as const, path });

function competitiveStockModel(): GameplayModel {
  return {
    schemaVersion: 1,
    modelId: 'multiplayer-stock-v1',
    project: { projectInstanceId: '00000000-0000-4000-8000-000000000001', mapFingerprint: null, sceneSnapshotId: null, knowledgeFingerprint: 'c'.repeat(64) },
    externalEvents: ['buy', 'announce'],
    eventPolicies: [
      { event: 'buy', authority: 'server-only', playerRequired: true, duplicatePolicy: 'allow', targetSide: 'server', observableEffectRequired: true },
      { event: 'announce', authority: 'server-only', playerRequired: true, duplicatePolicy: 'allow', targetSide: 'server', observableEffectRequired: true },
      { event: 'notice', authority: 'server-only', playerRequired: true, duplicatePolicy: 'allow', targetSide: 'client', observableEffectRequired: true },
    ],
    initialState: { shared: { stock: 1 }, player: { goods: 0, lastBuyResult: 'idle' }, client: { notices: 0 } },
    handlers: [
      {
        handlerId: 'buy', event: 'buy', side: 'server', branches: [
          {
            branchId: 'won',
            when: { kind: 'compare', operator: 'gt', left: { kind: 'read', ref: sharedRef('stock') }, right: { kind: 'literal', value: 0 } },
            effects: [
              { kind: 'add', target: sharedRef('stock'), value: { kind: 'literal', value: -1 } },
              { kind: 'add', target: playerRef('goods'), value: { kind: 'literal', value: 1 } },
              { kind: 'set', target: playerRef('lastBuyResult'), value: { kind: 'literal', value: 'won' } },
            ],
          },
          { branchId: 'sold-out', effects: [{ kind: 'set', target: playerRef('lastBuyResult'), value: { kind: 'literal', value: 'sold-out' } }] },
        ],
      },
      {
        handlerId: 'announce', event: 'announce', side: 'server', branches: [{
          branchId: 'broadcast', effects: [{ kind: 'emit', event: 'notice', delayMilliseconds: 0, routing: 'broadcast' }],
        }],
      },
      {
        handlerId: 'notice', event: 'notice', side: 'client', branches: [{
          branchId: 'local', effects: [{ kind: 'add', target: clientRef('notices'), value: { kind: 'literal', value: 1 } }],
        }],
      },
    ],
    invariants: [
      { invariantId: 'stock-non-negative', kind: 'non-negative', ref: sharedRef('stock') },
      { invariantId: 'goods-non-negative', kind: 'non-negative', ref: playerRef('goods') },
    ],
    evidenceRequirements: [],
    multiplayer: { maximumPlayers: 8, rejoinPolicy: 'retain-player-reset-client' },
  };
}

function multiplayerScenario(steps: GameplayScenario['steps'], inputModel = competitiveStockModel()): GameplayScenario {
  return {
    schemaVersion: 1,
    scenarioId: 'multiplayer-race',
    name: '多人库存竞争',
    modelBinding: { modelId: inputModel.modelId, modelFingerprint: gameplayModelFingerprint(inputModel), ...inputModel.project },
    players: ['p1', 'p2'],
    limits: { maxEvents: 100, maxVirtualMilliseconds: 10_000, maxVisitedStates: 100, maxBranches: 100 },
    steps,
  };
}

describe('multiplayer-first gameplay simulation', () => {
  it('explores both same-frame purchase orders without cross-player contamination or negative stock', () => {
    const matrix = runGameplayMultiplayerMatrix(competitiveStockModel(), multiplayerScenario([{
      kind: 'parallel',
      exploreInterleavings: true,
      actions: [{ event: 'buy', playerId: 'p1' }, { event: 'buy', playerId: 'p2' }],
    }]));
    expect(matrix.status).toBe('pass');
    expect(matrix.schedulesExplored).toBe(2);
    expect(matrix.schedules.map((schedule) => schedule.result.finalState.shared.stock)).toEqual([0, 0]);
    for (const schedule of matrix.schedules) {
      const goods = [schedule.result.finalState.players.p1?.goods, schedule.result.finalState.players.p2?.goods];
      expect(goods.sort()).toEqual([0, 1]);
      expect(schedule.result.failures).toEqual([]);
    }
  });

  it('broadcasts client-local results to connected players and never shares the client state object', () => {
    const result = runGameplayScenario(competitiveStockModel(), multiplayerScenario([
      { kind: 'dispatch', event: 'announce', playerId: 'p1' },
      { kind: 'expect', ref: clientRef('notices', 'p1'), operator: 'eq', value: 1 },
      { kind: 'expect', ref: clientRef('notices', 'p2'), operator: 'eq', value: 1 },
    ]));
    expect(result.status).toBe('pass');
    expect(result.finalState.clients.p1).not.toBe(result.finalState.clients.p2);
  });

  it('blocks a hard-coded client write to another player', () => {
    const model = competitiveStockModel();
    model.handlers.push({
      handlerId: 'leak', event: 'leak', side: 'client', branches: [{
        branchId: 'write-p2', effects: [{ kind: 'set', target: clientRef('notices', 'p2'), value: { kind: 'literal', value: 99 } }],
      }],
    });
    expect(reviewGameplayModel(model)).toContainEqual(expect.objectContaining({
      code: 'HARDCODED_CROSS_PLAYER_TARGET', severity: 'error',
    }));
  });

  it('blocks a server handler from directly writing client-local state', () => {
    const model = competitiveStockModel();
    model.handlers.push({
      handlerId: 'server-ui-leak', event: 'server.ui.leak', side: 'server', branches: [{
        branchId: 'write-client', effects: [{ kind: 'set', target: clientRef('notices'), value: { kind: 'literal', value: 1 } }],
      }],
    });
    expect(reviewGameplayModel(model)).toContainEqual(expect.objectContaining({
      code: 'SERVER_WRITES_CLIENT_STATE', severity: 'error',
    }));
  });

  it('never treats a client-side cross-player write as authorized even when the model sets the server-only override flag', () => {
    const model = competitiveStockModel();
    model.handlers.push({
      handlerId: 'client-forged-authorization', event: 'client.leak', side: 'client', branches: [{
        branchId: 'write-p2', effects: [{
          kind: 'set', target: clientRef('notices', 'p2'), value: { kind: 'literal', value: 99 }, allowCrossPlayer: true,
        }],
      }],
    });
    expect(reviewGameplayModel(model)).toContainEqual(expect.objectContaining({
      code: 'CLIENT_CROSS_PLAYER_AUTHORITY_INVALID', severity: 'error',
    }));
  });

  it('rejects actions from a disconnected player and resets only client-local state on rejoin', () => {
    const result = runGameplayScenario(competitiveStockModel(), multiplayerScenario([
      { kind: 'dispatch', event: 'buy', playerId: 'p1' },
      { kind: 'leave', playerId: 'p1' },
      { kind: 'dispatch', event: 'buy', playerId: 'p1' },
      { kind: 'join', playerId: 'p1' },
      { kind: 'expect', ref: playerRef('goods', 'p1'), operator: 'eq', value: 1 },
      { kind: 'expect', ref: clientRef('notices', 'p1'), operator: 'eq', value: 0 },
    ]));
    expect(result.status).toBe('fail');
    expect(result.failures).toContainEqual(expect.objectContaining({ code: 'PLAYER_NOT_CONNECTED', stepIndex: 2 }));
    expect(result.finalState.connections.p1).toBe('connected');
  });

  it('supports an eight-player isolation baseline', () => {
    const players = Array.from({ length: 8 }, (_, index) => `p${index + 1}`);
    const scenario: GameplayScenario = {
      ...multiplayerScenario([]),
      scenarioId: 'eight-player-isolation',
      players,
      steps: [{ kind: 'dispatch', event: 'buy', playerId: 'p8' }],
    };
    const result = runGameplayScenario(competitiveStockModel(), scenario);
    expect(result.status).toBe('pass');
    expect(result.finalState.players.p8?.goods).toBe(1);
    expect(players.slice(0, 7).every((playerId) => result.finalState.players[playerId]?.goods === 0)).toBe(true);
  });

  it('models a participant pool with a genuinely disconnected player who joins mid-match', () => {
    const input: GameplayScenario = {
      ...multiplayerScenario([]),
      players: ['p1', 'p2', 'p3'],
      initialConnectedPlayers: ['p1', 'p2'],
      steps: [
        { kind: 'join', playerId: 'p3' },
        { kind: 'dispatch', event: 'buy', source: 'server', playerId: 'p3' },
      ],
    };
    const result = runGameplayScenario(competitiveStockModel(), input);
    expect(result.status).toBe('pass');
    expect(result.finalState.connections.p3).toBe('connected');
    expect(result.finalState.players.p3?.goods).toBe(1);
  });

  it('rejects a timer callback from an earlier connection epoch after leave and rejoin', () => {
    const model = competitiveStockModel();
    model.externalEvents.push('timer.start');
    model.eventPolicies?.push(
      { event: 'timer.start', authority: 'server-only', playerRequired: true, duplicatePolicy: 'allow', targetSide: 'server', observableEffectRequired: true },
      { event: 'timer.done', authority: 'server-only', playerRequired: true, duplicatePolicy: 'allow', targetSide: 'client', observableEffectRequired: true },
    );
    model.handlers.push(
      {
        handlerId: 'timer-start', event: 'timer.start', side: 'server', branches: [{
          branchId: 'schedule', effects: [{ kind: 'emit', event: 'timer.done', delayMilliseconds: 100 }],
        }],
      },
      {
        handlerId: 'timer-done', event: 'timer.done', side: 'client', branches: [{
          branchId: 'show', effects: [{ kind: 'add', target: clientRef('notices'), value: { kind: 'literal', value: 1 } }],
        }],
      },
    );
    const result = runGameplayScenario(model, multiplayerScenario([
      { kind: 'dispatch', event: 'timer.start', playerId: 'p1' },
      { kind: 'leave', playerId: 'p1' },
      { kind: 'join', playerId: 'p1' },
      { kind: 'advance', milliseconds: 100 },
    ], model));
    expect(result.status).toBe('fail');
    expect(result.failures).toContainEqual(expect.objectContaining({ code: 'LATE_EVENT_FOR_DISCONNECTED_PLAYER' }));
    expect(result.finalState.clients.p1?.notices).toBe(0);
  });

  it('detects a non-idempotent duplicate reward and missing callback player routing', () => {
    const model = competitiveStockModel();
    model.initialState.player.rewardCount = 0;
    model.externalEvents.push('reward.claim');
    model.eventPolicies?.push({
      event: 'reward.claim',
      authority: 'server-only',
      playerRequired: true,
      duplicatePolicy: 'must-be-idempotent',
      targetSide: 'server',
      observableEffectRequired: true,
    });
    model.handlers.push({
      handlerId: 'reward', event: 'reward.claim', side: 'server', branches: [{
        branchId: 'grant', effects: [{ kind: 'add', target: playerRef('rewardCount'), value: { kind: 'literal', value: 1 } }],
      }],
    });
    const result = runGameplayScenario(model, multiplayerScenario([
      { kind: 'dispatch', event: 'reward.claim', source: 'server', deliveryId: 'request-1' },
      { kind: 'dispatch', event: 'reward.claim', source: 'server', playerId: 'p1', deliveryId: 'request-2' },
      { kind: 'dispatch', event: 'reward.claim', source: 'server', playerId: 'p1', deliveryId: 'request-2' },
    ], model));
    expect(result.status).toBe('fail');
    expect(result.failures).toContainEqual(expect.objectContaining({ code: 'PLAYER_ROUTING_MISSING', stepIndex: 0 }));
    expect(result.failures).toContainEqual(expect.objectContaining({ code: 'DUPLICATE_EVENT_CHANGED_STATE', stepIndex: 2 }));
    expect(result.finalState.players.p1?.rewardCount).toBe(2);
  });

  it('keeps a must-be-idempotent delivery key across leave and rejoin epochs', () => {
    const model = competitiveStockModel();
    model.initialState.player.rewardCount = 0;
    model.externalEvents.push('reward.once');
    model.eventPolicies?.push({
      event: 'reward.once', authority: 'server-only', playerRequired: true, duplicatePolicy: 'must-be-idempotent', targetSide: 'server', observableEffectRequired: true,
    });
    model.handlers.push({ handlerId: 'reward-once', event: 'reward.once', side: 'server', branches: [{
      branchId: 'grant', effects: [{ kind: 'add', target: playerRef('rewardCount'), value: { kind: 'literal', value: 1 } }],
    }] });
    const result = runGameplayScenario(model, multiplayerScenario([
      { kind: 'dispatch', event: 'reward.once', source: 'server', playerId: 'p1', deliveryId: 'stable-request' },
      { kind: 'leave', playerId: 'p1' },
      { kind: 'join', playerId: 'p1' },
      { kind: 'dispatch', event: 'reward.once', source: 'server', playerId: 'p1', deliveryId: 'stable-request' },
    ], model));
    expect(result.finalState.players.p1?.rewardCount).toBe(2);
    expect(result.failures).toContainEqual(expect.objectContaining({ code: 'DUPLICATE_EVENT_CHANGED_STATE', stepIndex: 3 }));
  });

  it('rejects a client-origin event declared server-only', () => {
    const model = competitiveStockModel();
    const result = runGameplayScenario(model, multiplayerScenario([
      { kind: 'dispatch', event: 'buy', source: 'client', playerId: 'p1' },
    ], model));
    expect(result.status).toBe('fail');
    expect(result.failures).toContainEqual(expect.objectContaining({ code: 'UNAUTHORIZED_EVENT_SOURCE' }));
    expect(result.finalState.shared.stock).toBe(1);
  });

  it('checks authority again for events emitted by a client handler', () => {
    const model = competitiveStockModel();
    model.externalEvents.push('client.click');
    model.eventPolicies?.push(
      { event: 'client.click', authority: 'client-request', playerRequired: true, duplicatePolicy: 'allow', targetSide: 'client', observableEffectRequired: true },
      { event: 'server.award', authority: 'server-only', playerRequired: true, duplicatePolicy: 'allow', targetSide: 'server', observableEffectRequired: true },
    );
    model.handlers.push(
      {
        handlerId: 'client-click', event: 'client.click', side: 'client', branches: [{
          branchId: 'forge', effects: [{ kind: 'emit', event: 'server.award', delayMilliseconds: 0 }],
        }],
      },
      {
        handlerId: 'server-award', event: 'server.award', side: 'server', branches: [{
          branchId: 'grant', effects: [{ kind: 'add', target: playerRef('goods'), value: { kind: 'literal', value: 1 } }],
        }],
      },
    );
    const result = runGameplayScenario(model, multiplayerScenario([
      { kind: 'dispatch', event: 'client.click', source: 'client', playerId: 'p1' },
    ], model));
    expect(result.failures).toContainEqual(expect.objectContaining({ code: 'UNAUTHORIZED_EVENT_SOURCE' }));
    expect(result.finalState.players.p1?.goods).toBe(0);
  });

  it('treats a repeated emit as a non-idempotent queued side effect', () => {
    const model = competitiveStockModel();
    model.initialState.player.rewardCount = 0;
    model.externalEvents.push('reward.request');
    model.eventPolicies?.push(
      { event: 'reward.request', authority: 'server-only', playerRequired: true, duplicatePolicy: 'must-be-idempotent', targetSide: 'server', observableEffectRequired: true },
      { event: 'reward.deliver', authority: 'server-only', playerRequired: true, duplicatePolicy: 'allow', completion: 'must-drain', targetSide: 'server', observableEffectRequired: true },
    );
    model.handlers.push(
      {
        handlerId: 'reward-request', event: 'reward.request', side: 'server', branches: [{
          branchId: 'queue', effects: [{ kind: 'emit', event: 'reward.deliver', delayMilliseconds: 10 }],
        }],
      },
      {
        handlerId: 'reward-deliver', event: 'reward.deliver', side: 'server', branches: [{
          branchId: 'grant', effects: [{ kind: 'add', target: playerRef('rewardCount'), value: { kind: 'literal', value: 1 } }],
        }],
      },
    );
    const result = runGameplayScenario(model, multiplayerScenario([
      { kind: 'dispatch', event: 'reward.request', source: 'server', playerId: 'p1', deliveryId: 'same' },
      { kind: 'dispatch', event: 'reward.request', source: 'server', playerId: 'p1', deliveryId: 'same' },
      { kind: 'advance', milliseconds: 10 },
    ], model));
    expect(result.failures).toContainEqual(expect.objectContaining({ code: 'DUPLICATE_EVENT_CHANGED_STATE', stepIndex: 1 }));
    expect(result.finalState.players.p1?.rewardCount).toBe(2);
  });

  it('blocks an unreviewed server write to a hard-coded different player', () => {
    const model = competitiveStockModel();
    model.handlers.push({
      handlerId: 'server-leak', event: 'server.leak', side: 'server', branches: [{
        branchId: 'p2', effects: [{ kind: 'add', target: playerRef('goods', 'p2'), value: { kind: 'literal', value: 1 } }],
      }],
    });
    model.externalEvents.push('server.leak');
    const result = runGameplayScenario(model, multiplayerScenario([
      { kind: 'dispatch', event: 'server.leak', source: 'server', playerId: 'p1' },
    ], model));
    expect(result.status).toBe('blocked');
    expect(result.staticFindings).toContainEqual(expect.objectContaining({ code: 'HARDCODED_PLAYER_TARGET', severity: 'error' }));
    expect(result.finalState.players.p2?.goods).toBe(0);
  });

  it('rejects an emitted without-player event when its policy requires callback player routing', () => {
    const model = competitiveStockModel();
    model.externalEvents.push('route.start');
    model.eventPolicies?.push(
      { event: 'route.start', authority: 'server-only', playerRequired: true, duplicatePolicy: 'allow', targetSide: 'server', observableEffectRequired: true },
      { event: 'route.finish', authority: 'server-only', playerRequired: true, duplicatePolicy: 'allow', targetSide: 'server', observableEffectRequired: true },
    );
    model.handlers.push(
      {
        handlerId: 'route-start', event: 'route.start', side: 'server', branches: [{
          branchId: 'emit', effects: [{ kind: 'emit', event: 'route.finish', delayMilliseconds: 0, routing: 'without-player' }],
        }],
      },
      {
        handlerId: 'route-finish', event: 'route.finish', side: 'server', branches: [{
          branchId: 'write', effects: [{ kind: 'add', target: playerRef('goods'), value: { kind: 'literal', value: 1 } }],
        }],
      },
    );
    const result = runGameplayScenario(model, multiplayerScenario([
      { kind: 'dispatch', event: 'route.start', source: 'server', playerId: 'p1' },
    ], model));
    expect(result.failures).toContainEqual(expect.objectContaining({ code: 'PLAYER_ROUTING_MISSING' }));
    expect(result.finalState.players.p1?.goods).toBe(0);
  });

  it('reports a must-drain event still queued when the scenario ends', () => {
    const model = competitiveStockModel();
    model.externalEvents.push('timer.start');
    model.eventPolicies?.push(
      { event: 'timer.start', authority: 'server-only', playerRequired: true, duplicatePolicy: 'allow', targetSide: 'server', observableEffectRequired: true },
      { event: 'timer.done', authority: 'server-only', playerRequired: true, duplicatePolicy: 'allow', completion: 'must-drain', targetSide: 'server', observableEffectRequired: true },
    );
    model.handlers.push({
      handlerId: 'timer-start-pending', event: 'timer.start', side: 'server', branches: [{
        branchId: 'schedule', effects: [{ kind: 'emit', event: 'timer.done', delayMilliseconds: 100 }],
      }],
    });
    const result = runGameplayScenario(model, multiplayerScenario([
      { kind: 'dispatch', event: 'timer.start', source: 'server', playerId: 'p1' },
    ], model));
    expect(result.status).toBe('fail');
    expect(result.failures).toContainEqual(expect.objectContaining({ code: 'PENDING_CRITICAL_EVENTS' }));
  });

  it('distinguishes a complete exact-limit schedule set from a truly truncated set', () => {
    const two = runGameplayMultiplayerMatrix(competitiveStockModel(), multiplayerScenario([{
      kind: 'parallel', exploreInterleavings: true,
      actions: [{ event: 'buy', playerId: 'p1' }, { event: 'buy', playerId: 'p2' }],
    }]), { maxSchedules: 2 });
    expect(two.schedulesExplored).toBe(2);
    expect(two.truncated).toBe(false);

    const threePlayers = { ...multiplayerScenario([]), players: ['p1', 'p2', 'p3'] };
    const three = runGameplayMultiplayerMatrix(competitiveStockModel(), {
      ...threePlayers,
      steps: [{
        kind: 'parallel', exploreInterleavings: true,
        actions: [{ event: 'buy', playerId: 'p1' }, { event: 'buy', playerId: 'p2' }, { event: 'buy', playerId: 'p3' }],
      }],
    }, { maxSchedules: 2 });
    expect(three.schedulesExplored).toBe(2);
    expect(three.truncated).toBe(true);
    expect(three.status).toBe('needs-editor');
  });

  it('runs multiple independent scenarios for the same population instead of forcing a giant scenario', () => {
    const model = competitiveStockModel();
    const purchase = { ...multiplayerScenario([{ kind: 'dispatch', event: 'buy', playerId: 'p1' }], model), scenarioId: 'purchase-flow' };
    purchase.modelBinding = { modelId: model.modelId, modelFingerprint: gameplayModelFingerprint(model), ...model.project };
    const announce = { ...multiplayerScenario([{ kind: 'dispatch', event: 'announce', playerId: 'p2' }], model), scenarioId: 'announce-flow' };
    announce.modelBinding = { modelId: model.modelId, modelFingerprint: gameplayModelFingerprint(model), ...model.project };
    const population = runGameplayPopulationMatrix(model, [purchase, announce], { requiredPlayerCounts: [2] }).populations[0]!;
    expect(population.scenarioResults.map((entry) => entry.scenarioId)).toEqual(['purchase-flow', 'announce-flow']);
    expect(population.schedulesExplored).toBe(2);
  });
});
