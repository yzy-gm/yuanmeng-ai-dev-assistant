import { describe, expect, it } from 'vitest';

import { gameplayModelFingerprint, reviewGameplayModel } from '../../src/core/gameplay/model.js';
import { runGameplayScenario } from '../../src/core/gameplay/simulator.js';
import type { GameplayModel, GameplayScenario } from '../../src/core/gameplay/types.js';

const ref = (scope: 'shared' | 'player' | 'client', path: string, playerId?: string) => ({
  scope,
  path,
  ...(playerId === undefined ? {} : { playerId }),
} as const);

function supermarketModel(): GameplayModel {
  return {
    schemaVersion: 1,
    modelId: 'anonymous-supermarket-v1',
    project: {
      projectInstanceId: '00000000-0000-4000-8000-000000000001',
      mapFingerprint: 'a'.repeat(64),
      sceneSnapshotId: 'b'.repeat(64),
      knowledgeFingerprint: 'c'.repeat(64),
    },
    externalEvents: ['game.start', 'task.accept', 'goods.buy', 'goods.place', 'customer.purchase', 'shelf.upgrade'],
    eventPolicies: [
      { event: 'game.start', authority: 'server-only', playerRequired: true, duplicatePolicy: 'allow', targetSide: 'client', observableEffectRequired: true },
      { event: 'task.accept', authority: 'server-only', playerRequired: true, duplicatePolicy: 'allow', targetSide: 'server', observableEffectRequired: true },
      { event: 'goods.buy', authority: 'server-only', playerRequired: true, duplicatePolicy: 'allow', targetSide: 'server', observableEffectRequired: true },
      { event: 'goods.place', authority: 'server-only', playerRequired: true, duplicatePolicy: 'allow', targetSide: 'server', observableEffectRequired: true },
      { event: 'customer.purchase', authority: 'server-only', playerRequired: true, duplicatePolicy: 'allow', targetSide: 'server', observableEffectRequired: true },
      { event: 'shelf.upgrade', authority: 'server-only', playerRequired: true, duplicatePolicy: 'allow', targetSide: 'server', observableEffectRequired: true },
      { event: 'ui.purchase-result', authority: 'server-only', playerRequired: true, duplicatePolicy: 'allow', targetSide: 'client', observableEffectRequired: true },
    ],
    initialState: {
      shared: { shelfStock: 0, shelfLevel: 1, businessIncome: 0 },
      player: { money: 100, inventory: 0, taskAccepted: false },
      client: { taskPanelVisible: false, lastResult: 'idle' },
    },
    handlers: [
      {
        handlerId: 'show-task', event: 'game.start', side: 'client', branches: [{
          branchId: 'show', effects: [{ kind: 'set', target: ref('client', 'taskPanelVisible'), value: { kind: 'literal', value: true } }],
        }],
      },
      {
        handlerId: 'accept-task', event: 'task.accept', side: 'server', branches: [{
          branchId: 'accept', effects: [{ kind: 'set', target: ref('player', 'taskAccepted'), value: { kind: 'literal', value: true } }],
        }],
      },
      {
        handlerId: 'buy-goods', event: 'goods.buy', side: 'server', branches: [
          {
            branchId: 'enough-money',
            when: { kind: 'compare', operator: 'gte', left: { kind: 'read', ref: ref('player', 'money') }, right: { kind: 'literal', value: 20 } },
            effects: [
              { kind: 'add', target: ref('player', 'money'), value: { kind: 'literal', value: -20 } },
              { kind: 'add', target: ref('player', 'inventory'), value: { kind: 'literal', value: 1 } },
              { kind: 'emit', event: 'ui.purchase-result', delayMilliseconds: 0 },
            ],
          },
          { branchId: 'insufficient', effects: [] },
        ],
      },
      {
        handlerId: 'purchase-ui', event: 'ui.purchase-result', side: 'client', branches: [{
          branchId: 'success', effects: [{ kind: 'set', target: ref('client', 'lastResult'), value: { kind: 'literal', value: 'success' } }],
        }],
      },
      {
        handlerId: 'place-goods', event: 'goods.place', side: 'server', branches: [
          {
            branchId: 'has-goods',
            when: { kind: 'compare', operator: 'gt', left: { kind: 'read', ref: ref('player', 'inventory') }, right: { kind: 'literal', value: 0 } },
            effects: [
              { kind: 'add', target: ref('player', 'inventory'), value: { kind: 'literal', value: -1 } },
              { kind: 'add', target: ref('shared', 'shelfStock'), value: { kind: 'literal', value: 1 } },
            ],
          },
          { branchId: 'empty', effects: [] },
        ],
      },
      {
        handlerId: 'customer-purchase', event: 'customer.purchase', side: 'server', branches: [
          {
            branchId: 'in-stock',
            when: { kind: 'compare', operator: 'gt', left: { kind: 'read', ref: ref('shared', 'shelfStock') }, right: { kind: 'literal', value: 0 } },
            effects: [
              { kind: 'add', target: ref('shared', 'shelfStock'), value: { kind: 'literal', value: -1 } },
              { kind: 'add', target: ref('shared', 'businessIncome'), value: { kind: 'literal', value: 30 } },
            ],
          },
          { branchId: 'out-of-stock', effects: [] },
        ],
      },
      {
        handlerId: 'upgrade', event: 'shelf.upgrade', side: 'server', branches: [
          {
            branchId: 'affordable',
            when: { kind: 'compare', operator: 'gte', left: { kind: 'read', ref: ref('shared', 'businessIncome') }, right: { kind: 'literal', value: 30 } },
            effects: [
              { kind: 'add', target: ref('shared', 'businessIncome'), value: { kind: 'literal', value: -30 } },
              { kind: 'add', target: ref('shared', 'shelfLevel'), value: { kind: 'literal', value: 1 } },
            ],
          },
          { branchId: 'locked', effects: [] },
        ],
      },
    ],
    invariants: [
      { invariantId: 'money-non-negative', kind: 'non-negative', ref: ref('player', 'money') },
      { invariantId: 'inventory-non-negative', kind: 'non-negative', ref: ref('player', 'inventory') },
      { invariantId: 'stock-non-negative', kind: 'non-negative', ref: ref('shared', 'shelfStock') },
      { invariantId: 'income-non-negative', kind: 'non-negative', ref: ref('shared', 'businessIncome') },
    ],
    evidenceRequirements: [{
      requirementId: 'customer-can-reach-shelf',
      kind: 'npc-reachability',
      state: 'unverified',
      description: '顾客可从出生点到达货柜交互位置',
    }],
  };
}

function scenario(steps: GameplayScenario['steps'], inputModel = supermarketModel()): GameplayScenario {
  return {
    schemaVersion: 1,
    scenarioId: 'anonymous-full-flow',
    name: '超市完整流程',
    modelBinding: { modelId: inputModel.modelId, modelFingerprint: gameplayModelFingerprint(inputModel), ...inputModel.project },
    players: ['p1', 'p2'],
    limits: { maxEvents: 100, maxVirtualMilliseconds: 60_000, maxVisitedStates: 100, maxBranches: 100 },
    steps,
  };
}

describe('AI gameplay simulator', () => {
  it('runs the declared supermarket flow and separates model success from editor-required evidence', () => {
    const result = runGameplayScenario(supermarketModel(), scenario([
      { kind: 'dispatch', event: 'game.start', playerId: 'p1' },
      { kind: 'dispatch', event: 'task.accept', playerId: 'p1' },
      { kind: 'dispatch', event: 'goods.buy', playerId: 'p1' },
      { kind: 'dispatch', event: 'goods.place', playerId: 'p1' },
      { kind: 'dispatch', event: 'customer.purchase', playerId: 'p1' },
      { kind: 'dispatch', event: 'shelf.upgrade', playerId: 'p1' },
      { kind: 'expect', ref: ref('player', 'money', 'p1'), operator: 'eq', value: 80 },
      { kind: 'expect', ref: ref('player', 'inventory', 'p1'), operator: 'eq', value: 0 },
      { kind: 'expect', ref: ref('shared', 'shelfLevel'), operator: 'eq', value: 2 },
      { kind: 'expect', ref: ref('client', 'lastResult', 'p1'), operator: 'eq', value: 'success' },
    ]));
    expect(result.status).toBe('needs-editor');
    expect(result.failures).toEqual([]);
    expect(result.editorRequirements).toEqual([expect.objectContaining({ requirementId: 'customer-can-reach-shelf' })]);
    expect(result.finalState.players.p1).toMatchObject({ money: 80, inventory: 0, taskAccepted: true });
    expect(result.finalState.players.p2).toMatchObject({ money: 100, inventory: 0, taskAccepted: false });
    expect(result.coverage.visitedBranches).toBeGreaterThan(0);
    expect(result.trace.some((entry) => entry.event === 'ui.purchase-result' && entry.playerId === 'p1')).toBe(true);
  });

  it('blocks gameplay simulation when the static gate finds a client write to server state', () => {
    const model = supermarketModel();
    model.handlers.push({
      handlerId: 'unsafe-client-money', event: 'unsafe', side: 'client', branches: [{
        branchId: 'bad', effects: [{ kind: 'set', target: ref('shared', 'businessIncome'), value: { kind: 'literal', value: 999 } }],
      }],
    });
    const review = reviewGameplayModel(model);
    expect(review).toContainEqual(expect.objectContaining({ code: 'CLIENT_WRITES_SERVER_STATE', severity: 'error' }));
    const result = runGameplayScenario(model, scenario([{ kind: 'dispatch', event: 'unsafe', playerId: 'p1' }]));
    expect(result.status).toBe('blocked');
    expect(result.trace).toEqual([]);
  });

  it('keeps per-player and client-local state isolated', () => {
    const model = { ...supermarketModel(), evidenceRequirements: [] };
    const result = runGameplayScenario(model, scenario([
      { kind: 'dispatch', event: 'goods.buy', playerId: 'p1' },
      { kind: 'expect', ref: ref('player', 'money', 'p1'), operator: 'eq', value: 80 },
      { kind: 'expect', ref: ref('player', 'money', 'p2'), operator: 'eq', value: 100 },
      { kind: 'expect', ref: ref('client', 'lastResult', 'p1'), operator: 'eq', value: 'success' },
      { kind: 'expect', ref: ref('client', 'lastResult', 'p2'), operator: 'eq', value: 'idle' },
    ], model));
    expect(result.status).toBe('pass');
    expect(result.failures).toEqual([]);
  });

  it('reports failed expectations and invariant violations without hiding the first failing step', () => {
    const model = supermarketModel();
    model.handlers.unshift({
      handlerId: 'bad-reward', event: 'bad.reward', side: 'server', branches: [{
        branchId: 'bad', effects: [{ kind: 'add', target: ref('player', 'money'), value: { kind: 'literal', value: -200 } }],
      }],
    });
    model.externalEvents.push('bad.reward');
    model.eventPolicies?.push({ event: 'bad.reward', authority: 'server-only', playerRequired: true, duplicatePolicy: 'allow', targetSide: 'server', observableEffectRequired: true });
    const result = runGameplayScenario(model, scenario([
      { kind: 'dispatch', event: 'bad.reward', playerId: 'p1' },
      { kind: 'expect', ref: ref('player', 'money', 'p1'), operator: 'gte', value: 0 },
    ], model));
    expect(result.status).toBe('fail');
    expect(result.failures[0]).toMatchObject({ code: 'INVARIANT_FAILED', stepIndex: 0 });
    expect(result.failures).toContainEqual(expect.objectContaining({ code: 'EXPECTATION_FAILED', stepIndex: 1 }));
  });

  it('stops an event storm at the declared event limit', () => {
    const model = supermarketModel();
    model.handlers = [{
      handlerId: 'loop', event: 'loop', side: 'server', branches: [{
        branchId: 'again', effects: [{ kind: 'emit', event: 'loop', delayMilliseconds: 0 }],
      }],
    }];
    model.externalEvents = ['loop'];
    model.eventPolicies = [{ event: 'loop', authority: 'server-only', playerRequired: true, duplicatePolicy: 'allow', targetSide: 'server', observableEffectRequired: true }];
    model.invariants = [];
    model.evidenceRequirements = [];
    const limited = scenario([{ kind: 'dispatch', event: 'loop', playerId: 'p1' }]);
    limited.limits.maxEvents = 10;
    limited.modelBinding = { modelId: model.modelId, modelFingerprint: gameplayModelFingerprint(model), ...model.project };
    const result = runGameplayScenario(model, limited);
    expect(result.status).toBe('fail');
    expect(result.failures).toContainEqual(expect.objectContaining({ code: 'EVENT_LIMIT_EXCEEDED' }));
    expect(result.trace).toHaveLength(10);
  });

  it('is deterministic for the same model and scenario', () => {
    const model = { ...supermarketModel(), evidenceRequirements: [] };
    const input = scenario([{ kind: 'dispatch', event: 'goods.buy', playerId: 'p1' }], model);
    const first = runGameplayScenario(model, input);
    const second = runGameplayScenario(model, input);
    expect(second.reportId).toBe(first.reportId);
    expect(second.trace).toEqual(first.trace);
    expect(second.finalState).toEqual(first.finalState);
  });

  it('distinguishes a missing state path from explicit null and rejects a nested write through a scalar', () => {
    const missingModel = { ...supermarketModel(), evidenceRequirements: [] };
    const missing = runGameplayScenario(missingModel, scenario([
      { kind: 'expect', ref: ref('shared', 'notCreated'), operator: 'eq', value: null },
    ], missingModel));
    expect(missing.failures).toContainEqual(expect.objectContaining({ code: 'EXPECTATION_FAILED' }));

    const conflictModel = supermarketModel();
    conflictModel.evidenceRequirements = [];
    conflictModel.initialState.shared.scalar = 1;
    conflictModel.externalEvents.push('type.conflict');
    conflictModel.eventPolicies?.push({
      event: 'type.conflict', authority: 'server-only', playerRequired: true, duplicatePolicy: 'allow',
      targetSide: 'server', observableEffectRequired: true,
    });
    conflictModel.handlers.push({ handlerId: 'type-conflict', event: 'type.conflict', side: 'server', branches: [{
      branchId: 'write', effects: [{ kind: 'set', target: ref('shared', 'scalar.child'), value: { kind: 'literal', value: 1 } }],
    }] });
    const conflict = runGameplayScenario(conflictModel, scenario([{ kind: 'dispatch', event: 'type.conflict', playerId: 'p1' }], conflictModel));
    expect(conflict.failures).toContainEqual(expect.objectContaining({ code: 'SIMULATION_ERROR', message: expect.stringContaining('不是对象') }));
  });

  it('reports overlapping condition branches instead of silently taking the first match', () => {
    const model = supermarketModel();
    model.evidenceRequirements = [];
    model.externalEvents.push('ambiguous');
    model.eventPolicies?.push({ event: 'ambiguous', authority: 'server-only', playerRequired: true, duplicatePolicy: 'allow', targetSide: 'server', observableEffectRequired: true });
    model.handlers.push({ handlerId: 'ambiguous', event: 'ambiguous', side: 'server', branches: [
      { branchId: 'gte', when: { kind: 'compare', operator: 'gte', left: { kind: 'read', ref: ref('shared', 'shelfStock') }, right: { kind: 'literal', value: 0 } }, effects: [{ kind: 'add', target: ref('shared', 'shelfStock'), value: { kind: 'literal', value: 1 } }] },
      { branchId: 'lte', when: { kind: 'compare', operator: 'lte', left: { kind: 'read', ref: ref('shared', 'shelfStock') }, right: { kind: 'literal', value: 0 } }, effects: [{ kind: 'add', target: ref('shared', 'shelfStock'), value: { kind: 'literal', value: 1 } }] },
    ] });
    const result = runGameplayScenario(model, scenario([{ kind: 'dispatch', event: 'ambiguous', playerId: 'p1' }], model));
    expect(result.failures).toContainEqual(expect.objectContaining({ code: 'AMBIGUOUS_BRANCH_MATCH' }));
    expect(result.finalState.shared.shelfStock).toBe(0);
  });
});
