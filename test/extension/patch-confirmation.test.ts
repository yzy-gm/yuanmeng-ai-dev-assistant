import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import * as vscode from 'vscode';

import { createPatchProposal, type AppliedProposal } from '../../src/core/patch/proposal.js';
import type { ExtensionTestCase } from './index.js';

export const patchConfirmationTests: ExtensionTestCase[] = [{
  name: 'patch confirmation cancellation writes nothing and confirmed undo is hash guarded',
  run: async () => {
    const root = process.env.YMAI_EXTENSION_TEST_ROOT_A;
    assert.ok(root);
    const target = join(root, 'src', 'PatchTarget.lua');
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(target, 'return "before"\n', 'utf8');
    const proposal = createPatchProposal({
      projectInstanceId: '00000000-0000-4000-8000-000000000903',
      targetPath: 'src/PatchTarget.lua',
      originalContent: 'return "before"\n',
      newContent: 'return "after"\n',
      summary: 'anonymous Extension Host patch',
      createdAt: '2026-08-20T02:03:04.000Z',
    });

    const cancelled = await vscode.commands.executeCommand<AppliedProposal | undefined>(
      'yuanmengAi.previewPatch', proposal, root, 'cancel',
    );
    assert.equal(cancelled, undefined);
    assert.equal(await readFile(target, 'utf8'), 'return "before"\n');

    const applied = await vscode.commands.executeCommand<AppliedProposal>(
      'yuanmengAi.previewPatch', proposal, root, 'confirm',
    );
    assert.ok(applied.manifestPath.includes(join('.yuanmeng-inspector', 'backups')));
    assert.equal(await readFile(target, 'utf8'), 'return "after"\n');

    await writeFile(target, 'return "external"\n', 'utf8');
    await assert.rejects(
      vscode.commands.executeCommand('yuanmengAi.undoPatch', applied.manifestPath, root, 'confirm'),
      (error: unknown) => typeof error === 'object' && error !== null && (error as { code?: string }).code === 'HASH_CONFLICT',
    );
    assert.equal(await readFile(target, 'utf8'), 'return "external"\n');

    await writeFile(target, 'return "after"\n', 'utf8');
    assert.equal(
      await vscode.commands.executeCommand('yuanmengAi.undoPatch', applied.manifestPath, root, 'confirm'),
      true,
    );
    assert.equal(await readFile(target, 'utf8'), 'return "before"\n');
  },
}];
