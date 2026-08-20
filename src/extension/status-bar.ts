import { basename } from 'node:path';

import * as vscode from 'vscode';

import type { ManagedWorkspaceContext, WorkspaceContextManager } from './workspaces.js';

function linkLabel(state: ManagedWorkspaceContext['status']['link']['state']): string {
  return state === 'online' ? '在线' : state === 'offline' ? '离线' : '未知';
}

export function renderStatusText(context: ManagedWorkspaceContext): string {
  const project = basename(context.project.root) || '未知工程';
  const map = context.project.mapName ?? '未知地图';
  const link = `联动:${linkLabel(context.status.link.state)}`;
  const refreshed = context.status.ui.lastRefreshAt === null
    ? '刷新:从未'
    : `刷新:${context.status.ui.lastRefreshAt}`;
  const problemCount = Object.values(context.status.issueCounts).reduce((total, count) => total + count, 0);
  return `${project} | ${map} | ${link} | ${refreshed} | 问题:${problemCount}`;
}

export function createStatusBar(manager: WorkspaceContextManager): vscode.Disposable {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 20);
  item.command = 'yuanmengAi.openWizard';
  item.tooltip = '元梦 AI 开发助手';
  const update = (): void => {
    const first = manager.list()[0];
    item.text = first === undefined
      ? '$(tools) 未识别工程 | 未知地图 | 联动:未知 | 刷新:从未 | 问题:0'
      : `$(tools) ${renderStatusText(first)}`;
    item.show();
  };
  update();
  const listener = manager.onDidChange(update);
  return vscode.Disposable.from(item, listener);
}
