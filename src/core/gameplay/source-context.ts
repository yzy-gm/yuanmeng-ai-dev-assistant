import type { ProjectDiagnostic } from '../diagnostics/analyzer.js';
import { ProductError } from '../errors.js';
import { buildLuaSourceIndex, type LuaApiKnowledge, type LuaSourceFile, type LuaSourceIndex } from '../lua/source-index.js';
import type { RegistryDocument, UiSnapshot } from '../model.js';
import type { CapabilityEvidenceResolution } from '../scene/probe-evidence.js';
import type { SceneSnapshot } from '../scene/types.js';
import { createGameplayKnowledgeFingerprint } from './model.js';
import type { GameplayModel } from './types.js';

export interface GameplaySourceContext {
  sourceIndex: LuaSourceIndex;
  syntaxDiagnostics: ProjectDiagnostic[];
  currentProject: GameplayModel['project'];
}

export function buildGameplaySourceContext(input: {
  project: Omit<GameplayModel['project'], 'knowledgeFingerprint'>;
  luaFiles: readonly LuaSourceFile[];
  registry: RegistryDocument;
  apiKnowledge: LuaApiKnowledge;
  uiSnapshot: UiSnapshot | null;
  sceneSnapshot: SceneSnapshot | null;
  runtimeCapabilities: ReadonlyMap<string, CapabilityEvidenceResolution>;
}): GameplaySourceContext {
  const parseableLuaFiles: LuaSourceFile[] = [];
  const syntaxDiagnostics: ProjectDiagnostic[] = [];
  for (const file of input.luaFiles) {
    try {
      buildLuaSourceIndex([file], input.registry, input.apiKnowledge);
      parseableLuaFiles.push(file);
    } catch (error) {
      if (!(error instanceof ProductError) || (error.code !== 'VALIDATION_FAILED' && error.code !== 'INVALID_LUA_SYNTAX')) throw error;
      syntaxDiagnostics.push({
        code: 'LUA_SYNTAX_ERROR', severity: 'error',
        message: `Lua 文件 ${file.path} 语法无效，未纳入严格源码索引。`,
        nextAction: '修复该 Lua 文件语法；若它是备份文件，应移出工程源码目录。',
        path: file.path, range: null, evidence: 'STATIC_LOCAL', runtimeVerified: false,
      });
    }
  }
  const sourceIndex = buildLuaSourceIndex(parseableLuaFiles, input.registry, input.apiKnowledge);
  return {
    sourceIndex,
    syntaxDiagnostics,
    currentProject: {
      ...input.project,
      knowledgeFingerprint: createGameplayKnowledgeFingerprint({
        project: input.project,
        luaFiles: input.luaFiles,
        registry: input.registry,
        uiSnapshot: input.uiSnapshot,
        sceneSnapshot: input.sceneSnapshot,
        runtimeCapabilities: input.runtimeCapabilities,
      }),
    },
  };
}
