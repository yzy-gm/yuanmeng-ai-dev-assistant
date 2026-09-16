import { access, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { nodeFileIO } from '../../src/core/fs.js';
import { GameplayRunStore, createNodeGameplayRunStoreIO } from '../../src/core/gameplay/run-store.js';
import { gameplayModelFingerprint } from '../../src/core/gameplay/model.js';
import { runGameplayWorkflow } from '../../src/core/gameplay/workflow.js';
import { buildLuaSourceIndex, type LuaSourceFile } from '../../src/core/lua/source-index.js';
import type { RegistryDocument } from '../../src/core/model.js';
import type { GameplayModel, GameplayScenario } from '../../src/core/gameplay/types.js';

const roots: string[] = [];
const registry: RegistryDocument = { schemaVersion: 1, records: [] };
const api = { calls: [], configuredIdFields: [] };

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ymai-gameplay-workflow-'));
  roots.push(root);
  return root;
}

const luaFiles: LuaSourceFile[] = [{
  path: 'src/GameEntry.lua',
  source: ['---@ymai-side server', 'System:RegisterEvent("workflow.event", function()', '  UI:Show()', 'end)'].join('\n'),
}];

function project(knowledgeFingerprint = 'a'.repeat(64)) {
  return {
    projectInstanceId: '55555555-5555-4555-8555-555555555555',
    mapFingerprint: null,
    sceneSnapshotId: null,
    knowledgeFingerprint,
  };
}

function common(root: string, knowledgeFingerprint = 'a'.repeat(64)) {
  return {
    root,
    currentProject: project(knowledgeFingerprint),
    luaFiles,
    strictDiagnostics: [],
    strictPreparationFindings: [],
    sourceIndex: buildLuaSourceIndex(luaFiles, registry, api),
    eventMetadata: new Map(),
    registry,
    uiSnapshot: null,
    sceneSnapshot: null,
    runtimeCapabilities: new Map(),
  };
}

function store(runId: string): GameplayRunStore {
  return new GameplayRunStore({
    io: createNodeGameplayRunStoreIO(nodeFileIO),
    runIdFactory: () => runId,
    clock: () => new Date('2026-08-26T03:00:00.000Z'),
  });
}

function manualModel(knowledgeFingerprint = 'a'.repeat(64)): GameplayModel {
  return {
    schemaVersion: 1, modelId: 'manual-model', project: project(knowledgeFingerprint),
    externalEvents: ['manual.event'],
    eventPolicies: [{ event: 'manual.event', authority: 'server-only', playerRequired: false, duplicatePolicy: 'allow', targetSide: 'server', observableEffectRequired: true }],
    initialState: { shared: { done: false }, player: {}, client: {} },
    handlers: [{ handlerId: 'manual-handler', event: 'manual.event', side: 'server', branches: [{
      branchId: 'manual-branch', effects: [{ kind: 'set', target: { scope: 'shared', path: 'done' }, value: { kind: 'literal', value: true } }],
    }] }],
    invariants: [], evidenceRequirements: [], multiplayer: { maximumPlayers: 8, rejoinPolicy: 'retain-player-reset-client' },
  };
}

function manualScenarios(inputModel: GameplayModel): GameplayScenario[] {
  return [1, 2, 4, 8].map((count) => ({
    schemaVersion: 1, scenarioId: `manual-${count}`, name: `${count}`,
    modelBinding: { modelId: inputModel.modelId, modelFingerprint: gameplayModelFingerprint(inputModel), ...inputModel.project },
    players: Array.from({ length: count }, (_, index) => `p${index + 1}`),
    limits: { maxEvents: 20, maxVirtualMilliseconds: 1000, maxVisitedStates: 20, maxBranches: 20 },
    steps: [{ kind: 'dispatch', event: 'manual.event', source: 'server', targetSide: 'server' }],
  }));
}

describe('shared gameplay workflow', () => {
  it('is deterministic across automatic runs except for the run id', async () => {
    const root = await temporaryRoot();
    const first = await runGameplayWorkflow({ ...common(root), mode: 'auto', store: store('workflow-run-one') });
    const second = await runGameplayWorkflow({ ...common(root), mode: 'auto', store: store('workflow-run-two') });

    expect(first.run?.manifest.runId).toBe('workflow-run-one');
    expect(second.run?.manifest.runId).toBe('workflow-run-two');
    expect(second.modelFingerprint).toBe(first.modelFingerprint);
    expect(second.scenarioFingerprint).toBe(first.scenarioFingerprint);
    expect(second.classification).toBe(first.classification);
    expect(second.executedScenarioIds).toEqual(first.executedScenarioIds);
    expect(first.executedScenarioIds.length).toBeGreaterThan(0);
  });

  it('fails closed for a manually confirmed model after current Lua knowledge changes', async () => {
    const root = await temporaryRoot();
    const staleModel = manualModel('a'.repeat(64));
    const result = await runGameplayWorkflow({
      ...common(root, 'b'.repeat(64)),
      mode: 'manual',
      manual: { model: staleModel, scenarios: manualScenarios(staleModel), outputRoot: join(root, 'explicit-output') },
    });

    expect(result.classification).toBe('not-run-fatal');
    expect(result.report).toBeNull();
    expect(result.model.project.knowledgeFingerprint).toBe('a'.repeat(64));
    expect(result.simulationGate.status).toBe('blocked');
  });

  it('does not read manual specs in auto mode and never creates latest in manual mode', async () => {
    const autoRoot = await temporaryRoot();
    const manualArtifactRoot = join(autoRoot, '.yuanmeng-inspector', 'gameplay');
    await mkdir(join(manualArtifactRoot, 'scenarios'), { recursive: true });
    await writeFile(join(manualArtifactRoot, 'spec.json'), '{broken', 'utf8');
    await writeFile(join(manualArtifactRoot, 'scenarios', 'broken.json'), '{broken', 'utf8');
    const automatic = await runGameplayWorkflow({ ...common(autoRoot), mode: 'auto', store: store('auto-ignores-manual') });
    expect(automatic.executedScenarioIds.length).toBeGreaterThan(0);

    const manualRoot = await temporaryRoot();
    const inputModel = manualModel();
    await runGameplayWorkflow({
      ...common(manualRoot),
      mode: 'manual',
      manual: { model: inputModel, scenarios: manualScenarios(inputModel), outputRoot: join(manualRoot, 'explicit-output') },
    });
    await expect(access(join(manualRoot, '.yuanmeng-inspector', 'gameplay', 'latest.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(join(manualRoot, 'explicit-output', 'gameplay-report.json'))).resolves.toBeUndefined();
  });

  it('supports an automatic in-memory preview without committing a run or latest pointer', async () => {
    const root = await temporaryRoot();
    const result = await runGameplayWorkflow({
      ...common(root),
      mode: 'auto',
      persist: false,
      store: store('preview-must-not-commit'),
    });

    expect(result.classification).toBe('partial-needs-editor');
    expect(result.report).not.toBeNull();
    expect(result.run).toBeNull();
    await expect(access(join(root, '.yuanmeng-inspector', 'gameplay', 'latest.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
