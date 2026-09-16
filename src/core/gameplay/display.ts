import type { GameplayRunClassification, GameplayTestReport } from './types.js';

export function gameplayModeLabel(mode: 'auto' | 'manual' | 'none'): string {
  return mode === 'auto' ? '自动' : mode === 'manual' ? '手动' : '未运行';
}

export function gameplayClassificationLabel(classification: GameplayRunClassification | null): string {
  if (classification === null) return '未运行';
  const labels: Readonly<Record<GameplayRunClassification, string>> = {
    'model-pass': '模型通过',
    'model-fail': '模型失败',
    'partial-needs-editor': '部分通过，需官方编辑器复核',
    'not-run-fatal': '未运行，存在致命问题',
  };
  return labels[classification];
}

export function gameplayGateLabel(status: 'pass' | 'blocked' | 'not-run'): string {
  return status === 'pass' ? '通过' : status === 'blocked' ? '已阻断' : '未运行';
}

export function gameplayPopulationStatusLabel(status: 'not-run' | 'stale' | GameplayTestReport['status']): string {
  const labels: Readonly<Record<'not-run' | 'stale' | GameplayTestReport['status'], string>> = {
    'not-run': '未运行',
    stale: '已过期',
    blocked: '已阻断',
    fail: '失败',
    'needs-editor': '需编辑器复核',
    pass: '通过',
  };
  return labels[status];
}
