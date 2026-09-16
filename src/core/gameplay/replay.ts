import { ProductError } from '../errors.js';
import { sha256Hex, stableJson } from '../hash.js';
import { runGameplayScenario, type RunGameplayScenarioOptions } from './simulator.js';
import type { GameplayModel, GameplayScenario, GameplaySimulationResult } from './types.js';

export interface GameplayReplayArtifact {
  schemaVersion: 1;
  artifactId: string;
  modelSha256: string;
  scenarioSha256: string;
  expectedReportId: string;
}

function fingerprint(value: GameplayModel | GameplayScenario): string {
  return sha256Hex(stableJson(value));
}

export function createGameplayReplayArtifact(
  model: GameplayModel,
  scenario: GameplayScenario,
  result: GameplaySimulationResult,
): GameplayReplayArtifact {
  if (result.modelId !== model.modelId || result.scenarioId !== scenario.scenarioId) {
    throw new ProductError('VALIDATION_FAILED', '玩法重放结果与模型或场景不匹配。', ['使用同一次模拟的模型、场景和结果。'], 'STATIC_LOCAL');
  }
  const content = {
    schemaVersion: 1 as const,
    modelSha256: fingerprint(model),
    scenarioSha256: fingerprint(scenario),
    expectedReportId: result.reportId,
  };
  return { ...content, artifactId: sha256Hex(stableJson(content)) };
}

export function replayGameplayScenario(
  model: GameplayModel,
  scenario: GameplayScenario,
  artifact: GameplayReplayArtifact,
  options: RunGameplayScenarioOptions = {},
): GameplaySimulationResult {
  if (
    artifact.schemaVersion !== 1
    || artifact.modelSha256 !== fingerprint(model)
    || artifact.scenarioSha256 !== fingerprint(scenario)
  ) {
    throw new ProductError('VALIDATION_FAILED', '模型或场景指纹与重放工件不匹配。', ['重新生成确定性重放工件。'], 'STATIC_LOCAL');
  }
  const result = runGameplayScenario(model, scenario, options);
  if (result.reportId !== artifact.expectedReportId) {
    throw new ProductError('VALIDATION_FAILED', '玩法模拟重放结果不确定。', ['检查事件排序、随机数和未建模外部状态。'], 'UNIT_E2E');
  }
  return result;
}
