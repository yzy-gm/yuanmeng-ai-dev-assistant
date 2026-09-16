import { join } from 'node:path';

import * as vscode from 'vscode';

import {
  desiredCodexRegistration,
  inspectCodexRegistration,
  parseCodexMcpList,
  runCodexMcpCommand,
  type CodexRegistrationPreview
} from './codex-mcp-registration.js';

interface CodexProject {
  project: { root: string; projectInstanceId: string };
}

interface CodexProjectChooser {
  choose(root?: string): Promise<CodexProject>;
}

async function preview(manager: CodexProjectChooser, root?: string): Promise<{
  desired: ReturnType<typeof desiredCodexRegistration>;
  preview: CodexRegistrationPreview;
}> {
  const target = await manager.choose(root);
  const desired = desiredCodexRegistration(
    target.project.projectInstanceId,
    join(target.project.root, '.yuanmeng-inspector', 'bin', 'ymai-mcp.cmd'),
  );
  const listed = await runCodexMcpCommand('list', desired);
  return { desired, preview: inspectCodexRegistration(parseCodexMcpList(listed.stdout), desired) };
}

export function registerCodexMcpCommands(
  context: vscode.ExtensionContext,
  manager: CodexProjectChooser,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('yuanmengAi.previewCodexMcpRegistration', async (root?: string) => preview(manager, root)),
    vscode.commands.registerCommand('yuanmengAi.registerCodexMcp', async (root?: string, simulatedConfirm?: boolean) => {
      const state = await preview(manager, root);
      if (state.preview.state === 'conflict') throw new Error('CODEX_MCP_NAME_CONFLICT');
      if (state.preview.state === 'current') return { ...state.preview, changed: false, requiresNewSession: true };
      const confirmed = simulatedConfirm === true || await vscode.window.showWarningMessage(
        `将通过 Codex CLI 注册本机 MCP：${state.desired.name}\n${state.desired.launcherPath}`,
        { modal: true },
        '确认注册',
      ) === '确认注册';
      if (!confirmed) return { ...state.preview, changed: false, cancelled: true };
      await runCodexMcpCommand('add', state.desired);
      return { ...(await preview(manager, root)).preview, changed: true, requiresNewSession: true };
    }),
    vscode.commands.registerCommand('yuanmengAi.removeCodexMcp', async (root?: string, simulatedConfirm?: boolean) => {
      const state = await preview(manager, root);
      if (state.preview.state === 'missing') return { ...state.preview, changed: false };
      if (state.preview.state === 'conflict') throw new Error('CODEX_MCP_NAME_CONFLICT');
      const confirmed = simulatedConfirm === true || await vscode.window.showWarningMessage(
        `仅移除当前工程的 Codex MCP 条目：${state.desired.name}`,
        { modal: true },
        '确认移除',
      ) === '确认移除';
      if (!confirmed) return { ...state.preview, changed: false, cancelled: true };
      await runCodexMcpCommand('remove', state.desired);
      return { ...(await preview(manager, root)).preview, changed: true, requiresNewSession: true };
    }),
  );
}
