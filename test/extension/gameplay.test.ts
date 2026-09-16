import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import * as vscode from 'vscode';

import { gameplayModelFingerprint } from '../../src/core/gameplay/model.js';
import type { GameplayModel, GameplayScenario } from '../../src/core/gameplay/types.js';
import type { ExtensionTestCase } from './index.js';

interface CompanionApi {
  listContexts(): Array<{ root: string; projectInstanceId: string }>;
}

function scenario(model: GameplayModel, playerCount: number): GameplayScenario {
  return {
    schemaVersion: 1,
    scenarioId: `extension-${playerCount}`,
    name: `${playerCount} player extension flow`,
    modelBinding: { modelId: model.modelId, modelFingerprint: gameplayModelFingerprint(model), ...model.project },
    players: Array.from({ length: playerCount }, (_, index) => `p${index + 1}`),
    exploreReadyEventInterleavings: playerCount > 1,
    limits: { maxEvents: 100, maxVirtualMilliseconds: 1_000, maxVisitedStates: 100, maxBranches: 100 },
    steps: Array.from({ length: playerCount }, (_, index) => ({
      kind: 'dispatch' as const,
      event: 'test.request',
      source: 'server' as const,
      playerId: `p${index + 1}`,
      deliveryId: `extension-${playerCount}-${index + 1}`,
    })),
  };
}

export const gameplayTests: ExtensionTestCase[] = [{
  name: 'AI gameplay default command auto-runs without confirmed files while advanced manual mode remains stale-strict',
  async run() {
    const root = process.env.YMAI_EXTENSION_TEST_ROOT_A;
    assert.ok(root);
    const extension = vscode.extensions.getExtension<CompanionApi>('bujianxingguang.yuanmeng-ai-dev-assistant');
    assert.ok(extension);
    await extension.activate();

    const gameplayRoot = join(root, '.yuanmeng-inspector', 'gameplay');
    await writeFile(join(root, 'src', 'GameEntry.lua'), [
      '---@ymai-side server',
      'System:RegisterEvent("extension.auto", function()',
      '  UI:Show()',
      'end)',
    ].join('\n'), 'utf8');

    const automatic = await vscode.commands.executeCommand<{
      committed: boolean; mode: string; classification: string; runId: string;
    }>('yuanmengAi.runGameplayTests', root, 'cancel');
    assert.equal(automatic?.committed, true);
    assert.equal(automatic.mode, 'auto');
    assert.notEqual(automatic.classification, 'not-run-fatal');
    const latest = JSON.parse(await readFile(join(gameplayRoot, 'latest.json'), 'utf8')) as { runId: string };
    assert.equal(latest.runId, automatic.runId);
    const latestBeforeManualCancel = await readFile(join(gameplayRoot, 'latest.json'));
    const cancelled = await vscode.commands.executeCommand<{ committed: boolean; status: string }>(
      'yuanmengAi.runConfirmedGameplayTests', root, 'cancel',
    );
    assert.equal(cancelled?.committed, false);
    assert.equal(cancelled.status, 'cancelled');
    assert.deepEqual(await readFile(join(gameplayRoot, 'latest.json')), latestBeforeManualCancel);
    const generatedScenarioRoot = join(gameplayRoot, 'runs', automatic.runId, 'generated-scenarios');
    const generatedScenarios = await readdir(generatedScenarioRoot);
    assert.ok(generatedScenarios.length > 0);
    for (const filename of generatedScenarios) {
      const generated = JSON.parse(await readFile(join(generatedScenarioRoot, filename), 'utf8')) as { steps?: unknown[] };
      assert.ok(Array.isArray(generated.steps) && generated.steps.length > 0);
    }

    const draftResult = await vscode.commands.executeCommand<{ committed: boolean }>('yuanmengAi.generateGameplayDraft', root);
    assert.equal(draftResult?.committed, true);
    const draft = JSON.parse(await readFile(join(gameplayRoot, 'spec.draft.json'), 'utf8')) as GameplayModel;
    const model: GameplayModel = {
      ...draft,
      modelId: 'extension-gameplay-model',
      externalEvents: ['test.request'],
      eventPolicies: [{
        event: 'test.request', authority: 'server-only', playerRequired: true,
        duplicatePolicy: 'allow', targetSide: 'server', observableEffectRequired: true,
      }],
      initialState: { shared: {}, player: { count: 0 }, client: {} },
      handlers: [{
        handlerId: 'test-request', event: 'test.request', side: 'server', branches: [{
          branchId: 'apply', effects: [{
            kind: 'add', target: { scope: 'player', path: 'count' }, value: { kind: 'literal', value: 1 },
          }],
        }],
      }],
      invariants: [{ invariantId: 'count-non-negative', kind: 'non-negative', ref: { scope: 'player', path: 'count' } }],
      evidenceRequirements: [],
    };
    await writeFile(join(gameplayRoot, 'spec.json'), JSON.stringify(model, null, 2), 'utf8');
    const scenarioRoot = join(gameplayRoot, 'scenarios');
    await mkdir(scenarioRoot, { recursive: true });
    for (const playerCount of [1, 2, 4, 8]) {
      await writeFile(join(scenarioRoot, `${playerCount}.json`), JSON.stringify(scenario(model, playerCount), null, 2), 'utf8');
    }

    const runResult = await vscode.commands.executeCommand<{ committed: boolean; status: string }>(
      'yuanmengAi.runConfirmedGameplayTests', root, 'confirm',
    );
    assert.equal(runResult?.committed, true);
    assert.equal(runResult.status, 'pass');
    const report = JSON.parse(await readFile(join(gameplayRoot, 'reports', 'current', 'gameplay-report.json'), 'utf8')) as {
      status: string;
      populations: Array<{ playerCount: number }>;
      evidence: { officialEditor: string };
    };
    assert.equal(report.status, 'pass');
    assert.deepEqual(report.populations.map((entry) => entry.playerCount), [1, 2, 4, 8]);
    assert.equal(report.evidence.officialEditor, 'REQUIRED_FOR_ENGINE_BEHAVIOR');

    await writeFile(join(root, 'src', 'GameEntry.lua'), 'return { changed = true }\n', 'utf8');
    const stale = await vscode.commands.executeCommand<{ committed: boolean; status: string }>(
      'yuanmengAi.runConfirmedGameplayTests', root, 'confirm',
    );
    assert.equal(stale?.committed, false);
    assert.equal(stale.status, 'blocked');
    const review = await readFile(join(gameplayRoot, 'reports', 'current', 'codex-review.json'), 'utf8');
    assert.match(review, /CURRENT_KNOWLEDGE_FINGERPRINT_MISMATCH/u);
    await assert.rejects(
      vscode.commands.executeCommand('yuanmengAi.openGameplayReport', root),
      /旧模型|过期|重新运行/u,
    );
  },
}];
