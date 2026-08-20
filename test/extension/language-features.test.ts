import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import * as vscode from 'vscode';

import type { ExtensionTestCase } from './index.js';

interface CompanionApi {
  refreshUi(root: string): Promise<void>;
}

async function waitForDiagnostic(uri: vscode.Uri, code: string): Promise<vscode.Diagnostic> {
  const deadline = Date.now() + 5_000;
  while (Date.now() <= deadline) {
    const found = vscode.languages.getDiagnostics(uri).find((item) => item.code === code);
    if (found !== undefined) return found;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`diagnostic ${code} was not published`);
}

function hoverText(hover: vscode.Hover): string {
  return hover.contents.map((content) => (
    typeof content === 'string' ? content : content instanceof vscode.MarkdownString ? content.value : content.value
  )).join('\n');
}

export const languageFeatureTests: ExtensionTestCase[] = [{
  name: 'language features expose evidence fields and navigation-only quick fixes',
  run: async () => {
    const root = process.env.YMAI_EXTENSION_TEST_ROOT_A;
    assert.ok(root);
    const fakeOfficial = vscode.commands.registerCommand('dreamhelper.GetCustomUIData', async () => {
      const dataDirectory = join(root, 'src', 'Data');
      await mkdir(dataDirectory, { recursive: true });
      await writeFile(join(dataDirectory, 'CustomUIData.lua'), [
        'return { schemaVersion = 1, roots = {',
        "  { id = '201', name = 'FixtureControl', type = 'Text', children = {} },",
        '} }',
        '',
      ].join('\n'), 'utf8');
    });
    const extension = vscode.extensions.getExtension<CompanionApi>('bujianxingguang.yuanmeng-ai-dev-assistant');
    assert.ok(extension);
    const api = await extension.activate();
    await api.refreshUi(root);
    const path = join(root, 'src', 'LanguageFeature.lua');
    try {
      await writeFile(path, 'local controlId = 201\nreturn controlId\n', 'utf8');
      const document = await vscode.workspace.openTextDocument(path);
      await vscode.window.showTextDocument(document);
      const uri = document.uri;
      const position = new vscode.Position(0, 19);

      const diagnostic = await waitForDiagnostic(uri, 'PENDING_ID_REFERENCE');
      assert.equal(diagnostic.source, '元梦 AI');

      const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
        'vscode.executeHoverProvider', uri, position,
      );
      assert.ok(hovers.length > 0);
      const renderedHover = hovers.map(hoverText).join('\n');
      assert.match(renderedHover, /环境：unspecified/u);
      assert.match(renderedHover, /有效性：pending/u);
      assert.match(renderedHover, /作用域：workspace/u);
      assert.match(renderedHover, /地图匹配：unknown/u);

      const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>(
        'vscode.executeCodeLensProvider', uri,
      );
      const lens = lenses.find((candidate) => candidate.command?.title.includes('201'));
      assert.ok(lens?.command?.title.includes('unspecified/pending'));
      assert.ok(lens.command.title.includes('workspace'));

      const actions = await vscode.commands.executeCommand<Array<vscode.CodeAction | vscode.Command>>(
        'vscode.executeCodeActionProvider', uri, diagnostic.range,
      );
      const quickFixes = actions.filter((action): action is vscode.CodeAction => (
        action instanceof vscode.CodeAction
        && (
          action.command?.command === 'yuanmengAi.openRegistryRecord'
          || action.command?.command === 'yuanmengAi.searchApi'
        )
      ));
      assert.ok(quickFixes.length > 0);
      assert.ok(quickFixes.every((action) => action.edit === undefined));
      assert.ok(quickFixes.every((action) => (
        action.command?.command === 'yuanmengAi.openRegistryRecord'
        || action.command?.command === 'yuanmengAi.searchApi'
      )));
    } finally {
      fakeOfficial.dispose();
    }
  },
}];
