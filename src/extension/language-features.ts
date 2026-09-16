import { isAbsolute, relative } from 'node:path';

import * as vscode from 'vscode';

import {
  searchApiSymbols,
  type ApiIndex,
} from '../core/api/declaration-index.js';
import { buildLuaApiKnowledge } from '../core/api/lua-knowledge.js';
import { resolveEventMetadata, type EventDocumentationIndex } from '../core/api/event-doc-index.js';
import { searchResourceCatalog, type ResourceCatalog } from '../core/api/resource-catalog.js';
import { analyzeProject, type ProjectDiagnostic } from '../core/diagnostics/analyzer.js';
import { filterEditorDiagnostics } from '../core/diagnostics/editor-policy.js';
import { buildLuaSourceIndex, type LuaSourceIndex } from '../core/lua/source-index.js';
import { KeyedDebouncer } from '../core/async/keyed-debouncer.js';
import type { RegistryRecord, SourceRange } from '../core/model.js';
import { loadOfficialApiIndexFromExtensions } from '../integrations/official/api-index-loader.js';
import { loadLocalEventDocumentation } from '../integrations/official/event-doc-source.js';
import { loadLocalResourceCatalog } from '../integrations/official/resource-doc-source.js';
import type { WorkspaceContextManager } from './workspaces.js';

export const LANGUAGE_FEATURE_DEBOUNCE_MILLISECONDS = 250;

export const apiKnowledge = buildLuaApiKnowledge;

export async function loadApiIndex(): Promise<ApiIndex> {
  const override = vscode.workspace.getConfiguration('yuanmengAi').get<string>('officialExtensionPath', '').trim();
  return loadOfficialApiIndexFromExtensions(vscode.extensions.all.map((extension) => ({
    id: extension.id,
    extensionPath: extension.extensionPath,
    packageJSON: extension.packageJSON,
  })), override === '' ? null : override);
}

async function loadEventDocumentation(): Promise<EventDocumentationIndex | null> {
  const configured = vscode.workspace.getConfiguration('yuanmengAi').get<string>('eventsDocumentationPath', '').trim();
  try {
    return await loadLocalEventDocumentation(configured === '' ? null : configured);
  } catch {
    return null;
  }
}

async function loadResourceDocumentation(): Promise<ResourceCatalog | null> {
  const configured = vscode.workspace.getConfiguration('yuanmengAi').get<string>('resourceDocumentationPath', '').trim();
  try {
    return await loadLocalResourceCatalog(configured === '' ? null : configured);
  } catch {
    return null;
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
  #eventDocumentationPromise: Promise<EventDocumentationIndex | null> | null = null;
  #resourceDocumentationPromise: Promise<ResourceCatalog | null> | null = null;
  readonly #analysisCache = new Map<string, { version: number; promise: Promise<DocumentAnalysis | null> }>();

  constructor(manager: WorkspaceContextManager) {
    this.#manager = manager;
  }

  dispose(): void {
    this.#analysisCache.clear();
    this.#diagnostics.dispose();
  }

  invalidate(): void {
    this.#analysisCache.clear();
    this.#apiIndexPromise = null;
    this.#eventDocumentationPromise = null;
    this.#resourceDocumentationPromise = null;
  }

  #apiIndex(): Promise<ApiIndex> {
    this.#apiIndexPromise ??= loadApiIndex();
    return this.#apiIndexPromise;
  }

  async searchApiSymbols(query: string) {
    const [index, documentation] = await Promise.all([
      this.#apiIndex(),
      (this.#eventDocumentationPromise ??= loadEventDocumentation()),
    ]);
    const events = new Map(resolveEventMetadata(index, documentation).map((event) => [event.name, event]));
    return searchApiSymbols(index, query).map((symbol) => ({
      symbol,
      eventMetadata: symbol.kind === 'constant' && symbol.module === 'Events'
        ? events.get(symbol.name) ?? null
        : null,
      eventDocumentationState: documentation === null ? 'missing' as const : 'loaded-unversioned-local-doc' as const,
    }));
  }

  async searchResources(query: string) {
    const catalog = await (this.#resourceDocumentationPromise ??= loadResourceDocumentation());
    return catalog === null ? { results: [], issues: [], state: 'missing' as const } : {
      results: searchResourceCatalog(catalog, query),
      issues: catalog.issues,
      state: 'loaded-unversioned-local-doc' as const,
    };
  }

  async analyze(document: vscode.TextDocument): Promise<DocumentAnalysis | null> {
    if (document.uri.scheme !== 'file' || !document.fileName.toLocaleLowerCase().endsWith('.lua')) return null;
    const cacheKey = document.uri.toString();
    const cached = this.#analysisCache.get(cacheKey);
    if (cached?.version === document.version) return cached.promise;
    const promise = this.#analyzeCurrentDocument(document);
    this.#analysisCache.set(cacheKey, { version: document.version, promise });
    void promise.then(
      () => undefined,
      () => {
        const current = this.#analysisCache.get(cacheKey);
        if (current?.promise === promise) this.#analysisCache.delete(cacheKey);
      },
    );
    return promise;
  }

  async #analyzeCurrentDocument(document: vscode.TextDocument): Promise<DocumentAnalysis | null> {
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
      const version = document.version;
      const analysis = await this.analyze(document);
      if (document.version !== version) return;
      if (analysis === null) {
        this.#diagnostics.delete(document.uri);
        return;
      }
      this.#diagnostics.set(document.uri, filterEditorDiagnostics(analysis.diagnostics).map((item) => {
        const diagnostic = new vscode.Diagnostic(
          item.range === null ? new vscode.Range(0, 0, 0, 1) : vscodeRange(item.range),
          `${item.message} 下一步：${item.nextAction}`,
          severity(item.severity),
        );
        diagnostic.code = item.code;
        diagnostic.source = '元梦 AI';
        return diagnostic;
      }));
    } catch (error) {
      // API/Lua diagnostics belong to the official helper and Lua tooling.
      // Do not turn an unavailable private index into a second Problems source.
      void error;
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
  const debouncer = new KeyedDebouncer();
  const schedulePublish = (document: vscode.TextDocument, delayMilliseconds: number): void => {
    debouncer.schedule(document.uri.toString(), () => { void engine.publish(document); }, delayMilliseconds);
  };
  const refreshOpenDocuments = (): void => {
    engine.invalidate();
    for (const document of vscode.workspace.textDocuments) schedulePublish(document, 0);
  };
  const codeLensEmitter = new vscode.EventEmitter<void>();
  context.subscriptions.push(
    engine,
    codeLensEmitter,
    debouncer,
    vscode.workspace.onDidOpenTextDocument((document) => schedulePublish(document, 0)),
    vscode.workspace.onDidChangeTextDocument((event) => schedulePublish(event.document, LANGUAGE_FEATURE_DEBOUNCE_MILLISECONDS)),
    vscode.workspace.onDidSaveTextDocument((document) => schedulePublish(document, 0)),
    vscode.workspace.onDidCloseTextDocument((document) => debouncer.cancel(document.uri.toString())),
    manager.onDidChange(() => {
      refreshOpenDocuments();
      codeLensEmitter.fire();
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        event.affectsConfiguration('yuanmengAi.officialExtensionPath')
        || event.affectsConfiguration('yuanmengAi.eventsDocumentationPath')
        || event.affectsConfiguration('yuanmengAi.resourceDocumentationPath')
      ) {
        refreshOpenDocuments();
      }
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
      const query = await vscode.window.showInputBox({ prompt: '输入官方函数、事件、常量、枚举中文说明或英文名称' });
      if (query === undefined || query.trim() === '') return undefined;
      const [results, resourceSearch] = await Promise.all([
        engine.searchApiSymbols(query),
        engine.searchResources(query),
      ]);
      if (results.length === 0 && resourceSearch.results.length === 0) {
        void vscode.window.showWarningMessage('当前官方 API 声明和本地通用数据定义中没有匹配项。');
        return { api: [], resources: [] };
      }
      const apiItems = results.slice(0, 200).map((entry) => ({
        label: entry.symbol.kind === 'function'
          ? entry.symbol.signature
          : entry.symbol.kind === 'constant'
            ? `${entry.symbol.module}.${entry.symbol.name} = ${JSON.stringify(entry.symbol.value)}`
            : `${entry.symbol.module}.${entry.symbol.name}`,
        description: `${entry.symbol.kind} · 官方扩展 ${entry.symbol.officialExtensionVersion}`,
        detail: entry.eventMetadata === null
          ? `${entry.symbol.description || '无说明'} · ${entry.symbol.source.relativePath}`
          : `${entry.eventMetadata.scope} · 回调 ${entry.eventMetadata.callbackState} · 生成 ${entry.eventMetadata.generationEligibility}`,
        value: { kind: 'api' as const, entry },
      }));
      const resourceItems = resourceSearch.results.slice(0, 200).map((entry) => ({
        label: `${entry.name} = ${entry.id}`,
        description: `${entry.domain} · 本地通用数据定义`,
        detail: `${entry.categories.join(' / ') || '无分类'} · ${entry.sources.map((source) => source.relativePath).join('、')}`,
        value: { kind: 'resource' as const, entry },
      }));
      const selected = await vscode.window.showQuickPick([...apiItems, ...resourceItems], {
        placeHolder: `找到 ${results.length} 个官方声明符号、${resourceSearch.results.length} 个资源条目`,
      });
      if (selected !== undefined) {
        const content = `${JSON.stringify(selected.value, null, 2)}\n`;
        const document = await vscode.workspace.openTextDocument({ content, language: 'json' });
        await vscode.window.showTextDocument(document, { preview: true });
      }
      return { api: results, resources: resourceSearch.results, resourceIssues: resourceSearch.issues };
    }),
  );
  refreshOpenDocuments();
}
