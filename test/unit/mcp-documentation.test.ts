import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { MCP_TOOL_NAMES } from '../../src/mcp/contracts.js';
import { MCP_PROMPT_NAMES } from '../../src/mcp/prompts.js';
import { MCP_RESOURCE_URIS } from '../../src/mcp/resources.js';

describe('MCP documentation coverage', () => {
  it('documents every tool, resource, prompt, and client channel', async () => {
    const [manual, readme] = await Promise.all([
      readFile(new URL('../../docs/mcp.md', import.meta.url), 'utf8'),
      readFile(new URL('../../README.md', import.meta.url), 'utf8')
    ]);
    for (const name of [...MCP_TOOL_NAMES, ...MCP_RESOURCE_URIS, ...MCP_PROMPT_NAMES]) {
      expect(manual, `missing documentation for ${name}`).toContain(name);
    }
    for (const channel of ['VS Code Agent', 'Codex Desktop/CLI', '其他 stdio MCP host', '公共 MCP Gallery']) {
      expect(readme).toContain(channel);
    }
    expect(readme).toContain('不会出现在 Gallery');
    expect(readme).toContain('code_YYYY-MM-DD-HH-MM-SS.zip');
  });
});
