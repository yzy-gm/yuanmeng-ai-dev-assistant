import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import * as vscode from 'vscode';

import type { ExtensionTestCase } from './index.js';

interface CompanionApi {
  listContexts(): Array<{ root: string; projectInstanceId: string }>;
}

export const propertyCommandTests: ExtensionTestCase[] = [{
  name: 'property command reads one target and separates file and push confirmations',
  run: async () => {
    const root = process.env.YMAI_EXTENSION_TEST_ROOT_A;
    assert.ok(root);
    const extension = vscode.extensions.getExtension<CompanionApi>('bujianxingguang.yuanmeng-ai-dev-assistant');
    assert.ok(extension);
    const api = await extension.activate();
    const projectInstanceId = api.listContexts().find((item) => item.root === root)?.projectInstanceId;
    assert.ok(projectInstanceId);
    const source = 'return { title = "Anonymous", count = 3, enabled = true }\n';
    const dataDirectory = join(root, 'src', 'Data');
    const propertyPath = join(dataDirectory, 'CustomProperty_7001_8001.lua');
    const registryDirectory = join(root, '.yuanmeng-inspector', 'registry');
    await mkdir(registryDirectory, { recursive: true });
    await mkdir(dataDirectory, { recursive: true });
    await writeFile(propertyPath, 'return {}\n', 'utf8');
    const evidence = {
      kind: 'user-entry', relativePath: null, sha256: 'a'.repeat(64), observedAt: '2026-08-20T00:00:00.000Z',
      officialExtensionVersion: null, evidence: 'EXTENSION_HOST',
    };
    await writeFile(join(registryDirectory, 'registry.json'), JSON.stringify({
      schemaVersion: 1,
      records: [
        {
          recordId: 'test-layer', kind: 'scene-layer', name: 'Test Layer', value: '7001', scope: 'workspace',
          projectInstanceId, mapFingerprint: null, layerId: null, environment: 'test', validity: 'confirmed',
          source: evidence, lastConfirmedAt: '2026-08-20T00:00:00.000Z', notes: '',
        },
        {
          recordId: 'test-instance', kind: 'scene-instance', name: 'Test Instance', value: '8001', scope: 'workspace',
          projectInstanceId, mapFingerprint: null, layerId: '7001', environment: 'unspecified', validity: 'pending',
          source: evidence, lastConfirmedAt: null, notes: '',
        },
      ],
    }), 'utf8');
    let reads = 0;
    let pushes = 0;
    let pushedPath = '';
    const getCommand = vscode.commands.registerCommand('dreamhelper.GetCustomPropertyData', async () => {
      reads += 1;
      await mkdir(dataDirectory, { recursive: true });
      await writeFile(propertyPath, source, 'utf8');
    });
    const pushCommand = vscode.commands.registerCommand('dreamhelper.sendCustomPropertyData', async (uri: vscode.Uri) => {
      pushes += 1;
      pushedPath = uri.fsPath;
    });
    try {
      const loaded = await vscode.commands.executeCommand<{
        state: string; outcome: string; target: { warning: string; filename: string }; snapshot: { values: Record<string, unknown> };
      }>('yuanmengAi.readProperty', root, 'test-layer', 'test-instance');
      assert.equal(reads, 1);
      assert.equal(loaded.state, 'loaded');
      assert.equal(loaded.outcome, 'READ_SUCCEEDED');
      assert.equal(loaded.target.warning, '地图身份未由官方确认');
      assert.equal(loaded.target.filename, 'CustomProperty_7001_8001.lua');
      assert.equal(loaded.snapshot.values['/title'], 'Anonymous');

      const fileCancelled = await vscode.commands.executeCommand<{ outcome: string }>(
        'yuanmengAi.pushPropertyLiteral', root, 'test-layer', 'test-instance', '/title', 'Cancelled',
        { file: 'cancel', push: 'confirm' },
      );
      assert.equal(fileCancelled.outcome, 'file-cancelled');
      assert.equal(await readFile(propertyPath, 'utf8'), source);
      assert.equal(pushes, 0);

      const pushCancelled = await vscode.commands.executeCommand<{ outcome: string; state: string }>(
        'yuanmengAi.pushPropertyLiteral', root, 'test-layer', 'test-instance', '/title', 'First',
        { file: 'confirm', push: 'cancel' },
      );
      assert.equal(pushCancelled.outcome, 'push-cancelled');
      assert.equal(pushCancelled.state, 'file-written');
      assert.match(await readFile(propertyPath, 'utf8'), /title = "First"/u);
      assert.equal(pushes, 0);

      const pushed = await vscode.commands.executeCommand<{ outcome: string; state: string }>(
        'yuanmengAi.pushPropertyLiteral', root, 'test-layer', 'test-instance', '/title', 'Final',
        { file: 'confirm', push: 'confirm' },
      );
      assert.equal(pushed.outcome, 'push-requested');
      assert.equal(pushed.state, 'push-requested');
      assert.equal(pushes, 1);
      assert.equal(pushedPath.toLocaleLowerCase('en-US'), propertyPath.toLocaleLowerCase('en-US'));
    } finally {
      getCommand.dispose();
      pushCommand.dispose();
    }
  },
}, {
  name: 'property command treats an empty official property table as a successful read',
  run: async () => {
    const root = process.env.YMAI_EXTENSION_TEST_ROOT_A;
    assert.ok(root);
    const extension = vscode.extensions.getExtension<CompanionApi>('bujianxingguang.yuanmeng-ai-dev-assistant');
    assert.ok(extension);
    const api = await extension.activate();
    const projectInstanceId = api.listContexts().find((item) => item.root === root)?.projectInstanceId;
    assert.ok(projectInstanceId);
    const dataDirectory = join(root, 'src', 'Data');
    const propertyPath = join(dataDirectory, 'CustomProperty_9001_9207.lua');
    const registryDirectory = join(root, '.yuanmeng-inspector', 'registry');
    await mkdir(registryDirectory, { recursive: true });
    await mkdir(dataDirectory, { recursive: true });
    await writeFile(propertyPath, 'return {}\n', 'utf8');
    const evidence = {
      kind: 'user-entry', relativePath: null, sha256: 'c'.repeat(64), observedAt: '2026-08-21T01:28:22.000Z',
      officialExtensionVersion: '1.4.7', evidence: 'OFFICIAL_EDITOR_SINGLE',
    };
    await writeFile(join(registryDirectory, 'registry.json'), JSON.stringify({
      schemaVersion: 1,
      records: [
        {
          recordId: 'scene-layer-anonymous', kind: 'scene-layer', name: 'Anonymous Layer', value: '9001', scope: 'scene-layer',
          projectInstanceId, mapFingerprint: null, layerId: null, environment: 'test', validity: 'confirmed',
          source: evidence, lastConfirmedAt: '2026-08-21T01:28:22.000Z', notes: '',
        },
        {
          recordId: 'scene-instance-anonymous', kind: 'scene-instance', name: 'Anonymous Cube', value: '9207', scope: 'scene-layer',
          projectInstanceId, mapFingerprint: null, layerId: '9001', environment: 'test', validity: 'confirmed',
          source: evidence, lastConfirmedAt: '2026-08-21T01:28:22.000Z', notes: '',
        },
      ],
    }), 'utf8');
    let reads = 0;
    const getCommand = vscode.commands.registerCommand('dreamhelper.GetCustomPropertyData', async () => {
      reads += 1;
      await new Promise((resolve) => setTimeout(resolve, 25));
      await writeFile(propertyPath, 'return {}\n', 'utf8');
    });
    try {
      const loaded = await vscode.commands.executeCommand<{
        state: string; outcome: string; target: { filename: string }; snapshot: { values: Record<string, unknown> };
      }>('yuanmengAi.readProperty', root, 'scene-layer-anonymous', 'scene-instance-anonymous');
      assert.equal(reads, 1);
      assert.equal(loaded.state, 'loaded');
      assert.equal(loaded.outcome, 'READ_SUCCEEDED_EMPTY_PROPERTIES');
      assert.equal(loaded.target.filename, 'CustomProperty_9001_9207.lua');
      assert.deepEqual(loaded.snapshot.values, {});
    } finally {
      getCommand.dispose();
    }
  },
}];
