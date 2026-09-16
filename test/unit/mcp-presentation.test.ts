import { describe, expect, it } from 'vitest';

import { toCallToolResult } from '../../src/mcp/presentation.js';
import type { YuanmengMcpEnvelope } from '../../src/mcp/contracts.js';

function envelope(): YuanmengMcpEnvelope<unknown> {
  return {
    schemaVersion: 1,
    requestId: 'request-1',
    tool: 'yuanmeng_scene_status',
    ok: false,
    code: 'STALE',
    summary: '场景数据陈旧：C:\\private\\ugc\\LayerData.pbin',
    project: { projectInstanceId: 'project-1', displayName: '当前地图' },
    evidence: { level: 'STATIC_LOCAL', freshness: 'stale', snapshotId: 'snapshot-1' },
    data: { complete: true, nested: { value: 7 } },
    warnings: ['请先保存编辑器内容'],
    nextActions: [{ kind: 'call-tool', label: '刷新场景', tool: 'yuanmeng_scene_refresh' }]
  };
}

describe('MCP presentation', () => {
  it('keeps the complete envelope in structuredContent and emits one short text block', () => {
    const value = envelope();
    const result = toCallToolResult(value);

    expect(result.structuredContent).toEqual(value);
    expect(result.content).toHaveLength(1);
    expect(result.content[0]).toMatchObject({ type: 'text' });
    const text = result.content[0]?.type === 'text' ? result.content[0].text : '';
    expect(text).toContain('场景数据陈旧');
    expect(text).toContain('警告：请先保存编辑器内容');
    expect(text).toContain('下一步：刷新场景');
    expect(text).not.toContain('LayerData.pbin');
    expect(text).not.toContain(JSON.stringify(value.data));
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThan(2048);
  });

  it('bounds oversized structured content and marks what was compacted', () => {
    const value = envelope();
    value.data = {
      records: Array.from({ length: 200 }, (_, index) => ({
        id: String(index),
        description: '超长内容'.repeat(2_000),
      })),
    };
    const result = toCallToolResult(value);
    const structured = JSON.stringify(result.structuredContent);
    expect(Buffer.byteLength(structured, 'utf8')).toBeLessThanOrEqual(64 * 1024);
    expect(structured).toContain('内容已压缩');
    expect(result.structuredContent).not.toEqual(value);
  });
});
