import type {
  GameplayFailure,
  GameplayModel,
  GameplayPopulationMatrixResult,
  GameplayPopulationResult,
} from './types.js';

export interface GameplayCoverageSummary {
  scope: 'declared-model-branches';
  visitedBranches: number;
  totalBranches: number;
  ratio: number;
  byPopulation: Array<{
    playerCount: number;
    visitedBranches: number;
    totalBranches: number;
    ratio: number;
    shared: { visitedBranches: number; totalBranches: number; ratio: number };
    byPlayer: Array<{ playerId: string; visitedBranches: number; totalBranches: number; ratio: number }>;
  }>;
}

export function declaredGameplayBranchIds(model: GameplayModel): string[] {
  return model.handlers.flatMap((handler) => handler.branches
    .filter((branch) => branch.coverageRequired !== false)
    .map((branch) => `${handler.handlerId}:${branch.branchId}`)).sort((left, right) => left.localeCompare(right, 'en'));
}

export function summarizeGameplayCoverage(
  model: GameplayModel,
  matrix: GameplayPopulationMatrixResult,
): GameplayCoverageSummary {
  const declared = declaredGameplayBranchIds(model);
  const playerRequiredEvents = new Set((model.eventPolicies ?? []).filter((policy) => policy.playerRequired).map((policy) => policy.event));
  const perPlayerDeclared = model.handlers.flatMap((handler) => playerRequiredEvents.has(handler.event)
    ? handler.branches.filter((branch) => branch.coverageRequired !== false).map((branch) => `${handler.handlerId}:${branch.branchId}`)
    : []);
  const perPlayerSet = new Set(perPlayerDeclared);
  const sharedDeclared = declared.filter((branch) => !perPlayerSet.has(branch));
  const visited = new Set<string>();
  for (const population of matrix.populations) {
    for (const schedule of population.matrix.schedules) {
      for (const trace of schedule.result.trace) for (const branch of trace.branches) visited.add(branch);
    }
  }
  const visitedBranches = declared.filter((branch) => visited.has(branch)).length;
  const byPopulation = matrix.populations.map((population) => {
    const populationVisited = new Set<string>();
    const byPlayerVisited = new Map<string, Set<string>>();
    for (const schedule of population.matrix.schedules) {
      for (const playerId of Object.keys(schedule.result.finalState.players)) {
        if (!byPlayerVisited.has(playerId)) byPlayerVisited.set(playerId, new Set<string>());
      }
      for (const trace of schedule.result.trace) {
        for (const branch of trace.branches) {
          populationVisited.add(branch);
          if (trace.playerId !== null) {
            const branches = byPlayerVisited.get(trace.playerId) ?? new Set<string>();
            if (perPlayerSet.has(branch)) branches.add(branch);
            byPlayerVisited.set(trace.playerId, branches);
          }
        }
      }
    }
    const populationVisitedCount = declared.filter((branch) => populationVisited.has(branch)).length;
    const sharedVisitedCount = sharedDeclared.filter((branch) => populationVisited.has(branch)).length;
    return {
      playerCount: population.playerCount,
      visitedBranches: populationVisitedCount,
      totalBranches: declared.length,
      ratio: declared.length === 0 ? 1 : populationVisitedCount / declared.length,
      shared: {
        visitedBranches: sharedVisitedCount,
        totalBranches: sharedDeclared.length,
        ratio: sharedDeclared.length === 0 ? 1 : sharedVisitedCount / sharedDeclared.length,
      },
      byPlayer: [...byPlayerVisited.entries()].sort(([left], [right]) => left.localeCompare(right, 'en')).map(([playerId, branches]) => {
        const count = perPlayerDeclared.filter((branch) => branches.has(branch)).length;
        return { playerId, visitedBranches: count, totalBranches: perPlayerDeclared.length, ratio: perPlayerDeclared.length === 0 ? 1 : count / perPlayerDeclared.length };
      }),
    };
  });
  return {
    scope: 'declared-model-branches',
    visitedBranches,
    totalBranches: declared.length,
    ratio: declared.length === 0 ? 1 : visitedBranches / declared.length,
    byPopulation,
  };
}

export function firstPopulationFailure(population: GameplayPopulationResult): GameplayFailure | null {
  for (const schedule of population.matrix.schedules) {
    const failure = schedule.result.failures[0];
    if (failure !== undefined) return failure;
  }
  return null;
}

export function populationEditorRequirementIds(population: GameplayPopulationResult): string[] {
  const requirements = new Set<string>();
  for (const schedule of population.matrix.schedules) {
    for (const requirement of schedule.result.editorRequirements) requirements.add(requirement.requirementId);
  }
  return [...requirements].sort((left, right) => left.localeCompare(right, 'en'));
}
