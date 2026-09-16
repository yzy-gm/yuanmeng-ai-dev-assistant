import { basename } from 'node:path';

import * as vscode from 'vscode';

import {
  formatCompanionStatus,
  formatCompanionStatusSegments,
  type CompanionStatusDisplayInput,
  type CompanionStatusSegment,
} from '../core/status/display.js';
import type { ManagedWorkspaceContext, WorkspaceContextManager } from './workspaces.js';

function displayInput(context: ManagedWorkspaceContext): CompanionStatusDisplayInput {
  const problemCount = Object.values(context.status.issueCounts).reduce((total, count) => total + count, 0);
  return {
    projectName: basename(context.project.root) || '未知工程',
    mapDisplayName: context.mapDisplayName,
    officialMapName: context.project.mapName,
    linkState: context.status.link.state,
    linkReasonCode: context.status.link.reasonCode,
    lastRefreshAt: context.status.ui.lastRefreshAt,
    problemCount,
  };
}

export function renderStatusText(context: ManagedWorkspaceContext): string {
  return formatCompanionStatus(displayInput(context));
}

export function createStatusBar(manager: WorkspaceContextManager): vscode.Disposable {
  const items = [0, 1, 2, 3, 4].map((_value, index) => (
    vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 24 - index)
  ));
  const activeRoot = (): string | null => {
    const uri = vscode.window.activeTextEditor?.document.uri;
    if (uri === undefined) return null;
    return vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath ?? null;
  };
  const update = (): void => {
    const contexts = manager.list();
    const selectedRoot = activeRoot();
    const selected = selectedRoot === null
      ? contexts.length === 1 ? contexts[0] : undefined
      : contexts.find((context) => context.project.root === selectedRoot);
    const segments: CompanionStatusSegment[] = selected === undefined
      ? formatCompanionStatusSegments({
        projectName: contexts.length > 1 ? '多个工程' : '未识别工程',
        mapDisplayName: null,
        officialMapName: null,
        linkState: 'unknown',
        lastRefreshAt: null,
        problemCount: 0,
      })
      : formatCompanionStatusSegments(displayInput(selected));
    segments.forEach((segment, index) => {
      const item = items[index]!;
      item.text = index === 0 ? `$(tools) ${segment.text}` : segment.text;
      item.tooltip = segment.tooltip;
      item.command = selected === undefined || segment.action === null
        ? undefined
        : segment.action === 'set-map-name'
          ? { command: 'yuanmengAi.setMapDisplayName', title: '设置地图名称', arguments: [selected.project.root] }
          : { command: 'yuanmengAi.openWizard', title: '打开开发向导', arguments: [] };
      item.show();
    });
  };
  update();
  const listener = manager.onDidChange(update);
  return vscode.Disposable.from(...items, listener, vscode.window.onDidChangeActiveTextEditor(update));
}
