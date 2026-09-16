import { mkdtemp, mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { nodeFileIO } from '../../src/core/fs.js';
import { GameplayRunStore, createNodeGameplayRunStoreIO, type GameplayRunCommitPhase } from '../../src/core/gameplay/run-store.js';
import { gameplayModelFingerprint } from '../../src/core/gameplay/model.js';
import type { GameplayModel, GameplayScenario } from '../../src/core/gameplay/types.js';

const roots: string[] = [];

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'ymai-gameplay-run-store-'));
  roots.push(value);
  return value;
}

function model(knowledgeFingerprint = 'a'.repeat(64)): GameplayModel {
  return {
    schemaVersion: 1, modelId: 'stored-model',
    project: { projectInstanceId: '33333333-3333-4333-8333-333333333333', mapFingerprint: null, sceneSnapshotId: null, knowledgeFingerprint },
    externalEvents: ['stored.event'],
    eventPolicies: [{ event: 'stored.event', authority: 'server-only', playerRequired: false, duplicatePolicy: 'allow', targetSide: 'server', observableEffectRequired: true }],
    initialState: { shared: { observed: false }, player: {}, client: {} },
    handlers: [{ handlerId: 'stored-handler', event: 'stored.event', side: 'server', branches: [{
      branchId: 'stored-branch', coverageRequired: false,
      effects: [{ kind: 'set', target: { scope: 'shared', path: 'observed' }, value: { kind: 'literal', value: true } }],
    }] }],
    invariants: [], evidenceRequirements: [], multiplayer: { maximumPlayers: 2, rejoinPolicy: 'retain-player-reset-client' },
  };
}

function scenario(inputModel: GameplayModel): GameplayScenario {
  return {
    schemaVersion: 1, scenarioId: 'stored-scenario', name: 'stored scenario',
    modelBinding: { modelId: inputModel.modelId, modelFingerprint: gameplayModelFingerprint(inputModel), ...inputModel.project },
    players: ['p1'], limits: { maxEvents: 20, maxVirtualMilliseconds: 1000, maxVisitedStates: 20, maxBranches: 20 },
    steps: [{ kind: 'dispatch', event: 'stored.event', source: 'server', targetSide: 'server' }],
  };
}

function input(rootPath: string, inputModel = model()) {
  return {
    root: rootPath,
    mode: 'auto' as const,
    project: inputModel.project,
    model: inputModel,
    scenarios: [scenario(inputModel)],
    strictReview: { schemaVersion: 1, kind: 'CODEX_REVIEW_INPUT', safe: true },
    strictReviewMarkdown: '# strict\n',
    simulationReport: { schemaVersion: 1, reportId: 'safe-report' },
    simulationReportMarkdown: '# simulation\n',
    strictStaticGate: 'blocked' as const,
    simulationGate: 'pass' as const,
    classification: 'model-pass' as const,
  };
}

function store(runId: string, commitGuard?: (phase: GameplayRunCommitPhase) => void): GameplayRunStore {
  return new GameplayRunStore({
    io: createNodeGameplayRunStoreIO(nodeFileIO),
    clock: () => new Date('2026-08-26T02:00:00.000Z'),
    runIdFactory: () => runId,
    ...(commitGuard === undefined ? {} : { commitGuard }),
  });
}

describe('gameplay run store', () => {
  it('atomically commits a complete run, updates latest, and reports history count and bytes', async () => {
    const rootPath = await root();
    const result = await store('run-success').commit(input(rootPath));
    const gameplayRoot = join(rootPath, '.yuanmeng-inspector', 'gameplay');

    expect(JSON.parse(await readFile(join(gameplayRoot, 'latest.json'), 'utf8'))).toMatchObject({
      runId: 'run-success', projectInstanceId: input(rootPath).project.projectInstanceId,
      knowledgeFingerprint: input(rootPath).project.knowledgeFingerprint,
      mode: 'auto', classification: 'model-pass',
    });
    expect(result.manifest.completed).toBe(true);
    expect(Object.keys(result.manifest.artifactSha256)).toHaveLength(6);
    expect(await store('unused').summarizeHistory(rootPath)).toMatchObject({ count: 1, bytes: expect.any(Number) });
    expect((await store('unused').summarizeHistory(rootPath)).bytes).toBeGreaterThan(0);
    expect((await store('unused').readCurrent(rootPath, input(rootPath).project))?.manifest.runId).toBe('run-success');
  });

  it.each([
    ['artifact-1', (phase: GameplayRunCommitPhase) => phase.phase === 'before-artifact-write' && phase.index === 1],
    ['artifact-3', (phase: GameplayRunCommitPhase) => phase.phase === 'before-artifact-write' && phase.index === 3],
    ['artifact-6', (phase: GameplayRunCommitPhase) => phase.phase === 'before-artifact-write' && phase.index === 6],
    ['before-rename', (phase: GameplayRunCommitPhase) => phase.phase === 'before-run-rename'],
    ['after-rename', (phase: GameplayRunCommitPhase) => phase.phase === 'after-run-rename'],
    ['before-latest', (phase: GameplayRunCommitPhase) => phase.phase === 'before-latest-write'],
  ] as const)('keeps the previous latest byte-identical when %s fails', async (_name, shouldFail) => {
    const rootPath = await root();
    await store('old-run').commit(input(rootPath));
    const latestPath = join(rootPath, '.yuanmeng-inspector', 'gameplay', 'latest.json');
    const before = await readFile(latestPath);
    let injected = false;
    const failingStore = store('new-run', (phase) => {
      if (injected || !shouldFail(phase)) return;
      injected = true;
      const error = new Error('injected failure');
      if (_name === 'artifact-3') error.name = 'AbortError';
      throw error;
    });

    await expect(failingStore.commit(input(rootPath))).rejects.toThrow('injected failure');
    expect(injected).toBe(true);
    expect(await readFile(latestPath)).toEqual(before);
    expect((await failingStore.readCurrent(rootPath, input(rootPath).project))?.manifest.runId).toBe('old-run');
  });

  it('cleans only its own staging directory after a failed commit', async () => {
    const rootPath = await root();
    const unrelated = join(rootPath, '.yuanmeng-inspector', 'gameplay', 'runs', '.staging-other-run');
    const sentinel = join(unrelated, 'sentinel.txt');
    await mkdir(unrelated, { recursive: true });
    await writeFile(sentinel, 'unrelated', 'utf8');
    const failingStore = store('current-run', (phase) => {
      if (phase.phase === 'before-run-rename') throw new Error('injected failure');
    });

    await expect(failingStore.commit(input(rootPath))).rejects.toThrow('injected failure');
    await expect(readFile(sentinel, 'utf8')).resolves.toBe('unrelated');
  });

  it('rejects damaged manifests, cross-project pointers, stale knowledge, and missing artifacts as current', async () => {
    const damagedRoot = await root();
    await store('damaged-run').commit(input(damagedRoot));
    const damagedManifest = join(damagedRoot, '.yuanmeng-inspector', 'gameplay', 'runs', 'damaged-run', 'manifest.json');
    await writeFile(damagedManifest, '{broken', 'utf8');
    expect(await store('unused').readCurrent(damagedRoot, input(damagedRoot).project)).toBeNull();

    const scopedRoot = await root();
    await store('scoped-run').commit(input(scopedRoot));
    expect(await store('unused').readCurrent(scopedRoot, { ...input(scopedRoot).project, projectInstanceId: '44444444-4444-4444-8444-444444444444' })).toBeNull();
    expect(await store('unused').readCurrent(scopedRoot, { ...input(scopedRoot).project, knowledgeFingerprint: 'b'.repeat(64) })).toBeNull();

    const missingRoot = await root();
    await store('missing-run').commit(input(missingRoot));
    await unlink(join(missingRoot, '.yuanmeng-inspector', 'gameplay', 'runs', 'missing-run', 'simulation-report.md'));
    expect(await store('unused').readCurrent(missingRoot, input(missingRoot).project)).toBeNull();
  });
});
