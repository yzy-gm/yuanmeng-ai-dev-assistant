import { join } from 'node:path';

import * as vscode from 'vscode';

import {
  createOrRefreshCliLauncher,
  createOrRefreshMcpLauncher,
  type CliLauncherInput,
  type CliLauncherResult,
  type McpLauncherInput,
  type McpLauncherResult,
} from './cli-launcher.js';
import { registerCommands } from './commands.js';
import { registerLanguageFeatures } from './language-features.js';
import { registerPatchPreviewController } from './virtual-documents.js';
import { WorkspaceRequestQueue } from './queue-host.js';
import { createStatusBar, renderStatusText } from './status-bar.js';
import { registerViews, SearchResultsProvider } from './views.js';
import { WIZARD_STEPS } from './wizard.js';
import { WorkspaceContextManager, type UiRefreshResult, type WorkspaceContextSummary } from './workspaces.js';
import { EXTENSION_ID } from '../core/launcher/manifest.js';
import {
  adaptOfficialUiTables,
  adaptSyntheticUiTablesForTests,
  parseOfficialUiExportFiles,
  parseSyntheticUiExportFilesForTests,
} from '../core/ui/adapter.js';
import type { UiSearchResult } from '../core/ui/index.js';
import { createSceneStatusBar, SceneController } from './scene-controller.js';
import { registerSceneViews } from './scene-views.js';
import { registerSceneCommands } from './scene-commands.js';
import { registerSceneWorkflowCommands, registerSceneWorkflowViews } from './scene-workflow-views.js';
import { inspectGameplayWorkspace, registerGameplayCommands, type GameplayViewSummary } from './gameplay-commands.js';
import { createSceneInspectionViews } from './scene-inspection-views.js';
import { registerGameplayView } from './gameplay-views.js';
import { registerPrivateToolsCommands } from './private-tools-commands.js';
import type { SceneQuery, SceneQueryResult } from '../core/scene/index.js';
import type { SceneSnapshot } from '../core/scene/types.js';
import { registerMcpProvider } from './mcp-provider.js';
import { buildMcpServerDefinitions, type LocalMcpServerDefinition } from './mcp-definitions.js';
import { registerCodexMcpCommands } from './codex-mcp-commands.js';
import { CodeDeliveryBridgeHost } from './code-delivery-bridge.js';
import { OfficialConnectionLogMonitor } from './official-connection-monitor.js';
import { MCP_TOOL_PROFILE_NAMES, type YuanmengMcpToolProfile } from '../mcp/contracts.js';
import { showReleaseNotice } from './release-notice.js';

export interface CompanionExtensionApi {
  listContexts(): WorkspaceContextSummary[];
  refreshUi(root: string): Promise<UiRefreshResult>;
  findUi(root: string, query: string): Promise<UiSearchResult>;
  statusText(root: string): string;
  wizardSteps: readonly string[];
  createOrRefreshCliLauncher(input: CliLauncherInput): Promise<CliLauncherResult>;
  createOrRefreshMcpLauncher(input: McpLauncherInput): Promise<McpLauncherResult>;
  refreshScene(root: string): Promise<SceneSnapshot>;
  findScene(root: string, query: SceneQuery): SceneQueryResult;
  gameplayStatus(root: string): Promise<GameplayViewSummary>;
  listMcpServerDefinitions(): LocalMcpServerDefinition[];
}

const CLI_COMMAND = '& ".\\.yuanmeng-inspector\\bin\\ymai.cmd" status --json';

function configuredMcpToolProfile(root: string): YuanmengMcpToolProfile {
  const value = vscode.workspace.getConfiguration('yuanmengAi', vscode.Uri.file(root)).get<string>('mcpToolProfile', 'workflow');
  return (MCP_TOOL_PROFILE_NAMES as readonly string[]).includes(value)
    ? value as YuanmengMcpToolProfile
    : 'workflow';
}

function configuredMcpPath(root: string, key: string): string | undefined {
  const value = vscode.workspace.getConfiguration('yuanmengAi', vscode.Uri.file(root)).get<string>(key, '').trim();
  return value === '' ? undefined : value;
}

function mcpProjectSummary(target: { project: { root: string; projectInstanceId: string }; mapDisplayName: string | null }): {
  root: string;
  projectInstanceId: string;
  mapDisplayName: string | null;
  mcpToolProfile: YuanmengMcpToolProfile;
  officialExtensionPath?: string;
  eventsDocumentationPath?: string;
  resourceDocumentationPath?: string;
  gameInstallPath?: string;
  ugcDataPath?: string;
} {
  const root = target.project.root;
  const officialExtensionPath = configuredMcpPath(root, 'officialExtensionPath');
  const eventsDocumentationPath = configuredMcpPath(root, 'eventsDocumentationPath');
  const resourceDocumentationPath = configuredMcpPath(root, 'resourceDocumentationPath');
  const gameInstallPath = configuredMcpPath(root, 'gameInstallPath');
  const ugcDataPath = configuredMcpPath(root, 'ugcDataPath');
  return {
    root,
    projectInstanceId: target.project.projectInstanceId,
    mapDisplayName: target.mapDisplayName,
    mcpToolProfile: configuredMcpToolProfile(root),
    ...(officialExtensionPath === undefined ? {} : { officialExtensionPath }),
    ...(eventsDocumentationPath === undefined ? {} : { eventsDocumentationPath }),
    ...(resourceDocumentationPath === undefined ? {} : { resourceDocumentationPath }),
    ...(gameInstallPath === undefined ? {} : { gameInstallPath }),
    ...(ugcDataPath === undefined ? {} : { ugcDataPath }),
  };
}

function extensionVersion(): string {
  const extension = vscode.extensions.getExtension(EXTENSION_ID);
  const version = extension?.packageJSON.version;
  if (typeof version !== 'string') {
    throw new Error('无法读取当前扩展版本。');
  }
  return version;
}

async function refreshProjectLaunchers(
  context: vscode.ExtensionContext,
  manager: WorkspaceContextManager,
): Promise<void> {
  const version = extensionVersion();
  await Promise.all(manager.list().flatMap((target) => [
    createOrRefreshCliLauncher({
      sourcePaths: mcpProjectSummary(target),
      projectRoot: target.project.root,
      projectInstanceId: target.project.projectInstanceId,
      projectRootHash: target.project.projectRootHash,
      extensionRoot: context.extensionPath,
      extensionVersion: version,
      cliPath: join(context.extensionPath, 'out', 'cli.cjs'),
    }),
    createOrRefreshMcpLauncher({
      sourcePaths: mcpProjectSummary(target),
      projectRoot: target.project.root,
      projectInstanceId: target.project.projectInstanceId,
      projectRootHash: target.project.projectRootHash,
      extensionRoot: context.extensionPath,
      extensionVersion: version,
      mcpPath: join(context.extensionPath, 'out', 'mcp.cjs'),
      toolProfile: configuredMcpToolProfile(target.project.root),
    }),
  ]));
}

export async function activate(context: vscode.ExtensionContext): Promise<CompanionExtensionApi> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const runningInExtensionHostTest = context.extensionMode !== vscode.ExtensionMode.Production;
  const useSyntheticSimulation = runningInExtensionHostTest
    && process.env.YMAI_EXTENSION_TEST_UI_ADAPTER === 'synthetic-simulation';
  const manager = await WorkspaceContextManager.create(folders, {
    uiAdapter: useSyntheticSimulation ? adaptSyntheticUiTablesForTests : adaptOfficialUiTables,
    uiPartParser: useSyntheticSimulation ? parseSyntheticUiExportFilesForTests : parseOfficialUiExportFiles,
    sourceEvidence: runningInExtensionHostTest ? 'EXTENSION_HOST' : 'OFFICIAL_EDITOR_SINGLE',
  });
  const sceneController = await SceneController.create(manager);
  await refreshProjectLaunchers(context, manager);
  const officialConnectionMonitor = new OfficialConnectionLogMonitor({
    logPath: context.logUri.fsPath,
    enabled: vscode.workspace.getConfiguration('yuanmengAi').get<boolean>('enableInternalLogAdapter', true),
    listProjects: () => manager.list().map((target) => ({ root: target.project.root })),
    onObservation: (root, observation) => manager.setOfficialConnectionObservation(root, observation),
  });
  context.subscriptions.push(officialConnectionMonitor);
  const mcpProvider = registerMcpProvider(context, () => manager.list().map(mcpProjectSummary));
  let launcherRefresh: Promise<void> = Promise.resolve();
  const requestQueue = new WorkspaceRequestQueue(manager);
  await requestQueue.reset();
  const searchResults = new SearchResultsProvider();
  const patchPreview = registerPatchPreviewController(context);
  const copyCliCommand = async (root?: string): Promise<void> => {
    const target = await manager.choose(root);
    await createOrRefreshCliLauncher({
      sourcePaths: mcpProjectSummary(target),
      projectRoot: target.project.root,
      projectInstanceId: target.project.projectInstanceId,
      projectRootHash: target.project.projectRootHash,
      extensionRoot: context.extensionPath,
      extensionVersion: extensionVersion(),
      cliPath: join(context.extensionPath, 'out', 'cli.cjs'),
    });
    await vscode.env.clipboard.writeText(CLI_COMMAND);
  };
  registerViews(context, manager, searchResults);
  registerCommands(
    context,
    manager,
    searchResults,
    copyCliCommand,
    patchPreview,
    async (root) => sceneController.reloadRuntimeEvidence(root),
  );
  registerSceneViews(context, sceneController);
  const sceneWorkflowViews = registerSceneWorkflowViews(context, sceneController);
  const sceneInspectionViews = createSceneInspectionViews(sceneController, manager);
  context.subscriptions.push(
    sceneInspectionViews,
    vscode.window.registerTreeDataProvider('yuanmengAi.sceneFields', sceneInspectionViews.fields),
    vscode.window.registerTreeDataProvider('yuanmengAi.sceneProblems', sceneInspectionViews.problems),
  );
  registerSceneCommands(context, manager, sceneController);
  registerSceneWorkflowCommands(context, manager, sceneController, sceneWorkflowViews);
  registerGameplayCommands(context, manager, sceneController);
  registerGameplayView(context, manager, sceneController);
  registerPrivateToolsCommands(context, manager, sceneController);
  registerCodexMcpCommands(context, manager);
  registerLanguageFeatures(context, manager);
  context.subscriptions.push(
    manager,
    sceneController,
    createSceneStatusBar(sceneController, manager),
    requestQueue,
    createStatusBar(manager),
    new CodeDeliveryBridgeHost(manager),
    manager.onDidChange(() => mcpProvider.fireChanged()),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (['mcpToolProfile', 'officialExtensionPath', 'eventsDocumentationPath', 'resourceDocumentationPath', 'gameInstallPath', 'ugcDataPath']
        .some((key) => event.affectsConfiguration(`yuanmengAi.${key}`))) {
        // Serialize updates so an older configuration cannot overwrite newer launchers.
        launcherRefresh = launcherRefresh.then(() => refreshProjectLaunchers(context, manager))
          .then(() => mcpProvider.fireChanged()).catch((error) => {
            void vscode.window.showWarningMessage(`工程启动器配置刷新失败：${error instanceof Error ? error.message : '未知错误'}`);
          });
      }
      if (event.affectsConfiguration('yuanmengAi.enableInternalLogAdapter')) {
        officialConnectionMonitor.setEnabled(
          vscode.workspace.getConfiguration('yuanmengAi').get<boolean>('enableInternalLogAdapter', true),
        );
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(async () => {
      await manager.reload(vscode.workspace.workspaceFolders ?? []);
      await sceneController.reload();
      await refreshProjectLaunchers(context, manager);
      await requestQueue.reset();
      await officialConnectionMonitor.refresh();
    }),
  );

  void showReleaseNotice(context).catch(() => { /* A notice must not interrupt workspace activation. */ });
  return {
    listContexts: () => manager.summaries(),
    refreshUi: async (root) => manager.refreshUi(root),
    findUi: async (root, query) => manager.findUi(root, query),
    statusText: (root) => renderStatusText(manager.get(root)),
    wizardSteps: WIZARD_STEPS,
    createOrRefreshCliLauncher,
    createOrRefreshMcpLauncher,
    refreshScene: async (root) => sceneController.refresh(root),
    findScene: (root, query) => sceneController.find(root, query),
    gameplayStatus: async (root) => inspectGameplayWorkspace(manager, sceneController, root),
    listMcpServerDefinitions: () => buildMcpServerDefinitions(manager.list().map(mcpProjectSummary)),
  };
}

export function deactivate(): void {
  // VSCode disposes everything registered in ExtensionContext.subscriptions.
}
