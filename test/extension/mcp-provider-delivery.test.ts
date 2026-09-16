import assert from 'node:assert/strict';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import * as vscode from 'vscode';

import type { ExtensionTestCase } from './index.js';
import { FileCodeDeliveryClient } from '../../src/mcp/code-delivery.js';

interface TestApi {
  listMcpServerDefinitions(): Array<{ label: string; command: string; cwd: string }>;
}

export const mcpProviderDeliveryTests: ExtensionTestCase[] = [{
  name: 'MCP provider exposes isolated launchers without mcp.json and delivery uses official command evidence',
  run: async () => {
    const rootA = process.env.YMAI_EXTENSION_TEST_ROOT_A;
    const rootB = process.env.YMAI_EXTENSION_TEST_ROOT_B;
    assert.ok(rootA && rootB);
    assert.equal(typeof vscode.lm.registerMcpServerDefinitionProvider, 'function');
    const extension = vscode.extensions.getExtension<TestApi>('bujianxingguang.yuanmeng-ai-dev-assistant');
    assert.ok(extension);
    const api = await extension.activate();
    const definitions = api.listMcpServerDefinitions();
    assert.equal(definitions.length, 2);
    assert.deepEqual(new Set(definitions.map((item) => item.cwd)), new Set([rootA, rootB]));
    for (const definition of definitions) {
      assert.equal(definition.command, join(definition.cwd, '.yuanmeng-inspector', 'bin', 'ymai-mcp.cmd'));
      await stat(definition.command);
    }
    await assert.rejects(stat(join(rootA, '.vscode', 'mcp.json')), { code: 'ENOENT' });

    const fakeUiRefresh = vscode.commands.registerCommand('dreamhelper.GetCustomUIData', async () => {
      const dataDirectory = join(rootA, 'src', 'Data');
      await mkdir(dataDirectory, { recursive: true });
      await writeFile(join(dataDirectory, 'CustomUIData.lua'), [
        'return { schemaVersion = 1, roots = {',
        "  { id = '101', name = '交付检查', type = 'Text', children = {} },",
        '} }',
        ''
      ].join('\n'), 'utf8');
    });
    let officialBuildCalls = 0;
    const fakeOfficial = vscode.commands.registerCommand('dreamhelper.scriptGen', async () => {
      officialBuildCalls += 1;
      const dist = join(rootA, 'dist');
      await mkdir(dist, { recursive: true });
      void (async () => {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
        const zip = join(dist, 'code_2026-08-22-14-02-00.zip');
        await writeFile(zip, 'part', 'utf8');
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
        await writeFile(zip, 'complete archive bytes', 'utf8');
      })();
      return undefined;
    });
    try {
      const metadata = JSON.parse(await readFile(join(rootA, '.yuanmeng-inspector', 'meta.json'), 'utf8')) as {
        projectInstanceId: string; projectRootHash: string;
      };
      const client = new FileCodeDeliveryClient({
        projectRoot: rootA,
        projectInstanceId: metadata.projectInstanceId,
        projectRootHash: metadata.projectRootHash,
        timeoutMilliseconds: 10_000
      });
      const invalidLua = join(rootA, 'src', 'Client', 'DeliveryInvalid_backup.lua');
      await mkdir(join(rootA, 'src', 'Client'), { recursive: true });
      await writeFile(invalidLua, 'local broken =\n', 'utf8');
      let blocked: Awaited<ReturnType<typeof client.deliver>> | null = null;
      for (let attempt = 0; attempt < 20 && (blocked === null || blocked.status === 'LINK_OFFLINE'); attempt += 1) {
        blocked = await client.deliver(new AbortController().signal);
        if (blocked.status === 'LINK_OFFLINE') await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
      }
      assert.ok(blocked);
      assert.equal(blocked.status, 'CHECK_FAILED');
      assert.match(blocked.nextAction, /src\/Client\/DeliveryInvalid_backup\.lua/u);
      assert.equal(officialBuildCalls, 0);
      await rm(invalidLua, { force: true });

      let result: Awaited<ReturnType<typeof client.deliver>> | null = null;
      for (let attempt = 0; attempt < 20 && (result === null || result.status === 'LINK_OFFLINE'); attempt += 1) {
        result = await client.deliver(new AbortController().signal);
        if (result.status === 'LINK_OFFLINE') await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
      }
      assert.ok(result);
      assert.equal(result.status, 'BUILT');
      assert.equal(result.commandAvailable, true);
      assert.deepEqual(result.dirtyAfter, []);
      assert.equal(result.evidenceLevel, 'EXTENSION_HOST');
      assert.equal(result.officialOutputEvidence.length, 0);
      assert.equal(officialBuildCalls, 1);
      assert.ok(result.artifactChanges.some((item) => item.relativePath === 'dist/code_2026-08-22-14-02-00.zip'));
    } finally {
      fakeOfficial.dispose();
      fakeUiRefresh.dispose();
    }
  }
}];
