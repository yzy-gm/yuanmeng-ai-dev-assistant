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
import type { WhereUsedKind } from '../core/lua/source-index.js';

interface CommonOptions {
  project: string | null;
  launcherManifest: string | null;
  json: boolean;
}

export type CliArgs =
  | ({ command: 'status' } & CommonOptions)
  | ({ command: 'refresh-ui'; timeoutSeconds: number } & CommonOptions)
  | ({ command: 'find-ui'; query: string; allowStale: boolean; searchMode: UiSearchMode } & CommonOptions)
  | ({
    command: 'list-ids';
    kind: RegistryKind | null;
    environment: RegistryEnvironment | null;
    validity: RegistryValidity | null;
    allowStale: boolean;
  } & CommonOptions)
  | ({ command: 'diff-ui'; from: string | null; to: string | null } & CommonOptions)
  | ({ command: 'where-used'; query: string; kind: WhereUsedKind | null } & CommonOptions)
  | ({ command: 'api-search'; query: string } & CommonOptions)
  | ({ command: 'audit' } & CommonOptions)
  | ({ command: 'export'; subject: 'ui'; format: UiExportFormat; out: string } & CommonOptions);

type CliCommand = CliArgs['command'];
const COMMANDS: ReadonlySet<string> = new Set(['status', 'refresh-ui', 'find-ui', 'list-ids', 'diff-ui', 'where-used', 'api-search', 'audit', 'export']);

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
          if (value !== 'id' && value !== 'signal' && value !== 'ui') {
            usage('--kind 只支持 id、signal 或 ui。');
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
  if (command === 'status') {
    if (positionals.length !== 0 || allowStale || searchModeProvided || timeoutProvided || from !== null || to !== null || format !== null || out !== null || kind !== null || environment !== null || validity !== null || whereKind !== null) {
      usage('status 参数无效。');
    }
    return { command, ...common };
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
      usage('where-used 必须提供一个查询值，可选 --kind <id|signal|ui>。');
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
    return { command, query: positionals[0]!, ...common };
  }
  if (command === 'audit') {
    if (positionals.length !== 0 || allowStale || searchModeProvided || timeoutProvided || from !== null || to !== null || format !== null || out !== null || kind !== null || environment !== null || validity !== null || whereKind !== null) {
      usage('audit 参数无效。');
    }
    return { command, ...common };
  }
  if (
    positionals.length !== 1
    || positionals[0] !== 'ui'
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
    usage('export 首版只支持：export ui --format <json|csv|md> --out <path>。');
  }
  return { command, subject: 'ui', format, out, ...common };
}
