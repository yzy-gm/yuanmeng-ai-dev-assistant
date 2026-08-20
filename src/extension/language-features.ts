import { readFile } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';

import * as vscode from 'vscode';

import {
  buildApiIndex,
  parseDeclarationFile,
  type ApiIndex,
} from '../core/api/declaration-index.js';
import { analyzeProject, type ProjectDiagnostic } from '../core/diagnostics/analyzer.js';
import { buildLuaSourceIndex, type LuaSourceIndex } from '../core/lua/source-index.js';
import type { RegistryRecord, SourceRange } from '../core/model.js';
import { discoverOfficialApiSource } from '../integrations/official/api-source.js';
import type { WorkspaceContextManager } from './workspaces.js';

const EMPTY_API_INDEX: ApiIndex = {
  schemaVersion: 1,
  officialExtensionVersion: 'unknown',
  declarations: [],
};

function apiKnowledge(index: ApiIndex) {
  return {
    calls: index.declarations.map((declaration) => ({
      qualifiedName: `${declaration.module}${declaration.callStyle === 'colon' ? ':' : '.'}${declaration.name}`,
      idParameterIndexes: declaration.params.flatMap((parameter, parameterIndex) => (
        /(?:id|uid)$/iu.test(parameter.name) && !/(?:signal|event)/iu.test(parameter.name) ? [parameterIndex] : []
      )),
      signalParameterIndexes: declaration.params.flatMap((parameter, parameterIndex) => (
        /(?:signal|event)/iu.test(parameter.name) ? [parameterIndex] : []
      )),
    })),
    configuredIdFields: [],
  };
}

async function loadApiIndex(): Promise<ApiIndex> {
  const override = vscode.workspace.getConfiguration('yuanmengAi').get<string>('officialExtensionPath', '').trim();
  try {
    const source = await discoverOfficialApiSource(vscode.extensions.all.map((extension) => ({
      id: extension.id,
      extensionPath: extension.extensionPath,
      packageJSON: extension.packageJSON,
    })), override === '' ? null : override);
    if (source.state !== 'selected') return EMPTY_API_INDEX;
    const files = await Promise.all(source.declarationPaths.map(async (relativePath) => parseDeclarationFile({
      relativePath,
      source: await readFile(join(source.extensionRoot, ...relativePath.split('/')), 'utf8'),
    })));
    return buildApiIndex(files, { officialExtensionVersion: source.officialExtensionVersion });
  } catch {
    return EMPTY_API_INDEX;
  }
}

function documentPath(root: string, filePath: string): string | null {
  const child = relative(root, filePath);
  return child !== '' && !child.startsWith('..') && !isAbsolute(child)
    ? child.replace(/\\/gu, '/')
    : null;
}

function vscodeRange(value: SourceRange): vscode.Range {
  return new vscode.Range(
    Math.max(0, value.startLine - 1),
    Math.max(0, value.startColumn - 1),
    Math.max(0, value.endLine - 1),
    Math.max(0, value.endColumn - 1),
  );
}

function severity(value: ProjectDiagnostic['severity']): vscode.DiagnosticSeverity {
  return value === 'error'
    ? vscode.DiagnosticSeverity.Error
    : value === 'warning'
      ? vscode.DiagnosticSeverity.Warning
      : vscode.DiagnosticSeverity.Information;
}

function mapMatch(record: RegistryRecord, projectId: string, mapFingerprint: string | null): 'matched' | 'mismatched' | 'unknown' {
  if (record.projectInstanceId !== projectId) return 'mismatched';
  if (record.mapFingerprint === null || mapFingerprint === null) return 'unknown';
  return record.mapFingerprint === mapFingerprint ? 'matched' : 'mismatched';
}

interface DocumentAnalysis {
  sourceIndex: LuaSourceIndex;
  records: RegistryRecord[];
  diagnostics: ProjectDiagnostic[];
  projectInstanceId: string;
  mapFingerprint: string | null;
}

class LanguageFeatureEngine implements vscode.Disposable {
  readonly #manager: WorkspaceContextManager;
  readonly #diagnostics = vscode.languages.createDiagnosticCollection('元梦 AI');
  #apiIndexPromise: Promise<ApiIndex> | null = null;

  constructor(manager: WorkspaceContextManager) {
    this.#manager = manager;
  }

  dispose(): void {
    this.#diagnostics.dispose();
  }

  #apiIndex(): Promise<ApiIndex> {
    this.#apiIndexPromise ??= loadApiIndex();
    return this.#apiIndexPromise;
  }

  async analyze(document: vscode.TextDocument): Promise<DocumentAnalysis | null> {
    if (document.uri.scheme !== 'file' || !document.fileName.toLocaleLowerCase().endsWith('.lua')) return null;
    const context = this.#manager.list().find((candidate) => documentPath(candidate.project.root, document.fileName) !== null);
    if (context === undefined) return null;
    const path = documentPath(context.project.root, document.fileName)!;
    const [records, apiIndex] = await Promise.all([
      this.#manager.listRegistry(context.project.root),
      this.#apiIndex(),
    ]);
    const registry = { schemaVersion: 1 as const, records };
    const sourceIndex = buildLuaSourceIndex([{ path, source: document.getText() }], registry, apiKnowledge(apiIndex));
    const diagnostics = analyzeProject({
      sourceIndex,
      registry,
      apiIndex,
      uiSnapshot: context.snapshot,
      status: context.status,
      projectInstanceId: context.project.projectInstanceId,
      mapFingerprint: context.project.mapFingerprint,
    });
    return {
      sourceIndex,
      records,
      diagnostics,
      projectInstanceId: context.project.projectInstanceId,
      mapFingerprint: context.project.mapFingerprint,
    };
  }

  async publish(document: vscode.TextDocument): Promise<void> {
    try {
      const analysis = await this.analyze(document);
      if (analysis === null) {
        this.#diagnostics.delete(document.uri);
        return;
      }
      this.#diagnostics.set(document.uri, analysis.diagnostics.map((item) => {
        const diagnostic = new vscode.Diagnostic(
          item.range === null ? new vscode.Range(0, 0, 0, 1) : vscodeRange(item.range),
          `${item.message} 下一步：${item.nextAction}`,
          severity(item.severity),
        );
        diagnostic.code = item.code;
        diagnostic.source = '元梦 AI';
        return diagnostic;
      }));
    } catch {
      this.#diagnostics.delete(document.uri);
    }
  }

  async recordAt(document: vscode.TextDocument, position: vscode.Position): Promise<{
    record: RegistryRecord;
    range: vscode.Range;
    mapMatch: 'matched' | 'mismatched' | 'unknown';
  } | null> {
    const analysis = await this.analyze(document);
    if (analysis === null) return null;
    const byId = new Map(analysis.records.map((record) => [record.recordId, record]));
    for (const reference of analysis.sourceIndex.idReferences) {
      if (reference.evidence.source !== 'registry') continue;
      const referenceRange = vscodeRange({
        startLine: reference.line,
        startColumn: reference.column,
        endLine: reference.endLine,
        endColumn: reference.endColumn,
      });
      if (!referenceRange.contains(position)) continue;
      const record = byId.get(reference.evidence.recordId);
      if (record !== undefined) {
        return {
          record,
          range: referenceRange,
          mapMatch: mapMatch(record, analysis.projectInstanceId, analysis.mapFingerprint),
        };
      }
    }
    return null;
  }

  async records(document: vscode.TextDocument): Promise<Array<{
    record: RegistryRecord;
    range: vscode.Range;
    mapMatch: 'matched' | 'mismatched' | 'unknown';
  }>> {
    const analysis = await this.analyze(document);
    if (analysis === null) return [];
    const byId = new Map(analysis.records.map((record) => [record.recordId, record]));
    return analysis.sourceIndex.idReferences.flatMap((reference) => {
      if (reference.evidence.source !== 'registry') return [];
      const record = byId.get(reference.evidence.recordId);
      if (record === undefined) return [];
      return [{
        record,
        range: vscodeRange({
          startLine: reference.line,
          startColumn: reference.column,
          endLine: reference.endLine,
          endColumn: reference.endColumn,
        }),
        mapMatch: mapMatch(record, analysis.projectInstanceId, analysis.mapFingerprint),
      }];
    });
  }
}

function markdown(value: Awaited<ReturnType<LanguageFeatureEngine['recordAt']>> & object): vscode.MarkdownString {
  const result = new vscode.MarkdownString(undefined, true);
  result.appendMarkdown(`**${value.record.name}** · \`${value.record.value}\`\n\n`);
  result.appendMarkdown(`- 环境：${value.record.environment}\n`);
  result.appendMarkdown(`- 有效性：${value.record.validity}\n`);
  result.appendMarkdown(`- 作用域：${value.record.scope}\n`);
  result.appendMarkdown(`- 地图匹配：${value.mapMatch}\n`);
  result.appendMarkdown('- 运行验证：false');
  return result;
}

export function registerLanguageFeatures(
  context: vscode.ExtensionContext,
  manager: WorkspaceContextManager,
): void {
  const engine = new LanguageFeatureEngine(manager);
  const selector: vscode.DocumentSelector = [{ language: 'lua', scheme: 'file' }];
  const refreshOpenDocuments = (): void => {
    for (const document of vscode.workspace.textDocuments) void engine.publish(document);
  };
  const codeLensEmitter = new vscode.EventEmitter<void>();
  context.subscriptions.push(
    engine,
    codeLensEmitter,
    vscode.workspace.onDidOpenTextDocument((document) => { void engine.publish(document); }),
    vscode.workspace.onDidChangeTextDocument((event) => { void engine.publish(event.document); }),
    vscode.workspace.onDidSaveTextDocument((document) => { void engine.publish(document); }),
    manager.onDidChange(() => {
      refreshOpenDocuments();
      codeLensEmitter.fire();
    }),
    vscode.languages.registerHoverProvider(selector, {
      provideHover: async (document, position) => {
        const match = await engine.recordAt(document, position);
        return match === null ? null : new vscode.Hover(markdown(match), match.range);
      },
    }),
    vscode.languages.registerCodeLensProvider(selector, {
      onDidChangeCodeLenses: codeLensEmitter.event,
      provideCodeLenses: async (document) => (await engine.records(document)).map((item) => new vscode.CodeLens(
        item.range,
        {
          title: `ID ${item.record.value} · ${item.record.name} · ${item.record.environment}/${item.record.validity} · ${item.record.scope} · 地图${item.mapMatch}`,
          command: 'yuanmengAi.openRegistryRecord',
          arguments: [item.record.recordId],
        },
      )),
    }),
    vscode.languages.registerCodeActionsProvider(selector, {
      provideCodeActions: (_document, _range, actionContext) => actionContext.diagnostics.flatMap((diagnostic) => {
        if (diagnostic.source !== '元梦 AI' || typeof diagnostic.code !== 'string') return [];
        const apiDiagnostic = diagnostic.code.startsWith('API_') || diagnostic.code === 'UNKNOWN_OFFICIAL_API';
        const action = new vscode.CodeAction(
          apiDiagnostic ? '搜索当前官方 API' : '在注册中心查看记录',
          vscode.CodeActionKind.QuickFix,
        );
        action.diagnostics = [diagnostic];
        action.command = {
          title: action.title,
          command: apiDiagnostic ? 'yuanmengAi.searchApi' : 'yuanmengAi.openRegistryRecord',
        };
        return [action];
      }),
    }, { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }),
    vscode.commands.registerCommand('yuanmengAi.openRegistryRecord', async (recordId?: string) => {
      await vscode.window.showInformationMessage(recordId === undefined
        ? '请在元梦 AI 的注册中心视图选择记录。'
        : `注册中心记录：${recordId}`);
    }),
    vscode.commands.registerCommand('yuanmengAi.searchApi', async () => {
      await vscode.window.showInputBox({ prompt: '输入官方 API 中文说明或英文名称' });
    }),
  );
  refreshOpenDocuments();
}
