import { describe, expect, it } from 'vitest';

import { formatCompanionStatus, formatCompanionStatusSegments } from '../../src/core/status/display.js';

describe('status bar display', () => {
  it('prefers the user map name and shows an unconnected link until it is confirmed', () => {
    expect(formatCompanionStatus({
      projectName: 'sample_map_alpha',
      mapDisplayName: '示例地图',
      officialMapName: null,
      linkState: 'unknown',
      lastRefreshAt: null,
      problemCount: 0,
    })).toBe('sample_map_alpha | 地图:示例地图 | 连接:未连接 | 刷新:从未 | 问题:0');
  });

  it('shows a connected label only for confirmed online evidence', () => {
    expect(formatCompanionStatus({
      projectName: 'sample_map_alpha',
      mapDisplayName: null,
      officialMapName: null,
      linkState: 'online',
      lastRefreshAt: '2026-08-22T00:00:00.000Z',
      problemCount: 2,
    })).toBe('sample_map_alpha | 地图:未设置 | 连接:已连接 | 刷新:2026-08-22T00:00:00.000Z | 问题:2');
  });

  it('marks only the map segment as renameable', () => {
    const segments = formatCompanionStatusSegments({
      projectName: 'sample_map_alpha',
      mapDisplayName: '示例地图',
      officialMapName: null,
      linkState: 'offline',
      lastRefreshAt: null,
      problemCount: 0,
    });
    expect(segments.map((segment) => segment.key)).toEqual(['project', 'map', 'link', 'refresh', 'problems']);
    expect(segments.find((segment) => segment.key === 'project')?.action).toBe('open-wizard');
    expect(segments.filter((segment) => segment.action === 'set-map-name').map((segment) => segment.key)).toEqual(['map']);
    expect(segments.find((segment) => segment.key === 'map')?.action).toBe('set-map-name');
  });
});
