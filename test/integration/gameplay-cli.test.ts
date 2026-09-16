import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { runCli } from '../../src/cli/main.js';
import { normalizeCanonicalRoot } from '../../src/cli/project.js';
import { createGameplayKnowledgeFingerprint, gameplayModelFingerprint } from '../../src/core/gameplay/model.js';
import type { GameplayModel, GameplayScenario } from '../../src/core/gameplay/types.js';
import { nodeFileIO } from '../../src/core/fs.js';
import { sha256Hex } from '../../src/core/hash.js';
import type { RegistryDocument } from '../../src/core/model.js';
import { SCENE_ADAPTER_ID } from '../../src/core/scene/normalize.js';
import { saveSceneSnapshot } from '../../src/core/scene/store.js';
import type { SceneSnapshot } from '../../src/core/scene/types.js';

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

function scenario(model: GameplayModel, count: number): GameplayScenario {
  return {
    schemaVersion: 1,
    scenarioId: `cli-${count}`,
    name: `${count} players`,
    modelBinding: { modelId: model.modelId, modelFingerprint: gameplayModelFingerprint(model), ...model.project },
    players: Array.from({ length: count }, (_, index) => `p${index + 1}`),
    exploreReadyEventInterleavings: count > 1,
    limits: { maxEvents: 100, maxVirtualMilliseconds: 1_000, maxVisitedStates: 100, maxBranches: 100 },
    steps: Array.from({ length: count }, (_, index) => ({
      kind: 'dispatch' as const, event: 'cli.request', source: 'server' as const,
      playerId: `p${index + 1}`, deliveryId: `cli-${count}-${index + 1}`,
    })),
  };
}

describe('gameplay CLI workflow', () => {
  it('writes review/report packages for 1/2/4/8 and fail-closes after only Lua changes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ymai-gameplay-cli-'));
    directories.push(root);
    const projectInstanceId = '99999999-9999-4999-8999-999999999999';
    await mkdir(join(root, 'src'), { recursive: true });
    await mkdir(join(root, '.yuanmeng-inspector'), { recursive: true });
    const luaPath = join(root, 'src', 'GameEntry.lua');
    const source = 'return {}\n';
    await writeFile(luaPath, source, 'utf8');
    await writeFile(join(root, '.yuanmeng-inspector', 'meta.json'), JSON.stringify({
      schemaVersion: 1,
      projectInstanceId,
      projectRootHash: sha256Hex(normalizeCanonicalRoot(await realpath(root))),
    }), 'utf8');
    const registry: RegistryDocument = { schemaVersion: 1, records: [] };
    const projectBase = { projectInstanceId, mapFingerprint: null, sceneSnapshotId: null };
    const knowledgeFingerprint = createGameplayKnowledgeFingerprint({
      project: projectBase, luaFiles: [{ path: 'src/GameEntry.lua', source }], registry, uiSnapshot: null, sceneSnapshot: null,
    });
    const model: GameplayModel = {
      schemaVersion: 1,
      modelId: 'cli-gameplay-model',
      project: { ...projectBase, knowledgeFingerprint },
      externalEvents: ['cli.request'],
      eventPolicies: [{
        event: 'cli.request', authority: 'server-only', playerRequired: true,
        duplicatePolicy: 'allow', targetSide: 'server', observableEffectRequired: true,
      }],
      initialState: { shared: {}, player: { count: 0 }, client: {} },
      handlers: [{
        handlerId: 'cli-request', event: 'cli.request', side: 'server', branches: [{
          branchId: 'apply', effects: [{
            kind: 'add', target: { scope: 'player', path: 'count' }, value: { kind: 'literal', value: 1 },
          }],
        }],
      }],
      invariants: [{ invariantId: 'non-negative', kind: 'non-negative', ref: { scope: 'player', path: 'count' } }],
      evidenceRequirements: [],
      multiplayer: { maximumPlayers: 8, rejoinPolicy: 'retain-player-reset-client' },
    };
    await writeFile(join(root, 'spec.json'), JSON.stringify(model), 'utf8');
    await mkdir(join(root, 'scenarios'));
    for (const count of [1, 2, 4, 8]) await writeFile(join(root, 'scenarios', `${count}.json`), JSON.stringify(scenario(model, count)), 'utf8');

    const reviewed = await runCli(['gameplay-review', 'spec.json', '--out', 'reports', '--json'], { cwd: root });
    expect(reviewed.envelope).toMatchObject({ ok: true, data: { staticGate: 'pass', evidence: 'STATIC_LOCAL' } });
    const tested = await runCli(['gameplay-test', 'spec.json', 'scenarios', '--out', 'reports', '--json'], { cwd: root });
    expect(tested.envelope).toMatchObject({ ok: true, data: { status: 'pass' } });
    const report = JSON.parse(await readFile(join(root, 'reports', 'gameplay-report.json'), 'utf8')) as { populations: Array<{ playerCount: number }> };
    expect(report.populations.map((entry) => entry.playerCount)).toEqual([1, 2, 4, 8]);

    await writeFile(luaPath, 'return { changed = true }\n', 'utf8');
    const stale = await runCli(['gameplay-test', 'spec.json', 'scenarios', '--out', 'reports', '--json'], { cwd: root });
    expect(stale.envelope).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' });
    expect(await readFile(join(root, 'reports', 'codex-review.json'), 'utf8')).toContain('CURRENT_KNOWLEDGE_FINGERPRINT_MISMATCH');
  });

  it('ignores an unreferenced trigger box but requires a binding after production Lua guards that instance', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ymai-gameplay-trigger-cli-'));
    directories.push(root);
    const projectInstanceId = '88888888-8888-4888-8888-888888888888';
    await mkdir(join(root, 'src'), { recursive: true });
    await mkdir(join(root, '.yuanmeng-inspector'), { recursive: true });
    const source = 'return {}\n';
    await writeFile(join(root, 'src', 'GameEntry.lua'), source, 'utf8');
    await writeFile(join(root, '.yuanmeng-inspector', 'meta.json'), JSON.stringify({
      schemaVersion: 1,
      projectInstanceId,
      projectRootHash: sha256Hex(normalizeCanonicalRoot(await realpath(root))),
    }), 'utf8');
    const evidence = { state: 'observed-repeatable' as const, source: 'anonymous-trigger-fixture', confidence: 0.9 };
    const sceneSnapshot: SceneSnapshot = {
      schemaVersion: 1,
      snapshotId: 'a'.repeat(64),
      bindingId: 'b'.repeat(64),
      role: 'raw-pbin',
      sourceSha256: 'c'.repeat(64),
      observedAt: '2026-08-21T00:00:00.000Z',
      adapterId: SCENE_ADAPTER_ID,
      instances: [{
        instanceId: '517', elementTypeId: '1105000000000087', ownerId: null,
        variant: 'component6-oneof-1', evidence,
        transform: { state: 'absent' }, customProperties: { state: 'absent' }, signals: { state: 'absent' },
        resources: { state: 'absent' }, bounds: { state: 'absent' }, unknownFields: [],
      }],
      groups: [], issues: [], unknownFields: [],
    };
    await saveSceneSnapshot(root, sceneSnapshot, nodeFileIO, { preferred: true });
    const registry: RegistryDocument = { schemaVersion: 1, records: [] };
    const projectBase = { projectInstanceId, mapFingerprint: null, sceneSnapshotId: sceneSnapshot.snapshotId };
    const model: GameplayModel = {
      schemaVersion: 1,
      modelId: 'trigger-gate-model',
      project: {
        ...projectBase,
        knowledgeFingerprint: createGameplayKnowledgeFingerprint({
          project: projectBase,
          luaFiles: [{ path: 'src/GameEntry.lua', source }],
          registry,
          uiSnapshot: null,
          sceneSnapshot,
        }),
      },
      externalEvents: ['ping'],
      eventPolicies: [{
        event: 'ping', authority: 'server-only', playerRequired: false,
        duplicatePolicy: 'allow', targetSide: 'server', observableEffectRequired: true,
      }],
      initialState: { shared: { count: 0 }, player: {}, client: {} },
      handlers: [{
        handlerId: 'ping-handler', event: 'ping', side: 'server', branches: [{
          branchId: 'apply', effects: [{ kind: 'add', target: { scope: 'shared', path: 'count' }, value: { kind: 'literal', value: 1 } }],
        }],
      }],
      invariants: [{ invariantId: 'count-non-negative', kind: 'non-negative', ref: { scope: 'shared', path: 'count' } }],
      evidenceRequirements: [],
    };
    await writeFile(join(root, 'spec.json'), JSON.stringify(model), 'utf8');

    const reviewed = await runCli(['gameplay-review', 'spec.json', '--out', 'reports', '--json'], { cwd: root });
    expect(reviewed.envelope).toMatchObject({ ok: true, data: { staticGate: 'pass' } });
    expect(await readFile(join(root, 'reports', 'codex-review.json'), 'utf8')).not.toContain('SCENE_EVENT_BINDING_REQUIRED');

    const guardedSource = [
      '---@ymai-side server',
      'local function OnEnter(actorRef, triggerRef)',
      '  if triggerRef ~= 517 then return end',
      'end',
      'System:RegisterEvent(Events.ON_CHARACTER_ENTER_SIGNAL_BOX, OnEnter)',
    ].join('\n');
    await writeFile(join(root, 'src', 'GameEntry.lua'), guardedSource, 'utf8');
    model.project.knowledgeFingerprint = createGameplayKnowledgeFingerprint({
      project: projectBase,
      luaFiles: [{ path: 'src/GameEntry.lua', source: guardedSource }],
      registry,
      uiSnapshot: null,
      sceneSnapshot,
    });
    await writeFile(join(root, 'spec.json'), JSON.stringify(model), 'utf8');

    const relevant = await runCli(['gameplay-review', 'spec.json', '--out', 'reports', '--json'], { cwd: root });
    expect(relevant.envelope).toMatchObject({ ok: false, code: 'VALIDATION_FAILED', data: { staticGate: 'blocked' } });
    expect(await readFile(join(root, 'reports', 'codex-review.json'), 'utf8')).toContain('SCENE_EVENT_BINDING_REQUIRED');
  });
});
