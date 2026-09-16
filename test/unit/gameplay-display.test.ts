import { describe, expect, it } from 'vitest';

import {
  gameplayClassificationLabel,
  gameplayGateLabel,
  gameplayModeLabel,
  gameplayPopulationStatusLabel,
} from '../../src/core/gameplay/display.js';

describe('gameplay display labels', () => {
  it('translates internal run modes and classifications for the user-facing view', () => {
    expect(gameplayModeLabel('auto')).toBe('自动');
    expect(gameplayModeLabel('manual')).toBe('手动');
    expect(gameplayModeLabel('none')).toBe('未运行');
    expect(gameplayClassificationLabel('model-pass')).toBe('模型通过');
    expect(gameplayClassificationLabel('model-fail')).toBe('模型失败');
    expect(gameplayClassificationLabel('partial-needs-editor')).toBe('部分通过，需官方编辑器复核');
    expect(gameplayClassificationLabel('not-run-fatal')).toBe('未运行，存在致命问题');
    expect(gameplayClassificationLabel(null)).toBe('未运行');
  });

  it('translates gate and population statuses without changing their machine values', () => {
    expect(gameplayGateLabel('pass')).toBe('通过');
    expect(gameplayGateLabel('blocked')).toBe('已阻断');
    expect(gameplayGateLabel('not-run')).toBe('未运行');
    expect(gameplayPopulationStatusLabel('pass')).toBe('通过');
    expect(gameplayPopulationStatusLabel('fail')).toBe('失败');
    expect(gameplayPopulationStatusLabel('needs-editor')).toBe('需编辑器复核');
    expect(gameplayPopulationStatusLabel('blocked')).toBe('已阻断');
    expect(gameplayPopulationStatusLabel('stale')).toBe('已过期');
    expect(gameplayPopulationStatusLabel('not-run')).toBe('未运行');
  });
});
