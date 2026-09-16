import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { runCli } from '../../src/cli/main.js';
import { normalizeCanonicalRoot } from '../../src/cli/project.js';
import { buildLuaApiKnowledge } from '../../src/core/api/lua-knowledge.js';
import { analyzeProject } from '../../src/core/diagnostics/analyzer.js';
import { GameplayRunStore, createNodeGameplayRunStoreIO } from '../../src/core/gameplay/run-store.js';
import { buildGameplaySourceContext } from '../../src/core/gameplay/source-context.js';
import { runGameplayWorkflow } from '../../src/core/gameplay/workflow.js';
import { nodeFileIO } from '../../src/core/fs.js';
import { sha256Hex } from '../../src/core/hash.js';
import { loadOfficialApiIndexFromEnvironment } from '../../src/integrations/official/api-index-loader.js';
import { McpGateway } from '../../src/mcp/gateway.js';
import type { LuaSourceFile } from '../../src/core/lua/source-index.js';
import type { RegistryDocument } from '../../src/core/model.js';

const roots: string[] = [];
const registry: RegistryDocument = { schemaVersion: 1, records: [] };

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function createProject(source: string, backup?: string): Promise<{ root: string; projectInstanceId: string; luaFiles: LuaSourceFile[] }> {
  const root = await mkdtemp(join(tmpdir(), 'ymai-gameplay-consistency-'));
  roots.push(root);
  const projectInstanceId = '66666666-6666-4666-8666-666666666666';
  await mkdir(join(root, 'src'), { recursive: true });
  await mkdir(join(root, '.yuanmeng-inspector'), { recursive: true });
  await writeFile(join(root, 'src', 'GameEntry.lua'), source, 'utf8');
  const luaFiles: LuaSourceFile[] = [{ path: 'src/GameEntry.lua', source }];
  if (backup !== undefined) {
    await mkdir(join(root, 'src', 'Backup'), { recursive: true });
    await writeFile(join(root, 'src', 'Backup', 'Broken.lua'), backup, 'utf8');
    luaFiles.push({ path: 'src/Backup/Broken.lua', source: backup });
  }
  await writeFile(join(root, '.yuanmeng-inspector', 'meta.json'), JSON.stringify({
    schemaVersion: 1,
    projectInstanceId,
    projectRootHash: sha256Hex(normalizeCanonicalRoot(await realpath(root))),
  }), 'utf8');
  return { root, projectInstanceId, luaFiles };
}

async function runAll(source: string, backup?: string) {
  const project = await createProject(source, backup);
  const cli = await runCli(['gameplay-test', '--json'], { cwd: project.root });
  const cliData = cli.envelope.data as Record<string, unknown>;

  const gateway = new McpGateway({
    projectRoot: project.root,
    projectInstanceId: project.projectInstanceId,
    displayName: null,
    currentCliPath: resolve('out/cli.cjs'),
  });
  const mcp = await gateway.call('yuanmeng_gameplay_test', {}, new AbortController().signal);
  const mcpData = mcp.data as Record<string, unknown>;

  const projectBase = { projectInstanceId: project.projectInstanceId, mapFingerprint: null, sceneSnapshotId: null };
  const apiIndex = await loadOfficialApiIndexFromEnvironment();
  const sourceContext = buildGameplaySourceContext({
    project: projectBase,
    luaFiles: project.luaFiles,
    registry,
    apiKnowledge: buildLuaApiKnowledge(apiIndex),
    uiSnapshot: null,
    sceneSnapshot: null,
    runtimeCapabilities: new Map(),
  });
  const diagnostics = [
    ...sourceContext.syntaxDiagnostics,
    ...analyzeProject({
      sourceIndex: sourceContext.sourceIndex,
      registry,
      apiIndex,
      uiSnapshot: null,
      status: null,
      projectInstanceId: project.projectInstanceId,
      mapFingerprint: null,
    }),
  ];
  const shared = await runGameplayWorkflow({
    root: project.root,
    mode: 'auto',
    currentProject: sourceContext.currentProject,
    luaFiles: project.luaFiles,
    strictDiagnostics: diagnostics,
    strictPreparationFindings: [],
    sourceIndex: sourceContext.sourceIndex,
    eventMetadata: new Map(),
    registry,
    uiSnapshot: null,
    sceneSnapshot: null,
    runtimeCapabilities: new Map(),
    store: new GameplayRunStore({ io: createNodeGameplayRunStoreIO(nodeFileIO), runIdFactory: () => `shared-${roots.length}` }),
  });

  return { project, cli, cliData, mcp, mcpData, shared };
}

function sharedFields(value: Awaited<ReturnType<typeof runAll>>) {
  return {
    modelFingerprint: value.shared.modelFingerprint,
    scenarioFingerprint: value.shared.scenarioFingerprint,
    strictStaticGate: value.shared.strictReview.staticGate.status,
    simulationGate: value.shared.simulationGate.status,
    classification: value.shared.classification,
  };
}

describe('gameplay entry consistency', () => {
  it.each([
    {
      name: 'ordinary production flow',
      source: ['---@ymai-side server', 'System:RegisterEvent("entry.flow", function()', '  UI:Show()', 'end)'].join('\n'),
      backup: undefined,
      expected: 'partial-needs-editor',
    },
    {
      name: 'unreachable broken backup',
      source: ['---@ymai-side server', 'System:RegisterEvent("entry.flow", function()', '  UI:Show()', 'end)'].join('\n'),
      backup: 'local =',
      expected: 'partial-needs-editor',
    },
    {
      name: 'reachable syntax failure',
      source: 'local =',
      backup: undefined,
      expected: 'not-run-fatal',
    },
  ])('returns identical fingerprints and gates for $name', async ({ source, backup, expected }) => {
    const value = await runAll(source, backup);
    const expectedFields = sharedFields(value);
    expect(value.cliData).toMatchObject(expectedFields);
    expect(value.mcpData).toMatchObject(expectedFields);
    expect(value.shared.classification).toBe(expected);
    expect(value.cli.envelope.ok).toBe(value.mcp.ok);

    const storedText = JSON.stringify(value.shared.run);
    expect(storedText).not.toContain(value.project.root);
    for (const finding of value.shared.preparationFindings) for (const evidence of finding.evidence) {
      expect(evidence.path).toMatch(/^src\//u);
      expect(evidence.line).toBeGreaterThan(0);
      expect(evidence.column).toBeGreaterThan(0);
    }
  });
});
