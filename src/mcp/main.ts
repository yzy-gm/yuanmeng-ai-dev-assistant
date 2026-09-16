import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';

import { resolveCliProject } from '../cli/project.js';
import { readProjectDisplayProfile } from '../core/project/display-profile.js';
import { nodeFileIO } from '../core/fs.js';
import { McpGateway } from './gateway.js';
import { createYuanmengMcpServer } from './server.js';
import { MCP_TOOL_PROFILE_NAMES, type YuanmengMcpToolProfile } from './contracts.js';

interface StartArguments {
  readonly project: string | null;
  readonly launcherManifest: string | null;
  readonly profile: string | null;
}

export function resolveMcpToolProfile(
  environment: NodeJS.ProcessEnv = process.env,
  explicitProfile?: string | null,
): YuanmengMcpToolProfile {
  const value = explicitProfile?.trim() || environment.YMAI_MCP_PROFILE?.trim() || 'full';
  if ((MCP_TOOL_PROFILE_NAMES as readonly string[]).includes(value)) return value as YuanmengMcpToolProfile;
  throw new Error('MCP_TOOL_PROFILE_INVALID');
}

function parseStartArguments(argv: readonly string[]): StartArguments {
  let project: string | null = null;
  let launcherManifest: string | null = null;
  let profile: string | null = null;
  for (let index = 0; index < argv.length; index += 2) {
    const option = argv[index];
    const value = argv[index + 1];
    if (value === undefined || (option !== '--project' && option !== '--launcher-manifest' && option !== '--profile')) {
      throw new Error('MCP_START_ARGUMENTS_INVALID');
    }
    if (option === '--project' && project === null) project = value;
    else if (option === '--launcher-manifest' && launcherManifest === null) launcherManifest = value;
    else if (option === '--profile' && profile === null) profile = value;
    else throw new Error('MCP_START_ARGUMENTS_INVALID');
  }
  if (project === null && launcherManifest === null) throw new Error('MCP_PROJECT_REQUIRED');
  return { project, launcherManifest, profile };
}

async function packageVersion(extensionRoot: string): Promise<string> {
  const value = JSON.parse(await readFile(join(extensionRoot, 'package.json'), 'utf8')) as Record<string, unknown>;
  if (typeof value.version !== 'string') throw new Error('MCP_EXTENSION_VERSION_INVALID');
  return value.version;
}

export async function startMcpServer(argv: readonly string[]): Promise<{
  close(): Promise<void>;
}> {
  const args = parseStartArguments(argv);
  const currentMcpPath = resolve(process.argv[1] ?? '');
  const extensionRoot = dirname(dirname(currentMcpPath));
  const currentCliPath = join(dirname(currentMcpPath), 'cli.cjs');
  const project = await resolveCliProject({
    project: args.project,
    launcherManifest: args.launcherManifest,
    cwd: process.cwd(),
    currentCliPath: currentMcpPath,
    launcherKind: 'mcp'
  });
  const displayProfile = await readProjectDisplayProfile(
    project.root,
    project.projectInstanceId,
    nodeFileIO
  );
  const toolProfile = resolveMcpToolProfile(process.env, args.profile);
  const gateway = new McpGateway({
    projectRoot: project.root,
    projectInstanceId: project.projectInstanceId,
    displayName: displayProfile?.mapDisplayName ?? null,
    currentCliPath,
    projectRootHash: project.projectRootHash,
    toolProfile,
  });
  const server = createYuanmengMcpServer({
    gateway,
    version: await packageVersion(extensionRoot),
    toolProfile,
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return {
    async close() {
      await server.close();
    }
  };
}

async function main(): Promise<void> {
  let running: { close(): Promise<void> } | null = null;
  try {
    running = await startMcpServer(process.argv.slice(2));
    const shutdown = () => {
      const current = running;
      running = null;
      if (current !== null) {
        void current.close().catch(() => undefined);
      }
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  } catch (error) {
    const reasonCode = error instanceof Error && /^[A-Z0-9_]+$/u.test(error.message)
      ? error.message
      : 'MCP_START_FAILED';
    process.stderr.write(`元梦 MCP 启动失败。reasonCode=${reasonCode}\n`);
    process.exitCode = 1;
  }
}

if (typeof require !== 'undefined' && require.main === module) {
  void main();
}
