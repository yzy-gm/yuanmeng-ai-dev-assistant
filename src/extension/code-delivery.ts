import { isAbsolute, normalize, relative, resolve } from 'node:path';

export interface CodeDeliveryArtifact {
  relativePath: string;
  size: number;
  mtimeMs: number;
  sha256: string;
}

export interface PlayBuildEvidence {
  type: 'pack' | 'merge';
  pack: string | null;
  time: string | null;
}

export interface CorrelatedPlayBuildEvidence extends PlayBuildEvidence {
  matchesChangedArtifact: boolean;
}

export type CodeDeliveryStatus =
  | 'LINK_OFFLINE'
  | 'PROJECT_AMBIGUOUS'
  | 'SAVE_FAILED'
  | 'CHECK_FAILED'
  | 'COMMAND_UNAVAILABLE'
  | 'EVIDENCE_INSUFFICIENT'
  | 'BUILT'
  | 'SENT';

export interface CodeDeliveryResult {
  projectPath: string;
  savedFiles: string[];
  dirtyBefore: string[];
  dirtyAfter: string[];
  commandAvailable: boolean;
  buildStartedAt: string | null;
  artifactChanges: Array<{ relativePath: string; before: CodeDeliveryArtifact | null; after: CodeDeliveryArtifact | null }>;
  officialOutputEvidence: string[];
  playBuildEvidence: CorrelatedPlayBuildEvidence | null;
  status: CodeDeliveryStatus;
  nextAction: string;
  evidenceLevel: 'STATIC_LOCAL' | 'EXTENSION_HOST' | 'OFFICIAL_EDITOR_SINGLE';
}

export interface CodeDeliveryDependencies {
  projectRoot: string;
  projectInstanceId: string;
  workspaceRoots: readonly string[];
  listDirtyLua(): readonly string[];
  saveAll(): Promise<boolean>;
  runStaticChecks(): Promise<{ ok: boolean; summary: string; freshness: 'fresh' | 'stale' | 'unknown' }>;
  runProjectAudit(): Promise<{
    ok: boolean;
    summary: string;
    reasonCode?: string;
    file?: string;
    nextActions?: readonly string[];
    evidence: 'STATIC_LOCAL' | 'EXTENSION_HOST';
  }>;
  isOfficialCommandAvailable(): Promise<boolean>;
  executeOfficialBuild(): Promise<unknown>;
  snapshotArtifacts(): Promise<CodeDeliveryArtifact[]>;
  readPlayBuildEvidence?(): Promise<PlayBuildEvidence | null>;
  now(): Date;
  wait(milliseconds: number): Promise<void>;
  observation?: {
    timeoutMilliseconds: number;
    sampleMilliseconds: number;
    stableSampleCount: number;
  };
}

function canonical(path: string): string {
  return normalize(resolve(path)).replace(/[\\/]+$/u, '').toLowerCase();
}

function safeRelative(root: string, path: string): string {
  const value = relative(root, path).replace(/\\/gu, '/');
  return value !== '' && !value.startsWith('..') && !isAbsolute(value) ? value : path.split(/[\\/]/u).at(-1) ?? 'Lua';
}

function safePlayPack(root: string, path: string): string | null {
  const absolute = isAbsolute(path) ? resolve(path) : resolve(root, path);
  const value = relative(root, absolute).replace(/\\/gu, '/');
  return value !== '' && !value.startsWith('..') && !isAbsolute(value) ? value : null;
}

export function parsePlayBuildEvidence(content: string, projectRoot: string): PlayBuildEvidence | null {
  if (content.length === 0 || content.length > 64 * 1024) return null;
  let value: unknown;
  try {
    value = JSON.parse(content) as unknown;
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.type !== 'pack' && record.type !== 'merge') return null;
  const pack = typeof record.pack === 'string' && record.pack.length <= 4096
    ? safePlayPack(projectRoot, record.pack)
    : null;
  const time = typeof record.time === 'string'
    && record.time.length > 0
    && record.time.length <= 80
    && !/[\r\n\0]/u.test(record.time)
    ? record.time
    : null;
  return { type: record.type, pack, time };
}

function resultBase(deps: CodeDeliveryDependencies, dirtyBefore: string[]): CodeDeliveryResult {
  return {
    projectPath: deps.projectRoot,
    savedFiles: [],
    dirtyBefore,
    dirtyAfter: dirtyBefore,
    commandAvailable: false,
    buildStartedAt: null,
    artifactChanges: [],
    officialOutputEvidence: [],
    playBuildEvidence: null,
    status: 'EVIDENCE_INSUFFICIENT',
    nextAction: '检查 VS Code 与官方元梦开发助手的本机联动。',
    evidenceLevel: 'STATIC_LOCAL'
  };
}

function changes(
  beforeItems: readonly CodeDeliveryArtifact[],
  afterItems: readonly CodeDeliveryArtifact[],
): CodeDeliveryResult['artifactChanges'] {
  const before = new Map(beforeItems.map((item) => [item.relativePath, item]));
  const after = new Map(afterItems.map((item) => [item.relativePath, item]));
  return [...new Set([...before.keys(), ...after.keys()])].sort().flatMap((relativePath) => {
    const left = before.get(relativePath) ?? null;
    const right = after.get(relativePath) ?? null;
    return JSON.stringify(left) === JSON.stringify(right) ? [] : [{ relativePath, before: left, after: right }];
  });
}

function officialEvidence(value: unknown): string[] {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  const matches = text.match(/[^\r\n]{0,80}(?:工程代码已经发送|代码已经发送|发送成功)[^\r\n]{0,80}/gu) ?? [];
  return matches.slice(0, 10).map((item) => item.trim());
}

export async function runCodeDelivery(deps: CodeDeliveryDependencies): Promise<CodeDeliveryResult> {
  const rootMatches = deps.workspaceRoots.filter((root) => canonical(root) === canonical(deps.projectRoot));
  const initialDirty = [...deps.listDirtyLua()].map((path) => safeRelative(deps.projectRoot, path)).sort();
  const output = resultBase(deps, initialDirty);
  if (rootMatches.length !== 1) {
    output.status = 'PROJECT_AMBIGUOUS';
    output.nextAction = '在只包含目标工程一次的 VS Code 工作区中重试。';
    return output;
  }

  const saveReportedSuccess = await deps.saveAll();
  output.dirtyAfter = [...deps.listDirtyLua()].map((path) => safeRelative(deps.projectRoot, path)).sort();
  output.savedFiles = initialDirty.filter((path) => !output.dirtyAfter.includes(path));
  if (!saveReportedSuccess || output.dirtyAfter.length > 0) {
    output.status = 'SAVE_FAILED';
    output.nextAction = '处理无法保存的当前工程 Lua 文档后重试。';
    return output;
  }

  const checked = await deps.runStaticChecks();
  if (!checked.ok || checked.freshness !== 'fresh') {
    output.status = 'CHECK_FAILED';
    output.nextAction = `修复静态检查错误后重试：${checked.summary}`;
    return output;
  }

  const audited = await deps.runProjectAudit();
  if (!audited.ok) {
    output.status = 'CHECK_FAILED';
    output.nextAction = `修复项目静态审计错误后重试：${audited.summary}`;
    return output;
  }

  output.commandAvailable = await deps.isOfficialCommandAvailable();
  if (!output.commandAvailable) {
    output.status = 'COMMAND_UNAVAILABLE';
    output.nextAction = '安装或启用官方元梦开发助手并重新载入 VS Code。';
    return output;
  }

  const before = await deps.snapshotArtifacts();
  output.buildStartedAt = deps.now().toISOString();
  const commandResult = await deps.executeOfficialBuild();
  output.officialOutputEvidence = officialEvidence(commandResult);
  const observation = deps.observation ?? {
    timeoutMilliseconds: 70_000,
    sampleMilliseconds: 200,
    stableSampleCount: 3
  };
  const maximumSamples = Math.max(1, Math.ceil(observation.timeoutMilliseconds / observation.sampleMilliseconds));
  let stableSnapshot: CodeDeliveryArtifact[] | null = null;
  let previousSignature: string | null = null;
  let stableSamples = 0;
  for (let sample = 0; sample < maximumSamples; sample += 1) {
    await deps.wait(observation.sampleMilliseconds);
    const current = await deps.snapshotArtifacts();
    const currentChanges = changes(before, current);
    const hasGeneratedUpdate = currentChanges.some((item) => item.after !== null);
    if (!hasGeneratedUpdate) {
      previousSignature = null;
      stableSamples = 0;
      continue;
    }
    const signature = JSON.stringify([...current].sort((left, right) => left.relativePath.localeCompare(right.relativePath)));
    stableSamples = signature === previousSignature ? stableSamples + 1 : 1;
    previousSignature = signature;
    if (stableSamples >= observation.stableSampleCount) {
      stableSnapshot = current;
      break;
    }
  }
  output.artifactChanges = stableSnapshot === null ? [] : changes(before, stableSnapshot);
  let playEvidence: PlayBuildEvidence | null = null;
  try {
    playEvidence = await deps.readPlayBuildEvidence?.() ?? null;
  } catch {
    // play.json is optional supporting evidence and must never block an already
    // observed official artifact when the official process still holds the file.
    playEvidence = null;
  }
  output.playBuildEvidence = playEvidence === null ? null : {
    ...playEvidence,
    matchesChangedArtifact: playEvidence.pack !== null && output.artifactChanges.some((item) => (
      item.after !== null && item.after.relativePath === playEvidence.pack
    ))
  };
  if (output.officialOutputEvidence.length > 0) {
    output.status = 'SENT';
    output.evidenceLevel = 'EXTENSION_HOST';
    output.nextAction = '如需证明游戏内行为，继续进行官方编辑器单人或多人实测。';
  } else if (stableSnapshot !== null && output.artifactChanges.length > 0) {
    output.status = 'BUILT';
    output.evidenceLevel = 'EXTENSION_HOST';
    output.nextAction = '已观察到工程代码产物变化；这不证明地图发布或游戏内运行成功。';
  } else {
    output.status = 'EVIDENCE_INSUFFICIENT';
    output.evidenceLevel = 'EXTENSION_HOST';
    output.nextAction = '官方命令已返回，但没有新产物或明确发送证据；检查官方输出后重试。';
  }
  return output;
}
