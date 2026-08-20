import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import * as vscode from 'vscode';

import type { ExtensionTestCase } from './index.js';

export const buildCommandTests: ExtensionTestCase[] = [{
  name: 'build command requires confirmation and reports artifact evidence only',
  run: async () => {
    const root = process.env.YMAI_EXTENSION_TEST_ROOT_A;
    assert.ok(root);
    let calls = 0;
    const fakeOfficial = vscode.commands.registerCommand('dreamhelper.scriptGen', async () => {
      calls += 1;
      await mkdir(join(root, 'dist'), { recursive: true });
      await writeFile(join(root, 'dist', 'play.lua'), `return ${calls}\n`, 'utf8');
    });
    try {
      const cancelled = await vscode.commands.executeCommand<{ outcome: string }>(
        'yuanmengAi.buildScripts', root, 'cancel',
      );
      assert.equal(cancelled.outcome, 'cancelled');
      assert.equal(calls, 0);

      const result = await vscode.commands.executeCommand<{
        outcome: string;
        gameRuntimePassed: boolean;
        evidence: string;
      }>('yuanmengAi.buildScripts', root, 'confirm');
      assert.equal(calls, 1);
      assert.equal(result.outcome, 'artifact-updated');
      assert.equal(result.gameRuntimePassed, false);
      assert.equal(result.evidence, 'EXTENSION_HOST');
    } finally {
      fakeOfficial.dispose();
    }
  },
}];
