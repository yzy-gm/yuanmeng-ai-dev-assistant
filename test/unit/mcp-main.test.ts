import { describe, expect, it } from 'vitest';

import { resolveMcpToolProfile } from '../../src/mcp/main.js';

describe('MCP process profile selection', () => {
  it('defaults to full and accepts only declared profiles', () => {
    expect(resolveMcpToolProfile({})).toBe('full');
    expect(resolveMcpToolProfile({ YMAI_MCP_PROFILE: 'scene' })).toBe('scene');
    expect(resolveMcpToolProfile({ YMAI_MCP_PROFILE: 'workflow' })).toBe('workflow');
  });

  it('rejects an unknown profile instead of silently exposing an unexpected catalog', () => {
    expect(() => resolveMcpToolProfile({ YMAI_MCP_PROFILE: 'everything' })).toThrow('MCP_TOOL_PROFILE_INVALID');
  });

  it('lets a validated launcher argument take precedence over inherited environment', () => {
    expect(resolveMcpToolProfile({ YMAI_MCP_PROFILE: 'full' }, 'workflow')).toBe('workflow');
    expect(() => resolveMcpToolProfile({ YMAI_MCP_PROFILE: 'full' }, 'everything')).toThrow('MCP_TOOL_PROFILE_INVALID');
  });
});
