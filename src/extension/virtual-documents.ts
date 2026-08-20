import * as vscode from 'vscode';

import {
  applyProposal,
  type AppliedProposal,
  type PatchProposal,
  undoBackup,
} from '../core/patch/proposal.js';

const SCHEME = 'yuanmeng-ai-preview';

export type SimulatedPatchDecision = 'confirm' | 'cancel';

class PatchContentProvider implements vscode.TextDocumentContentProvider {
  private readonly documents = new Map<string, string>();

  set(uri: vscode.Uri, content: string): void {
    this.documents.set(uri.toString(), content);
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.documents.get(uri.toString()) ?? '-- 预览内容已失效，请重新生成。\n';
  }
}

export interface PatchPreviewController extends vscode.Disposable {
  previewAndApply(
    root: string,
    proposal: PatchProposal,
    simulatedDecision?: SimulatedPatchDecision,
    confirmationContext?: string,
  ): Promise<AppliedProposal | undefined>;
  confirmAndUndo(
    root: string,
    manifestPath: string,
    simulatedDecision?: SimulatedPatchDecision,
  ): Promise<boolean>;
}

export function registerPatchPreviewController(
  context: vscode.ExtensionContext,
): PatchPreviewController {
  const provider = new PatchContentProvider();
  const registration = vscode.workspace.registerTextDocumentContentProvider(SCHEME, provider);
  const canSimulate = context.extensionMode !== vscode.ExtensionMode.Production;

  async function decision(
    simulated: SimulatedPatchDecision | undefined,
    message: string,
    confirmLabel: string,
  ): Promise<boolean> {
    if (canSimulate && simulated !== undefined) return simulated === 'confirm';
    const choice = await vscode.window.showWarningMessage(message, { modal: true }, confirmLabel);
    return choice === confirmLabel;
  }

  const controller: PatchPreviewController = {
    async previewAndApply(root, proposal, simulatedDecision, confirmationContext) {
      const before = vscode.Uri.from({ scheme: SCHEME, path: `/${proposal.proposalId}/before.lua` });
      const after = vscode.Uri.from({ scheme: SCHEME, path: `/${proposal.proposalId}/after.lua` });
      provider.set(before, proposal.originalContent ?? '-- 文件当前不存在\n');
      provider.set(after, proposal.newContent);
      await vscode.commands.executeCommand(
        'vscode.diff',
        before,
        after,
        `元梦 AI 补丁预览：${proposal.targetPath}`,
        { preview: true },
      );
      const confirmed = await decision(
        simulatedDecision,
        `${confirmationContext === undefined ? '' : `${confirmationContext}\n`}`
          + `确认把以上差异写入 ${proposal.targetPath}？写入前会创建带哈希的本机备份。`,
        '确认写入',
      );
      if (!confirmed) return undefined;
      return applyProposal(root, proposal, true);
    },

    async confirmAndUndo(root, manifestPath, simulatedDecision) {
      const confirmed = await decision(
        simulatedDecision,
        '确认撤销此补丁？如果目标文件已被再次修改，撤销会安全停止。',
        '确认撤销',
      );
      if (!confirmed) return false;
      await undoBackup(root, manifestPath);
      return true;
    },

    dispose() {
      registration.dispose();
    },
  };
  context.subscriptions.push(controller);
  return controller;
}
