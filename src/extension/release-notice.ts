import * as vscode from 'vscode';

const NOTICE_KEY = 'yuanmengAi.releaseNotice.0.6.0';

export async function showReleaseNotice(context: vscode.ExtensionContext): Promise<void> {
  if (context.extensionMode !== vscode.ExtensionMode.Production || context.globalState.get<boolean>(NOTICE_KEY)) return;
  await context.globalState.update(NOTICE_KEY, true);
  const choice = await vscode.window.showInformationMessage(
    '元梦 AI 开发助手 0.6.0：全部插件功能现已采用 MIT 许可证开源，包含场景、Lua 审查、MCP 和玩法模拟。',
    '查看更新公告',
  );
  if (choice === '查看更新公告') {
    await vscode.commands.executeCommand('markdown.showPreview', vscode.Uri.joinPath(context.extensionUri, 'RELEASE_NOTES.md'));
  }
}
