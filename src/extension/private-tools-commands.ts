import { basename, join, relative } from 'node:path';
import { readdir } from 'node:fs/promises';

import * as vscode from 'vscode';

import {
  createAnonymousDiagnosticBundle,
  renderAnonymousDiagnosticBundle,
  type PrivateDiagnosticFormat,
  type PrivateDiagnosticNextAction,
} from '../core/diagnostics/private-bundle.js';
import { ProductError } from '../core/errors.js';
import {
  addFeedback,
  listFeedback,
  type FeedbackKind,
} from '../core/feedback/store.js';
import { buildLuaSourceIndex, type LuaSourceFile } from '../core/lua/source-index.js';
import type { RegistryDocument } from '../core/model.js';
import { applyProposal, undoBackup } from '../core/patch/proposal.js';
import { createGameplayTraceInsertion, createGameplayTraceRemoval } from '../core/logs/gameplay-trace.js';
import {
  applyLuaRebindPatch,
  buildSceneRebindPreview,
  createLuaRebindPatchPreview,
} from '../core/scene/rebind.js';
import { loadSceneSnapshotIfValid } from '../core/scene/store.js';
import type { SceneSnapshot } from '../core/scene/types.js';
import { nodeFileIO } from '../core/fs.js';
import type { SceneController } from './scene-controller.js';
import type { WorkspaceContextManager } from './workspaces.js';

const SNAPSHOT_FILE = /^[a-f0-9]{64}\.json$/u;

function message(error: unknown): string {
  if (error instanceof ProductError) {
    return `${error.message}${error.nextActions[0] === undefined ? '' : `\n下一步：${error.nextActions[0]}`}`;
  }
  return error instanceof Error ? error.message : '未知私有工具错误。';
}

async function collectLuaFiles(root: string): Promise<LuaSourceFile[]> {
  const uris = await vscode.workspace.findFiles(new vscode.RelativePattern(root, 'src/**/*.lua'), undefined, 10_001);
  if (uris.length > 10_000) {
    throw new ProductError('LUA_LIMIT_EXCEEDED', 'Lua 文件数量超过 10000 个上限。', ['缩小工程源码范围。'], 'STATIC_LOCAL');
  }
  const files: LuaSourceFile[] = [];
  for (const uri of uris.sort((left, right) => left.fsPath.localeCompare(right.fsPath, 'en'))) {
    if (/^Custom(?:UIData|Property_).*\.lua$/u.test(basename(uri.fsPath))) continue;
    files.push({
      path: relative(root, uri.fsPath).replace(/\\/gu, '/'),
      source: Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8'),
    });
  }
  return files;
}

async function previousSnapshots(root: string, current: SceneSnapshot): Promise<SceneSnapshot[]> {
  let names: string[];
  try {
    names = await readdir(join(root, '.yuanmeng-inspector', 'scene', 'snapshots'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const loaded = await Promise.all(names
    .filter((name) => SNAPSHOT_FILE.test(name) && name !== `${current.snapshotId}.json`)
    .slice(0, 2_000)
    .map((name) => loadSceneSnapshotIfValid(root, name.slice(0, -5), nodeFileIO)));
  return loaded
    .filter((candidate): candidate is SceneSnapshot => candidate !== null)
    .filter((candidate) => (
      candidate.bindingId === current.bindingId
      && candidate.role === current.role
      && candidate.adapterId === current.adapterId
    ))
    .sort((left, right) => right.observedAt.localeCompare(left.observedAt, 'en'));
}

async function showContent(content: string, language: 'json' | 'markdown' | 'lua'): Promise<void> {
  const document = await vscode.workspace.openTextDocument({ content, language });
  await vscode.window.showTextDocument(document, { preview: true });
}

const FEEDBACK_KIND_LABELS: Readonly<Record<FeedbackKind, string>> = {
  bug: '错误：功能结果不正确',
  friction: '阻碍：可以完成但过程费时或难用',
  improvement: '建议：新增或优化能力',
};

async function runRecordFeedback(
  context: vscode.ExtensionContext,
  manager: WorkspaceContextManager,
  sceneController: SceneController,
  suppliedRoot?: string,
  supplied?: { kind?: FeedbackKind; title?: string; message?: string; source?: 'ai' | 'user' },
): Promise<void> {
  const target = await manager.choose(suppliedRoot);
  const kind = supplied?.kind ?? await vscode.window.showQuickPick(
    (Object.entries(FEEDBACK_KIND_LABELS) as Array<[FeedbackKind, string]>).map(([value, label]) => ({ label, value })),
    { placeHolder: '选择反馈类型；记录只保存在当前工程本机目录' },
  ).then((selected) => selected?.value);
  if (kind === undefined) return;
  const title = supplied?.title ?? await vscode.window.showInputBox({
    prompt: '一句话说明发现的问题或建议',
    validateInput: (value) => value.trim().length === 0 ? '标题不能为空。' : value.length > 120 ? '标题不能超过 120 个字符。' : undefined,
  });
  if (title === undefined) return;
  const detail = supplied?.message ?? await vscode.window.showInputBox({
    prompt: '写明操作步骤、实际结果、期望结果；AI 会据此集中审查',
    validateInput: (value) => value.trim().length === 0 ? '反馈内容不能为空。' : value.length > 4_000 ? '反馈内容不能超过 4000 个字符。' : undefined,
  });
  if (detail === undefined) return;
  const entry = await addFeedback(target.project.root, {
    kind,
    title,
    message: detail,
    source: supplied?.source ?? 'user',
    context: {
      projectInstanceId: target.project.projectInstanceId,
      extensionVersion: context.extension.packageJSON.version as string,
      uiSnapshotId: target.snapshot?.snapshotId ?? null,
      sceneSnapshotId: sceneController.get(target.project.root).snapshot?.snapshotId ?? null,
    },
  }, nodeFileIO);
  await vscode.window.showInformationMessage(
    `反馈已保存在当前工程：${entry.feedbackId.slice(0, 12)}。AI 可运行 feedback list --json 集中读取。`,
  );
}

function markdownCell(value: string): string {
  return value.replace(/\|/gu, '\\|').replace(/[\r\n]+/gu, ' ');
}

async function runOpenFeedbackInbox(
  manager: WorkspaceContextManager,
  suppliedRoot?: string,
): Promise<void> {
  const target = await manager.choose(suppliedRoot);
  const result = await listFeedback(target.project.root, { status: null, kind: null }, nodeFileIO);
  const visible = result.entries.slice(0, 200);
  const rows = visible.map((entry) => `| ${entry.status === 'open' ? '待处理' : '已处理'} | ${FEEDBACK_KIND_LABELS[entry.kind]} | ${markdownCell(entry.title)} | \`${entry.feedbackId.slice(0, 12)}\` | ${entry.createdAt} |`);
  await showContent([
    '# 元梦 AI 开发助手：本地反馈箱',
    '',
    `当前工程共有 **${result.summary.total}** 条；待处理 **${result.summary.open}** 条，已处理 **${result.summary.resolved}** 条。`,
    '',
    '> 反馈仅保存在当前工程的 `.yuanmeng-inspector/feedback`，不会上传，也不会写入地图场景文件。AI 可用 `feedback list --json` 读取完整详情。',
    '',
    '| 状态 | 类型 | 标题 | 反馈 ID | 记录时间 |',
    '|---|---|---|---|---|',
    ...(rows.length === 0 ? ['| - | - | 暂无反馈 | - | - |'] : rows),
    ...(result.entries.length > visible.length ? ['', `仅展示最新 ${visible.length} 条；完整记录请让 AI 运行 \`feedback list --json\`。`] : []),
    '',
  ].join('\n'), 'markdown');
}

async function activeLuaTarget(manager: WorkspaceContextManager, suppliedRoot?: string) {
  const editor = vscode.window.activeTextEditor;
  if (editor === undefined || editor.document.uri.scheme !== 'file' || !editor.document.fileName.toLocaleLowerCase().endsWith('.lua')) {
    throw new ProductError('VALIDATION_FAILED', '请先打开并聚焦要插入探针的 src Lua 文件。', ['把光标放到需要记录流程的独立语句位置。'], 'STATIC_LOCAL');
  }
  const target = await manager.choose(suppliedRoot);
  const targetPath = relative(target.project.root, editor.document.fileName).replace(/\\/gu, '/');
  if (targetPath.startsWith('../') || targetPath === '' || !targetPath.startsWith('src/')) {
    throw new ProductError('VALIDATION_FAILED', '当前 Lua 文件不属于所选工程的 src 目录。', ['选择正确工程中的源文件。'], 'STATIC_LOCAL');
  }
  return { editor, target, targetPath };
}

async function runInsertGameplayTrace(
  manager: WorkspaceContextManager,
  suppliedRoot?: string,
  supplied?: {
    phase?: string; side?: 'server' | 'client' | 'shared' | 'unknown'; event?: string;
    player?: string; instance?: string; position?: string; state?: Record<string, string>;
  },
): Promise<void> {
  const { editor, target, targetPath } = await activeLuaTarget(manager, suppliedRoot);
  const phase = supplied?.phase ?? await vscode.window.showInputBox({ prompt: '流程阶段，例如 purchase.before' });
  if (phase === undefined) return;
  const event = supplied?.event ?? await vscode.window.showInputBox({ prompt: '事件名称，例如 purchase.request' });
  if (event === undefined) return;
  const side = supplied?.side ?? await vscode.window.showQuickPick(['server', 'client', 'shared', 'unknown'], { placeHolder: '当前日志所在运行侧' }) as 'server' | 'client' | 'shared' | 'unknown' | undefined;
  if (side === undefined) return;
  const player = supplied?.player ?? await vscode.window.showInputBox({ prompt: '玩家 ID 变量路径（可留空，例如 playerId）' });
  if (player === undefined) return;
  const instance = supplied?.instance ?? await vscode.window.showInputBox({ prompt: '场景实例 ID 变量路径（可留空，例如 shelfId）' });
  if (instance === undefined) return;
  const position = supplied?.position ?? await vscode.window.showInputBox({ prompt: '位置 Vector 变量路径（可留空，例如 position）' });
  if (position === undefined) return;
  const insertion = createGameplayTraceInsertion({
    projectInstanceId: target.project.projectInstanceId,
    targetPath,
    source: editor.document.getText(),
    insertBeforeLine: editor.selection.active.line + 1,
    phase,
    side,
    event,
    expressions: {
      ...(player.trim() === '' ? {} : { player: player.trim() }),
      ...(instance.trim() === '' ? {} : { instance: instance.trim() }),
      ...(position.trim() === '' ? {} : { position: position.trim() }),
      ...(supplied?.state === undefined ? {} : { state: supplied.state }),
    },
    createdAt: new Date().toISOString(),
  });
  await showContent(insertion.proposal.newContent, 'lua');
  const confirmed = await vscode.window.showWarningMessage(
    `已预览结构化玩法日志探针 ${insertion.probeId.slice(0, 12)}；只修改 ${targetPath} 并创建可撤销备份。`,
    { modal: true },
    '确认插入',
  );
  if (confirmed !== '确认插入') return;
  const applied = await applyProposal(target.project.root, insertion.proposal, true);
  const undo = await vscode.window.showInformationMessage('玩法日志探针已插入。', '立即撤销');
  if (undo === '立即撤销') await undoBackup(target.project.root, applied.manifestPath);
}

async function runRemoveGameplayTrace(manager: WorkspaceContextManager, suppliedRoot?: string): Promise<void> {
  const { editor, target, targetPath } = await activeLuaTarget(manager, suppliedRoot);
  const source = editor.document.getText();
  const ids = [...source.matchAll(/-- YMAI_TRACE_PROBE_BEGIN:([a-f0-9]{64})/gu)].map((match) => match[1]!);
  if (ids.length === 0) throw new ProductError('NOT_FOUND', '当前文件没有结构化玩法日志探针。', ['打开包含 YMAI_TRACE_PROBE_BEGIN 的文件。'], 'STATIC_LOCAL');
  const probeId = ids.length === 1 ? ids[0]! : await vscode.window.showQuickPick(ids, { placeHolder: '选择要移除的探针 ID' });
  if (probeId === undefined) return;
  const proposal = createGameplayTraceRemoval({
    projectInstanceId: target.project.projectInstanceId,
    targetPath,
    source,
    probeId,
    createdAt: new Date().toISOString(),
  });
  await showContent(proposal.newContent, 'lua');
  const confirmed = await vscode.window.showWarningMessage('已预览移除结果，并会创建可撤销备份。', { modal: true }, '确认移除');
  if (confirmed !== '确认移除') return;
  const applied = await applyProposal(target.project.root, proposal, true);
  const undo = await vscode.window.showInformationMessage('玩法日志探针已移除。', '立即撤销');
  if (undo === '立即撤销') await undoBackup(target.project.root, applied.manifestPath);
}

async function runRebind(
  manager: WorkspaceContextManager,
  sceneController: SceneController,
  suppliedRoot?: string,
): Promise<void> {
  const target = await manager.choose(suppliedRoot);
  const current = sceneController.get(target.project.root).snapshot;
  if (current === null) {
    throw new ProductError('NOT_FOUND', '当前工程没有可用场景快照。', ['先刷新场景数据。'], 'STATIC_LOCAL');
  }
  const candidates = await previousSnapshots(target.project.root, current);
  if (candidates.length === 0) {
    throw new ProductError('NOT_FOUND', '当前 lineage 没有可比较的历史快照。', ['保存场景变更并刷新后再试。'], 'STATIC_LOCAL');
  }
  const selected = await vscode.window.showQuickPick(candidates.map((snapshot, index) => ({
    label: `历史快照 ${index + 1}`,
    description: snapshot.observedAt,
    detail: `元件 ${snapshot.instances.length} · 编组 ${snapshot.groups.length} · ${snapshot.snapshotId.slice(0, 12)}`,
    snapshot,
  })), { placeHolder: '选择重绑前的同来源快照（不会修改场景文件）' });
  if (selected === undefined) return;

  const registry: RegistryDocument = { schemaVersion: 1, records: await manager.listRegistry(target.project.root) };
  const preview = buildSceneRebindPreview(selected.snapshot, current, registry);
  await showContent(JSON.stringify(preview, null, 2), 'json');
  if (preview.summary.ambiguous > 0 || preview.summary.insufficient > 0 || preview.summary.unique === 0) {
    await vscode.window.showWarningMessage(
      `重绑只读预览已生成：唯一 ${preview.summary.unique}，歧义 ${preview.summary.ambiguous}，证据不足 ${preview.summary.insufficient}。未生成 Lua 修改。`,
      { modal: true },
    );
    return;
  }

  const luaFiles = await collectLuaFiles(target.project.root);
  const sourceIndex = buildLuaSourceIndex(luaFiles, registry, { calls: [], configuredIdFields: [] });
  const oldIds = new Set(preview.mappings.map((mapping) => mapping.oldId));
  const paths = [...new Set(sourceIndex.idReferences
    .filter((reference) => oldIds.has(reference.value) && reference.registryKind === 'scene-instance')
    .map((reference) => reference.path))].sort((left, right) => left.localeCompare(right, 'en'));
  if (paths.length === 0) {
    await vscode.window.showInformationMessage('唯一重绑候选已确认，但 Lua 索引中没有可安全替换的已登记引用。');
    return;
  }
  const selectedPath = await vscode.window.showQuickPick(paths, { placeHolder: '选择要预览的 Lua 重绑补丁' });
  if (selectedPath === undefined) return;
  const file = luaFiles.find((item) => item.path === selectedPath)!;
  const patch = createLuaRebindPatchPreview({
    projectInstanceId: target.project.projectInstanceId,
    mapFingerprint: target.project.mapFingerprint,
    targetPath: file.path,
    source: file.source,
    sourceIndex,
    registry,
    currentSnapshot: current,
    rebind: preview,
    createdAt: new Date().toISOString(),
  });
  await showContent(patch.proposal.newContent, 'lua');
  const apply = await vscode.window.showWarningMessage(
    `已预览 ${patch.replacements.length} 处 Lua ID 重绑。只修改 ${selectedPath}，并创建可撤销备份。`,
    { modal: true },
    '确认应用并创建备份',
  );
  if (apply === undefined) return;
  const latestRegistry: RegistryDocument = { schemaVersion: 1, records: await manager.listRegistry(target.project.root) };
  const latestScene = sceneController.get(target.project.root).snapshot;
  if (latestScene === null) throw new ProductError('SCENE_SOURCE_CONFLICT', '当前场景快照已失效。', ['重新生成重绑预览。'], 'STATIC_LOCAL');
  const applied = await applyLuaRebindPatch(target.project.root, patch, { registry: latestRegistry, snapshot: latestScene }, true);
  const undo = await vscode.window.showInformationMessage(`已应用 ${patch.replacements.length} 处重绑，备份已创建。`, '立即撤销');
  if (undo === '立即撤销') {
    await undoBackup(target.project.root, applied.manifestPath);
    await vscode.window.showInformationMessage('重绑补丁已撤销。');
  }
}

async function runAnonymousDiagnostic(
  context: vscode.ExtensionContext,
  manager: WorkspaceContextManager,
  sceneController: SceneController,
  suppliedRoot?: string,
): Promise<void> {
  const target = await manager.choose(suppliedRoot);
  const records: RegistryDocument = { schemaVersion: 1, records: await manager.listRegistry(target.project.root) };
  const luaFiles = await collectLuaFiles(target.project.root);
  const luaIndex = buildLuaSourceIndex(luaFiles, records, { calls: [], configuredIdFields: [] });
  const sceneSnapshot = sceneController.get(target.project.root).snapshot ?? undefined;
  const uiSnapshot = target.snapshot ?? undefined;
  const nextActions: PrivateDiagnosticNextAction[] = [];
  if (sceneSnapshot === undefined) nextActions.push('REFRESH_SCENE');
  if (uiSnapshot === undefined) nextActions.push('REFRESH_UI');
  nextActions.push('RUN_OFFICIAL_EDITOR_SINGLE', 'RUN_OFFICIAL_EDITOR_MULTI');
  const bundle = createAnonymousDiagnosticBundle({
    pluginVersion: context.extension.packageJSON.version as string,
    protocolVersion: 'scene-v1',
    ...(sceneSnapshot === undefined ? {} : { sceneSnapshot }),
    ...(uiSnapshot === undefined ? {} : { uiSnapshot }),
    registry: records,
    luaIndex,
    errors: [],
    performanceSamples: [],
    nextActions,
  });
  const selected = await vscode.window.showQuickPick([
    { label: 'JSON', format: 'json' as const, language: 'json' as const },
    { label: 'Markdown', format: 'md' as const, language: 'markdown' as const },
  ], { placeHolder: '选择匿名诊断包格式（不含 ID、路径、名称、raw 或日志原文）' });
  if (selected === undefined) return;
  await showContent(renderAnonymousDiagnosticBundle(bundle, selected.format as PrivateDiagnosticFormat), selected.language);
}

export function registerPrivateToolsCommands(
  context: vscode.ExtensionContext,
  manager: WorkspaceContextManager,
  sceneController: SceneController,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('yuanmengAi.previewSceneRebind', async (root?: string) => {
      try { await runRebind(manager, sceneController, root); }
      catch (error) { await vscode.window.showErrorMessage(message(error), { modal: true }); }
    }),
    vscode.commands.registerCommand('yuanmengAi.openAnonymousDiagnostic', async (root?: string) => {
      try { await runAnonymousDiagnostic(context, manager, sceneController, root); }
      catch (error) { await vscode.window.showErrorMessage(message(error), { modal: true }); }
    }),
    vscode.commands.registerCommand('yuanmengAi.insertGameplayTraceProbe', async (root?: string, supplied?: Parameters<typeof runInsertGameplayTrace>[2]) => {
      try { await runInsertGameplayTrace(manager, root, supplied); }
      catch (error) { await vscode.window.showErrorMessage(message(error), { modal: true }); }
    }),
    vscode.commands.registerCommand('yuanmengAi.removeGameplayTraceProbe', async (root?: string) => {
      try { await runRemoveGameplayTrace(manager, root); }
      catch (error) { await vscode.window.showErrorMessage(message(error), { modal: true }); }
    }),
    vscode.commands.registerCommand('yuanmengAi.recordFeedback', async (root?: string, supplied?: Parameters<typeof runRecordFeedback>[4]) => {
      try { await runRecordFeedback(context, manager, sceneController, root, supplied); }
      catch (error) { await vscode.window.showErrorMessage(message(error), { modal: true }); }
    }),
    vscode.commands.registerCommand('yuanmengAi.openFeedbackInbox', async (root?: string) => {
      try { await runOpenFeedbackInbox(manager, root); }
      catch (error) { await vscode.window.showErrorMessage(message(error), { modal: true }); }
    }),
  );
}
