import * as vscode from 'vscode';

import type { WorkspaceContextManager } from './workspaces.js';

export const WIZARD_STEPS = ['检测官方插件', '开启联动', '激活工程', '更新 VSCode 工程 / 获取 UI 结构', '搜索控件'] as const;

export async function runWizard(manager: WorkspaceContextManager): Promise<void> {
  const capabilities = await manager.detectOfficialCapabilities();
  if (!capabilities.refreshUi) {
    await vscode.window.showErrorMessage('未检测到官方“获取自定义界面结构”命令。请安装或启用官方元梦开发助手。');
    return;
  }
  if (capabilities.startWork) {
    const choice = await vscode.window.showInformationMessage('官方插件已检测。下一步需要开启联动环境。', '调用官方开启联动');
    if (choice === '调用官方开启联动') {
      await vscode.commands.executeCommand('dreamhelper.startWork');
    }
  } else {
    await vscode.window.showWarningMessage('请先在官方元梦开发助手中开启联动环境，然后继续。');
  }
  const target = await manager.choose();
  await manager.refreshUi(target.project.root);
  const query = await vscode.window.showInputBox({
    prompt: '输入控件对象名称，例如“经验”；请修改右侧顶部对象名称，不要只改“显示的文字”',
  });
  if (query !== undefined && query.trim() !== '') {
    await vscode.commands.executeCommand('yuanmengAi.findUi', query, target.project.root);
  }
}
