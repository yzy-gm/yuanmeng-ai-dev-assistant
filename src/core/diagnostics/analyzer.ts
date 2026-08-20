import type { ApiDeclaration, ApiIndex } from '../api/declaration-index.js';
import type { EvidenceLevel } from '../errors.js';
import type { LuaSourceIndex, LuaSourceLocation } from '../lua/source-index.js';
import type {
  InspectorStatus,
  RegistryDocument,
  RegistryEnvironment,
  RegistryValidity,
  SourceRange,
  UiSnapshot,
} from '../model.js';

export type DiagnosticSeverity = 'error' | 'warning' | 'info';

export interface ProjectDiagnostic {
  code:
    | 'TEST_ID_REFERENCE'
    | 'SUSPECTED_ID_CHANGE'
    | 'INVALID_ID_REFERENCE'
    | 'PENDING_ID_REFERENCE'
    | 'CROSS_MAP_ID_REFERENCE'
    | 'UNREGISTERED_ID_REFERENCE'
    | 'UNKNOWN_OFFICIAL_API'
    | 'API_ARGUMENT_COUNT'
    | 'API_LITERAL_TYPE'
    | 'DUPLICATE_UI_NAME'
    | 'DUPLICATE_UI_ID'
    | 'STALE_UI_SNAPSHOT';
  severity: DiagnosticSeverity;
  message: string;
  nextAction: string;
  path: string | null;
  range: SourceRange | null;
  evidence: EvidenceLevel;
  runtimeVerified: false;
  registry?: {
    recordId: string;
    name: string;
    environment: RegistryEnvironment;
    validity: RegistryValidity;
  };
  mapMatch?: 'matched' | 'mismatched' | 'unknown';
}

export interface AnalyzeProjectInput {
  sourceIndex: LuaSourceIndex;
  registry: RegistryDocument;
  apiIndex: ApiIndex;
  uiSnapshot: UiSnapshot | null;
  status: InspectorStatus | null;
  projectInstanceId: string;
  mapFingerprint: string | null;
}

function range(location: LuaSourceLocation): SourceRange {
  return {
    startLine: location.line,
    startColumn: location.column,
    endLine: location.endLine,
    endColumn: location.endColumn,
  };
}

function sourceDiagnostic(
  location: LuaSourceLocation,
  values: Omit<ProjectDiagnostic, 'path' | 'range' | 'evidence' | 'runtimeVerified'>,
): ProjectDiagnostic {
  return {
    ...values,
    path: location.path,
    range: range(location),
    evidence: 'STATIC_LOCAL',
    runtimeVerified: false,
  };
}

function projectDiagnostic(
  values: Omit<ProjectDiagnostic, 'path' | 'range' | 'evidence' | 'runtimeVerified'>,
): ProjectDiagnostic {
  return {
    ...values,
    path: null,
    range: null,
    evidence: 'STATIC_LOCAL',
    runtimeVerified: false,
  };
}

function apiName(declaration: ApiDeclaration): string {
  return `${declaration.module}${declaration.callStyle === 'colon' ? ':' : '.'}${declaration.name}`;
}

function registryMapMatch(
  record: RegistryDocument['records'][number],
  input: AnalyzeProjectInput,
): 'matched' | 'mismatched' | 'unknown' {
  if (record.projectInstanceId !== input.projectInstanceId) return 'mismatched';
  if (record.mapFingerprint === null || input.mapFingerprint === null) return 'unknown';
  return record.mapFingerprint === input.mapFingerprint ? 'matched' : 'mismatched';
}

function registryDetails(record: RegistryDocument['records'][number]) {
  return {
    recordId: record.recordId,
    name: record.name,
    environment: record.environment,
    validity: record.validity,
  };
}

function analyzeIdReferences(input: AnalyzeProjectInput): ProjectDiagnostic[] {
  const output: ProjectDiagnostic[] = [];
  const byId = new Map(input.registry.records.map((record) => [record.recordId, record]));
  for (const reference of input.sourceIndex.idReferences) {
    const record = reference.evidence.source === 'registry'
      ? byId.get(reference.evidence.recordId)
      : undefined;
    if (record === undefined) {
      output.push(sourceDiagnostic(reference, {
        code: 'UNREGISTERED_ID_REFERENCE',
        severity: 'warning',
        message: `API 的 ID 参数 ${reference.value} 尚未登记，无法确认作用域。`,
        nextAction: '在当前工程注册中心登记并确认该 ID。',
      }));
      continue;
    }
    const details = registryDetails(record);
    const mapMatch = registryMapMatch(record, input);
    if (mapMatch === 'mismatched') {
      output.push(sourceDiagnostic(reference, {
        code: 'CROSS_MAP_ID_REFERENCE',
        severity: 'error',
        message: `ID ${reference.value} 的工程或地图身份与当前工程不匹配。`,
        nextAction: '切换到正确工程，或重新登记当前地图的 ID。',
        registry: details,
        mapMatch,
      }));
      continue;
    }
    if (record.validity === 'invalid') {
      output.push(sourceDiagnostic(reference, {
        code: 'INVALID_ID_REFERENCE',
        severity: 'error',
        message: `ID ${reference.value} 已标记失效。`,
        nextAction: '选择已确认的替代记录并预览补丁。',
        registry: details,
        mapMatch,
      }));
    } else if (record.validity === 'suspected-change') {
      output.push(sourceDiagnostic(reference, {
        code: 'SUSPECTED_ID_CHANGE',
        severity: 'warning',
        message: `ID ${reference.value} 疑似发生变化。`,
        nextAction: '刷新官方数据并人工确认该记录。',
        registry: details,
        mapMatch,
      }));
    } else if (record.validity === 'pending') {
      output.push(sourceDiagnostic(reference, {
        code: 'PENDING_ID_REFERENCE',
        severity: 'warning',
        message: `ID ${reference.value} 仍待确认。`,
        nextAction: '在测试工程中验证后把 validity 改为 confirmed。',
        registry: details,
        mapMatch,
      }));
    } else if (record.environment === 'test') {
      output.push(sourceDiagnostic(reference, {
        code: 'TEST_ID_REFERENCE',
        severity: 'info',
        message: `ID ${reference.value} 是已确认的测试环境记录。`,
        nextAction: '发布前选择独立登记的正式环境记录。',
        registry: details,
        mapMatch,
      }));
    }
  }
  return output;
}

function expectedLiteralType(type: string): 'string' | 'number' | 'boolean' | null {
  const normalized = type.trim().toLocaleLowerCase();
  return normalized === 'string' || normalized === 'number' || normalized === 'boolean'
    ? normalized
    : null;
}

function analyzeApiCalls(input: AnalyzeProjectInput): ProjectDiagnostic[] {
  const output: ProjectDiagnostic[] = [];
  const knownModules = new Set(input.apiIndex.declarations.map((value) => value.module));
  const declarations = new Map(input.apiIndex.declarations.map((value) => [apiName(value), value]));
  for (const call of input.sourceIndex.calls) {
    const module = /^([A-Za-z_][A-Za-z0-9_]*)[:.]/u.exec(call.qualifiedName)?.[1];
    const declaration = declarations.get(call.qualifiedName);
    if (declaration === undefined) {
      if (module !== undefined && knownModules.has(module)) {
        output.push(sourceDiagnostic(call, {
          code: 'UNKNOWN_OFFICIAL_API',
          severity: 'error',
          message: `已确认官方模块中不存在 API：${call.qualifiedName}。`,
          nextAction: '使用 api-search 查找当前版本的官方签名。',
        }));
      }
      continue;
    }
    if (call.argumentCount !== declaration.params.length) {
      output.push(sourceDiagnostic(call, {
        code: 'API_ARGUMENT_COUNT',
        severity: 'error',
        message: `${call.qualifiedName} 需要 ${declaration.params.length} 个参数，当前传入 ${call.argumentCount} 个。`,
        nextAction: `按官方签名 ${declaration.signature} 调整参数。`,
      }));
    }
    declaration.params.forEach((parameter, index) => {
      const argument = call.arguments[index];
      const expected = expectedLiteralType(parameter.type);
      if (
        argument !== undefined
        && expected !== null
        && argument.literalType !== 'other'
        && argument.literalType !== 'nil'
        && argument.literalType !== expected
      ) {
        output.push(sourceDiagnostic(argument, {
          code: 'API_LITERAL_TYPE',
          severity: 'error',
          message: `${call.qualifiedName} 的参数 ${parameter.name} 需要 ${expected}，当前字面量是 ${argument.literalType}。`,
          nextAction: `按官方签名 ${declaration.signature} 修改可确认的字面量类型。`,
        }));
      }
    });
  }
  return output;
}

function analyzeUi(input: AnalyzeProjectInput): ProjectDiagnostic[] {
  const output: ProjectDiagnostic[] = [];
  if (input.uiSnapshot !== null) {
    for (const duplicate of input.uiSnapshot.duplicateNames) {
      output.push(projectDiagnostic({
        code: 'DUPLICATE_UI_NAME',
        severity: 'warning',
        message: `UI 名称“${duplicate.name}”有 ${duplicate.paths.length} 个候选。`,
        nextAction: '使用完整路径消歧，禁止静默选择。',
      }));
    }
    const counts = new Map<string, number>();
    for (const node of input.uiSnapshot.nodes) counts.set(node.id, (counts.get(node.id) ?? 0) + 1);
    for (const [id, count] of counts) {
      if (count > 1) {
        output.push(projectDiagnostic({
          code: 'DUPLICATE_UI_ID',
          severity: 'error',
          message: `UI ID ${id} 在快照中出现 ${count} 次。`,
          nextAction: '在元梦编辑器更新 VSCode 工程后重新获取 UI 结构；在修复前不要生成或替换该 ID。',
        }));
      }
    }
  }
  if (input.status?.ui.freshness === 'stale') {
    output.push(projectDiagnostic({
      code: 'STALE_UI_SNAPSHOT',
      severity: 'warning',
      message: 'UI 快照已陈旧，诊断不能代表编辑器最新状态。',
      nextAction: '恢复官方联动，在元梦编辑器更新 VSCode 工程后重新获取 UI 结构。',
    }));
  }
  return output;
}

const SEVERITY_ORDER: Readonly<Record<DiagnosticSeverity, number>> = { error: 0, warning: 1, info: 2 };

export function analyzeProject(input: AnalyzeProjectInput): ProjectDiagnostic[] {
  const diagnostics = [
    ...analyzeIdReferences(input),
    ...analyzeApiCalls(input),
    ...analyzeUi(input),
  ];
  diagnostics.sort((left, right) => (
    SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity]
    || (left.path ?? '').localeCompare(right.path ?? '', 'en')
    || (left.range?.startLine ?? 0) - (right.range?.startLine ?? 0)
    || left.code.localeCompare(right.code, 'en')
  ));
  return diagnostics;
}
