import * as vscode from 'vscode';

import type { SceneQueryResult } from '../core/scene/index.js';
import type { SceneSnapshot } from '../core/scene/types.js';
import type { SceneTreeNode } from './scene-views.js';
import type { WorkspaceContextManager } from './workspaces.js';

export const WIZARD_STEPS = [
  '选择目标工程',
  'UI：获取结构并查找控件',
  '场景：可选的本地只读快照',
  '台账：核对 ID 与信号',
  'Lua：检查引用并预览修改',
  'API：查询官方公开签名',
  '属性：读取或预览单元件修改',
  '构建：确认后调用官方合成',
] as const;

type WizardAction = 'ui' | 'scene' | 'registry' | 'lua' | 'api' | 'property' | 'build' | 'close';

interface WizardItem extends vscode.QuickPickItem {
  action: WizardAction;
}

function workflowItems(): WizardItem[] {
  return [
    { label: '$(symbol-color) 1. UI：获取结构并查找控件', description: '官方 UI 导出落盘后建立索引；同时保留自动刷新与手动兜底', action: 'ui' },
    { label: '$(symbol-structure) 2. 场景：可选的本地只读快照', description: '仅在工程存在官方落盘场景文件时读取；没有 LayerData 文件则跳过，不读取编辑器内存', action: 'scene' },
    { label: '$(database) 3. 台账：核对 ID 与信号', description: '确认工程绑定、pending/confirmed/失效状态与来源证据', action: 'registry' },
    { label: '$(code) 4. Lua：检查引用并预览修改', description: '诊断硬编码/失效引用；任何修改仍需预览和确认', action: 'lua' },
    { label: '$(book) 5. API：查询官方公开签名', description: '只使用官方公开 API 索引，不猜测名称或参数', action: 'api' },
    { label: '$(settings) 6. 属性：读取或预览单元件修改', description: '官方面板确认后读取；写入和推送分别确认', action: 'property' },
    { label: '$(tools) 7. 构建：确认后调用官方合成', description: '先显示警告并确认；产物更新不等于编辑器运行通过', action: 'build' },
    { label: '$(close) 结束向导', action: 'close' },
  ];
}

async function runSceneWizardStep(root: string, officialUiLinked: boolean): Promise<void> {
  void vscode.window.showInformationMessage(
    `Lua 工程检查通过；官方 UI 联动：${officialUiLinked ? '可用' : '不可用'}。场景索引只读已落盘的 LayerData；官方编辑器没有此文件时可直接跳过。`,
  );
  const state = await vscode.window.showQuickPick([
    { label: '导入已存在的只读场景文件（可选）', command: 'yuanmengAi.bindSceneSource' },
    { label: '刷新已有场景绑定', command: 'yuanmengAi.refreshScene' },
  ], { placeHolder: '阶段 1/3：绑定或刷新只读场景快照；取消不会提交任何变更' });
  if (state === undefined) return;
  const snapshot = await vscode.commands.executeCommand<SceneSnapshot>(state.command, root);
  if (snapshot === undefined) return;
  void vscode.window.showInformationMessage(
    `场景 worker 阶段 complete：${snapshot.instances.length} 个元件，${snapshot.groups.length} 个编组。现在进入查找。`,
  );

  const found = await vscode.commands.executeCommand<SceneQueryResult | undefined>('yuanmengAi.findScene', root);
  if (found === undefined || found.kind === 'not-found') return;
  const match = found.kind === 'found'
    ? found.matches[0]
    : (await vscode.window.showQuickPick(found.matches.map((instance) => ({
      label: `实例 ${instance.instanceId}`,
      description: `类型 ${instance.elementTypeId ?? '未知'} · owner ${instance.ownerId ?? '无'}`,
      instance,
    })), { placeHolder: '阶段 2/3：查询为 AMBIGUOUS；请选择明确目标，取消即停止' }))?.instance;
  if (match === undefined) return;
  const continuePlan = await vscode.window.showQuickPick([
    { label: '继续生成通用空间计划', description: '阶段 3/3；计划始终 execute=false，仅预览', proceed: true },
    { label: '只查看查找结果并返回', proceed: false },
  ], { placeHolder: '是否以刚找到的元件继续？' });
  if (continuePlan?.proceed !== true) return;
  const node: Extract<SceneTreeNode, { kind: 'instance' }> = { kind: 'instance', root, instance: match };
  await vscode.commands.executeCommand('yuanmengAi.planSceneSelection', node);
}

export async function runWizard(manager: WorkspaceContextManager): Promise<void> {
  const target = await manager.choose();
  const root = target.project.root;
  const capabilities = await manager.detectOfficialCapabilities();
  if (!capabilities.refreshUi) {
    void vscode.window.showWarningMessage('未检测到官方“获取自定义界面结构”命令；场景只读、台账和 Lua 静态检查仍可继续使用。');
  }

  while (true) {
    const selected = await vscode.window.showQuickPick(workflowItems(), {
      title: `元梦 AI 全流程向导 · ${target.project.mapName ?? '当前工程'}`,
      placeHolder: '按实际进度选择下一步；所有修改性动作仍会单独预览和确认',
    });
    if (selected === undefined || selected.action === 'close') return;
    if (selected.action === 'ui') {
      if (!capabilities.refreshUi) {
        void vscode.window.showErrorMessage('官方 UI 获取命令不可用；请启用官方元梦开发助手后使用手动刷新。');
        continue;
      }
      await vscode.commands.executeCommand('yuanmengAi.refreshUi', root);
      const query = await vscode.window.showInputBox({ prompt: '可选：输入控件对象名称；留空返回向导' });
      if (query !== undefined && query.trim() !== '') {
        await vscode.commands.executeCommand('yuanmengAi.findUi', query, root);
      }
    } else if (selected.action === 'scene') {
      await runSceneWizardStep(root, capabilities.refreshUi);
    } else if (selected.action === 'registry') {
      await vscode.commands.executeCommand('yuanmengAi.registry.focus');
      void vscode.window.showInformationMessage('台账中的 pending 只代表已发现或用户登记，不代表官方编辑器已经验证。');
    } else if (selected.action === 'lua') {
      await vscode.commands.executeCommand('workbench.actions.view.problems');
      void vscode.window.showInformationMessage('已打开问题面板。先处理跨工程、失效 ID 和类型/实例混用；应用修改仍走补丁预览。');
    } else if (selected.action === 'api') {
      await vscode.commands.executeCommand('yuanmengAi.searchApi');
    } else if (selected.action === 'property') {
      await vscode.commands.executeCommand('yuanmengAi.readProperty', root);
    } else {
      await vscode.commands.executeCommand('yuanmengAi.buildScripts', root);
    }
  }
}
