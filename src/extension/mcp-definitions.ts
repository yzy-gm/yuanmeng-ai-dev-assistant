import { basename, join } from 'node:path';

import type { YuanmengMcpToolProfile } from '../mcp/contracts.js';
import { sourcePathEnvironment } from '../core/environment/source-paths.js';

export interface McpProjectSummary {
  root: string;
  projectInstanceId: string;
  mapDisplayName: string | null;
  mcpToolProfile?: YuanmengMcpToolProfile;
  officialExtensionPath?: string;
  eventsDocumentationPath?: string;
  resourceDocumentationPath?: string;
  gameInstallPath?: string;
  ugcDataPath?: string;
}

export interface LocalMcpServerDefinition {
  id: string;
  label: string;
  command: string;
  args: readonly string[];
  cwd: string;
  environment?: Readonly<Record<string, string>>;
}

export function buildMcpServerDefinitions(projects: readonly McpProjectSummary[]): LocalMcpServerDefinition[] {
  return [...projects]
    .sort((left, right) => left.root.localeCompare(right.root))
    .map((project) => ({
      id: `yuanmeng-ai-${project.projectInstanceId}`,
      label: `元梦 AI：${project.mapDisplayName ?? basename(project.root)}`,
      command: join(project.root, '.yuanmeng-inspector', 'bin', 'ymai-mcp.cmd'),
      args: [],
      cwd: project.root,
      ...(() => {
        const environment = sourcePathEnvironment(project, project.root);
        if (project.mcpToolProfile !== undefined && project.mcpToolProfile !== 'full') environment.YMAI_MCP_PROFILE = project.mcpToolProfile;
        return Object.keys(environment).length === 0 ? {} : { environment };
      })(),
    }));
}
