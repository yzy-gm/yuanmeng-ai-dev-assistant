import * as vscode from 'vscode';

import {
  buildMcpServerDefinitions,
  type McpProjectSummary
} from './mcp-definitions.js';

export { buildMcpServerDefinitions } from './mcp-definitions.js';
export type { LocalMcpServerDefinition, McpProjectSummary } from './mcp-definitions.js';

export const MCP_PROVIDER_ID = 'yuanmengAi.localProjects' as const;

export function registerMcpProvider(
  context: vscode.ExtensionContext,
  listProjects: () => readonly McpProjectSummary[],
): { fireChanged(): void } {
  const emitter = new vscode.EventEmitter<void>();
  const provider: vscode.McpServerDefinitionProvider<vscode.McpStdioServerDefinition> = {
    onDidChangeMcpServerDefinitions: emitter.event,
    provideMcpServerDefinitions: () => buildMcpServerDefinitions(listProjects()).map((definition) => {
      const server = new vscode.McpStdioServerDefinition(
        definition.label,
        definition.command,
        [...definition.args],
        { ...(definition.environment ?? {}) },
        definition.id,
      );
      server.cwd = vscode.Uri.file(definition.cwd);
      return server;
    }),
    resolveMcpServerDefinition: (definition) => definition
  };
  context.subscriptions.push(emitter, vscode.lm.registerMcpServerDefinitionProvider(MCP_PROVIDER_ID, provider));
  return { fireChanged: () => emitter.fire() };
}
