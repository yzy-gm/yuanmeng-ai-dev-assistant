import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

const COMMANDS = [
  'yuanmengAi.copySceneHierarchyPath',
  'yuanmengAi.copySceneLuaConstant',
  'yuanmengAi.copySceneJsonSnippet',
  'yuanmengAi.findSceneLuaReferences',
  'yuanmengAi.planSceneSelection',
  'yuanmengAi.previewSceneRebind',
  'yuanmengAi.openAnonymousDiagnostic',
  'yuanmengAi.recordFeedback',
  'yuanmengAi.openFeedbackInbox',
] as const;

const VIEWS = ['yuanmengAi.sceneFields', 'yuanmengAi.sceneProblems'] as const;

describe('scene intelligence extension contributions', () => {
  it('contributes every scene context command and both persistent inspection views', async () => {
    const manifest = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')) as {
      contributes?: {
        commands?: Array<{ command?: string; title?: string }>;
        views?: Record<string, Array<{ id?: string; name?: string }>>;
        menus?: { 'view/item/context'?: Array<{ command?: string; when?: string }> };
      };
    };
    const declaredCommands = new Map((manifest.contributes?.commands ?? []).map((entry) => [entry.command, entry.title]));
    const contextCommands = new Map((manifest.contributes?.menus?.['view/item/context'] ?? []).map((entry) => [entry.command, entry.when]));
    for (const command of COMMANDS) {
      expect(declaredCommands.get(command)).toMatch(/^%command\.[A-Za-z]+%$/u);
      if (![
        'yuanmengAi.previewSceneRebind',
        'yuanmengAi.openAnonymousDiagnostic',
        'yuanmengAi.recordFeedback',
        'yuanmengAi.openFeedbackInbox',
      ].includes(command)) {
        expect(contextCommands.get(command)).toMatch(/yuanmengSceneInstance|yuanmengSceneGroup/u);
      }
    }
    const declaredViews = new Map((manifest.contributes?.views?.yuanmengAi ?? []).map((entry) => [entry.id, entry.name]));
    for (const view of VIEWS) expect(declaredViews.get(view)).toMatch(/^%views\.[A-Za-z]+%$/u);
  });

  it('localizes the new scene commands and views in Chinese and English', async () => {
    const [zh, en] = await Promise.all([
      readFile(new URL('../../package.nls.json', import.meta.url), 'utf8').then((value) => JSON.parse(value) as Record<string, string>),
      readFile(new URL('../../package.nls.en.json', import.meta.url), 'utf8').then((value) => JSON.parse(value) as Record<string, string>),
    ]);
    for (const key of [
      'command.copySceneHierarchyPath',
      'command.copySceneLuaConstant',
      'command.copySceneJsonSnippet',
      'command.findSceneLuaReferences',
      'command.planSceneSelection',
      'command.previewSceneRebind',
      'command.openAnonymousDiagnostic',
      'command.recordFeedback',
      'command.openFeedbackInbox',
      'views.sceneFields',
      'views.sceneProblems',
    ]) {
      expect(zh[key]?.trim()).toBeTruthy();
      expect(en[key]?.trim()).toBeTruthy();
    }
  });
});
