import { basename, extname, join } from 'node:path';

import * as vscode from 'vscode';

import { ProductError } from '../core/errors.js';
import { BuildWorkflow } from '../core/build/workflow.js';
import { atomicWriteText, nodeFileIO } from '../core/fs.js';
import { sha256Hex, stableJson } from '../core/hash.js';
import type { UiNode, UiSnapshot } from '../core/model.js';
import type { RegistryRecord } from '../core/model.js';
import { createPatchProposal } from '../core/patch/proposal.js';
import {
  createPropertySnapshot,
  diffPropertySnapshots,
  editPropertyLiteral,
  PropertyWorkflow,
  selectPropertyTarget,
  validatePropertyFilename,
  type PropertySnapshot,
  type PropertyTarget,
} from '../core/property/workflow.js';
import type { RegistryImportFormat } from '../core/registry/store.js';
import { validatePatchProposal } from '../core/patch/proposal.js';
import type { SearchResultsProvider } from './views.js';
import type { PatchPreviewController, SimulatedPatchDecision } from './virtual-documents.js';
import type { WorkspaceContextManager } from './workspaces.js';
import { runWizard } from './wizard.js';
import { waitForStableExport } from '../integrations/official/files.js';
import { aggregateLog, parseImportedLog } from '../core/logs/parser.js';
import { containsGameplayTraceMarker, parseGameplayTraceLog } from '../core/logs/gameplay-trace.js';
import { containsUiGeometryMarker, parseUiGeometryProbeLog } from '../core/ui/runtime-geometry.js';
import {
  containsUiRuntimeWidgetMarker,
  containsUiScreenPointMarker,
  parseUiRuntimeWidgetProbeLog,
  parseUiScreenPointProbeLog,
} from '../core/ui/runtime-inspection.js';
import {
  containsSceneProbeMarker,
  createRuntimeOnlyProbeContext,
  parseSceneProbeLog,
  saveSceneProbeEvidence,
} from '../core/scene/probe-evidence.js';
import { loadSceneHeads, loadSceneSnapshot } from '../core/scene/store.js';

function messageFor(error: unknown): string {
  if (error instanceof ProductError) {
    const next = error.nextActions[0];
    return next === undefined ? error.message : `${error.message}\n下一步：${next}`;
  }
  return error instanceof Error ? error.message : '发生未知错误。';
}

function luaConstantName(name: string): string {
  const normalized = name.normalize('NFKC').replace(/[^A-Za-z0-9_]/gu, '_').replace(/^([0-9])/u, '_$1');
  return normalized === '' ? 'UI_CONTROL' : normalized.toUpperCase();
}

async function optionalHash(path: string): Promise<string | null> {
  try {
    return sha256Hex(await nodeFileIO.readBytes(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function optionalSignature(path: string): Promise<string | null> {
  try {
    const value = await nodeFileIO.stat(path);
    return value.isFile() ? `${value.size}:${value.mtimeMs}` : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function validateStoredPropertySnapshot(value: unknown): asserts value is { target: PropertyTarget; snapshot: PropertySnapshot } {
  if (
    typeof value !== 'object' || value === null || Array.isArray(value)
    || typeof (value as { target?: unknown }).target !== 'object'
    || (value as { target?: unknown }).target === null
    || (value as { snapshot?: Partial<PropertySnapshot> }).snapshot?.schemaVersion !== 1
    || typeof (value as { snapshot?: Partial<PropertySnapshot> }).snapshot?.sha256 !== 'string'
    || typeof (value as { snapshot?: Partial<PropertySnapshot> }).snapshot?.values !== 'object'
  ) throw new ProductError('VALIDATION_FAILED', '本机属性快照损坏。', ['保留文件并重新读取属性。'], 'STATIC_LOCAL');
}

async function persistPropertySnapshot(
  root: string,
  target: PropertyTarget,
  snapshot: PropertySnapshot,
): Promise<PropertySnapshot | null> {
  const directory = join(root, '.yuanmeng-inspector', 'properties', `${target.layerId}_${target.uid}`);
  const currentPath = join(directory, 'current.json');
  let previous: PropertySnapshot | null = null;
  try {
    const value: unknown = JSON.parse(await nodeFileIO.readFile(currentPath, 'utf8'));
    validateStoredPropertySnapshot(value);
    if (value.target.projectInstanceId === target.projectInstanceId) previous = value.snapshot;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const envelope = { target, snapshot };
  await atomicWriteText(nodeFileIO, join(directory, 'snapshots', `${snapshot.sha256}.json`), stableJson(envelope));
  await atomicWriteText(nodeFileIO, currentPath, stableJson(envelope));
  return previous;
}

async function choosePropertyRecord(
  records: readonly RegistryRecord[],
  kind: 'scene-layer' | 'scene-instance',
  recordId: unknown,
): Promise<RegistryRecord> {
  const candidates = records.filter((record) => record.kind === kind);
  if (typeof recordId === 'string') {
    const selected = candidates.find((record) => record.recordId === recordId);
    if (selected === undefined) throw new ProductError('NOT_FOUND', `未找到注册记录：${recordId}`, ['检查当前工程注册中心。'], 'STATIC_LOCAL');
    return selected;
  }
  const selected = await vscode.window.showQuickPick(candidates.map((record) => ({
    label: `${record.name} · ${record.value}`,
    description: `${record.environment}/${record.validity}`,
    record,
  })), { placeHolder: kind === 'scene-layer' ? '选择一个场景层记录' : '选择一个元件实例记录' });
  if (selected === undefined) throw new ProductError('USAGE_ERROR', '未选择属性目标。', ['重新运行命令并选择单个目标。'], 'STATIC_LOCAL');
  return selected.record;
}

export function registerCommands(
  context: vscode.ExtensionContext,
  manager: WorkspaceContextManager,
  searchResults: SearchResultsProvider,
  copyCliCommand: (root?: string) => Promise<void>,
  patchPreview: PatchPreviewController,
  onSceneEvidenceImported?: (root: string) => Promise<void>,
): void {
  const register = (command: string, handler: (...args: unknown[]) => Promise<unknown>): void => {
    context.subscriptions.push(vscode.commands.registerCommand(command, async (...args) => {
      try {
        return await handler(...args);
      } catch (error) {
        // Reporting must not hold command completion hostage to notification dismissal.
        void vscode.window.showErrorMessage(messageFor(error));
        throw error;
      }
    }));
  };

  register('yuanmengAi.refreshUi', async (root) => {
    const target = await manager.choose(typeof root === 'string' ? root : undefined);
    const refresh = await manager.refreshUi(target.project.root);
    if (refresh.layerOrderGuard.state === 'reversal-detected') {
      const groups = refresh.layerOrderGuard.reversedGroups
        .map((group) => group.parentPath)
        .slice(0, 3)
        .join('、');
      await vscode.window.showWarningMessage(
        `检测到 ${refresh.layerOrderGuard.reversedGroups.length} 个控件组疑似整体完全倒序（${groups}）。`
        + '插件已保留上一份可信层级基线，不会自动改写元梦地图；请先暂停保存并检查编辑器层级。'
        + (refresh.layerOrderIncidentRelativePath === null
          ? ''
          : ` 证据：${refresh.layerOrderIncidentRelativePath}`),
      );
      return refresh;
    }
    await vscode.window.showInformationMessage(refresh.reasonCode === 'REFRESH_SUCCEEDED_UNCHANGED'
      ? '已检查 UI，内容未变化；现有快照仍为最新。'
      : '已通过官方“获取自定义界面结构”读取更新后的文件，并建立本机索引。');
    return refresh;
  });
  register('yuanmengAi.findUi', async (queryValue, root) => {
    const query = typeof queryValue === 'string'
      ? queryValue
      : await vscode.window.showInputBox({ prompt: '输入控件名称，例如“经验”' });
    if (query === undefined || query.trim() === '') {
      return undefined;
    }
    const target = await manager.choose(typeof root === 'string' ? root : undefined);
    const result = manager.findUi(target.project.root, query);
    const nodes = result.kind === 'unique' ? [result.node] : result.kind === 'ambiguous' ? result.candidates : [];
    searchResults.setResults(nodes);
    if (result.kind === 'not-found') {
      await vscode.window.showWarningMessage(`未找到控件：${query}`);
    } else if (result.kind === 'ambiguous') {
      await vscode.window.showWarningMessage(`“${query}”存在 ${result.candidates.length} 个候选，请按完整路径和 ID 选择。`);
    }
    return result;
  });
  register('yuanmengAi.openWizard', async () => runWizard(manager));
  register('yuanmengAi.setMapDisplayName', async (root, suppliedName) => {
    const target = await manager.choose(typeof root === 'string' ? root : undefined);
    const name = typeof suppliedName === 'string'
      ? suppliedName
      : await vscode.window.showInputBox({
        title: '设置当前地图名称',
        prompt: '该名称只用于本机显示和 AI 识别，不改变官方地图身份。',
        value: target.mapDisplayName ?? target.project.mapName ?? '',
        placeHolder: '例如：星光超市',
      });
    if (name === undefined) return undefined;
    const saved = await manager.setMapDisplayName(target.project.root, name);
    void vscode.window.showInformationMessage(`当前地图名称已保存：${saved}`);
    return saved;
  });
  register('yuanmengAi.copyCliCommand', async (root) => copyCliCommand(typeof root === 'string' ? root : undefined));
  register('yuanmengAi.copyUiId', async (node) => {
    const value = node as UiNode;
    await vscode.env.clipboard.writeText(value.id);
  });
  register('yuanmengAi.copyUiPath', async (node) => {
    const value = node as UiNode;
    await vscode.env.clipboard.writeText(value.path);
  });
  register('yuanmengAi.copyLuaConstant', async (node) => {
    const value = node as UiNode;
    await vscode.env.clipboard.writeText(`${luaConstantName(value.name)} = ${JSON.stringify(value.id)}`);
  });
  register('yuanmengAi.importSceneIdFromClipboard', async (root, suppliedName, simulatedDecision) => {
    const target = await manager.choose(typeof root === 'string' ? root : undefined);
    // Privacy boundary: clipboard access happens only inside this explicit command.
    const value = (await vscode.env.clipboard.readText()).trim();
    if (!/^[1-9]\d*$/u.test(value)) {
      throw new ProductError('VALIDATION_FAILED', '剪贴板内容不是有效的十进制场景实例 ID。', ['在元梦编辑器复制实例 ID 后重新运行此命令。'], 'STATIC_LOCAL');
    }
    const name = typeof suppliedName === 'string' && suppliedName.trim() !== ''
      ? suppliedName.trim()
      : await vscode.window.showInputBox({
        prompt: '为这个场景实例填写便于识别的登记名称',
        value: `场景元件 ${value}`,
        validateInput: (input) => input.trim() === '' ? '登记名称不能为空' : null,
      });
    if (name === undefined) return { committed: false, value };
    const preview = await manager.previewClipboardSceneId(target.project.root, value, name);
    const canSimulate = context.extensionMode !== vscode.ExtensionMode.Production;
    const simulated = canSimulate && (simulatedDecision === 'confirm' || simulatedDecision === 'cancel')
      ? simulatedDecision
      : undefined;
    const confirmed = simulated === undefined
      ? await vscode.window.showWarningMessage(
        `将场景实例 ID ${value} 登记到工程“${basename(target.project.root)}”。记录保持 pending，且不会写回元梦场景文件。`,
        { modal: true, detail: `新增 ${preview.added.length}，修改 ${preview.changed.length}，替换同工程同 ID 记录 ${preview.removed.length}。` },
        '确认登记',
      ) === '确认登记'
      : simulated === 'confirm';
    if (!confirmed) return { committed: false, value };
    await manager.commitRegistryImport(target.project.root, preview);
    void vscode.window.showInformationMessage(`已登记场景实例 ID ${value}；来源为用户显式剪贴板导入，状态为 pending。`);
    return { committed: true, value };
  });
  register('yuanmengAi.importRegistry', async (root) => {
    const target = await manager.choose(typeof root === 'string' ? root : undefined);
    const selected = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      filters: {
        '注册中心数据': ['json', 'yaml', 'yml', 'csv'],
      },
      title: '选择要预览的 ID/信号注册中心文件',
    });
    const uri = selected?.[0];
    if (uri === undefined) {
      return undefined;
    }
    const extension = extname(uri.fsPath).toLowerCase();
    const format: RegistryImportFormat = extension === '.json'
      ? 'json'
      : extension === '.yaml' || extension === '.yml'
        ? 'yaml'
        : extension === '.csv'
          ? 'csv'
          : (() => { throw new ProductError('VALIDATION_FAILED', '不支持的注册中心文件格式。', ['选择 JSON、YAML 或 CSV。'], 'STATIC_LOCAL'); })();
    const input = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
    const preview = await manager.previewRegistryImport(target.project.root, input, format);
    const choice = await vscode.window.showWarningMessage(
      `注册中心差异：新增 ${preview.added.length}，修改 ${preview.changed.length}，删除 ${preview.removed.length}。确认后将原子替换当前工程注册中心。`,
      { modal: true },
      '确认导入',
    );
    if (choice !== '确认导入') {
      return undefined;
    }
    await manager.commitRegistryImport(target.project.root, preview);
    await vscode.window.showInformationMessage('注册中心已导入。');
    return preview;
  });
  register('yuanmengAi.previewPatch', async (proposalValue, root, simulatedDecision) => {
    validatePatchProposal(proposalValue);
    const proposal = proposalValue;
    const target = await manager.choose(typeof root === 'string' ? root : undefined);
    return patchPreview.previewAndApply(
      target.project.root,
      proposal,
      simulatedDecision as SimulatedPatchDecision | undefined,
    );
  });
  register('yuanmengAi.undoPatch', async (manifestPath, root, simulatedDecision) => {
    if (typeof manifestPath !== 'string') {
      throw new ProductError('VALIDATION_FAILED', '缺少撤销清单路径。', ['选择有效的备份清单。'], 'STATIC_LOCAL');
    }
    const target = await manager.choose(typeof root === 'string' ? root : undefined);
    return patchPreview.confirmAndUndo(
      target.project.root,
      manifestPath,
      simulatedDecision as SimulatedPatchDecision | undefined,
    );
  });
  register('yuanmengAi.buildScripts', async (root, simulatedDecision) => {
    const target = await manager.choose(typeof root === 'string' ? root : undefined);
    const workflow = new BuildWorkflow({
      totalTimeoutMilliseconds: vscode.workspace
        .getConfiguration('yuanmengAi', vscode.Uri.file(target.project.root))
        .get<number>('buildTimeoutSeconds', 60) * 1_000,
    });
    const prepared = await workflow.prepare(target.project.root);
    const canSimulate = context.extensionMode !== vscode.ExtensionMode.Production;
    const simulated = canSimulate && (simulatedDecision === 'confirm' || simulatedDecision === 'cancel')
      ? simulatedDecision
      : undefined;
    const confirmed = simulated === undefined
      ? await vscode.window.showWarningMessage(
        prepared.warning,
        { modal: true },
        '确认合成',
      ) === '确认合成'
      : simulated === 'confirm';
    const available = new Set(await vscode.commands.getCommands(false)).has('dreamhelper.scriptGen');
    const requested = await workflow.confirmAndRun(prepared, {
      confirmed,
      commandAvailable: available,
      execute: async () => { await vscode.commands.executeCommand('dreamhelper.scriptGen'); },
    });
    if (requested.outcome === 'cancelled') return requested;
    const result = await workflow.observeResult(
      prepared,
      context.extensionMode === vscode.ExtensionMode.Production ? 'OFFICIAL_EDITOR_SINGLE' : 'EXTENSION_HOST',
    );
    if (result.outcome === 'artifact-updated') {
      void vscode.window.showInformationMessage(
        `已观察到官方合成产物更新：${result.updatedArtifacts.join('、')}。这只证明文件更新，不代表游戏运行通过。`,
      );
    } else {
      void vscode.window.showWarningMessage(
        result.outcome === 'timeout'
          ? '官方命令已调用，但构建产物在超时前没有更新。'
          : '检测到构建产物变化，但文件未达到稳定状态。',
      );
    }
    return result;
  });
  register('yuanmengAi.readProperty', async (root, layerRecordId, instanceRecordId) => {
    const managed = await manager.choose(typeof root === 'string' ? root : undefined);
    const records = await manager.listRegistry(managed.project.root);
    const layer = await choosePropertyRecord(records, 'scene-layer', layerRecordId);
    const instance = await choosePropertyRecord(records, 'scene-instance', instanceRecordId);
    const target = selectPropertyTarget({
      projectInstanceId: managed.project.projectInstanceId,
      mapFingerprint: managed.project.mapFingerprint,
      layers: [layer],
      instances: [instance],
    });
    const path = join(managed.project.root, 'src', 'Data', target.filename);
    const baseline = await optionalHash(path);
    const baselineSignature = await optionalSignature(path);
    const capabilities = await manager.detectOfficialCapabilities();
    if (!capabilities.getCustomProperty) {
      throw new ProductError('OFFICIAL_COMMAND_MISSING', '官方获取自定义属性命令不可用。', ['启用官方元梦开发助手。'], 'STATIC_LOCAL');
    }
    await vscode.env.clipboard.writeText(`${target.layerId};${target.uid}`);
    void vscode.window.showInformationMessage(
      `${target.warning === null ? '' : `${target.warning}。`}已复制 ${target.layerId};${target.uid}。官方公共命令无法可靠预填面板，请在官方面板粘贴后确认导出。`,
    );
    const workflow = new PropertyWorkflow();
    workflow.requestRead();
    await vscode.commands.executeCommand('dreamhelper.GetCustomPropertyData');
    const configuration = vscode.workspace.getConfiguration('yuanmengAi', vscode.Uri.file(managed.project.root));
    const stable = await waitForStableExport({
      io: nodeFileIO,
      paths: [path],
      baselineHashes: { [path]: baseline },
      baselineSignatures: { [path]: baselineSignature },
      acceptUnchangedStableFiles: true,
      requireSignatureChangeForUnchanged: true,
      sampleMilliseconds: configuration.get<number>('fileStableSampleMilliseconds', 150),
      stableSampleCount: configuration.get<number>('fileStableSampleCount', 3),
      totalTimeoutMilliseconds: configuration.get<number>('propertyReadTimeoutSeconds', 120) * 1_000,
      timeoutError: {
        message: '等待官方“获取元件自定义属性”导出超时。',
        nextActions: ['确认已在官方属性面板填写元件ID并点击“确认”，且当前工程与官方联动在线后重试。'],
      },
      validateContent: (_path, source) => { createPropertySnapshot(source, new Date().toISOString()); },
    });
    validatePropertyFilename(target, basename(stable.files[0]!.path));
    const snapshot = createPropertySnapshot(stable.files[0]!.content, new Date().toISOString());
    const previous = await persistPropertySnapshot(managed.project.root, target, snapshot);
    workflow.load();
    return {
      target,
      snapshot,
      diff: previous === null ? null : diffPropertySnapshots(previous, snapshot),
      state: workflow.state,
      outcome: Object.keys(snapshot.values).length === 0
        ? 'READ_SUCCEEDED_EMPTY_PROPERTIES'
        : 'READ_SUCCEEDED',
      evidence: context.extensionMode === vscode.ExtensionMode.Production ? 'OFFICIAL_EDITOR_SINGLE' : 'EXTENSION_HOST',
    };
  });
  register('yuanmengAi.pushPropertyLiteral', async (
    root, layerRecordId, instanceRecordId, literalPath, value, simulatedDecisions,
  ) => {
    if (typeof literalPath !== 'string') throw new ProductError('VALIDATION_FAILED', '缺少属性路径。', ['选择已有标量属性。'], 'STATIC_LOCAL');
    const managed = await manager.choose(typeof root === 'string' ? root : undefined);
    const records = await manager.listRegistry(managed.project.root);
    const layer = await choosePropertyRecord(records, 'scene-layer', layerRecordId);
    const instance = await choosePropertyRecord(records, 'scene-instance', instanceRecordId);
    const target = selectPropertyTarget({
      projectInstanceId: managed.project.projectInstanceId,
      mapFingerprint: managed.project.mapFingerprint,
      layers: [layer], instances: [instance],
    });
    const relativePath = `src/Data/${target.filename}`;
    const path = join(managed.project.root, 'src', 'Data', target.filename);
    const source = await nodeFileIO.readFile(path, 'utf8');
    const edited = editPropertyLiteral(source, literalPath, value as never);
    const proposal = createPatchProposal({
      projectInstanceId: managed.project.projectInstanceId,
      targetPath: relativePath,
      originalContent: source,
      newContent: edited,
      summary: `edit custom property ${literalPath}`,
      createdAt: new Date().toISOString(),
    });
    const workflow = new PropertyWorkflow();
    workflow.requestRead(); workflow.load(); workflow.previewEdit();
    const canSimulate = context.extensionMode !== vscode.ExtensionMode.Production;
    const decisions = canSimulate && typeof simulatedDecisions === 'object' && simulatedDecisions !== null
      ? simulatedDecisions as { file?: SimulatedPatchDecision; push?: SimulatedPatchDecision }
      : {};
    const applied = await patchPreview.previewAndApply(
      managed.project.root,
      proposal,
      decisions.file,
      target.warning ?? `地图指纹：${target.mapFingerprint}`,
    );
    if (applied === undefined) return { state: workflow.state, outcome: 'file-cancelled' };
    workflow.writeFile(true);
    const writtenSnapshot = createPropertySnapshot(edited, new Date().toISOString());
    const previous = await persistPropertySnapshot(managed.project.root, target, writtenSnapshot);
    const identity = target.warning ?? `地图指纹：${target.mapFingerprint}`;
    const pushConfirmed = decisions.push === undefined
      ? await vscode.window.showWarningMessage(
        `${identity}\n工程：${target.projectInstanceId}\n文件哈希：${proposal.newSha256}\n${proposal.summary}\n文件已写入，但尚未应用到编辑器。确认推送此单个元件？`,
        { modal: true }, '确认推送',
      ) === '确认推送'
      : decisions.push === 'confirm';
    if (!pushConfirmed) return {
      state: workflow.state,
      outcome: 'push-cancelled',
      applied,
      diff: previous === null ? null : diffPropertySnapshots(previous, writtenSnapshot),
    };
    const capabilities = await manager.detectOfficialCapabilities();
    if (!capabilities.sendCustomProperty) {
      throw new ProductError('OFFICIAL_COMMAND_MISSING', '官方推送自定义属性命令不可用。', ['启用官方元梦开发助手。'], 'STATIC_LOCAL');
    }
    workflow.requestPush(true);
    await vscode.commands.executeCommand('dreamhelper.sendCustomPropertyData', vscode.Uri.file(path));
    workflow.commandResolved();
    return {
      state: workflow.state,
      outcome: 'push-requested',
      applied,
      target,
      newSha256: proposal.newSha256,
      diff: previous === null ? null : diffPropertySnapshots(previous, writtenSnapshot),
    };
  });
  register('yuanmengAi.importLog', async (root, suppliedPath) => {
    const managed = await manager.choose(typeof root === 'string' ? root : undefined);
    const uri = typeof suppliedPath === 'string'
      ? vscode.Uri.file(suppliedPath)
      : (await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        title: '选择要导入的本机日志文件',
        filters: { '日志文本': ['log', 'txt'] },
      }))?.[0];
    if (uri === undefined) return undefined;
    const bytes = await vscode.workspace.fs.readFile(uri);
    if (containsUiScreenPointMarker(bytes) || containsUiRuntimeWidgetMarker(bytes)) {
      let snapshot: UiSnapshot;
      try {
        const raw: unknown = JSON.parse(await nodeFileIO.readFile(
          join(managed.project.root, '.yuanmeng-inspector', 'ui', 'current.json'),
          'utf8',
        ));
        if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('invalid snapshot');
        const candidate = raw as Partial<UiSnapshot>;
        if (
          candidate.schemaVersion !== 1
          || typeof candidate.snapshotId !== 'string'
          || candidate.projectInstanceId !== managed.project.projectInstanceId
          || !Array.isArray(candidate.nodes)
        ) throw new Error('snapshot mismatch');
        snapshot = candidate as UiSnapshot;
      } catch (error) {
        throw new ProductError(
          'UI_RUNTIME_EVIDENCE_INSUFFICIENT',
          '当前工程没有可绑定的有效 UI 快照。',
          ['先刷新 UI 索引，再导入同一次试玩日志。'],
          'STATIC_LOCAL',
          error,
        );
      }
      let uiScreenPointOutput: string | null = null;
      let uiScreenPoint: ReturnType<typeof parseUiScreenPointProbeLog> | null = null;
      let uiRuntimeWidgetsOutput: string | null = null;
      let uiRuntimeWidgets: ReturnType<typeof parseUiRuntimeWidgetProbeLog> | null = null;
      if (containsUiScreenPointMarker(bytes)) {
        uiScreenPoint = parseUiScreenPointProbeLog(bytes, { snapshot });
        const directory = join(managed.project.root, '.yuanmeng-inspector', 'ui', 'screen-points');
        uiScreenPointOutput = join(directory, `${uiScreenPoint.runtimeSnapshotId}.json`);
        await atomicWriteText(nodeFileIO, uiScreenPointOutput, stableJson(uiScreenPoint));
        await atomicWriteText(nodeFileIO, join(directory, 'current.json'), stableJson(uiScreenPoint));
      }
      if (containsUiRuntimeWidgetMarker(bytes)) {
        uiRuntimeWidgets = parseUiRuntimeWidgetProbeLog(bytes, { snapshot });
        const directory = join(managed.project.root, '.yuanmeng-inspector', 'ui', 'runtime-widgets');
        uiRuntimeWidgetsOutput = join(directory, `${uiRuntimeWidgets.runtimeSnapshotId}.json`);
        await atomicWriteText(nodeFileIO, uiRuntimeWidgetsOutput, stableJson(uiRuntimeWidgets));
        await atomicWriteText(nodeFileIO, join(directory, 'current.json'), stableJson(uiRuntimeWidgets));
      }
      void vscode.window.showInformationMessage(
        `已导入${uiScreenPoint === null ? '' : '屏幕点命中'}${uiScreenPoint !== null && uiRuntimeWidgets !== null ? '与' : ''}${uiRuntimeWidgets === null ? '' : `${uiRuntimeWidgets.entries.length} 条运行时控件`}证据；未保存原始日志行。`,
      );
      return { output: null, parsed: null, aggregate: null, uiScreenPointOutput, uiScreenPoint, uiRuntimeWidgetsOutput, uiRuntimeWidgets };
    }
    if (containsUiGeometryMarker(bytes)) {
      let snapshot: { snapshotId: string; projectInstanceId: string };
      try {
        const raw: unknown = JSON.parse(await nodeFileIO.readFile(
          join(managed.project.root, '.yuanmeng-inspector', 'ui', 'current.json'),
          'utf8',
        ));
        if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('invalid snapshot');
        const candidate = raw as Record<string, unknown>;
        if (typeof candidate.snapshotId !== 'string' || candidate.projectInstanceId !== managed.project.projectInstanceId) {
          throw new Error('snapshot mismatch');
        }
        snapshot = { snapshotId: candidate.snapshotId, projectInstanceId: candidate.projectInstanceId };
      } catch (error) {
        throw new ProductError(
          'UI_GEOMETRY_EVIDENCE_INSUFFICIENT',
          '当前工程没有可绑定的有效 UI 快照。',
          ['先刷新 UI 索引，再导入同一次试玩日志。'],
          'STATIC_LOCAL',
          error,
        );
      }
      const uiGeometry = parseUiGeometryProbeLog(bytes, {
        context: { projectInstanceId: snapshot.projectInstanceId, uiSnapshotId: snapshot.snapshotId },
      });
      const runtimeDirectory = join(managed.project.root, '.yuanmeng-inspector', 'ui', 'runtime');
      const uiGeometryOutput = join(runtimeDirectory, `${uiGeometry.runtimeSnapshotId}.json`);
      await atomicWriteText(nodeFileIO, uiGeometryOutput, stableJson(uiGeometry));
      await atomicWriteText(nodeFileIO, join(runtimeDirectory, 'current.json'), stableJson(uiGeometry));
      const successful = uiGeometry.entries.filter((entry) => entry.status === 'ok').length;
      void vscode.window.showInformationMessage(`已绑定 ${successful}/${uiGeometry.selectedIds.length} 个控件的运行时屏幕几何；未保存原始日志行。`);
      return { output: null, parsed: null, aggregate: null, uiGeometryOutput, uiGeometry };
    }
    if (containsSceneProbeMarker(bytes)) {
      const heads = await loadSceneHeads(managed.project.root, nodeFileIO);
      let sceneEvidence: ReturnType<typeof parseSceneProbeLog>;
      if (heads.preferredSnapshotId !== null) {
        const snapshot = await loadSceneSnapshot(managed.project.root, heads.preferredSnapshotId, nodeFileIO);
        sceneEvidence = parseSceneProbeLog(bytes, {
          context: {
            projectInstanceId: managed.project.projectInstanceId,
            bindingId: snapshot.bindingId,
            snapshotId: snapshot.snapshotId,
            sceneSourceSha256: snapshot.sourceSha256,
          },
        });
      } else {
        const candidates = (await manager.listRegistry(managed.project.root)).filter((record) => (
          record.kind === 'scene-instance'
          && record.projectInstanceId === managed.project.projectInstanceId
        ));
        const matches = [];
        for (const record of candidates) {
          try {
            matches.push(parseSceneProbeLog(bytes, {
              context: createRuntimeOnlyProbeContext(
                managed.project.projectInstanceId,
                record.recordId,
                record.source.sha256,
              ),
            }));
          } catch (error) {
            if (!(error instanceof ProductError) || error.code !== 'SCENE_EVIDENCE_INSUFFICIENT') throw error;
          }
        }
        if (matches.length === 0) {
          throw new ProductError(
            'SCENE_EVIDENCE_INSUFFICIENT',
            '当前工程没有可绑定的场景快照，且日志未匹配任何已显式登记的场景实例。',
            ['先显式登记官方编辑器当前选中元件 ID，再重新生成并导入同一份 runtime-only 探针日志。'],
            'STATIC_LOCAL',
          );
        }
        if (matches.length > 1) {
          throw new ProductError(
            'SCENE_EVIDENCE_INSUFFICIENT',
            '日志同时匹配多个显式登记实例，无法安全确定目标。',
            ['为当前目标保留唯一登记记录后重新导入日志。'],
            'STATIC_LOCAL',
          );
        }
        sceneEvidence = matches[0]!;
        void vscode.window.showInformationMessage('已导入 runtime-only 场景探针证据；当前工程仍没有完整 LayerData 场景快照。');
      }
      const sceneEvidenceOutput = await saveSceneProbeEvidence(managed.project.root, sceneEvidence, nodeFileIO);
      await onSceneEvidenceImported?.(managed.project.root);
      if (sceneEvidence.issues.length > 0 || sceneEvidence.entries.length === 0) {
        void vscode.window.showWarningMessage(`场景探针日志已绑定当前快照，但有 ${sceneEvidence.issues.length} 个问题，证据不足以生成执行代码。`);
      } else {
        void vscode.window.showInformationMessage(`已导入并绑定 ${sceneEvidence.entries.length} 条当前场景探针证据。`);
      }
      return { output: null, parsed: null, aggregate: null, sceneEvidenceOutput, sceneEvidence };
    }
    if (containsGameplayTraceMarker(bytes)) {
      const gameplayTrace = parseGameplayTraceLog(bytes);
      const gameplayTraceOutput = join(
        managed.project.root,
        '.yuanmeng-inspector',
        'gameplay',
        'trace-evidence',
        `${gameplayTrace.sourceHash}.json`,
      );
      await atomicWriteText(nodeFileIO, gameplayTraceOutput, stableJson(gameplayTrace));
      void vscode.window.showInformationMessage(`已导入 ${gameplayTrace.entries.length} 条结构化玩法日志；未保存原始日志行。`);
      return { output: null, parsed: null, aggregate: null, gameplayTraceOutput, gameplayTrace };
    }
    const parsed = parseImportedLog(bytes);
    const output = join(managed.project.root, '.yuanmeng-inspector', 'logs', 'imported', `${parsed.sourceHash}.json`);
    await atomicWriteText(nodeFileIO, output, stableJson(parsed));
    const aggregate = aggregateLog(parsed);
    void vscode.window.showInformationMessage(`已导入 ${parsed.entries.length} 行本机日志；未发现场景探针标记。`);
    return { output, parsed, aggregate, sceneEvidenceOutput: null, sceneEvidence: null };
  });
}
