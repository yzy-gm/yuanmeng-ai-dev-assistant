import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  parseOfficialConnectionEvents,
  selectOfficialConnectionObservation,
} from '../../src/core/logs/official-connection.js';
import { readOfficialConnectionLogDocuments } from '../../src/core/logs/official-connection-files.js';
import { OfficialConnectionLogMonitor } from '../../src/extension/official-connection-monitor.js';

const now = new Date(2026, 7, 30, 3, 2, 0);

describe('official output connection evidence', () => {
  it('recognizes the official login line and associates a following code-send line with the project', () => {
    const events = parseOfficialConnectionEvents([{
      name: '1-dreamhelper.log',
      content: [
        '[2026-8-30 3:1:24] [127.0.0.1:64211] 连接成功',
        '[2026-8-30 3:1:26] d:\\sample_map_beta 工程代码已经发送',
      ].join('\n'),
    }]);

    const observation = selectOfficialConnectionObservation(events, {
      projectName: 'sample_map_beta',
      now,
    });

    expect(observation).toMatchObject({
      state: 'online',
      projectName: 'sample_map_beta',
      source: 'official-output-log',
    });
    expect(observation.observedAt).toBeTruthy();
    expect(JSON.stringify(observation)).not.toContain('64211');
    expect(JSON.stringify(observation)).not.toContain('d:\\sample_map_beta');
  });

  it('does not treat the official listening message as a connected session', () => {
    const events = parseOfficialConnectionEvents([{
      name: 'dreamhelper.log',
      content: '[2026-8-30 3:0:00] 开启联动环境成功，端口：2356\n',
    }]);

    expect(selectOfficialConnectionObservation(events, { projectName: 'sample_map_alpha', now })).toMatchObject({
      state: 'unknown',
      source: 'official-output-log',
    });
  });

  it('uses the latest official disconnect event after a successful login', () => {
    const events = parseOfficialConnectionEvents([{
      name: 'dreamhelper.log',
      content: [
        '[2026-8-30 3:1:24] [127.0.0.1:64211] 连接成功',
        '[2026-8-30 3:1:40] 没有联动设备连接',
      ].join('\n'),
    }]);

    expect(selectOfficialConnectionObservation(events, { projectName: 'sample_map_alpha', now })).toMatchObject({
      state: 'offline',
      source: 'official-output-log',
    });
  });

  it('expires an old success instead of claiming that the current window is connected', () => {
    const events = parseOfficialConnectionEvents([{
      name: 'dreamhelper.log',
      content: '[2026-8-30 2:40:00] [127.0.0.1:64211] 连接成功\n',
    }]);

    expect(selectOfficialConnectionObservation(events, {
      projectName: 'sample_map_alpha',
      now,
      maxAgeMilliseconds: 10 * 60 * 1000,
    })).toMatchObject({
      state: 'unknown',
      source: 'official-output-log',
    });
  });

  it('does not apply a project-specific event to a different project', () => {
    const events = parseOfficialConnectionEvents([{
      name: 'dreamhelper.log',
      content: [
        '[2026-8-30 3:1:24] [127.0.0.1:64211] 连接成功',
        '[2026-8-30 3:1:26] d:\\sample_map_beta 工程代码已经发送',
      ].join('\n'),
    }]);

    expect(selectOfficialConnectionObservation(events, {
      projectName: 'another-map',
      now,
    })).toMatchObject({
      state: 'unknown',
      projectName: null,
      source: 'official-output-log',
    });
  });

  it('reads only bounded Dream Helper files below the current extension-host log path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ymai-official-log-'));
    const extensionHost = join(root, 'window1', 'exthost');
    const outputDirectory = join(extensionHost, 'output_logging_20260830T030000');
    await mkdir(outputDirectory, { recursive: true });
    await writeFile(join(outputDirectory, '1-dreamhelper.log'), '[2026-8-30 3:1:24] [127.0.0.1:64211] 连接成功\n', 'utf8');
    await writeFile(join(outputDirectory, 'other-extension.log'), '[2026-8-30 3:1:24] 连接成功\n', 'utf8');
    try {
      const documents = await readOfficialConnectionLogDocuments(join(extensionHost, 'yuanmeng-extension'));
      expect(documents).toHaveLength(1);
      expect(selectOfficialConnectionObservation(parseOfficialConnectionEvents(documents), {
        projectName: 'sample_map_alpha',
        now,
      }).state).toBe('online');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('publishes the current-window observation to the matching project', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ymai-official-monitor-'));
    const extensionHost = join(root, 'window1', 'exthost');
    const outputDirectory = join(extensionHost, 'output_logging_20260830T030000');
    const projectRoot = join(root, 'sample_map_beta');
    await mkdir(outputDirectory, { recursive: true });
    await writeFile(join(outputDirectory, '1-dreamhelper.log'), [
      '[2026-8-30 3:1:24] [127.0.0.1:64211] 连接成功',
      '[2026-8-30 3:1:26] d:\\sample_map_beta 工程代码已经发送',
    ].join('\n'), 'utf8');
    const observations: Array<{ root: string; state: string; reason?: string }> = [];
    const monitor = new OfficialConnectionLogMonitor({
      logPath: join(extensionHost, 'bujianxingguang.yuanmeng-ai-dev-assistant'),
      enabled: false,
      listProjects: () => [{ root: projectRoot }],
      onObservation: (observedRoot, observation) => observations.push({
        root: observedRoot,
        state: observation.state,
      }),
      now: () => now,
    });
    try {
      monitor.setEnabled(true);
      const deadline = Date.now() + 2_000;
      while (Date.now() < deadline && !observations.some((item) => item.state === 'online')) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(observations).toContainEqual({ root: projectRoot, state: 'online' });
    } finally {
      monitor.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reuses unchanged official log tails through the optional signature cache', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ymai-official-cache-'));
    const outputDirectory = join(root, 'output_logging_20260830T030000');
    await mkdir(outputDirectory, { recursive: true });
    await writeFile(join(outputDirectory, 'dreamhelper.log'), '[2026-8-30 3:1:24] [127.0.0.1:64211] 连接成功\n', 'utf8');
    const cache = { signature: null, documents: [] } as Parameters<typeof readOfficialConnectionLogDocuments>[1];
    try {
      const first = await readOfficialConnectionLogDocuments(root, cache);
      const second = await readOfficialConnectionLogDocuments(root, cache);
      expect(second).toBe(first);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
