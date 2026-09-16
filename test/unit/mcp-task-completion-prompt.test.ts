import { describe, expect, it } from 'vitest';

import { MCP_PROMPT_NAMES, promptText } from '../../src/mcp/prompts.js';

describe('task completion gameplay self-check prompt', () => {
  it('routes large, complex, or multiplayer changes through gameplay checks without packaging', () => {
    expect(MCP_PROMPT_NAMES).toContain('yuanmeng_task_completion_check');

    const text = promptText('yuanmeng_task_completion_check', {
      focus: '多人客户端与服务端的库存同步',
    });

    expect(text).toContain('yuanmeng_project_audit');
    expect(text).toContain('yuanmeng_gameplay_test');
    expect(text).toContain('默认自动准备并尽可能模拟');
    expect(text).toContain('只有显式提供人工模型、场景目录和输出目录时才进入手工严格模式');
    expect(text).not.toContain('先调用 yuanmeng_gameplay_review');
    expect(text).toContain('大型、复杂或多人');
    expect(text).toContain('同一功能连续出错或返工 2 次及以上');
    expect(text).toContain('先读取日志、失败分支和运行证据');
    expect(text).toContain('小型 UI、文案、固定 ID、纯布局');
    expect(text).toContain('不调用 yuanmeng_build_and_send_code');
    expect(text).toContain('不得冒充官方编辑器或真实多人实测');
  });
});
