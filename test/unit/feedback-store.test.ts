import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { nodeFileIO } from '../../src/core/fs.js';
import {
  addFeedback,
  listFeedback,
  resolveFeedback,
} from '../../src/core/feedback/store.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('local AI feedback inbox', () => {
  it('adds, filters, summarizes and resolves structured project-local feedback', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ymai-feedback-'));
    roots.push(root);
    const context = {
      projectInstanceId: '33333333-3333-4333-8333-333333333333',
      extensionVersion: '0.4.0-private.10',
      uiSnapshotId: 'a'.repeat(64),
      sceneSnapshotId: 'b'.repeat(64),
    };
    const first = await addFeedback(root, {
      kind: 'bug', title: '场景刷新提示不准确', message: '保存后快照已更新，但提示仍显示未接入。',
      source: 'ai', context, createdAt: '2026-08-22T03:00:00.000Z',
    }, nodeFileIO);
    await addFeedback(root, {
      kind: 'improvement', title: '类型清单增加搜索', message: '希望按类型 ID 查代表实例。',
      source: 'user', context, createdAt: '2026-08-22T03:01:00.000Z',
    }, nodeFileIO);

    const open = await listFeedback(root, { status: 'open', kind: null }, nodeFileIO);
    expect(open.summary).toEqual({ total: 2, open: 2, resolved: 0, byKind: { bug: 1, friction: 0, improvement: 1 } });
    expect(open.entries.map((entry) => entry.title)).toEqual(['类型清单增加搜索', '场景刷新提示不准确']);

    const resolved = await resolveFeedback(root, first.feedbackId, {
      resolution: '刷新状态时间与绑定文案已拆分。', resolvedAt: '2026-08-22T03:05:00.000Z',
    }, nodeFileIO);
    expect(resolved).toMatchObject({ status: 'resolved', resolution: '刷新状态时间与绑定文案已拆分。' });
    expect((await listFeedback(root, { status: 'resolved', kind: 'bug' }, nodeFileIO)).entries).toHaveLength(1);
  });

  it('rejects oversized or control-character feedback instead of writing arbitrary content', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ymai-feedback-invalid-'));
    roots.push(root);
    await expect(addFeedback(root, {
      kind: 'bug', title: 'bad\nname', message: 'x', source: 'ai',
      context: {
        projectInstanceId: '33333333-3333-4333-8333-333333333333', extensionVersion: null,
        uiSnapshotId: null, sceneSnapshotId: null,
      }, createdAt: '2026-08-22T03:00:00.000Z',
    }, nodeFileIO)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});
