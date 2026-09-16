import { ProductError } from '../core/errors.js';
import {
  REGISTRY_ENVIRONMENTS,
  REGISTRY_KINDS,
  REGISTRY_VALIDITIES,
  type RegistryEnvironment,
  type RegistryKind,
  type RegistryValidity,
} from '../core/model.js';
import type { UiExportFormat } from '../core/ui/export.js';
import type { UiSearchMode } from '../core/ui/index.js';
import type { UiScreenPointRequest } from '../core/ui/runtime-inspection.js';
import type { WhereUsedKind } from '../core/lua/source-index.js';
import type { SceneSourceRole } from '../core/scene/container.js';
import { CUSTOM_PROPERTY_TYPES, type CustomPropertyType } from '../core/scene/lua-probe.js';
import type { SceneAxis, ScenePlacementRequest } from '../core/scene/placement-plan.js';
import type { SceneGeometryRequest } from '../core/scene/geometry.js';

interface CommonOptions {
  project: string | null;
  launcherManifest: string | null;
  json: boolean;
}

export type GameplayTestCliArgs = (
  | {
    command: 'gameplay-test';
    mode: 'auto';
    modelPath: null;
    scenarioDirectory: null;
    out: null;
    focus: string | null;
    changedFiles: string[];
    preview: boolean;
  }
  | {
    command: 'gameplay-test';
    mode: 'manual';
    modelPath: string;
    scenarioDirectory: string;
    out: string;
    focus: null;
    changedFiles: [];
    preview: false;
  }
) & CommonOptions;

type FeedbackKind = 'bug' | 'friction' | 'improvement';
type FeedbackStatus = 'open' | 'resolved';

export type CliArgs =
  | ({ command: 'status' } & CommonOptions)
  | ({ command: 'set-map-name'; mapDisplayName: string } & CommonOptions)
  | ({ command: 'refresh-ui'; timeoutSeconds: number } & CommonOptions)
  | ({ command: 'find-ui'; query: string; allowStale: boolean; searchMode: UiSearchMode } & CommonOptions)
  | ({ command: 'resolve-ui'; query: string; allowStale: boolean } & CommonOptions)
  | ({ command: 'ui-inspect-point'; request: UiScreenPointRequest; allowStale: boolean } & CommonOptions)
  | ({ command: 'ui-runtime-widgets'; query: string; allowStale: boolean } & CommonOptions)
  | ({ command: 'runtime-probe'; kind: 'ui-screen-point'; request: UiScreenPointRequest; allowStale: boolean } & CommonOptions)
  | ({ command: 'runtime-probe'; kind: 'ui-runtime-tree'; query: string; allowStale: boolean } & CommonOptions)
  | ({ command: 'runtime-probe'; kind: 'scene-capability'; instanceId: string } & CommonOptions)
  | ({ command: 'ui-screen-snapshot'; query: string; allowStale: boolean; searchMode: UiSearchMode } & CommonOptions)
  | ({ command: 'ui-tree-screen-snapshot'; query: string; allowStale: boolean; searchMode: UiSearchMode } & CommonOptions)
  | ({ command: 'ui-layout-audit'; query: string; allowStale: boolean; searchMode: UiSearchMode; includePotentialSiblingOverlap: boolean } & CommonOptions)
  | ({
    command: 'list-ids';
    kind: RegistryKind | null;
    environment: RegistryEnvironment | null;
    validity: RegistryValidity | null;
    allowStale: boolean;
  } & CommonOptions)
  | ({ command: 'diff-ui'; from: string | null; to: string | null } & CommonOptions)
  | ({ command: 'where-used'; query: string; kind: WhereUsedKind | null } & CommonOptions)
  | ({ command: 'api-search'; query: string; limit: number } & CommonOptions)
  | ({ command: 'official-audit'; saveBaseline: boolean } & CommonOptions)
  | ({ command: 'audit'; files: string[]; errorsOnly: boolean } & CommonOptions)
  | ({ command: 'scene-status' } & CommonOptions)
  | ({ command: 'bind-scene'; role: SceneSourceRole; sourcePath: string } & CommonOptions)
  | ({ command: 'refresh-scene'; role: SceneSourceRole | null; timeoutSeconds: number } & CommonOptions)
  | ({ command: 'find-scene'; query: string } & CommonOptions)
  | ({ command: 'scene-tree'; instanceId: string } & CommonOptions)
  | ({ command: 'field-inspect'; instanceId: string } & CommonOptions)
  | ({ command: 'group-members'; groupId: string } & CommonOptions)
  | ({ command: 'scene-diff'; from: string | null; to: string | null } & CommonOptions)
  | ({ command: 'scene-plan'; mode: 'floor-align'; supportId: string; moverIds: string[] } & CommonOptions)
  | ({ command: 'scene-plan'; mode: 'placement'; request: ScenePlacementRequest } & CommonOptions)
  | ({ command: 'scene-journal'; action: 'list'; limit: number } & CommonOptions)
  | ({ command: 'scene-journal'; action: 'show'; journalId: string } & CommonOptions)
  | ({ command: 'scene-near'; instanceId: string; radius: number; limit: number } & CommonOptions)
  | ({ command: 'scene-audit'; detailed: boolean } & CommonOptions)
  | ({ command: 'scene-types' } & CommonOptions)
  | ({ command: 'scene-capabilities'; instanceId: string } & CommonOptions)
  | ({ command: 'scene-geometry'; request: SceneGeometryRequest } & CommonOptions)
  | ({ command: 'gameplay-review'; modelPath: string; out: string } & CommonOptions)
  | GameplayTestCliArgs
  | ({ command: 'feedback'; action: 'add'; kind: FeedbackKind; title: string; message: string } & CommonOptions)
  | ({ command: 'feedback'; action: 'list'; status: FeedbackStatus | null; kind: FeedbackKind | null } & CommonOptions)
  | ({ command: 'feedback'; action: 'resolve'; feedbackId: string; resolution: string } & CommonOptions)
  | ({ command: 'property-locate'; propertyName: string; propertyType: CustomPropertyType } & CommonOptions)
  | ({ command: 'export'; subject: 'ui' | 'scene' | 'scene-ai'; format: UiExportFormat; out: string } & CommonOptions);

type CliCommand = CliArgs['command'];
const COMMANDS: ReadonlySet<string> = new Set([
  'status', 'set-map-name', 'refresh-ui', 'find-ui', 'resolve-ui', 'ui-inspect-point', 'ui-runtime-widgets', 'runtime-probe', 'ui-screen-snapshot', 'ui-tree-screen-snapshot', 'ui-layout-audit', 'list-ids', 'diff-ui', 'where-used', 'api-search', 'official-audit', 'audit', 'export',
  'scene-status', 'bind-scene', 'refresh-scene', 'find-scene', 'scene-tree', 'field-inspect', 'group-members', 'scene-diff', 'scene-plan', 'scene-journal', 'scene-near', 'scene-audit', 'scene-types', 'scene-capabilities', 'scene-geometry', 'property-locate',
  'gameplay-review', 'gameplay-test',
  'feedback',
]);

function parseAxis(value: string, option: string): SceneAxis {
  if (value !== 'x' && value !== 'y' && value !== 'z') usage(`${option} 只支持 x、y 或 z。`);
  return value;
}

function parseComponentOffsets(value: string, option: string): Partial<Record<SceneAxis, number>> {
  const result: Partial<Record<SceneAxis, number>> = {};
  for (const item of value.split(',')) {
    const match = /^(x|y|z)=(.+)$/u.exec(item.trim());
    if (match === null) usage(`${option} 必须使用 x=数值,y=数值,z=数值 格式。`);
    const axis = match[1] as SceneAxis;
    if (result[axis] !== undefined) usage(`${option} 的 ${axis} 分量不能重复。`);
    const numeric = Number(match[2]);
    if (!Number.isFinite(numeric)) usage(`${option} 的分量必须是有限数值。`);
    result[axis] = numeric;
  }
  if (Object.keys(result).length === 0) usage(`${option} 至少需要一个分量。`);
  return result;
}

function usage(message: string): never {
  throw new ProductError('USAGE_ERROR', message, [
    '运行 ymai status --json，或查看 README 中的 CLI 用法。',
  ], 'STATIC_LOCAL');
}

function takeValue(argv: readonly string[], index: number, option: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    usage(`${option} 缺少参数。`);
  }
  return value;
}

function parseAuditFile(value: string): string {
  const normalized = value.replace(/\\/gu, '/');
  const segments = normalized.split('/');
  if (
    !normalized.startsWith('src/')
    || !normalized.toLowerCase().endsWith('.lua')
    || normalized.includes('\0')
    || segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')
    || /^[A-Za-z]:/u.test(normalized)
  ) {
    usage('--file 只接受 src/ 下的工程相对 Lua 路径。');
  }
  return normalized;
}

export function parseCliArgs(argv: readonly string[]): CliArgs {
  let project: string | null = null;
  let launcherManifest: string | null = null;
  let projectProvided = false;
  let launcherManifestProvided = false;
  let commandIndex = 0;

  while (commandIndex < argv.length && argv[commandIndex]!.startsWith('--')) {
    const option = argv[commandIndex]!;
    if (option !== '--project' && option !== '--launcher-manifest') {
      usage(`CLI 命令前不支持选项：${option}`);
    }
    const value = takeValue(argv, commandIndex, option);
    if (option === '--project') {
      if (projectProvided) {
        usage('--project 不能重复使用。');
      }
      projectProvided = true;
      project = value;
    } else {
      if (launcherManifestProvided) {
        usage('--launcher-manifest 不能重复使用。');
      }
      launcherManifestProvided = true;
      launcherManifest = value;
    }
    commandIndex += 2;
  }

  const rawCommand = argv[commandIndex];
  if (rawCommand === undefined || !COMMANDS.has(rawCommand)) {
    usage('缺少或不支持 CLI 命令。');
  }
  const command = rawCommand as CliCommand;

  let json = false;
  let allowStale = false;
  let searchMode: UiSearchMode = 'exact-name';
  let searchModeProvided = false;
  let timeoutSeconds = 30;
  let timeoutProvided = false;
  let from: string | null = null;
  let to: string | null = null;
  let format: UiExportFormat | null = null;
  let out: string | null = null;
  let kind: RegistryKind | null = null;
  let environment: RegistryEnvironment | null = null;
  let validity: RegistryValidity | null = null;
  let whereKind: WhereUsedKind | null = null;
  let radius = 100;
  let radiusProvided = false;
  let limit = 50;
  let limitProvided = false;
  let referenceId: string | null = null;
  let axis: SceneAxis | null = null;
  let anchor: 'position' | 'min' | 'center' | 'max' | null = null;
  let spacing: number | null = null;
  let rowAxis: SceneAxis | null = null;
  let columnAxis: SceneAxis | null = null;
  let columns: number | null = null;
  let rowSpacing: number | null = null;
  let columnSpacing: number | null = null;
  let boundsGap = false;
  let preserveGroupRelative = true;
  let preserveGroupProvided = false;
  let detailed = false;
  let detailedProvided = false;
  let message: string | null = null;
  let focus: string | null = null;
  let preview = false;
  let previewProvided = false;
  let saveBaseline = false;
  const auditFiles: string[] = [];
  let errorsOnly = false;
  let includePotentialSiblingOverlap = false;
  let includeGroup = false;
  let includeGroupProvided = false;
  let groupId = '0';
  let groupIdProvided = false;
  let tolerance = 0.1;
  let toleranceProvided = false;
  const components: { position?: Partial<Record<SceneAxis, number>>; rotation?: Partial<Record<SceneAxis, number>>; scale?: Partial<Record<SceneAxis, number>> } = {};
  const positionals: string[] = [];

  for (let index = commandIndex + 1; index < argv.length; index += 1) {
    const argument = argv[index]!;
    switch (argument) {
      case '--project':
        if (projectProvided) {
          usage('--project 不能重复使用。');
        }
        projectProvided = true;
        project = takeValue(argv, index, argument);
        index += 1;
        break;
      case '--launcher-manifest':
        if (launcherManifestProvided) {
          usage('--launcher-manifest 不能重复使用。');
        }
        launcherManifestProvided = true;
        launcherManifest = takeValue(argv, index, argument);
        index += 1;
        break;
      case '--json':
        json = true;
        break;
      case '--allow-stale':
        allowStale = true;
        break;
      case '--path':
        if (searchModeProvided) {
          usage('--path 与 --fuzzy 不能同时或重复使用。');
        }
        searchModeProvided = true;
        searchMode = 'exact-path';
        break;
      case '--fuzzy':
        if (searchModeProvided) {
          usage('--path 与 --fuzzy 不能同时或重复使用。');
        }
        searchModeProvided = true;
        searchMode = 'fuzzy';
        break;
      case '--timeout': {
        const raw = takeValue(argv, index, argument);
        timeoutSeconds = Number(raw);
        if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 300) {
          usage('--timeout 必须是 1 到 300 秒的整数。');
        }
        timeoutProvided = true;
        index += 1;
        break;
      }
      case '--from':
        from = takeValue(argv, index, argument);
        index += 1;
        break;
      case '--to':
        to = takeValue(argv, index, argument);
        index += 1;
        break;
      case '--radius': {
        if (radiusProvided) usage('--radius 不能重复使用。');
        radius = Number(takeValue(argv, index, argument));
        if (!Number.isFinite(radius) || radius < 0 || radius > 1_000_000_000) usage('--radius 必须是有限非负数。');
        radiusProvided = true;
        index += 1;
        break;
      }
      case '--limit': {
        if (limitProvided) usage('--limit 不能重复使用。');
        limit = Number(takeValue(argv, index, argument));
        if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) usage('--limit 必须是 1 到 1000 的整数。');
        limitProvided = true;
        index += 1;
        break;
      }
      case '--reference':
        if (referenceId !== null) usage('--reference 不能重复使用。');
        referenceId = takeValue(argv, index, argument);
        index += 1;
        break;
      case '--axis':
        if (axis !== null) usage('--axis 不能重复使用。');
        axis = parseAxis(takeValue(argv, index, argument), argument);
        index += 1;
        break;
      case '--anchor': {
        if (anchor !== null) usage('--anchor 不能重复使用。');
        const value = takeValue(argv, index, argument);
        if (value !== 'position' && value !== 'min' && value !== 'center' && value !== 'max') usage('--anchor 只支持 position、min、center 或 max。');
        anchor = value;
        index += 1;
        break;
      }
      case '--spacing':
        if (spacing !== null) usage('--spacing 不能重复使用。');
        spacing = Number(takeValue(argv, index, argument));
        if (!Number.isFinite(spacing)) usage('--spacing 必须是有限数值。');
        index += 1;
        break;
      case '--row-axis':
        if (rowAxis !== null) usage('--row-axis 不能重复使用。');
        rowAxis = parseAxis(takeValue(argv, index, argument), argument);
        index += 1;
        break;
      case '--column-axis':
        if (columnAxis !== null) usage('--column-axis 不能重复使用。');
        columnAxis = parseAxis(takeValue(argv, index, argument), argument);
        index += 1;
        break;
      case '--columns':
        if (columns !== null) usage('--columns 不能重复使用。');
        columns = Number(takeValue(argv, index, argument));
        if (!Number.isInteger(columns) || columns < 1 || columns > 1000) usage('--columns 必须是 1 到 1000 的整数。');
        index += 1;
        break;
      case '--row-spacing':
        if (rowSpacing !== null) usage('--row-spacing 不能重复使用。');
        rowSpacing = Number(takeValue(argv, index, argument));
        if (!Number.isFinite(rowSpacing)) usage('--row-spacing 必须是有限数值。');
        index += 1;
        break;
      case '--column-spacing':
        if (columnSpacing !== null) usage('--column-spacing 不能重复使用。');
        columnSpacing = Number(takeValue(argv, index, argument));
        if (!Number.isFinite(columnSpacing)) usage('--column-spacing 必须是有限数值。');
        index += 1;
        break;
      case '--bounds-gap':
        if (boundsGap) usage('--bounds-gap 不能重复使用。');
        boundsGap = true;
        break;
      case '--no-preserve-group':
        if (preserveGroupProvided) usage('--no-preserve-group 不能重复使用。');
        preserveGroupProvided = true;
        preserveGroupRelative = false;
        break;
      case '--detailed':
        if (detailedProvided) usage('--detailed 不能重复使用。');
        detailedProvided = true;
        detailed = true;
        break;
      case '--message':
        if (message !== null) usage('--message 不能重复使用。');
        message = takeValue(argv, index, argument);
        index += 1;
        break;
      case '--focus':
        if (focus !== null) usage('--focus 不能重复使用。');
        focus = takeValue(argv, index, argument);
        if (focus.length > 2_000) usage('--focus 最多 2000 个字符。');
        index += 1;
        break;
      case '--preview':
        if (previewProvided) usage('--preview 不能重复使用。');
        preview = true;
        previewProvided = true;
        break;
      case '--save-baseline':
        if (saveBaseline) usage('--save-baseline 不能重复使用。');
        saveBaseline = true;
        break;
      case '--file': {
        const file = parseAuditFile(takeValue(argv, index, argument));
        if (auditFiles.includes(file)) usage('--file 不能重复指定同一文件。');
        if (auditFiles.length >= 100) usage('--file 最多指定 100 个文件。');
        auditFiles.push(file);
        index += 1;
        break;
      }
      case '--errors-only':
        if (errorsOnly) usage('--errors-only 不能重复使用。');
        errorsOnly = true;
        break;
      case '--include-overlaps':
        if (includePotentialSiblingOverlap) usage('--include-overlaps 不能重复使用。');
        includePotentialSiblingOverlap = true;
        break;
      case '--include-group':
        if (includeGroupProvided) usage('--include-group 不能重复使用。');
        includeGroupProvided = true;
        includeGroup = true;
        break;
      case '--group-id':
        if (groupIdProvided) usage('--group-id 不能重复使用。');
        groupId = takeValue(argv, index, argument);
        if (!/^\d{1,20}$/u.test(groupId)) usage('--group-id 必须是十进制控件组 ID。');
        groupIdProvided = true;
        index += 1;
        break;
      case '--tolerance':
        if (toleranceProvided) usage('--tolerance 不能重复使用。');
        tolerance = Number(takeValue(argv, index, argument));
        if (!Number.isFinite(tolerance) || tolerance < 0 || tolerance > 1_000_000) usage('--tolerance 必须是 0 到 1000000 的有限数值。');
        toleranceProvided = true;
        index += 1;
        break;
      case '--position':
      case '--rotation':
      case '--scale': {
        const field = argument.slice(2) as 'position' | 'rotation' | 'scale';
        if (components[field] !== undefined) usage(`${argument} 不能重复使用。`);
        components[field] = parseComponentOffsets(takeValue(argv, index, argument), argument);
        index += 1;
        break;
      }
      case '--format': {
        const value = takeValue(argv, index, argument);
        if (value !== 'json' && value !== 'csv' && value !== 'md') {
          usage('--format 只支持 json、csv 或 md。');
        }
        format = value;
        index += 1;
        break;
      }
      case '--out':
        out = takeValue(argv, index, argument);
        index += 1;
        break;
      case '--kind': {
        const value = takeValue(argv, index, argument);
        if (command === 'where-used') {
          if (whereKind !== null) {
            usage('--kind 不能重复使用。');
          }
          if (
            value !== 'id'
            && value !== 'signal'
            && value !== 'ui'
            && value !== 'scene-instance'
            && value !== 'element-type'
            && value !== 'scene-layer'
          ) {
            usage('--kind 只支持 id、signal、ui、scene-instance、element-type 或 scene-layer。');
          }
          whereKind = value;
        } else {
          if (kind !== null) {
            usage('--kind 不能重复使用。');
          }
          if (!REGISTRY_KINDS.includes(value as RegistryKind)) {
            usage(`--kind 只支持 ${REGISTRY_KINDS.join('、')}。`);
          }
          kind = value as RegistryKind;
        }
        index += 1;
        break;
      }
      case '--environment': {
        if (environment !== null) {
          usage('--environment 不能重复使用。');
        }
        const value = takeValue(argv, index, argument);
        if (!REGISTRY_ENVIRONMENTS.includes(value as RegistryEnvironment)) {
          usage(`--environment 只支持 ${REGISTRY_ENVIRONMENTS.join('、')}。`);
        }
        environment = value as RegistryEnvironment;
        index += 1;
        break;
      }
      case '--validity': {
        if (validity !== null) {
          usage('--validity 不能重复使用。');
        }
        const value = takeValue(argv, index, argument);
        if (!REGISTRY_VALIDITIES.includes(value as RegistryValidity)) {
          usage(`--validity 只支持 ${REGISTRY_VALIDITIES.join('、')}。`);
        }
        validity = value as RegistryValidity;
        index += 1;
        break;
      }
      default:
        if (argument.startsWith('--')) {
          usage(`未知选项：${argument}`);
        }
        positionals.push(argument);
    }
  }

  const common = { project, launcherManifest, json };
  const noRegistryFilters = kind === null && environment === null && validity === null && whereKind === null;
  const noUiSearchOptions = !allowStale && !searchModeProvided;
  const noExportOptions = format === null && out === null;
  const placementOptionsProvided = referenceId !== null || axis !== null || anchor !== null || spacing !== null
    || rowAxis !== null || columnAxis !== null || columns !== null || rowSpacing !== null || columnSpacing !== null
    || boundsGap || preserveGroupProvided || Object.keys(components).length > 0;
  if (command !== 'scene-near' && command !== 'scene-journal' && command !== 'api-search' && (radiusProvided || limitProvided)) usage(`${command} 不支持 --radius 或 --limit。`);
  if (command !== 'scene-plan' && placementOptionsProvided) usage(`${command} 不支持空间计划选项。`);
  if (command !== 'scene-audit' && detailedProvided) usage(`${command} 不支持 --detailed。`);
  if (command !== 'feedback' && message !== null) usage(`${command} 不支持 --message。`);
  if (command !== 'audit' && command !== 'gameplay-test' && auditFiles.length > 0) usage(`${command} 不支持 --file。`);
  if (command !== 'audit' && errorsOnly) usage(`${command} 不支持 --errors-only。`);
  if (command !== 'gameplay-test' && focus !== null) usage(`${command} 不支持 --focus。`);
  if (command !== 'gameplay-test' && previewProvided) usage(`${command} 不支持 --preview。`);
  if (command !== 'official-audit' && saveBaseline) usage(`${command} 不支持 --save-baseline。`);
  if (command !== 'ui-layout-audit' && includePotentialSiblingOverlap) usage(`${command} 不支持 --include-overlaps。`);
  if (command !== 'ui-inspect-point' && command !== 'runtime-probe' && (includeGroupProvided || groupIdProvided)) usage(`${command} 不支持控件组命中选项。`);
  if (command !== 'scene-geometry' && toleranceProvided) usage(`${command} 不支持 --tolerance。`);
  if (command === 'feedback') {
    if (!noUiSearchOptions || timeoutProvided || from !== null || to !== null || !noExportOptions || !noRegistryFilters || radiusProvided || limitProvided || placementOptionsProvided || detailedProvided) usage('feedback 参数无效。');
    const action = positionals[0];
    if (action === 'add' && positionals.length === 3 && message !== null) {
      const feedbackKind = positionals[1];
      if (feedbackKind !== 'bug' && feedbackKind !== 'friction' && feedbackKind !== 'improvement') usage('feedback add 类型只支持 bug、friction 或 improvement。');
      return { command, action, kind: feedbackKind, title: positionals[2]!, message, ...common };
    }
    if (action === 'list' && positionals.length >= 1 && positionals.length <= 3 && message === null) {
      const rawStatus = positionals[1] ?? 'all';
      const rawKind = positionals[2] ?? 'all';
      if (rawStatus !== 'all' && rawStatus !== 'open' && rawStatus !== 'resolved') usage('feedback list 状态只支持 all、open 或 resolved。');
      if (rawKind !== 'all' && rawKind !== 'bug' && rawKind !== 'friction' && rawKind !== 'improvement') usage('feedback list 类型只支持 all、bug、friction 或 improvement。');
      return { command, action, status: rawStatus === 'all' ? null : rawStatus, kind: rawKind === 'all' ? null : rawKind, ...common };
    }
    if (action === 'resolve' && positionals.length === 2 && /^[a-f0-9]{64}$/u.test(positionals[1]!) && message !== null) {
      return { command, action, feedbackId: positionals[1]!, resolution: message, ...common };
    }
    usage('feedback 用法：feedback add <bug|friction|improvement> <标题> --message <内容>；feedback list [all|open|resolved] [all|bug|friction|improvement]；feedback resolve <ID> --message <处理说明>。');
  }
  const parseScreenPoint = (values: readonly string[]): UiScreenPointRequest => {
    if (values.length !== 2) usage('屏幕点命中必须提供 X 和 Y。');
    const x = Number(values[0]);
    const y = Number(values[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > 1_000_000_000 || y > 1_000_000_000) {
      usage('屏幕坐标必须是非负有限数值。');
    }
    if (includeGroup && (!groupIdProvided || groupId === '0')) usage('--include-group 必须同时提供非零 --group-id。');
    if (!includeGroup && groupIdProvided) usage('--group-id 只能与 --include-group 同时使用。');
    return { x, y, includeGroup, groupId };
  };
  const p0CommonClean = timeoutProvided === false && from === null && to === null && noExportOptions && noRegistryFilters
    && !radiusProvided && !limitProvided && !placementOptionsProvided && !detailedProvided && message === null
    && auditFiles.length === 0 && !errorsOnly && !includePotentialSiblingOverlap && !toleranceProvided;
  if (command === 'resolve-ui' || command === 'ui-runtime-widgets') {
    if (positionals.length !== 1 || searchModeProvided || !p0CommonClean || includeGroupProvided || groupIdProvided) usage(`${command} 必须提供一个 ID、完整路径或精确名称。`);
    return { command, query: positionals[0]!, allowStale, ...common };
  }
  if (command === 'ui-inspect-point') {
    if (searchModeProvided || !p0CommonClean) usage('ui-inspect-point 参数无效。');
    return { command, request: parseScreenPoint(positionals), allowStale, ...common };
  }
  if (command === 'runtime-probe') {
    if (searchModeProvided || !p0CommonClean || positionals.length < 2) usage('runtime-probe 只支持 ui-screen-point、ui-runtime-tree 或 scene-capability。');
    const probeKind = positionals[0];
    if (probeKind === 'ui-screen-point') return { command, kind: probeKind, request: parseScreenPoint(positionals.slice(1)), allowStale, ...common };
    if (probeKind === 'ui-runtime-tree' && positionals.length === 2 && !includeGroupProvided && !groupIdProvided) {
      return { command, kind: probeKind, query: positionals[1]!, allowStale, ...common };
    }
    if (probeKind === 'scene-capability' && positionals.length === 2 && !allowStale && !includeGroupProvided && !groupIdProvided && /^\d{1,20}$/u.test(positionals[1]!)) {
      return { command, kind: probeKind, instanceId: positionals[1]!, ...common };
    }
    usage('runtime-probe 只接受受控探针：ui-screen-point <X> <Y>、ui-runtime-tree <控件>、scene-capability <实例ID>。');
  }
  if (command === 'scene-capabilities') {
    if (positionals.length !== 1 || !/^\d{1,20}$/u.test(positionals[0]!) || !noUiSearchOptions || !p0CommonClean || includeGroupProvided || groupIdProvided) {
      usage('scene-capabilities 必须提供一个十进制场景实例 ID。');
    }
    return { command, instanceId: positionals[0]!, ...common };
  }
  if (command === 'scene-status' || command === 'scene-types') {
    if (positionals.length !== 0 || !noUiSearchOptions || timeoutProvided || from !== null || to !== null || !noExportOptions || !noRegistryFilters) usage(`${command} 参数无效。`);
    return { command, ...common };
  }
  if (command === 'bind-scene') {
    const role = positionals[0];
    if (
      positionals.length !== 2
      || (role !== 'manual-dat' && role !== 'auto-dat' && role !== 'raw-pbin')
      || !noUiSearchOptions || timeoutProvided || from !== null || to !== null || !noExportOptions || !noRegistryFilters
    ) usage('bind-scene 用法：bind-scene <manual-dat|auto-dat|raw-pbin> <文件路径>。');
    return { command, role, sourcePath: positionals[1]!, ...common };
  }
  if (command === 'refresh-scene') {
    const role = positionals[0] ?? null;
    if (
      positionals.length > 1
      || (role !== null && role !== 'manual-dat' && role !== 'auto-dat' && role !== 'raw-pbin')
      || !noUiSearchOptions || from !== null || to !== null || !noExportOptions || !noRegistryFilters
    ) usage('refresh-scene 最多接受一个来源角色。');
    return { command, role, timeoutSeconds, ...common };
  }
  if (command === 'find-scene') {
    if (positionals.length !== 1 || !noUiSearchOptions || timeoutProvided || from !== null || to !== null || !noExportOptions || !noRegistryFilters) usage('find-scene 必须提供实例 ID、type:类型ID、owner:OwnerID 或 signal:信号名。');
    return { command, query: positionals[0]!, ...common };
  }
  if (command === 'scene-tree' || command === 'field-inspect' || command === 'group-members') {
    if (positionals.length !== 1 || !noUiSearchOptions || timeoutProvided || from !== null || to !== null || !noExportOptions || !noRegistryFilters) usage(`${command} 必须提供一个十进制 ID。`);
    if (command === 'scene-tree') return { command, instanceId: positionals[0]!, ...common };
    if (command === 'field-inspect') return { command, instanceId: positionals[0]!, ...common };
    return { command, groupId: positionals[0]!, ...common };
  }
  if (command === 'scene-diff') {
    if (positionals.length !== 0 || !noUiSearchOptions || timeoutProvided || !noExportOptions || !noRegistryFilters) usage('scene-diff 参数无效。');
    return { command, from, to, ...common };
  }
  if (command === 'scene-plan') {
    if (positionals.length < 2 || !noUiSearchOptions || timeoutProvided || from !== null || to !== null || !noExportOptions || !noRegistryFilters || radiusProvided || limitProvided) usage('scene-plan 参数无效。');
    const operation = positionals[0]!;
    const targetIds = positionals.slice(1);
    if (!['axis-align', 'equal-spacing', 'grid', 'rows', 'columns', 'batch-offset', 'floor-align'].includes(operation)) {
      if (placementOptionsProvided) usage('旧版 floor-align 位置参数不支持其他空间计划选项。');
      return { command, mode: 'floor-align', supportId: operation, moverIds: targetIds, ...common };
    }
    if (operation === 'floor-align') {
      if (targetIds.length < 2 || placementOptionsProvided) usage('scene-plan floor-align 用法：scene-plan floor-align <承载面ID> <移动ID...>。');
      return { command, mode: 'floor-align', supportId: targetIds[0]!, moverIds: targetIds.slice(1), ...common };
    }
    if (operation === 'axis-align') {
      if (referenceId === null || axis === null || anchor === null || targetIds.length < 1 || spacing !== null || rowAxis !== null || columnAxis !== null || columns !== null || rowSpacing !== null || columnSpacing !== null || boundsGap || Object.keys(components).length > 0) usage('axis-align 需要目标、--reference、--axis 和 --anchor。');
      return { command, mode: 'placement', request: { kind: operation, targetIds, referenceId, axis, anchor, preserveGroupRelative }, ...common };
    }
    if (operation === 'equal-spacing') {
      if (targetIds.length < 3 || axis === null || referenceId !== null || anchor !== null || spacing !== null || rowAxis !== null || columnAxis !== null || columns !== null || rowSpacing !== null || columnSpacing !== null || Object.keys(components).length > 0) usage('equal-spacing 需要至少三个目标和 --axis，可选 --bounds-gap。');
      return { command, mode: 'placement', request: { kind: operation, targetIds, axis, mode: boundsGap ? 'bounds-gap' : 'position', preserveGroupRelative }, ...common };
    }
    if (operation === 'grid') {
      if (targetIds.length < 1 || rowAxis === null || columnAxis === null || rowAxis === columnAxis || columns === null || rowSpacing === null || columnSpacing === null || referenceId !== null || axis !== null || anchor !== null || spacing !== null || boundsGap || Object.keys(components).length > 0) usage('grid 需要目标、不同的 --row-axis/--column-axis、--columns、--row-spacing 和 --column-spacing。');
      return { command, mode: 'placement', request: { kind: operation, targetIds, rowAxis, columnAxis, columns, rowSpacing, columnSpacing, preserveGroupRelative }, ...common };
    }
    if (operation === 'rows' || operation === 'columns') {
      if (targetIds.length < 1 || axis === null || spacing === null || referenceId !== null || anchor !== null || rowAxis !== null || columnAxis !== null || columns !== null || rowSpacing !== null || columnSpacing !== null || boundsGap || Object.keys(components).length > 0) usage(`${operation} 需要目标、--axis 和 --spacing。`);
      return { command, mode: 'placement', request: { kind: operation, targetIds, axis, spacing, preserveGroupRelative }, ...common };
    }
    if (targetIds.length < 1 || Object.keys(components).length === 0 || referenceId !== null || axis !== null || anchor !== null || spacing !== null || rowAxis !== null || columnAxis !== null || columns !== null || rowSpacing !== null || columnSpacing !== null || boundsGap) usage('batch-offset 需要目标和至少一个 --position/--rotation/--scale。');
    return { command, mode: 'placement', request: { kind: 'batch-offset', targetIds, components, preserveGroupRelative }, ...common };
  }
  if (command === 'scene-journal') {
    if (!noUiSearchOptions || timeoutProvided || from !== null || to !== null || !noExportOptions || !noRegistryFilters || radiusProvided || placementOptionsProvided) usage('scene-journal 参数无效。');
    if (positionals[0] === 'list' && positionals.length === 1) {
      if (limit > 200) usage('scene-journal --limit 最大为 200。');
      return { command, action: 'list', limit, ...common };
    }
    if (positionals[0] === 'show' && positionals.length === 2 && !limitProvided && /^[a-f0-9]{64}$/u.test(positionals[1]!)) return { command, action: 'show', journalId: positionals[1]!, ...common };
    usage('scene-journal 用法：scene-journal list [--limit 1..200] 或 scene-journal show <64位日志ID>。');
  }
  if (command === 'scene-near') {
    if (
      positionals.length !== 1 || !/^\d{1,20}$/u.test(positionals[0]!)
      || !noUiSearchOptions || timeoutProvided || from !== null || to !== null || !noExportOptions || !noRegistryFilters
    ) usage('scene-near 用法：scene-near <实例ID> [--radius <距离>] [--limit <数量>]。');
    return { command, instanceId: positionals[0]!, radius, limit, ...common };
  }
  if (command === 'scene-audit') {
    if (positionals.length !== 0 || !noUiSearchOptions || timeoutProvided || from !== null || to !== null || !noExportOptions || !noRegistryFilters) usage('scene-audit 参数无效。');
    return { command, detailed, ...common };
  }
  if (command === 'scene-geometry') {
    if (!noUiSearchOptions || timeoutProvided || from !== null || to !== null || !noExportOptions || !noRegistryFilters || radiusProvided || limitProvided || placementOptionsProvided || detailedProvided) usage('scene-geometry 参数无效。');
    const operation = positionals[0];
    const ids = positionals.slice(1);
    if (ids.some((id) => !/^\d{1,20}$/u.test(id))) usage('scene-geometry 仅接受十进制实例或编组 ID。');
    if (operation === 'bounds' && ids.length === 1 && !toleranceProvided) return { command, request: { operation, targetId: ids[0]! }, ...common };
    if (operation === 'contact' && ids.length === 2) return { command, request: { operation, targetId: ids[0]!, supportId: ids[1]!, tolerance }, ...common };
    if (operation === 'overlaps' && ids.length >= 2 && !toleranceProvided) return { command, request: { operation, targetIds: ids }, ...common };
    usage('scene-geometry 用法：bounds <ID>；contact <目标ID> <承载面ID> [--tolerance 数值]；overlaps <ID...>。');
  }
  if (command === 'property-locate') {
    if (
      positionals.length !== 2
      || !CUSTOM_PROPERTY_TYPES.includes(positionals[1] as CustomPropertyType)
      || !noUiSearchOptions || timeoutProvided || from !== null || to !== null || !noExportOptions || !noRegistryFilters
    ) usage(`property-locate 用法：property-locate <属性名> <${CUSTOM_PROPERTY_TYPES.join('|')}>。`);
    return { command, propertyName: positionals[0]!, propertyType: positionals[1] as CustomPropertyType, ...common };
  }
  if (command === 'gameplay-review') {
    if (
      positionals.length !== 1
      || out === null
      || format !== null
      || !noUiSearchOptions
      || timeoutProvided
      || from !== null
      || to !== null
      || !noRegistryFilters
      || radiusProvided
      || limitProvided
      || placementOptionsProvided
    ) usage('gameplay-review 用法：gameplay-review <spec.json> --out <报告目录>。');
    return { command, modelPath: positionals[0]!, out, ...common };
  }
  if (command === 'gameplay-test') {
    const sharedOptionsClean = format === null
      && noUiSearchOptions
      && !timeoutProvided
      && from === null
      && to === null
      && noRegistryFilters
      && !radiusProvided
      && !limitProvided
      && !placementOptionsProvided
      && !errorsOnly;
    if (sharedOptionsClean && positionals.length === 0 && out === null) {
      return {
        command,
        mode: 'auto',
        modelPath: null,
        scenarioDirectory: null,
        out: null,
        focus,
        changedFiles: auditFiles,
        preview,
        ...common,
      };
    }
    if (
      sharedOptionsClean
      && positionals.length === 2
      && out !== null
      && focus === null
      && auditFiles.length === 0
      && !previewProvided
    ) {
      return {
        command,
        mode: 'manual',
        modelPath: positionals[0]!,
        scenarioDirectory: positionals[1]!,
        out,
        focus: null,
        changedFiles: [],
        preview: false,
        ...common,
      };
    }
    usage('gameplay-test 用法：gameplay-test [--preview] [--focus <说明>] [--file <src/相对路径>...]，或 gameplay-test <spec.json> <scenarios目录> --out <报告目录>。');
  }
  if (command === 'status') {
    if (positionals.length !== 0 || allowStale || searchModeProvided || timeoutProvided || from !== null || to !== null || format !== null || out !== null || kind !== null || environment !== null || validity !== null || whereKind !== null) {
      usage('status 参数无效。');
    }
    return { command, ...common };
  }
  if (command === 'set-map-name') {
    if (
      positionals.length !== 1
      || !noUiSearchOptions
      || timeoutProvided
      || from !== null
      || to !== null
      || !noExportOptions
      || !noRegistryFilters
      || radiusProvided
      || limitProvided
      || placementOptionsProvided
      || detailedProvided
    ) {
      usage('set-map-name 用法：set-map-name <地图名称>。');
    }
    return { command, mapDisplayName: positionals[0]!, ...common };
  }
  if (command === 'refresh-ui') {
    if (positionals.length !== 0 || allowStale || searchModeProvided || from !== null || to !== null || format !== null || out !== null || kind !== null || environment !== null || validity !== null || whereKind !== null) {
      usage('refresh-ui 参数无效。');
    }
    return { command, timeoutSeconds, ...common };
  }
  if (command === 'find-ui') {
    if (positionals.length !== 1 || timeoutProvided || from !== null || to !== null || format !== null || out !== null || kind !== null || environment !== null || validity !== null || whereKind !== null) {
      usage('find-ui 必须提供一个查询词。');
    }
    return { command, query: positionals[0]!, allowStale, searchMode, ...common };
  }
  if (command === 'ui-screen-snapshot' || command === 'ui-tree-screen-snapshot' || command === 'ui-layout-audit') {
    if (positionals.length !== 1 || timeoutProvided || from !== null || to !== null || format !== null || out !== null || kind !== null || environment !== null || validity !== null || whereKind !== null) {
      usage(`${command} 必须提供一个 UI 名称、ID 或完整路径查询词。`);
    }
    if (command === 'ui-layout-audit') return { command, query: positionals[0]!, allowStale, searchMode, includePotentialSiblingOverlap, ...common };
    return { command, query: positionals[0]!, allowStale, searchMode, ...common };
  }
  if (command === 'list-ids') {
    if (positionals.length !== 0 || searchModeProvided || timeoutProvided || from !== null || to !== null || format !== null || out !== null || whereKind !== null) {
      usage('list-ids 参数无效。');
    }
    return { command, kind, environment, validity, allowStale, ...common };
  }
  if (command === 'diff-ui') {
    if (positionals.length !== 0 || allowStale || searchModeProvided || timeoutProvided || format !== null || out !== null || kind !== null || environment !== null || validity !== null || whereKind !== null) {
      usage('diff-ui 参数无效。');
    }
    return { command, from, to, ...common };
  }
  if (command === 'where-used') {
    if (
      positionals.length !== 1
      || allowStale
      || searchModeProvided
      || timeoutProvided
      || from !== null
      || to !== null
      || format !== null
      || out !== null
      || kind !== null
      || environment !== null
      || validity !== null
    ) {
      usage('where-used 必须提供一个查询值，可选 --kind <id|signal|ui|scene-instance|element-type|scene-layer>。');
    }
    return { command, query: positionals[0]!, kind: whereKind, ...common };
  }
  if (command === 'api-search') {
    if (
      positionals.length !== 1
      || allowStale
      || searchModeProvided
      || timeoutProvided
      || from !== null
      || to !== null
      || format !== null
      || out !== null
      || kind !== null
      || environment !== null
      || validity !== null
      || whereKind !== null
    ) {
      usage('api-search 必须提供一个查询词。');
    }
    return { command, query: positionals[0]!, limit: limitProvided ? limit : 200, ...common };
  }
  if (command === 'official-audit') {
    if (positionals.length !== 0 || allowStale || searchModeProvided || timeoutProvided || from !== null || to !== null || format !== null || out !== null || kind !== null || environment !== null || validity !== null || whereKind !== null || radiusProvided || limitProvided || placementOptionsProvided || detailedProvided || message !== null || auditFiles.length > 0 || errorsOnly || includePotentialSiblingOverlap || includeGroupProvided || groupIdProvided || toleranceProvided) {
      usage('official-audit 参数无效。');
    }
    return { command, saveBaseline, ...common };
  }
  if (command === 'audit') {
    if (positionals.length !== 0 || allowStale || searchModeProvided || timeoutProvided || from !== null || to !== null || format !== null || out !== null || kind !== null || environment !== null || validity !== null || whereKind !== null) {
      usage('audit 参数无效。');
    }
    return { command, files: auditFiles, errorsOnly, ...common };
  }
  if (
    positionals.length !== 1
    || (positionals[0] !== 'ui' && positionals[0] !== 'scene' && positionals[0] !== 'scene-ai')
    || format === null
    || out === null
    || allowStale
    || searchModeProvided
    || timeoutProvided
    || from !== null
    || to !== null
    || kind !== null
    || environment !== null
    || validity !== null
    || whereKind !== null
  ) {
    usage('export 支持：export <ui|scene|scene-ai> --format <json|csv|md> --out <path>。');
  }
  if (positionals[0] === 'scene-ai' && format === 'csv') usage('scene-ai 只支持 json 或 md。');
  return { command, subject: positionals[0] as 'ui' | 'scene' | 'scene-ai', format, out, ...common };
}
