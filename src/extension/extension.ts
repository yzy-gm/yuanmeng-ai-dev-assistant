import { join } from 'node:path';

import * as vscode from 'vscode';

import {
  createOrRefreshCliLauncher,
  type CliLauncherInput,
  type CliLauncherResult,
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

export interface CompanionExtensionApi {
  listContexts(): WorkspaceContextSummary[];
  refreshUi(root: string): Promise<UiRefreshResult>;
  findUi(root: string, query: string): Promise<UiSearchResult>;
  statusText(root: string): string;
  wizardSteps: readonly string[];
  createOrRefreshCliLauncher(input: CliLauncherInput): Promise<CliLauncherResult>;
}

const CLI_COMMAND = '& ".\\.yuanmeng-inspector\\bin\\ymai.cmd" status --json';

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
  await Promise.all(manager.list().map(async (target) => createOrRefreshCliLauncher({
    projectRoot: target.project.root,
    projectInstanceId: target.project.projectInstanceId,
    projectRootHash: target.project.projectRootHash,
    extensionRoot: context.extensionPath,
    extensionVersion: version,
    cliPath: join(context.extensionPath, 'out', 'cli.cjs'),
  })));
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
  await refreshProjectLaunchers(context, manager);
  const requestQueue = new WorkspaceRequestQueue(manager);
  await requestQueue.reset();
  const searchResults = new SearchResultsProvider();
  const patchPreview = registerPatchPreviewController(context);
  const copyCliCommand = async (root?: string): Promise<void> => {
    const target = await manager.choose(root);
    await createOrRefreshCliLauncher({
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
  registerCommands(context, manager, searchResults, copyCliCommand, patchPreview);
  registerLanguageFeatures(context, manager);
  context.subscriptions.push(
    manager,
    requestQueue,
    createStatusBar(manager),
    vscode.workspace.onDidChangeWorkspaceFolders(async () => {
      await manager.reload(vscode.workspace.workspaceFolders ?? []);
      await refreshProjectLaunchers(context, manager);
      await requestQueue.reset();
    }),
  );

  return {
    listContexts: () => manager.summaries(),
    refreshUi: async (root) => manager.refreshUi(root),
    findUi: async (root, query) => manager.findUi(root, query),
    statusText: (root) => renderStatusText(manager.get(root)),
    wizardSteps: WIZARD_STEPS,
    createOrRefreshCliLauncher,
  };
}

export function deactivate(): void {
  // VSCode disposes everything registered in ExtensionContext.subscriptions.
}
