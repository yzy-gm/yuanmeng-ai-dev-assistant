import { describe, expect, it, vi } from 'vitest';

import {
  codexMcpCommand,
  inspectCodexRegistration,
  runCodexMcpCommand,
  type CodexMcpListEntry
} from '../../src/extension/codex-mcp-registration.js';

const desired = {
  name: 'yuanmeng-ai-abc123',
  launcherPath: 'Z:\\fixture project\\bin\\ymai-mcp.cmd',
  projectInstanceId: 'abc123'
};

describe('Codex MCP registration safety', () => {
  it('previews missing, same-project, and conflicting registrations without mutation', () => {
    expect(inspectCodexRegistration([], desired).state).toBe('missing');
    expect(inspectCodexRegistration([{ name: desired.name, command: desired.launcherPath }], desired).state).toBe('current');
    expect(inspectCodexRegistration([{ name: desired.name, command: 'C:\\other\\ymai-mcp.cmd' }], desired))
      .toMatchObject({ state: 'conflict', canApply: false });
  });

  it('builds argv arrays for formal add/list/remove commands and never edits config.toml', () => {
    expect(codexMcpCommand('list', desired)).toEqual(['mcp', 'list', '--json']);
    expect(codexMcpCommand('add', desired)).toEqual(['mcp', 'add', desired.name, '--', desired.launcherPath]);
    expect(codexMcpCommand('remove', desired)).toEqual(['mcp', 'remove', desired.name]);
    expect(JSON.stringify(codexMcpCommand('add', desired))).not.toContain('config.toml');
  });

  it('does not mistake a similarly named entry for the current project', () => {
    const entries: CodexMcpListEntry[] = [{ name: `${desired.name}-other`, command: desired.launcherPath }];
    expect(inspectCodexRegistration(entries, desired).state).toBe('missing');
  });

  it('falls back to the official Codex Desktop user CLI only when the PATH entry is unavailable', async () => {
    const calls: string[] = [];
    const execute = vi.fn(async (executable: string) => {
      calls.push(executable);
      if (executable === 'codex') throw Object.assign(new Error('access denied'), { code: 'EACCES' });
      return { stdout: '[]', stderr: '' };
    });

    await expect(runCodexMcpCommand('list', desired, 'codex', {
      execute,
      discoverOfficialExecutables: async () => ['C:\\Users\\fixture\\AppData\\Local\\OpenAI\\Codex\\bin\\hash\\codex.exe']
    })).resolves.toEqual({ stdout: '[]', stderr: '' });
    expect(calls).toEqual([
      'codex',
      'C:\\Users\\fixture\\AppData\\Local\\OpenAI\\Codex\\bin\\hash\\codex.exe'
    ]);
  });

  it('does not hide a real Codex CLI command failure by trying another executable', async () => {
    const execute = vi.fn(async () => {
      throw Object.assign(new Error('registration conflict'), { code: 1 });
    });

    await expect(runCodexMcpCommand('add', desired, 'codex', {
      execute,
      discoverOfficialExecutables: async () => ['C:\\fallback\\codex.exe']
    })).rejects.toThrow('registration conflict');
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
