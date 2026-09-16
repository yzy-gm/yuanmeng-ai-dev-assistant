import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { InspectorStatus, UiSnapshot } from '../model.js';
import {
  validateCliLauncherManifest,
  validateMcpLauncherManifest,
  type CliLauncherManifest,
  type McpLauncherManifest
} from '../launcher/manifest.js';

export type EnvironmentComponentState = 'current' | 'missing' | 'stale' | 'invalid' | 'mismatch';

export interface EnvironmentHealthReport {
  overall: 'healthy' | 'degraded' | 'blocked';
  launchers: {
    cli: { state: EnvironmentComponentState; extensionVersion: string | null; generatedAt: string | null };
    mcp: { state: EnvironmentComponentState; extensionVersion: string | null; generatedAt: string | null };
  };
  bridge: { state: 'online' | 'missing' | 'stale' | 'invalid' | 'mismatch'; leaseAgeMilliseconds: number | null };
  official: { refreshUiAvailable: boolean; buildAvailable: boolean; extensionVersion: string | null };
  issues: Array<{ code: string; severity: 'warning' | 'error'; message: string; nextAction: string }>;
}

interface EnvironmentHealthInput {
  root: string;
  projectInstanceId: string;
  projectRootHash: string;
  status: InspectorStatus | null;
  snapshot: UiSnapshot | null;
  nowMilliseconds?: number;
  bridgeLeaseMaxAgeMilliseconds?: number;
}

async function readOptionalJson(path: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return Symbol.for('invalid-json');
  }
}

async function launcherState(
  path: string,
  kind: 'cli' | 'mcp',
  projectInstanceId: string,
  projectRootHash: string
): Promise<{ state: EnvironmentComponentState; extensionVersion: string | null; generatedAt: string | null }> {
  const value = await readOptionalJson(path);
  if (value === null) return { state: 'missing', extensionVersion: null, generatedAt: null };
  try {
    if (kind === 'cli') validateCliLauncherManifest(value);
    else validateMcpLauncherManifest(value);
  } catch {
    return { state: 'invalid', extensionVersion: null, generatedAt: null };
  }
  const manifest = value as CliLauncherManifest | McpLauncherManifest;
  return {
    state: manifest.projectInstanceId === projectInstanceId && manifest.projectRootHash === projectRootHash
      ? 'current'
      : 'mismatch',
    extensionVersion: manifest.extensionVersion,
    generatedAt: manifest.generatedAt
  };
}

function officialVersion(snapshot: UiSnapshot | null): string | null {
  if (snapshot === null) return null;
  const versions = [...new Set(snapshot.sources
    .map((source) => source.officialExtensionVersion)
    .filter((value): value is string => value !== null))];
  return versions.length === 1 ? versions[0]! : null;
}

export async function diagnoseProjectEnvironment(input: EnvironmentHealthInput): Promise<EnvironmentHealthReport> {
  const binRoot = join(input.root, '.yuanmeng-inspector', 'bin');
  const [cli, mcp, leaseValue] = await Promise.all([
    launcherState(join(binRoot, 'cli-launcher.json'), 'cli', input.projectInstanceId, input.projectRootHash),
    launcherState(join(binRoot, 'mcp-launcher.json'), 'mcp', input.projectInstanceId, input.projectRootHash),
    readOptionalJson(join(input.root, '.yuanmeng-inspector', 'mcp-bridge', 'host.json'))
  ]);
  const now = input.nowMilliseconds ?? Date.now();
  const maximumLeaseAge = input.bridgeLeaseMaxAgeMilliseconds ?? 10_000;
  let bridge: EnvironmentHealthReport['bridge'];
  if (leaseValue === null) {
    bridge = { state: 'missing', leaseAgeMilliseconds: null };
  } else if (typeof leaseValue !== 'object' || Array.isArray(leaseValue)) {
    bridge = { state: 'invalid', leaseAgeMilliseconds: null };
  } else {
    const lease = leaseValue as Record<string, unknown>;
    if (
      lease.schemaVersion !== 1
      || typeof lease.projectInstanceId !== 'string'
      || typeof lease.projectRootHash !== 'string'
      || typeof lease.updatedAt !== 'string'
    ) {
      bridge = { state: 'invalid', leaseAgeMilliseconds: null };
    } else if (lease.projectInstanceId !== input.projectInstanceId || lease.projectRootHash !== input.projectRootHash) {
      bridge = { state: 'mismatch', leaseAgeMilliseconds: null };
    } else {
      const age = now - Date.parse(lease.updatedAt);
      bridge = !Number.isFinite(age) || age < 0
        ? { state: 'invalid', leaseAgeMilliseconds: null }
        : { state: age <= maximumLeaseAge ? 'online' : 'stale', leaseAgeMilliseconds: Math.round(age) };
    }
  }

  const official = {
    refreshUiAvailable: input.status?.officialCommands.refreshUi === true,
    buildAvailable: input.status?.officialCommands.build === true,
    extensionVersion: officialVersion(input.snapshot)
  };
  const issues: EnvironmentHealthReport['issues'] = [];
  for (const [name, value] of [['CLI', cli], ['MCP', mcp]] as const) {
    if (value.state === 'current') continue;
    issues.push({
      code: `${name}_LAUNCHER_${value.state.toUpperCase()}`,
      severity: value.state === 'mismatch' || value.state === 'invalid' ? 'error' : 'warning',
      message: `${name} 启动器${value.state === 'missing' ? '尚未生成' : value.state === 'mismatch' ? '属于其他工程或旧身份' : '清单无效'}。`,
      nextAction: '在当前工程的 VS Code 窗口激活元梦 AI 开发助手；扩展只刷新当前工程启动器。'
    });
  }
  if (bridge.state !== 'online') {
    issues.push({
      code: `DELIVERY_BRIDGE_${bridge.state.toUpperCase()}`,
      severity: bridge.state === 'mismatch' || bridge.state === 'invalid' ? 'error' : 'warning',
      message: `代码交付桥当前为 ${bridge.state}。`,
      nextAction: '确认当前工程仍在已激活私有插件的 VS Code 窗口中打开。'
    });
  }
  if (!official.refreshUiAvailable || !official.buildAvailable) {
    issues.push({
      code: 'OFFICIAL_COMMANDS_INCOMPLETE',
      severity: 'warning',
      message: '官方元梦扩展的 UI 刷新或代码打包命令未全部出现。',
      nextAction: '确认官方元梦开发助手已启用；插件不会自动卸载、更新或重载扩展。'
    });
  }
  const blocked = issues.some((issue) => issue.severity === 'error');
  return {
    overall: blocked ? 'blocked' : issues.length === 0 ? 'healthy' : 'degraded',
    launchers: { cli, mcp },
    bridge,
    official,
    issues
  };
}
