import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import * as vscode from 'vscode';

import type { ExtensionTestCase } from './index.js';

interface CompanionApi {
  refreshUi(root: string): Promise<void>;
}

export const officialSchemaGateTests: ExtensionTestCase[] = [{
  name: 'Extension Host simulation uses calibrated indexed projection without claiming official editor evidence',
  run: async () => {
    const root = process.env.YMAI_EXTENSION_TEST_ROOT_A;
    assert.ok(root);
    const fakeOfficial = vscode.commands.registerCommand('dreamhelper.GetCustomUIData', async () => {
      const dataDirectory = join(root, 'src', 'Data');
      await mkdir(dataDirectory, { recursive: true });
      await writeFile(join(dataDirectory, 'CustomUIData.lua'), [
        'return {',
        '  ["AlphaGroup"] = {',
        '    _uid = 41001,',
        '    ["RepeatedLabel"] = { _uid = 41002 },',
        '    ["RepeatedLabel"] = { _uid = 41003 },',
        '  },',
        '}',
        '',
      ].join('\n'), 'utf8');
      await writeFile(join(dataDirectory, 'CustomUIData2.lua'), [
        'return {',
        '  _1 = {',
        '    _uid = 41001, _name = "AlphaGroup",',
        '    _1 = { _uid = 41002, _name = "RepeatedLabel" },',
        '    _2 = { _uid = 41003, _name = "RepeatedLabel" },',
        '  },',
        '}',
        '',
      ].join('\n'), 'utf8');
    });
    try {
      const extension = vscode.extensions.getExtension<CompanionApi>('bujianxingguang.yuanmeng-ai-dev-assistant');
      assert.ok(extension);
      const api = await extension.activate();
      await api.refreshUi(root);
      const snapshot = JSON.parse(await readFile(
        join(root, '.yuanmeng-inspector', 'ui', 'current.json'),
        'utf8',
      )) as { nodes: Array<{ id: string; type: string }>; sources: Array<{ evidence: string }> };
      const status = JSON.parse(await readFile(
        join(root, '.yuanmeng-inspector', 'status.json'),
        'utf8',
      )) as { ui: { freshness: string } };
      assert.deepEqual(snapshot.nodes.map((node) => node.id).sort(), ['41001', '41002', '41003']);
      assert.ok(snapshot.nodes.every((node) => node.type === 'unknown'));
      assert.deepEqual(snapshot.sources.map((source) => source.evidence), ['EXTENSION_HOST', 'EXTENSION_HOST']);
      assert.equal(status.ui.freshness, 'fresh');
    } finally {
      fakeOfficial.dispose();
    }
  },
}];
