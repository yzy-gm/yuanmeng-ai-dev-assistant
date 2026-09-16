import { execFile } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import { join, normalize, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface DesiredCodexMcpRegistration {
  name: string;
  launcherPath: string;
  projectInstanceId: string;
}

export interface CodexMcpListEntry {
  name: string;
  command: string;
}

export interface CodexRegistrationPreview {
  state: 'missing' | 'current' | 'conflict';
  canApply: boolean;
  name: string;
  launcherPath: string;
  projectInstanceId: string;
}

interface CodexCommandResult {
  stdout: string;
  stderr: string;
}

export interface CodexCommandRunnerOptions {
  execute?: (executable: string, args: readonly string[]) => Promise<CodexCommandResult>;
  discoverOfficialExecutables?: () => Promise<string[]>;
}

export function desiredCodexRegistration(
  projectInstanceId: string,
  launcherPath: string,
): DesiredCodexMcpRegistration {
  return {
    name: `yuanmeng-ai-${projectInstanceId.replace(/-/gu, '').slice(0, 12).toLowerCase()}`,
    launcherPath,
    projectInstanceId
  };
}

export function parseCodexMcpList(stdout: string): CodexMcpListEntry[] {
  const value: unknown = JSON.parse(stdout);
  const entries = Array.isArray(value)
    ? value
    : typeof value === 'object' && value !== null && Array.isArray((value as { servers?: unknown }).servers)
      ? (value as { servers: unknown[] }).servers
      : [];
  return entries.flatMap((entry): CodexMcpListEntry[] => {
    if (typeof entry !== 'object' || entry === null) return [];
    const record = entry as Record<string, unknown>;
    const transport = typeof record.transport === 'object' && record.transport !== null
      ? record.transport as Record<string, unknown>
      : null;
    const command = typeof record.command === 'string'
      ? record.command
      : typeof transport?.command === 'string' ? transport.command : null;
    return typeof record.name === 'string' && command !== null ? [{ name: record.name, command }] : [];
  });
}

function canonical(path: string): string {
  return normalize(resolve(path)).toLowerCase();
}

export function inspectCodexRegistration(
  entries: readonly CodexMcpListEntry[],
  desired: DesiredCodexMcpRegistration,
): CodexRegistrationPreview {
  const existing = entries.find((entry) => entry.name === desired.name);
  const state = existing === undefined
    ? 'missing'
    : canonical(existing.command) === canonical(desired.launcherPath) ? 'current' : 'conflict';
  return {
    state,
    canApply: state !== 'conflict',
    name: desired.name,
    launcherPath: desired.launcherPath,
    projectInstanceId: desired.projectInstanceId
  };
}

export function codexMcpCommand(
  action: 'list' | 'add' | 'remove',
  desired: DesiredCodexMcpRegistration,
): string[] {
  if (action === 'list') return ['mcp', 'list', '--json'];
  if (action === 'remove') return ['mcp', 'remove', desired.name];
  return ['mcp', 'add', desired.name, '--', desired.launcherPath];
}

export async function discoverOfficialCodexExecutables(
  localAppData = process.env.LOCALAPPDATA,
): Promise<string[]> {
  if (localAppData === undefined || localAppData.length === 0) return [];
  const binRoot = join(localAppData, 'OpenAI', 'Codex', 'bin');
  let entries;
  try {
    entries = await readdir(binRoot, { withFileTypes: true });
  } catch (error) {
    if (isUnavailableExecutable(error)) return [];
    throw error;
  }
  const candidates = await Promise.all(entries
    .filter((entry) => entry.isDirectory())
    .map(async (entry) => {
      const executable = join(binRoot, entry.name, 'codex.exe');
      try {
        return { executable, modifiedAt: (await stat(executable)).mtimeMs };
      } catch (error) {
        if (isUnavailableExecutable(error)) return null;
        throw error;
      }
    }));
  return candidates
    .filter((candidate): candidate is { executable: string; modifiedAt: number } => candidate !== null)
    .sort((left, right) => right.modifiedAt - left.modifiedAt)
    .map((candidate) => candidate.executable);
}

function isUnavailableExecutable(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  const code = (error as { code?: unknown }).code;
  return code === 'ENOENT' || code === 'EACCES' || code === 'EPERM';
}

async function executeCodex(executable: string, args: readonly string[]): Promise<CodexCommandResult> {
  const result = await execFileAsync(executable, [...args], {
    encoding: 'utf8',
    windowsHide: true
  });
  return { stdout: String(result.stdout), stderr: String(result.stderr) };
}

export async function runCodexMcpCommand(
  action: 'list' | 'add' | 'remove',
  desired: DesiredCodexMcpRegistration,
  executable = 'codex',
  options: CodexCommandRunnerOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  const execute = options.execute ?? executeCodex;
  const candidates = [executable];
  if (executable === 'codex') {
    candidates.push(...await (options.discoverOfficialExecutables ?? discoverOfficialCodexExecutables)());
  }
  const uniqueCandidates = [...new Set(candidates.map((candidate) => normalize(candidate)))];
  for (const [index, candidate] of uniqueCandidates.entries()) {
    try {
      return await execute(candidate, codexMcpCommand(action, desired));
    } catch (error) {
      if (!isUnavailableExecutable(error) || index === uniqueCandidates.length - 1) throw error;
    }
  }
  throw new Error('CODEX_CLI_UNAVAILABLE');
}
