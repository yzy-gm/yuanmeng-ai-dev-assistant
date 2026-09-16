import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildMcpServerDefinitions } from '../../src/extension/mcp-definitions.js';

describe('VS Code MCP server definitions', () => {
  it('creates one isolated validated stdio definition per current project', () => {
    const definitions = buildMcpServerDefinitions([
      { root: 'C:\\maps\\alpha', projectInstanceId: 'a', mapDisplayName: '冷库' },
      { root: 'C:\\maps\\beta', projectInstanceId: 'b', mapDisplayName: null }
    ]);

    expect(definitions).toEqual([
      {
        id: 'yuanmeng-ai-a',
        label: '元梦 AI：冷库',
        command: join('C:\\maps\\alpha', '.yuanmeng-inspector', 'bin', 'ymai-mcp.cmd'),
        args: [],
        cwd: 'C:\\maps\\alpha'
      },
      {
        id: 'yuanmeng-ai-b',
        label: '元梦 AI：beta',
        command: join('C:\\maps\\beta', '.yuanmeng-inspector', 'bin', 'ymai-mcp.cmd'),
        args: [],
        cwd: 'C:\\maps\\beta'
      }
    ]);
    expect(definitions.every((item) => !item.command.includes('.vscode'))).toBe(true);
  });

  it('passes an opt-in compact tool profile to the project-local MCP process', () => {
    const [definition] = buildMcpServerDefinitions([{
      root: 'C:\\maps\\workflow',
      projectInstanceId: 'workflow',
      mapDisplayName: null,
      mcpToolProfile: 'workflow',
    }]);

    expect(definition).toMatchObject({
      environment: { YMAI_MCP_PROFILE: 'workflow' },
    });
  });

  it('passes configured read-only official source roots without changing the project command', () => {
    const [definition] = buildMcpServerDefinitions([{
      root: 'C:\\maps\\official',
      projectInstanceId: 'official',
      mapDisplayName: null,
      officialExtensionPath: 'C:\\extensions\\dreamhelper',
      gameInstallPath: 'E:\\WeGameApps\\Yuanmeng',
      ugcDataPath: 'C:\\ugc-cache',
    }]);

    expect(definition).toMatchObject({
      command: join('C:\\maps\\official', '.yuanmeng-inspector', 'bin', 'ymai-mcp.cmd'),
      environment: {
        YMAI_OFFICIAL_EXTENSION_PATH: 'C:\\extensions\\dreamhelper',
        YMAI_GAME_INSTALL_PATH: 'E:\\WeGameApps\\Yuanmeng',
        YMAI_UGC_DATA_PATH: 'C:\\ugc-cache',
      },
    });
  });
});
