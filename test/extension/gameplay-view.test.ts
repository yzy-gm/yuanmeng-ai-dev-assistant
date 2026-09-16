import assert from 'node:assert/strict';

import * as vscode from 'vscode';

import type { ExtensionTestCase } from './index.js';

interface GameplayViewSummary {
  specStatus: string;
  knowledgeFresh: boolean | null;
  staticGate: string;
  populations: Array<{ playerCount: number; status: string }>;
  reportAvailable: boolean;
  mode: 'auto' | 'manual' | 'none';
  classification: string | null;
  latestCurrent: boolean;
  latestState: 'current' | 'stale' | 'missing';
  strictStaticGate: string;
  simulationGate: string;
  history: { count: number; bytes: number };
}

interface CompanionApi {
  gameplayStatus(root: string): Promise<GameplayViewSummary>;
}

export const gameplayViewTests: ExtensionTestCase[] = [{
  name: 'AI gameplay persistent view exposes draft-first status without leaking workspace identity',
  async run() {
    const root = process.env.YMAI_EXTENSION_TEST_ROOT_B;
    assert.ok(root);
    const extension = vscode.extensions.getExtension<CompanionApi>('bujianxingguang.yuanmeng-ai-dev-assistant');
    assert.ok(extension);
    const api = await extension.activate();
    const viewIds = new Set((extension.packageJSON.contributes?.views?.yuanmengAi as Array<{ id?: string }> | undefined)?.map((entry) => entry.id));
    const commandIds = new Set((extension.packageJSON.contributes?.commands as Array<{ command?: string }> | undefined)?.map((entry) => entry.command));
    assert.ok(viewIds.has('yuanmengAi.gameplay'));
    assert.ok(commandIds.has('yuanmengAi.refreshGameplayView'));
    assert.ok(commandIds.has('yuanmengAi.runConfirmedGameplayTests'));
    assert.ok(commandIds.has('yuanmengAi.previewSceneRebind'));
    assert.ok(commandIds.has('yuanmengAi.openAnonymousDiagnostic'));

    const missing = await api.gameplayStatus(root);
    assert.equal(missing.specStatus, 'missing');
    assert.equal(missing.latestState, 'missing');
    assert.equal(missing.knowledgeFresh, null);
    assert.deepEqual(missing.populations.map((entry) => entry.playerCount), [1, 2, 4, 8]);
    await vscode.workspace.fs.writeFile(vscode.Uri.file(`${root}/src/GameEntry.lua`), Buffer.from([
      '---@ymai-side server',
      'System:RegisterEvent("view.auto", function()',
      '  UI:Show()',
      'end)',
    ].join('\n'), 'utf8'));
    await vscode.commands.executeCommand('yuanmengAi.runGameplayTests', root);
    await vscode.commands.executeCommand('yuanmengAi.refreshGameplayView');
    const automatic = await api.gameplayStatus(root);
    assert.equal(automatic.specStatus, 'missing');
    assert.equal(automatic.mode, 'auto');
    assert.equal(automatic.latestCurrent, true);
    assert.equal(automatic.latestState, 'current');
    assert.notEqual(automatic.classification, null);
    assert.equal(automatic.simulationGate, 'pass');
    assert.ok(automatic.history.count >= 1);
    assert.ok(automatic.history.bytes > 0);
    const serialized = JSON.stringify(automatic);
    assert.ok(!serialized.includes(root));
    assert.doesNotMatch(serialized, /[a-f0-9]{64}/u);
  },
}];
