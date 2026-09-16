import { describe, expect, it } from 'vitest';

import type { ProjectDiagnostic } from '../../src/core/diagnostics/analyzer.js';
import { gameplayModelFingerprint, reviewGameplaySimulationEligibility } from '../../src/core/gameplay/model.js';
import { classifyGameplayRun } from '../../src/core/gameplay/report.js';
import type { GameplayModel, GameplayPreparationFinding, GameplayScenario, GameplayTestReport } from '../../src/core/gameplay/types.js';

function model(): GameplayModel {
  return {
    schemaVersion: 1, modelId: 'gate-model',
    project: { projectInstanceId: '33333333-3333-4333-8333-333333333333', mapFingerprint: null, sceneSnapshotId: null, knowledgeFingerprint: 'a'.repeat(64) },
    externalEvents: ['gate.event'],
    eventPolicies: [{ event: 'gate.event', authority: 'server-only', playerRequired: false, duplicatePolicy: 'allow', targetSide: 'server', observableEffectRequired: true }],
    initialState: { shared: { observed: false }, player: {}, client: {} },
    handlers: [{ handlerId: 'gate-handler', event: 'gate.event', side: 'server', branches: [{
      branchId: 'run', coverageRequired: false,
      effects: [{ kind: 'set', target: { scope: 'shared', path: 'observed' }, value: { kind: 'literal', value: true } }],
    }] }],
    invariants: [], evidenceRequirements: [], multiplayer: { maximumPlayers: 2, rejoinPolicy: 'retain-player-reset-client' },
  };
}

function scenario(inputModel = model()): GameplayScenario {
  return {
    schemaVersion: 1, scenarioId: 'gate-scenario', name: 'gate',
    modelBinding: { modelId: inputModel.modelId, modelFingerprint: gameplayModelFingerprint(inputModel), ...inputModel.project },
    players: ['p1'], limits: { maxEvents: 20, maxVirtualMilliseconds: 1000, maxVisitedStates: 20, maxBranches: 20 },
    steps: [{ kind: 'dispatch', event: 'gate.event', source: 'server', targetSide: 'server' }],
  };
}

function diagnostic(code: ProjectDiagnostic['code'], path: string | null, severity: ProjectDiagnostic['severity'] = 'error'): ProjectDiagnostic {
  return { code, severity, message: `fixture ${code}`, nextAction: 'fixture action', path, range: null, evidence: 'STATIC_LOCAL', runtimeVerified: false };
}

function preparation(code: string, severity: GameplayPreparationFinding['severity']): GameplayPreparationFinding {
  return { code, severity, scope: 'flow', message: code, nextAction: 'fixture action', evidence: [] };
}

describe('gameplay simulation eligibility', () => {
  it.each([
    { name: 'unknown API in production remains strict-only', diagnostics: [diagnostic('UNKNOWN_OFFICIAL_API', 'src/GameEntry.lua')], preparation: [], status: 'pass', fatal: [], skipped: ['UNKNOWN_OFFICIAL_API'] },
    { name: 'official API unavailable remains strict-only', diagnostics: [diagnostic('OFFICIAL_API_UNAVAILABLE', null)], preparation: [], status: 'pass', fatal: [], skipped: ['OFFICIAL_API_UNAVAILABLE'] },
    { name: 'an unreachable backup error cannot block simulation', diagnostics: [diagnostic('INVALID_ID_REFERENCE', 'src/Backup/Broken.lua')], preparation: [], status: 'pass', fatal: [], skipped: ['INVALID_ID_REFERENCE'] },
    { name: 'the same ID error in production is fatal', diagnostics: [diagnostic('INVALID_ID_REFERENCE', 'src/GameEntry.lua')], preparation: [], status: 'blocked', fatal: ['INVALID_ID_REFERENCE'], skipped: [] },
    { name: 'a current scene binding error is fatal', diagnostics: [diagnostic('SCENE_EVENT_BINDING_REQUIRED', null)], preparation: [], status: 'blocked', fatal: ['SCENE_EVENT_BINDING_REQUIRED'], skipped: [] },
    { name: 'a local unmodeled flow is partial', diagnostics: [], preparation: [preparation('GAMEPLAY_LOCAL_FLOW_UNMODELED', 'partial')], status: 'pass', fatal: [], skipped: ['GAMEPLAY_LOCAL_FLOW_UNMODELED'] },
    { name: 'a preparation fatal always blocks', diagnostics: [], preparation: [preparation('GAMEPLAY_REACHABLE_LUA_INVALID', 'fatal')], status: 'blocked', fatal: ['GAMEPLAY_REACHABLE_LUA_INVALID'], skipped: [] },
  ])('$name', ({ diagnostics, preparation: preparationFindings, status, fatal, skipped }) => {
    const inputModel = model();
    const gate = reviewGameplaySimulationEligibility({ model: inputModel, scenarios: [scenario(inputModel)], productionPaths: new Set(['src/GameEntry.lua']), preparationFindings, projectDiagnostics: diagnostics });
    expect(gate.status).toBe(status);
    expect(gate.fatalFindings.map((entry) => entry.code)).toEqual(fatal);
    expect(gate.skippedFindings.map((entry) => entry.code)).toEqual(skipped);
  });

  it('keeps scene evidence gaps out of the automatic fatal gate while preserving an editor-required finding', () => {
    const inputModel = model();
    const gate = reviewGameplaySimulationEligibility({
      model: inputModel,
      scenarios: [scenario(inputModel)],
      productionPaths: new Set(['src/GameEntry.lua']),
      preparationFindings: [],
      projectDiagnostics: [diagnostic('SCENE_EVENT_BINDING_REQUIRED', null)],
      allowSceneEvidenceGaps: true,
    });

    expect(gate.status).toBe('pass');
    expect(gate.fatalFindings).toEqual([]);
    expect(gate.skippedFindings).toEqual([expect.objectContaining({
      code: 'SCENE_EVENT_BINDING_REQUIRED', severity: 'partial',
    })]);
  });

  it('blocks empty handlers, empty scenario collections, and empty scenario steps', () => {
    const noHandlers = model();
    noHandlers.handlers = [];
    expect(reviewGameplaySimulationEligibility({ model: noHandlers, scenarios: [scenario(noHandlers)], productionPaths: new Set(), preparationFindings: [], projectDiagnostics: [] }).fatalFindings)
      .toContainEqual(expect.objectContaining({ code: 'GAMEPLAY_NO_EXECUTABLE_HANDLERS' }));
    expect(reviewGameplaySimulationEligibility({ model: model(), scenarios: [], productionPaths: new Set(), preparationFindings: [], projectDiagnostics: [] }).fatalFindings)
      .toContainEqual(expect.objectContaining({ code: 'GAMEPLAY_NO_EXECUTABLE_SCENARIOS' }));
    const empty = scenario();
    empty.steps = [];
    expect(reviewGameplaySimulationEligibility({ model: model(), scenarios: [empty], productionPaths: new Set(), preparationFindings: [], projectDiagnostics: [] }).fatalFindings)
      .toContainEqual(expect.objectContaining({ code: 'GAMEPLAY_EMPTY_SCENARIO' }));
  });
});

describe('gameplay run classification', () => {
  const gate = { schemaVersion: 1 as const, status: 'pass' as const, fatalFindings: [], skippedFindings: [] };
  const report = (status: GameplayTestReport['status'], truncated = false, staticGate: GameplayTestReport['staticGate'] = 'pass') => ({ status, staticGate, populations: [{ truncated }] } as GameplayTestReport);

  it.each([
    ['strict blocked but model passed', gate, report('pass', false, 'blocked'), [], 'model-pass'],
    ['editor-only gate gap is partial', { ...gate, skippedFindings: [preparation('SCENE_EVENT_BINDING_REQUIRED', 'partial')] }, report('pass'), [], 'partial-needs-editor'],
    ['skipped flow needs editor', gate, report('pass'), [{ flowId: 'x', reasonCode: 'SKIP', needsEditor: true, evidence: [] }], 'partial-needs-editor'],
    ['bounded search truncation', gate, report('pass', true), [], 'partial-needs-editor'],
    ['report needs editor', gate, report('needs-editor'), [], 'partial-needs-editor'],
    ['model assertion failed', gate, report('fail'), [], 'model-fail'],
    ['fatal gate did not run', { ...gate, status: 'blocked' as const, fatalFindings: [preparation('FATAL', 'fatal')] }, null, [], 'not-run-fatal'],
  ] as const)('%s', (_name, inputGate, inputReport, skippedFlows, expected) => {
    expect(classifyGameplayRun({ gate: inputGate, report: inputReport, skippedFlows })).toBe(expected);
  });
});
