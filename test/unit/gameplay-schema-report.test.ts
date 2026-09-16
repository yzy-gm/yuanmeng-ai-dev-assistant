import { describe, expect, it } from 'vitest';

import type { ProjectDiagnostic } from '../../src/core/diagnostics/analyzer.js';
import { buildGameplayKnowledgeDraft, createGameplayKnowledgeFingerprint, gameplayModelFingerprint, prepareGameplaySimulationDiagnostics, refreshGameplayEvidence, refreshGameplayScenarioBinding, reviewGameplayEventDocumentation, reviewGameplaySceneEventBindings, reviewGameplayStaticGate } from '../../src/core/gameplay/model.js';
import { buildApiIndex, parseDeclarationFile } from '../../src/core/api/declaration-index.js';
import { parseEventDocumentation, resolveEventMetadata } from '../../src/core/api/event-doc-index.js';
import { createGameplayCodexReviewPackage, createGameplayTestReport, renderGameplayTestReportMarkdown } from '../../src/core/gameplay/report.js';
import { createGameplayReplayArtifact, replayGameplayScenario } from '../../src/core/gameplay/replay.js';
import { parseGameplayModel, parseGameplayScenario } from '../../src/core/gameplay/scenario-schema.js';
import { runGameplayPopulationMatrix, runGameplayScenario } from '../../src/core/gameplay/simulator.js';
import type { GameplayModel, GameplayScenario } from '../../src/core/gameplay/types.js';
import { buildLuaSourceIndex, type LuaSourceIndex } from '../../src/core/lua/source-index.js';
import type { RegistryDocument, UiSnapshot } from '../../src/core/model.js';
import type { SceneSnapshot } from '../../src/core/scene/types.js';

function model(): GameplayModel {
  return {
    schemaVersion: 1,
    modelId: 'closed-model',
    project: { projectInstanceId: '00000000-0000-4000-8000-000000000001', mapFingerprint: null, sceneSnapshotId: null, knowledgeFingerprint: 'c'.repeat(64) },
    externalEvents: ['ping'],
    eventPolicies: [{ event: 'ping', authority: 'server-only', playerRequired: true, duplicatePolicy: 'allow', observableEffectRequired: true }],
    initialState: { shared: {}, player: { count: 0 }, client: { visible: false } },
    handlers: [{
      handlerId: 'ping', event: 'ping', side: 'server', branches: [{
        branchId: 'apply', effects: [{
          kind: 'add', target: { scope: 'player', path: 'count' }, value: { kind: 'literal', value: 1 },
        }],
      }],
    }],
    invariants: [{ invariantId: 'count', kind: 'non-negative', ref: { scope: 'player', path: 'count' } }],
    evidenceRequirements: [],
    multiplayer: { maximumPlayers: 8, rejoinPolicy: 'retain-player-reset-client' },
  };
}

function scenario(playerCount = 1, inputModel = model()): GameplayScenario {
  return {
    schemaVersion: 1,
    scenarioId: `population-${playerCount}`,
    name: `${playerCount} player`,
    modelBinding: { modelId: inputModel.modelId, modelFingerprint: gameplayModelFingerprint(inputModel), ...inputModel.project },
    players: Array.from({ length: playerCount }, (_, index) => `p${index + 1}`),
    limits: { maxEvents: 100, maxVirtualMilliseconds: 10_000, maxVisitedStates: 100, maxBranches: 100 },
    steps: Array.from({ length: playerCount }, (_, index) => ({
      kind: 'dispatch' as const, event: 'ping', playerId: `p${index + 1}`, source: 'server' as const, deliveryId: `delivery-${index + 1}`,
    })),
  };
}

describe('gameplay closed schemas and static gate', () => {
  it('accepts a closed model and scenario but rejects unknown fields and excessive expression depth', () => {
    expect(parseGameplayModel(structuredClone(model()))).toEqual(model());
    expect(parseGameplayScenario(structuredClone(scenario()))).toEqual(scenario());
    expect(() => parseGameplayScenario({ ...scenario(), unexpected: true })).toThrow(/未知字段|字段/u);

    const hostile = structuredClone(model());
    let expression: NonNullable<GameplayModel['handlers'][number]['branches'][number]['when']> = { kind: 'literal', value: true };
    for (let index = 0; index < 40; index += 1) expression = { kind: 'not', value: expression };
    hostile.handlers[0]!.branches[0]!.when = expression;
    expect(() => parseGameplayModel(hostile)).toThrow(/深度|上限/u);

    const withSceneBinding = { ...model(), sceneEventBindings: [{
      instanceId: '517', status: 'event-bound', interaction: 'character-enter-trigger',
      eventName: 'Events.ON_CHARACTER_ENTER_SIGNAL_BOX', handlerId: 'signal-box-enter',
    }] };
    expect(parseGameplayModel(withSceneBinding)).toMatchObject({ sceneEventBindings: withSceneBinding.sceneEventBindings });
    expect(() => parseGameplayModel({ ...model(), sceneEventBindings: [{
      instanceId: '517', status: 'event-bound', interaction: 'character-enter-trigger',
      eventName: 'Events.ON_PLAYER_TOUCH_ELEMENT', handlerId: 'touch', extra: true,
    }] })).toThrow(/未知字段|字段/u);
    expect(() => parseGameplayModel({ ...model(), sceneEventBindings: [
      { instanceId: '517', status: 'not-used', interaction: null, eventName: null, handlerId: null },
      { instanceId: '517', status: 'event-bound', interaction: 'character-enter-trigger', eventName: 'Events.ON_CHARACTER_ENTER_SIGNAL_BOX', handlerId: 'enter' },
    ] })).toThrow(/不能重复/u);
    expect(() => parseGameplayModel({ ...model(), sceneEventBindings: [
      { instanceId: 'not-decimal', status: 'not-used', interaction: null, eventName: null, handlerId: null },
    ] })).toThrow(/字符串无效/u);
  });

  it('requires an exact model/project/snapshot binding and rejects unknown scenario controls', () => {
    const missing = structuredClone(scenario()) as unknown as Record<string, unknown>;
    delete missing.modelBinding;
    expect(() => parseGameplayScenario(missing)).toThrow(/modelBinding|缺少/u);
    expect(parseGameplayScenario({ ...scenario(), exploreReadyEventInterleavings: true })).toMatchObject({ exploreReadyEventInterleavings: true });
    expect(() => parseGameplayScenario({ ...scenario(), exploreReadyEventInterleavings: 'yes' })).toThrow(/布尔/u);
    const incompletePolicy = structuredClone(model()) as unknown as { eventPolicies: Array<Record<string, unknown>> };
    delete incompletePolicy.eventPolicies[0]?.observableEffectRequired;
    expect(() => parseGameplayModel(incompletePolicy)).toThrow(/observableEffectRequired|缺少/u);
  });

  it('blocks server-authoritative external events without a policy and requires both handlers for targetSide both', () => {
    const missingPolicy = model();
    missingPolicy.eventPolicies = [];
    expect(reviewGameplayStaticGate(missingPolicy).findings).toContainEqual(expect.objectContaining({ code: 'MISSING_EVENT_POLICY', severity: 'error' }));

    const onlyServer = model();
    onlyServer.eventPolicies = [{ event: 'ping', authority: 'server-only', playerRequired: true, duplicatePolicy: 'allow', targetSide: 'both', observableEffectRequired: true }];
    expect(reviewGameplayStaticGate(onlyServer).findings).toContainEqual(expect.objectContaining({ code: 'BOTH_REQUIRES_BOTH_HANDLERS', severity: 'error' }));

    const internalMissing = model();
    internalMissing.handlers.push({ handlerId: 'internal', event: 'internal.done', side: 'server', branches: [{ branchId: 'done', effects: [] }] });
    expect(reviewGameplayStaticGate(internalMissing).findings).toContainEqual(expect.objectContaining({ code: 'MISSING_EVENT_POLICY', severity: 'error' }));
  });

  it('blocks official event bindings when Events.md scope or callback metadata conflicts', () => {
    const bound = {
      ...model(),
      externalEvents: ['Events.ON_CONFLICTING_SCOPE'],
      handlers: [{ handlerId: 'official', event: 'Events.ON_CONFLICTING_SCOPE', side: 'server' as const, branches: [{ branchId: 'run', effects: [] }] }],
      sceneEventBindings: [{ instanceId: '517', status: 'event-bound' as const, interaction: 'character-enter-trigger' as const, eventName: 'Events.ON_CONFLICTING_SCOPE', handlerId: 'official' }],
    };
    const api = buildApiIndex([parseDeclarationFile({
      relativePath: 'res/lib/Events.d.lua',
      source: '--- @module "Events"\nlocal Events_module = {}\n---@const Events.ON_CONFLICTING_SCOPE\nEvents_module.ON_CONFLICTING_SCOPE = "ON_CONFLICTING_SCOPE"',
    })], { officialExtensionVersion: 'fixture' });
    const docs = parseEventDocumentation({ sourceId: 'fixture/Events.md', source: `
### Events.ON_CONFLICTING_SCOPE
* 描述: 只有服务端能收到
* 描述: 只有客户端能收到
\`\`\`lua
System:RegisterEvent(Events.ON_CONFLICTING_SCOPE, function (playerId, signalBoxId) end)
\`\`\`
` });
    const metadata = new Map(resolveEventMetadata(api, docs).map((event) => [event.name, event]));
    expect(reviewGameplayEventDocumentation(bound, metadata)).toContainEqual(expect.objectContaining({ code: 'EVENT_DOCUMENTATION_BLOCKED', severity: 'error' }));
    expect(reviewGameplayStaticGate(bound, [], metadata).status).toBe('blocked');
  });

  it('reuses supplied official event metadata when building review packages and reports', () => {
    const official = model();
    official.externalEvents = ['Events.ON_ALLOWED'];
    official.eventPolicies = [{
      event: 'Events.ON_ALLOWED', authority: 'engine', playerRequired: true,
      duplicatePolicy: 'allow', targetSide: 'client', observableEffectRequired: false,
    }];
    official.initialState = { shared: {}, player: {}, client: {} };
    official.handlers = [{
      handlerId: 'official', event: 'Events.ON_ALLOWED', side: 'client',
      branches: [{ branchId: 'run', effects: [] }],
    }];
    const api = buildApiIndex([parseDeclarationFile({
      relativePath: 'res/lib/Events.d.lua',
      source: '--- @module "Events"\nlocal Events_module = {}\n---@const Events.ON_ALLOWED\nEvents_module.ON_ALLOWED = "ON_ALLOWED"',
    })], { officialExtensionVersion: 'fixture' });
    const docs = parseEventDocumentation({ sourceId: 'fixture/Events.md', source: [
      '', '### Events.ON_ALLOWED', '* 描述: 只有客户端能收到', '* 描述: 事件传参: playerId:number -- 玩家 id', '```lua',
      'System:RegisterEvent(Events.ON_ALLOWED, function (playerId) end)', '```',
    ].join('\n') });
    const metadata = new Map(resolveEventMetadata(api, docs).map((event) => [event.name, event]));
    expect(metadata.get('ON_ALLOWED')?.generationEligibility).toBe('allowed');

    const review = createGameplayCodexReviewPackage(official, [], official.project, metadata);
    expect(review.staticGate.findings).not.toContainEqual(expect.objectContaining({ code: 'EVENT_DOCUMENTATION_BLOCKED' }));

    const report = createGameplayTestReport(official, runGameplayPopulationMatrix(official, [scenario(1, official)], { requiredPlayerCounts: [1], eventMetadata: metadata }), { eventMetadata: metadata });
    expect(report.findings).not.toContainEqual(expect.objectContaining({ code: 'EVENT_DOCUMENTATION_BLOCKED' }));
  });

  it('changes the knowledge fingerprint when only Lua source changes', () => {
    const base = { projectInstanceId: model().project.projectInstanceId, mapFingerprint: null, sceneSnapshotId: null };
    const registry: RegistryDocument = { schemaVersion: 1, records: [] };
    const first = createGameplayKnowledgeFingerprint({ project: base, luaFiles: [{ path: 'src/Game.lua', source: 'return 1' }], registry, uiSnapshot: null, sceneSnapshot: null });
    const second = createGameplayKnowledgeFingerprint({ project: base, luaFiles: [{ path: 'src/Game.lua', source: 'return 2' }], registry, uiSnapshot: null, sceneSnapshot: null });
    expect(second).not.toBe(first);
  });

  it('binds exact runtime scene-family evidence into the knowledge fingerprint and gameplay draft', () => {
    const evidence = { state: 'observed-repeatable' as const, source: 'anonymous-fixture', confidence: 0.9 };
    const sceneSnapshot: SceneSnapshot = {
      schemaVersion: 1, snapshotId: '9'.repeat(64), bindingId: 'binding', role: 'Manual', sourceSha256: 'a'.repeat(64),
      observedAt: '2026-08-21T00:00:00.000Z', adapterId: 'ym-layerdata-observed-v6',
      instances: [{
        instanceId: '901', elementTypeId: '9999999999999999', ownerId: null, variant: 'unknown', evidence,
        transform: { state: 'absent' }, customProperties: { state: 'absent' }, signals: { state: 'absent' },
        resources: { state: 'absent' }, bounds: { state: 'absent' }, unknownFields: [],
      }], groups: [], issues: [], unknownFields: [],
    };
    const runtimeCapabilities = new Map([['901', { state: 'unique' as const, evidence: {
      instanceId: '901', snapshotId: sceneSnapshot.snapshotId, sceneSourceSha256: sceneSnapshot.sourceSha256,
      importedAt: '2026-08-21T02:00:00.000Z', characterState: 'absent' as const, creatureState: 'absent' as const,
      elementState: 'absent' as const,
      logicElementState: 'absent' as const, triggerBoxState: 'present' as const,
      playerState: 'absent' as const,
      triggerSampleState: 'ok' as const, triggerSample: [1, 2, 3] as [number, number, number], fields: {}, fieldConflicts: [],
    } }]]);
    const emptyIndex: LuaSourceIndex = {
      files: [], returnedModules: [], functions: [], requires: [], stringLiterals: [], numericLiterals: [], configFields: [], idReferences: [], signalReferences: [],
      calls: [{
        path: 'src/GameEntry.lua', line: 1, column: 1, endLine: 1, endColumn: 1, context: 'guard 901',
        qualifiedName: 'System:RegisterEvent', argumentCount: 2, arguments: [],
        side: { value: 'server', evidence: 'fixture' }, sceneInstanceGuards: ['901'],
      }],
    };
    const draft = buildGameplayKnowledgeDraft({
      project: model().project, knowledgeFingerprint: model().project.knowledgeFingerprint, sourceIndex: emptyIndex,
      registry: { schemaVersion: 1, records: [] }, uiSnapshot: null, sceneSnapshot, runtimeCapabilities,
    });
    expect(draft.graph.nodes).toContainEqual(expect.objectContaining({
      kind: 'scene-instance', externalId: '901', label: expect.stringContaining('信号触发盒（运行时确认）'),
    }));
    expect(draft.assumptions).toContainEqual(expect.objectContaining({
      kind: 'scene-event-compatibility', prompt: expect.stringContaining('ON_CHARACTER_ENTER_SIGNAL_BOX'),
    }));

    const base = { projectInstanceId: model().project.projectInstanceId, mapFingerprint: null, sceneSnapshotId: sceneSnapshot.snapshotId };
    const input = { project: base, luaFiles: [] as const, registry: { schemaVersion: 1 as const, records: [] }, uiSnapshot: null, sceneSnapshot };
    const withoutRuntime = createGameplayKnowledgeFingerprint(input);
    const withRuntime = createGameplayKnowledgeFingerprint({ ...input, runtimeCapabilities });
    expect(withRuntime).not.toBe(withoutRuntime);
  });

  it('adapts existing project diagnostics into the hard gate and blocks simulation before a trace is produced', () => {
    const privatePath = ['C:', 'private', 'project', 'src', 'Game.lua'].join('/');
    const diagnostic: ProjectDiagnostic = {
      code: 'CROSS_MAP_ID_REFERENCE', severity: 'error', message: 'cross-map id', nextAction: 'fix registry',
      path: privatePath, range: null, evidence: 'STATIC_LOCAL', runtimeVerified: false,
    };
    const gate = reviewGameplayStaticGate(model(), [diagnostic]);
    expect(gate.status).toBe('blocked');
    expect(gate.findings).toContainEqual(expect.objectContaining({ code: 'CROSS_MAP_ID_REFERENCE', source: 'project' }));
    const result = runGameplayScenario(model(), scenario(), { projectDiagnostics: [diagnostic] });
    expect(result.status).toBe('blocked');
    expect(result.trace).toEqual([]);
  });
});

describe('gameplay knowledge draft', () => {
  it('links Lua, registry, UI and scene identities but leaves signal behavior and ownership for user confirmation', () => {
    const sourceIndex: LuaSourceIndex = {
      files: [{ path: 'src/GameServer.lua', side: { value: 'server', evidence: 'file marker' } }],
      returnedModules: [], functions: [], calls: [], requires: [], stringLiterals: [], numericLiterals: [], configFields: [], idReferences: [],
      signalReferences: [{
        path: 'src/GameServer.lua', line: 2, column: 1, endLine: 2, endColumn: 12, context: 'listen',
        value: 'purchase.request', kind: 'signal', role: 'listen', confidence: 'confirmed',
        evidence: { source: 'api', qualifiedName: 'Events:Listen', parameterIndex: 0 },
      }],
    };
    const registry: RegistryDocument = { schemaVersion: 1, records: [] };
    const uiSnapshot: UiSnapshot = {
      schemaVersion: 1, snapshotId: 'u'.repeat(64), createdAt: '2026-08-21T00:00:00.000Z',
      projectInstanceId: '00000000-0000-4000-8000-000000000001', mapFingerprint: null, sources: [], duplicateNames: [],
      nodes: [{ id: '100001', name: '购买按钮', type: 'Button', parentId: null, path: 'HUD/购买按钮', depth: 0, siblingIndex: 0, sourceFile: 'src/Data/CustomUIData.lua', sourceRange: null }],
    };
    const sceneSnapshot: SceneSnapshot = {
      schemaVersion: 1, snapshotId: 's'.repeat(64), bindingId: 'binding', role: 'Manual', sourceSha256: 'a'.repeat(64),
      observedAt: '2026-08-21T00:00:00.000Z', adapterId: 'strict-v1', instances: [], groups: [], issues: [], unknownFields: [],
    };
    const draft = buildGameplayKnowledgeDraft({ project: model().project, knowledgeFingerprint: model().project.knowledgeFingerprint, sourceIndex, registry, uiSnapshot, sceneSnapshot });
    expect(draft.requiresUserConfirmation).toBe(true);
    expect(draft.model.handlers).toContainEqual(expect.objectContaining({ event: 'purchase.request', side: 'server' }));
    expect(draft.graph.nodes).toContainEqual(expect.objectContaining({ kind: 'ui-control', externalId: '100001' }));
    expect(draft.assumptions).toContainEqual(expect.objectContaining({ kind: 'signal-semantics', status: 'needs-user-confirmation' }));
    expect(draft.model.handlers[0]?.branches[0]?.effects).toEqual([]);
    expect(draft.assumptions.map((entry) => entry.kind)).toEqual(expect.arrayContaining([
      'resource-bounds', 'transaction-contract', 'task-prerequisite', 'upgrade-prerequisite',
    ]));
    expect(draft.model.evidenceRequirements).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'scene-bounds', state: 'unverified' }),
      expect.objectContaining({ kind: 'physics-contact', state: 'unverified' }),
      expect.objectContaining({ kind: 'network-ordering', state: 'unverified' }),
    ]));
  });

  it('injects known project and scene issues into the draft without pretending to understand gameplay semantics', () => {
    const emptyIndex: LuaSourceIndex = { files: [], returnedModules: [], functions: [], calls: [], requires: [], stringLiterals: [], numericLiterals: [], configFields: [], idReferences: [], signalReferences: [] };
    const sceneSnapshot: SceneSnapshot = {
      schemaVersion: 1, snapshotId: '1'.repeat(64), bindingId: 'binding', role: 'Manual', sourceSha256: '2'.repeat(64),
      observedAt: '2026-08-21T00:00:00.000Z', adapterId: 'strict-v1', instances: [], groups: [], unknownFields: [],
      issues: [{ code: 'ORPHAN_OWNER', message: '父元件不存在', instanceId: '42' }],
    };
    const projectDiagnostics: ProjectDiagnostic[] = [{
      code: 'UNREGISTERED_ID_REFERENCE', severity: 'warning', message: 'ID 42 未登记', nextAction: '登记或确认删除',
      path: null, range: null, evidence: 'STATIC_LOCAL', runtimeVerified: false,
    }];
    const first = buildGameplayKnowledgeDraft({
      project: { ...model().project, sceneSnapshotId: sceneSnapshot.snapshotId }, knowledgeFingerprint: 'a'.repeat(64), sourceIndex: emptyIndex,
      registry: { schemaVersion: 1, records: [] }, uiSnapshot: null, sceneSnapshot, projectDiagnostics,
    });
    const second = buildGameplayKnowledgeDraft({
      project: { ...model().project, sceneSnapshotId: sceneSnapshot.snapshotId }, knowledgeFingerprint: 'b'.repeat(64), sourceIndex: emptyIndex,
      registry: { schemaVersion: 1, records: [] }, uiSnapshot: null, sceneSnapshot, projectDiagnostics,
    });
    expect(first.sourceFindings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'UNREGISTERED_ID_REFERENCE' }),
      expect.objectContaining({ code: 'SCENE_ORPHAN_OWNER' }),
    ]));
    expect(first.model.modelId).not.toBe(second.model.modelId);
  });

  it('preserves duplicate scene instance identities and nested group relationships as ambiguity evidence', () => {
    const evidence = { state: 'observed-repeatable' as const, source: 'anonymous-fixture', confidence: 0.8 };
    const instance = (ownerId: string | null) => ({
      instanceId: '42', elementTypeId: '7', ownerId, variant: 'standard' as const, evidence,
      transform: { state: 'absent' as const }, customProperties: { state: 'absent' as const }, signals: { state: 'absent' as const },
      resources: { state: 'absent' as const }, bounds: { state: 'absent' as const }, unknownFields: [],
    });
    const sceneSnapshot: SceneSnapshot = {
      schemaVersion: 1, snapshotId: 'c'.repeat(64), bindingId: 'binding', role: 'Manual', sourceSha256: 'd'.repeat(64),
      observedAt: '2026-08-21T00:00:00.000Z', adapterId: 'strict-v1',
      instances: [instance(null), instance('42')],
      groups: [
        { groupId: 'g1', memberIds: ['42'], nestedGroupIds: ['g2'], evidence },
        { groupId: 'g2', memberIds: [], nestedGroupIds: [], evidence },
      ],
      issues: [], unknownFields: [],
    };
    const emptyIndex: LuaSourceIndex = {
      files: [], returnedModules: [], functions: [], calls: [], requires: [], stringLiterals: [], numericLiterals: [],
      configFields: [], idReferences: [], signalReferences: [],
    };
    const draft = buildGameplayKnowledgeDraft({
      project: model().project, knowledgeFingerprint: model().project.knowledgeFingerprint, sourceIndex: emptyIndex, registry: { schemaVersion: 1, records: [] }, uiSnapshot: null, sceneSnapshot,
    });
    expect(draft.graph.nodes.filter((node) => node.kind === 'scene-instance' && node.externalId === '42')).toHaveLength(2);
    expect(draft.assumptions).toContainEqual(expect.objectContaining({
      prompt: expect.stringContaining('场景实例 ID 42 存在 2 个候选'),
      evidenceNodeIds: expect.arrayContaining(draft.graph.nodes.filter((node) => node.kind === 'scene-instance' && node.externalId === '42').map((node) => node.nodeId)),
    }));
    const groupNodes = draft.graph.nodes.filter((node) => node.kind === 'scene-group');
    expect(groupNodes).toHaveLength(2);
    expect(draft.graph.edges.some((edge) => edge.kind === 'member-of' && groupNodes.some((node) => node.nodeId === edge.from) && groupNodes.some((node) => node.nodeId === edge.to))).toBe(true);
  });

  it('preserves duplicate group occurrences instead of silently merging members', () => {
    const evidence = { state: 'observed-repeatable' as const, source: 'anonymous-fixture', confidence: 0.8 };
    const sceneSnapshot: SceneSnapshot = {
      schemaVersion: 1, snapshotId: 'e'.repeat(64), bindingId: 'binding', role: 'Manual', sourceSha256: 'f'.repeat(64),
      observedAt: '2026-08-21T00:00:00.000Z', adapterId: 'strict-v1', instances: [],
      groups: [
        { groupId: 'same', memberIds: ['1'], nestedGroupIds: [], evidence },
        { groupId: 'same', memberIds: ['2'], nestedGroupIds: [], evidence },
      ],
      issues: [], unknownFields: [],
    };
    const emptyIndex: LuaSourceIndex = { files: [], returnedModules: [], functions: [], calls: [], requires: [], stringLiterals: [], numericLiterals: [], configFields: [], idReferences: [], signalReferences: [] };
    const draft = buildGameplayKnowledgeDraft({ project: model().project, knowledgeFingerprint: model().project.knowledgeFingerprint, sourceIndex: emptyIndex, registry: { schemaVersion: 1, records: [] }, uiSnapshot: null, sceneSnapshot });
    expect(draft.graph.nodes.filter((node) => node.kind === 'scene-group' && node.externalId === 'same')).toHaveLength(2);
    expect(draft.assumptions).toContainEqual(expect.objectContaining({ kind: 'scene-meaning', prompt: expect.stringContaining('编组 ID same 存在 2 个候选') }));
  });

  it('binds a calibrated trigger box to the dedicated enter event and flags generic touch usage for review', () => {
    const evidence = { state: 'confirmed-calibration' as const, source: 'anonymous-fixture', confidence: 1 };
    const sceneSnapshot: SceneSnapshot = {
      schemaVersion: 1, snapshotId: '7'.repeat(64), bindingId: 'binding', role: 'Manual', sourceSha256: '8'.repeat(64),
      observedAt: '2026-08-21T00:00:00.000Z', adapterId: 'ym-layerdata-observed-v6',
      instances: [{
        instanceId: '517', elementTypeId: '1105000000000087', ownerId: '626', variant: 'component6-oneof-1', evidence,
        transform: { state: 'absent' }, customProperties: { state: 'absent' }, signals: { state: 'absent' },
        resources: { state: 'absent' }, bounds: { state: 'absent' }, unknownFields: [],
      }],
      groups: [], issues: [], unknownFields: [],
    };
    const touchLine = 'System:RegisterEvent(Events.ON_PLAYER_TOUCH_ELEMENT, function(playerId, elementId) end)';
    const location = { path: 'src/GameServer.lua', line: 2, column: 1, endLine: 2, endColumn: touchLine.length, context: touchLine };
    const sourceIndex: LuaSourceIndex = {
      files: [{ path: 'src/GameServer.lua', side: { value: 'server', evidence: 'file marker' } }],
      returnedModules: [], functions: [], requires: [], stringLiterals: [], numericLiterals: [], configFields: [], idReferences: [], signalReferences: [],
      calls: [{ ...location, qualifiedName: 'System:RegisterEvent', argumentCount: 2, arguments: [], side: { value: 'server', evidence: 'file marker' } }],
    };
    const draft = buildGameplayKnowledgeDraft({
      project: model().project, knowledgeFingerprint: model().project.knowledgeFingerprint, sourceIndex,
      registry: { schemaVersion: 1, records: [] }, uiSnapshot: null, sceneSnapshot,
    });
    expect(draft.graph.nodes).toContainEqual(expect.objectContaining({ kind: 'scene-instance', externalId: '517', label: expect.stringContaining('信号触发盒') }));
    expect(draft.assumptions).not.toContainEqual(expect.objectContaining({ kind: 'scene-event-compatibility' }));
    expect(draft.assumptions).not.toContainEqual(expect.objectContaining({ kind: 'scene-event-capability' }));
    expect(draft.sourceFindings).toContainEqual(expect.objectContaining({
      code: 'TRIGGER_BOX_TOUCH_EVENT_REVIEW_REQUIRED', severity: 'warning',
    }));
    expect(draft.model.sceneEventBindings ?? []).toEqual([]);

    const referencedSourceIndex: LuaSourceIndex = {
      ...sourceIndex,
      calls: [{ ...sourceIndex.calls[0]!, sceneInstanceGuards: ['517'] }],
    };
    const referencedDraft = buildGameplayKnowledgeDraft({
      project: model().project, knowledgeFingerprint: model().project.knowledgeFingerprint, sourceIndex: referencedSourceIndex,
      registry: { schemaVersion: 1, records: [] }, uiSnapshot: null, sceneSnapshot,
    });
    expect(referencedDraft.assumptions).toContainEqual(expect.objectContaining({
      kind: 'scene-event-compatibility',
      prompt: expect.stringContaining('Events.ON_CHARACTER_ENTER_SIGNAL_BOX'),
    }));
    expect(referencedDraft.assumptions).toContainEqual(expect.objectContaining({
      kind: 'scene-event-capability',
      prompt: expect.stringContaining('Events.ON_CHARACTER_LEAVE_SIGNAL_BOX'),
    }));
    expect(referencedDraft.model.sceneEventBindings).toContainEqual({
      instanceId: '517', status: 'unconfirmed', interaction: 'character-enter-trigger',
      eventName: 'Events.ON_CHARACTER_ENTER_SIGNAL_BOX', handlerId: null,
    });

    // 没有在玩法模型中声明的场景信号盒不属于本次流程契约，不能因为地图里存在
    // 其他信号盒就强制所有模型补绑定；只有显式 sceneEventBindings 才进入门禁。
    const missing = reviewGameplaySceneEventBindings(model(), sceneSnapshot, new Map());
    expect(missing).toEqual([]);
    const configurationReferenceIndex: LuaSourceIndex = {
      ...sourceIndex,
      idReferences: [{
        path: 'src/Common/StoreConfig.lua', line: 1, column: 1, endLine: 1, endColumn: 4,
        context: 'signalBoxId = 517', value: '517', kind: 'id', registryKind: null,
        idDomain: 'scene-instance', confidence: 'inferred',
        evidence: { source: 'config', field: 'build.FOUNDATION.signalBoxId' },
      }],
    };
    expect(reviewGameplaySceneEventBindings(model(), sceneSnapshot, new Map(), configurationReferenceIndex)).toEqual([]);
    const unconfirmedModel = { ...model(), sceneEventBindings: referencedDraft.model.sceneEventBindings };
    expect(reviewGameplaySceneEventBindings(unconfirmedModel, sceneSnapshot, new Map())).toContainEqual(
      expect.objectContaining({ code: 'SCENE_EVENT_BINDING_UNCONFIRMED', severity: 'error' }),
    );
    const wrongModel = { ...model(), sceneEventBindings: [{
      instanceId: '517', status: 'event-bound' as const, interaction: 'character-enter-trigger' as const,
      eventName: 'Events.ON_PLAYER_TOUCH_ELEMENT', handlerId: 'ping',
    }] };
    expect(reviewGameplaySceneEventBindings(wrongModel, sceneSnapshot, new Map())).toContainEqual(
      expect.objectContaining({ code: 'SCENE_CAPABILITY_MISMATCH', severity: 'error' }),
    );
    const correctModel: GameplayModel = {
      ...model(),
      externalEvents: ['ping', 'Events.ON_CHARACTER_ENTER_SIGNAL_BOX'],
      eventPolicies: [
        ...(model().eventPolicies ?? []),
        {
          event: 'Events.ON_CHARACTER_ENTER_SIGNAL_BOX', authority: 'engine', playerRequired: true,
          duplicatePolicy: 'allow', targetSide: 'server', observableEffectRequired: true,
        },
      ],
      handlers: [
        ...model().handlers,
        { handlerId: 'signal-box-enter', event: 'Events.ON_CHARACTER_ENTER_SIGNAL_BOX', side: 'server', branches: [{ branchId: 'entered', effects: [] }] },
      ],
      sceneEventBindings: [{
        instanceId: '517', status: 'event-bound', interaction: 'character-enter-trigger',
        eventName: 'Events.ON_CHARACTER_ENTER_SIGNAL_BOX', handlerId: 'signal-box-enter',
      }],
    };
    expect(reviewGameplaySceneEventBindings(correctModel, sceneSnapshot, new Map())).toEqual([]);
    expect(reviewGameplaySceneEventBindings(correctModel, sceneSnapshot, new Map(), sourceIndex)).toContainEqual(
      expect.objectContaining({ code: 'SCENE_EVENT_BINDING_UNCONFIRMED', severity: 'error', message: expect.stringContaining('Lua 索引未找到') }),
    );
    const enterIndex = buildLuaSourceIndex([{
      path: 'src/GameServer.lua',
      source: [
        '---@ymai-side server',
        'System:RegisterEvent(',
        '  Events.ON_CHARACTER_ENTER_SIGNAL_BOX,',
        '  function(playerId, signalBoxId) end',
        ')',
      ].join('\n'),
    }], { schemaVersion: 1, records: [] }, { calls: [], configuredIdFields: [] });
    expect(reviewGameplaySceneEventBindings(correctModel, sceneSnapshot, new Map(), enterIndex)).toEqual([]);

    const secondTriggerScene = structuredClone(sceneSnapshot);
    secondTriggerScene.instances.push({ ...structuredClone(sceneSnapshot.instances[0]!), instanceId: '518' });
    const twoTriggerModel: GameplayModel = {
      ...correctModel,
      sceneEventBindings: [
        ...correctModel.sceneEventBindings!,
        { instanceId: '518', status: 'not-used', interaction: null, eventName: null, handlerId: null },
      ],
    };
    // 第二个触发盒明确标为 not-used，不应把它当作本流程的事件入口，也不应
    // 因为地图中存在它就要求 517 的回调证明全局分发保护。
    expect(reviewGameplaySceneEventBindings(twoTriggerModel, secondTriggerScene, new Map(), enterIndex)).toEqual([]);
    const guardedEnterIndex = buildLuaSourceIndex([{
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
      ].join('\n'),
    }], { schemaVersion: 1, records: [] }, { calls: [], configuredIdFields: [] });
    expect(reviewGameplaySceneEventBindings(twoTriggerModel, secondTriggerScene, new Map(), guardedEnterIndex)).toEqual([]);
    expect(reviewGameplaySceneEventBindings({ ...model(), sceneEventBindings: [{
      instanceId: '517', status: 'not-used' as const, interaction: null, eventName: null, handlerId: null,
    }] }, sceneSnapshot, new Map())).toEqual([]);
    expect(reviewGameplaySceneEventBindings(correctModel, sceneSnapshot, new Map([['517', {
      state: 'unique' as const,
      evidence: {
        instanceId: '517', snapshotId: sceneSnapshot.snapshotId, sceneSourceSha256: sceneSnapshot.sourceSha256,
        importedAt: '2026-08-21T03:00:00.000Z', elementState: 'present' as const,
        logicElementState: 'absent' as const, triggerBoxState: 'absent' as const,
        triggerSampleState: 'not-applicable' as const, triggerSample: null, fields: {}, fieldConflicts: [],
      },
    }]]))).toContainEqual(expect.objectContaining({ code: 'SCENE_EVIDENCE_INSUFFICIENT', severity: 'error' }));
    const noHandler = { ...correctModel, handlers: model().handlers };
    expect(reviewGameplaySceneEventBindings(noHandler, sceneSnapshot, new Map())).toContainEqual(
      expect.objectContaining({ code: 'SCENE_EVENT_BINDING_UNCONFIRMED', severity: 'error' }),
    );
    const wrongIntent = structuredClone(correctModel);
    wrongIntent.sceneEventBindings![0]!.eventName = 'Events.ON_CHARACTER_LEAVE_SIGNAL_BOX';
    expect(reviewGameplaySceneEventBindings(wrongIntent, sceneSnapshot, new Map())).toContainEqual(
      expect.objectContaining({ code: 'SCENE_CAPABILITY_MISMATCH', severity: 'error' }),
    );
    const wrongAuthority = structuredClone(correctModel);
    wrongAuthority.eventPolicies!.find((entry) => entry.event === 'Events.ON_CHARACTER_ENTER_SIGNAL_BOX')!.authority = 'server-only';
    expect(reviewGameplaySceneEventBindings(wrongAuthority, sceneSnapshot, new Map())).toContainEqual(
      expect.objectContaining({ code: 'SCENE_EVENT_BINDING_UNCONFIRMED', severity: 'error' }),
    );
    expect(reviewGameplaySceneEventBindings(correctModel, null, new Map())).toContainEqual(
      expect.objectContaining({ code: 'SCENE_EVENT_BINDING_STALE', severity: 'error' }),
    );
    const duplicateScene = structuredClone(sceneSnapshot);
    duplicateScene.instances.push(structuredClone(duplicateScene.instances[0]!));
    expect(reviewGameplaySceneEventBindings(correctModel, duplicateScene, new Map())).toContainEqual(
      expect.objectContaining({ code: 'SCENE_EVENT_BINDING_STALE', severity: 'error' }),
    );
    expect(reviewGameplaySceneEventBindings(correctModel, sceneSnapshot, new Map([['517', {
      state: 'unique' as const,
      evidence: {
        instanceId: '517', snapshotId: '0'.repeat(64), sceneSourceSha256: sceneSnapshot.sourceSha256,
        importedAt: '2026-08-21T03:00:00.000Z', elementState: 'present' as const,
        logicElementState: 'absent' as const, triggerBoxState: 'present' as const,
        triggerSampleState: 'ok' as const, triggerSample: [0, 0, 0] as [number, number, number], fields: {}, fieldConflicts: [],
      },
    }]]))).toContainEqual(expect.objectContaining({ code: 'SCENE_EVIDENCE_INSUFFICIENT', severity: 'error' }));
  });

  it('refreshes only current evidence metadata and preserves the confirmed gameplay model', () => {
    const currentProject = {
      projectInstanceId: model().project.projectInstanceId,
      mapFingerprint: 'd'.repeat(64),
      sceneSnapshotId: 'e'.repeat(64),
      knowledgeFingerprint: 'f'.repeat(64),
    };
    const refreshed = refreshGameplayEvidence(model(), currentProject);
    expect(refreshed.refreshed).toBe(true);
    expect(refreshed.changedKeys).toEqual(['mapFingerprint', 'sceneSnapshotId', 'knowledgeFingerprint']);
    expect(refreshed.model.project).toEqual(currentProject);
    expect(refreshed.model.handlers).toEqual(model().handlers);
    expect(refreshed.model.externalEvents).toEqual(model().externalEvents);

    const inputScenario = scenario(1);
    const rebound = refreshGameplayScenarioBinding(inputScenario, model(), refreshed.model);
    expect(rebound.modelBinding).toEqual({
      modelId: refreshed.model.modelId,
      modelFingerprint: gameplayModelFingerprint(refreshed.model),
      ...currentProject,
    });
    expect(refreshGameplayEvidence(refreshed.model, currentProject).refreshed).toBe(false);
  });

  it('rejects evidence refresh across project instances and keeps unknown API findings non-blocking only for model simulation', () => {
    expect(() => refreshGameplayEvidence(model(), {
      projectInstanceId: '00000000-0000-4000-8000-000000000002',
      mapFingerprint: null,
      sceneSnapshotId: null,
      knowledgeFingerprint: 'f'.repeat(64),
    })).toThrow('另一个工程');
    const diagnostics: ProjectDiagnostic[] = [{
      code: 'UNKNOWN_OFFICIAL_API', severity: 'error', message: 'Element:SetTransparency 未找到官方声明。',
      nextAction: '核对官方 API。', path: null, range: null, evidence: 'STATIC_LOCAL', runtimeVerified: false,
    }, {
      code: 'SCENE_CAPABILITY_MISMATCH', severity: 'error', message: '场景交互能力不匹配。',
      nextAction: '修正场景绑定。', path: null, range: null, evidence: 'STATIC_LOCAL', runtimeVerified: false,
    }];
    const simulationDiagnostics = prepareGameplaySimulationDiagnostics(diagnostics);
    expect(simulationDiagnostics[0]).toEqual(expect.objectContaining({ severity: 'warning', code: 'UNKNOWN_OFFICIAL_API' }));
    expect(simulationDiagnostics[0]?.message).toContain('纯模型模拟不执行 Lua');
    expect(simulationDiagnostics[1]).toEqual(diagnostics[1]);
  });

  it('does not turn every unreferenced unknown scene instance into a gameplay confirmation task', () => {
    const evidence = { state: 'observed-repeatable' as const, source: 'anonymous-fixture', confidence: 0.9 };
    const baseInstance = {
      ownerId: null, variant: 'unknown' as const, evidence,
      transform: { state: 'absent' as const }, customProperties: { state: 'absent' as const }, signals: { state: 'absent' as const },
      resources: { state: 'absent' as const }, bounds: { state: 'absent' as const }, unknownFields: [],
    };
    const sceneSnapshot: SceneSnapshot = {
      schemaVersion: 1, snapshotId: '3'.repeat(64), bindingId: 'binding', role: 'Manual', sourceSha256: '4'.repeat(64),
      observedAt: '2026-08-21T00:00:00.000Z', adapterId: 'ym-layerdata-observed-v6',
      instances: [
        { ...baseInstance, instanceId: '901', elementTypeId: '9999999999999999' },
        { ...baseInstance, instanceId: '517', elementTypeId: '1105000000000087', variant: 'component6-oneof-1' },
      ],
      groups: [], issues: [], unknownFields: [],
    };
    const emptyIndex: LuaSourceIndex = {
      files: [], returnedModules: [], functions: [], calls: [], requires: [], stringLiterals: [], numericLiterals: [],
      configFields: [], idReferences: [], signalReferences: [],
    };

    const draft = buildGameplayKnowledgeDraft({
      project: model().project, knowledgeFingerprint: model().project.knowledgeFingerprint, sourceIndex: emptyIndex,
      registry: { schemaVersion: 1, records: [] }, uiSnapshot: null, sceneSnapshot,
    });

    expect(draft.graph.nodes).toContainEqual(expect.objectContaining({ kind: 'scene-instance', externalId: '901' }));
    expect(draft.assumptions.some((entry) => entry.evidenceNodeIds.some((nodeId) => (
      draft.graph.nodes.some((node) => node.nodeId === nodeId && node.externalId === '901')
    )))).toBe(false);
    expect(draft.assumptions).not.toContainEqual(expect.objectContaining({
      kind: 'scene-event-compatibility', prompt: expect.stringContaining('实例 517'),
    }));
  });

  it('includes observed scene signals, custom properties and root metadata in the AI knowledge graph', () => {
    const evidence = { state: 'observed-repeatable' as const, source: 'anonymous-fixture', confidence: 0.9 };
    const sceneSnapshot: SceneSnapshot = {
      schemaVersion: 1, snapshotId: '4'.repeat(64), bindingId: 'binding', role: 'Manual', sourceSha256: '5'.repeat(64),
      observedAt: '2026-08-21T00:00:00.000Z', adapterId: 'ym-layerdata-observed-v6',
      instances: [{
        instanceId: '901', elementTypeId: '1101002001034000', ownerId: '908', variant: 'component6-oneof-11', evidence,
        transform: { state: 'absent' },
        customProperties: { state: 'observed', value: [{ key: '测试立方体', value: 66 }], evidence },
        signals: { state: 'observed', value: [{ name: '测试冰箱' }], evidence },
        resources: { state: 'absent' }, bounds: { state: 'absent' }, unknownFields: [],
      }],
      groups: [{ groupId: '908', memberIds: ['901'], nestedGroupIds: [], evidence }], issues: [], unknownFields: [],
      signalRegistry: { state: 'observed', value: [{ name: '测试冰箱', unknownRefCount: 1 }], evidence },
      sceneMetadata: {
        layerName: { state: 'observed', value: '主图层', evidence },
        editorVersionCandidate: { state: 'observed', value: '1.5.82.106', evidence },
        instanceIndex: { state: 'absent' },
      },
    };
    const emptyIndex: LuaSourceIndex = { files: [], returnedModules: [], functions: [], calls: [], requires: [], stringLiterals: [], numericLiterals: [], configFields: [], idReferences: [], signalReferences: [] };
    const draft = buildGameplayKnowledgeDraft({
      project: model().project, knowledgeFingerprint: model().project.knowledgeFingerprint, sourceIndex: emptyIndex,
      registry: { schemaVersion: 1, records: [] }, uiSnapshot: null, sceneSnapshot,
    });
    expect(draft.graph.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'scene-signal', label: '测试冰箱' }),
      expect.objectContaining({ kind: 'scene-property', label: expect.stringContaining('测试立方体=66') }),
      expect.objectContaining({ kind: 'scene-metadata', label: expect.stringContaining('主图层') }),
      expect.objectContaining({ kind: 'scene-metadata', label: expect.stringContaining('1.5.82.106') }),
    ]));
    expect(draft.assumptions).toContainEqual(expect.objectContaining({
      kind: 'signal-semantics', prompt: expect.stringContaining('测试冰箱'),
    }));
  });
});

describe('gameplay population report', () => {
  it('runs separate 1/2/4/8-player populations and never hides a multiplayer failure behind a single-player pass', () => {
    const scenarios = [1, 2, 4, 8].map((count) => scenario(count));
    scenarios[1]!.steps.push({ kind: 'expect', ref: { scope: 'player', path: 'count', playerId: 'p2' }, operator: 'eq', value: 2 });
    const matrix = runGameplayPopulationMatrix(model(), scenarios);
    expect(matrix.populations.map((entry) => entry.playerCount)).toEqual([1, 2, 4, 8]);
    expect(matrix.populations[0]?.status).toBe('pass');
    expect(matrix.populations[1]?.status).toBe('fail');
    expect(matrix.status).toBe('fail');
  });

  it('renders a deterministic privacy-safe report with coverage scoped to declared model branches', () => {
    const matrix = runGameplayPopulationMatrix(model(), [1, 2, 4, 8].map((count) => scenario(count)));
    const privatePath = ['C:', 'private', 'map.lua'].join('/');
    const otherPrivatePath = ['D:', 'secret'].join('/');
    const networkPrivatePath = ['', '', 'server', 'share', 'map.lua'].join('\\');
    const unixPrivatePath = ['', 'opt', 'private', 'map.lua'].join('/');
    const diagnostics: ProjectDiagnostic[] = [{
      code: 'UNREGISTERED_ID_REFERENCE', severity: 'warning', message: `contains ${privatePath} and ${networkPrivatePath}`, nextAction: `fix ${otherPrivatePath} or ${unixPrivatePath}`,
      path: privatePath, range: null, evidence: 'STATIC_LOCAL', runtimeVerified: false,
    }];
    const runSummary = {
      mode: 'auto' as const,
      classification: 'partial-needs-editor' as const,
      strictStaticGate: 'blocked' as const,
      simulationGate: 'pass' as const,
      executedScenarioIds: ['scenario-1'],
      skippedFlows: [{ flowId: 'skipped-1', reasonCode: 'NEEDS_EDITOR', needsEditor: true, evidence: [] }],
      truncated: false,
    };
    const first = createGameplayTestReport(model(), matrix, { projectDiagnostics: diagnostics, runSummary });
    expect(createGameplayTestReport(model(), matrix, { projectDiagnostics: diagnostics, runSummary })).toEqual(first);
    const serialized = JSON.stringify(first);
    const markdown = renderGameplayTestReportMarkdown(first);
    expect(serialized).not.toMatch(/[A-Z]:[\\/]/u);
    expect(markdown).not.toMatch(/[A-Z]:[\\/]/u);
    expect(serialized).not.toContain('server\\share');
    expect(serialized).not.toContain('/opt/private');
    expect(markdown).toContain('运行模式：auto');
    expect(markdown).toContain('运行分类：partial-needs-editor');
    expect(markdown).toContain('严格静态门：blocked');
    expect(markdown).toContain('模拟准入门：pass');
    expect(markdown).toContain('实际执行场景：scenario-1');
    expect(markdown).toContain('跳过流程：skipped-1/NEEDS_EDITOR');
    expect(first.coverage.scope).toBe('declared-model-branches');
    expect(first.evidence.sceneEvidence).toBe('NOT_AVAILABLE');
    expect(markdown).toContain('多人模式');
    expect(markdown).toContain('SCENE_EVIDENCE / NOT_AVAILABLE');
    expect(markdown).toContain('官方编辑器');
    expect(first.nextActions.length).toBeGreaterThan(0);
    expect(first.nextActions.every((entry) => entry.autoApply === false)).toBe(true);
    expect(first.nextActions.map((entry) => entry.kind)).not.toContain('lua-auto-patch');
    expect(first.nextActions.find((entry) => entry.kind === 'official-editor-test')?.description).toContain('2/4/8 人');
    expect(markdown).toContain('建议下一步（只预览，不自动改 Lua）');
  });

  it('reports stale scene evidence independently and never upgrades it to editor proof', () => {
    const staleModel = model();
    staleModel.project.sceneSnapshotId = 'd'.repeat(64);
    staleModel.evidenceRequirements = [{
      requirementId: 'shelf-contact', kind: 'physics-contact', state: 'stale', description: '货柜底面接触地板顶面',
    }];
    const scenarios = [1, 2, 4, 8].map((count) => {
      const input = scenario(count);
      input.modelBinding = { modelId: staleModel.modelId, modelFingerprint: gameplayModelFingerprint(staleModel), ...staleModel.project };
      return input;
    });
    const report = createGameplayTestReport(staleModel, runGameplayPopulationMatrix(staleModel, scenarios));
    expect(report.status).toBe('needs-editor');
    expect(report.evidence.sceneEvidence).toBe('STALE');
    expect(renderGameplayTestReportMarkdown(report)).toContain('SCENE_EVIDENCE / STALE');
  });

  it('does not accept a confirmed engine requirement without sufficient editor evidence', () => {
    const insufficient = model();
    insufficient.evidenceRequirements = [{
      requirementId: 'real-network-order', kind: 'network-ordering', state: 'confirmed', description: '真实多人顺序', evidence: 'STATIC_LOCAL',
    }];
    const input = scenario(2, insufficient);
    const result = runGameplayScenario(insufficient, input);
    expect(result.status).toBe('needs-editor');
    expect(result.editorRequirements).toContainEqual(expect.objectContaining({ requirementId: 'real-network-order' }));
    expect(result.staticFindings).toContainEqual(expect.objectContaining({ code: 'CONFIRMED_EVIDENCE_INSUFFICIENT' }));
  });

  it('fails the report when an eight-player population exercises required player branches only for p1', () => {
    const scenarios = [1, 2, 4, 8].map((count) => scenario(count));
    scenarios[3]!.steps = scenarios[3]!.steps.filter((step) => step.kind !== 'dispatch' || step.playerId === 'p1');
    const report = createGameplayTestReport(model(), runGameplayPopulationMatrix(model(), scenarios));
    expect(report.status).toBe('fail');
    expect(report.coverage.byPopulation.find((entry) => entry.playerCount === 8)?.byPlayer.find((entry) => entry.playerId === 'p8')?.ratio).toBe(0);
  });

  it('counts only handled broadcast deliveries and reports a player who left before delayed delivery as missing', () => {
    const broadcastModel = model();
    broadcastModel.externalEvents.push('announce.delayed');
    broadcastModel.eventPolicies?.push(
      { event: 'announce.delayed', authority: 'server-only', playerRequired: true, duplicatePolicy: 'allow', targetSide: 'server', observableEffectRequired: true },
      { event: 'notice.delayed', authority: 'server-only', playerRequired: true, duplicatePolicy: 'allow', targetSide: 'client', observableEffectRequired: true },
    );
    broadcastModel.handlers.push(
      { handlerId: 'announce-delayed', event: 'announce.delayed', side: 'server', branches: [{ branchId: 'broadcast', effects: [{ kind: 'emit', event: 'notice.delayed', delayMilliseconds: 100, routing: 'broadcast' }] }] },
      { handlerId: 'notice-delayed', event: 'notice.delayed', side: 'client', branches: [{ branchId: 'show', effects: [{ kind: 'set', target: { scope: 'client', path: 'visible' }, value: { kind: 'literal', value: true } }] }] },
    );
    const input = scenario(2, broadcastModel);
    input.steps = [
      { kind: 'dispatch', event: 'announce.delayed', source: 'server', playerId: 'p1' },
      { kind: 'leave', playerId: 'p2' },
      { kind: 'advance', milliseconds: 100 },
    ];
    const report = createGameplayTestReport(broadcastModel, runGameplayPopulationMatrix(broadcastModel, [input], { requiredPlayerCounts: [2] }));
    expect(report.populations[0]?.broadcastDeliveries).toContainEqual(expect.objectContaining({
      expectedRecipientPlayerIds: ['p1', 'p2'], actualRecipientPlayerIds: ['p1'], missingRecipientPlayerIds: ['p2'],
    }));
  });

  it('does not report pass when a declared required branch remains uncovered', () => {
    const uncovered = model();
    uncovered.handlers[0]!.branches[0]!.when = {
      kind: 'compare', operator: 'gte', left: { kind: 'read', ref: { scope: 'player', path: 'count' } }, right: { kind: 'literal', value: 0 },
    };
    uncovered.handlers[0]!.branches.push({
      branchId: 'required-never-visited', coverageRequired: true,
      when: { kind: 'compare', operator: 'lt', left: { kind: 'read', ref: { scope: 'player', path: 'count' } }, right: { kind: 'literal', value: 0 } },
      effects: [],
    });
    const matrix = runGameplayPopulationMatrix(uncovered, [1, 2, 4, 8].map((count) => scenario(count, uncovered)));
    const report = createGameplayTestReport(uncovered, matrix);
    expect(report.coverage.ratio).toBe(0.5);
    expect(report.status).toBe('fail');
    expect(report.findings).toContainEqual(expect.objectContaining({ code: 'DECLARED_BRANCH_COVERAGE_INCOMPLETE' }));
    expect(report.coverage.byPopulation.map((entry) => entry.playerCount)).toEqual([1, 2, 4, 8]);
    expect(report.coverage.byPopulation.find((entry) => entry.playerCount === 4)?.byPlayer).toHaveLength(4);
  });
});

describe('gameplay deterministic replay', () => {
  it('replays only the exact model/scenario fingerprints and reproduces the same report id', () => {
    const inputModel = model();
    const inputScenario = scenario(2);
    const result = runGameplayScenario(inputModel, inputScenario);
    const artifact = createGameplayReplayArtifact(inputModel, inputScenario, result);
    expect(replayGameplayScenario(inputModel, inputScenario, artifact).reportId).toBe(result.reportId);

    const changed = structuredClone(inputScenario);
    changed.steps.push({ kind: 'advance', milliseconds: 1 });
    expect(() => replayGameplayScenario(inputModel, changed, artifact)).toThrow(/指纹|重放/u);
    expect(JSON.stringify(artifact)).not.toMatch(/[A-Z]:[\\/]/u);
  });
});
