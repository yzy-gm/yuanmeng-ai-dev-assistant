import { sha256Hex, stableJson } from '../hash.js';
import type { ProjectDiagnostic } from '../diagnostics/analyzer.js';
import type { ResolvedEventMetadata } from '../api/event-doc-index.js';
import { gameplayModelFingerprint, isGameplayEvidenceSatisfied, reviewGameplayStaticGate } from './model.js';
import type {
  GameplayBranch,
  GameplayExpression,
  GameplayFailure,
  GameplayInvariant,
  GameplayModel,
  GameplayRuntimeState,
  GameplayScenario,
  GameplayScenarioStep,
  GameplaySimulationResult,
  GameplayMultiplayerMatrixResult,
  GameplayPopulationMatrixResult,
  GameplayDispatchAction,
  GameplayEventTargetSide,
  GameplayStateRef,
  GameplayValue,
} from './types.js';

export interface RunGameplayScenarioOptions {
  projectDiagnostics?: readonly ProjectDiagnostic[];
  currentProject?: GameplayModel['project'];
  eventMetadata?: ReadonlyMap<string, ResolvedEventMetadata>;
  /** Internal deterministic schedule selector used by the bounded matrix explorer. */
  readyEventChoices?: readonly number[];
}

interface QueuedEvent {
  sequence: number;
  due: number;
  stepIndex: number;
  event: string;
  playerId: string | null;
  playerEpoch: number | null;
  source: NonNullable<GameplayDispatchAction['source']>;
  deliveryId: string | null;
  targetSide: Exclude<GameplayEventTargetSide, 'both'>;
  routing: 'direct' | 'same-player' | 'broadcast' | 'without-player';
  broadcastId: string | null;
  broadcastExpectedPlayerIds: string[] | null;
}

function cloneValue<T extends GameplayValue | Record<string, GameplayValue>>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function initialState(model: GameplayModel, players: readonly string[], initialConnectedPlayers: readonly string[]): GameplayRuntimeState {
  const connected = new Set(initialConnectedPlayers);
  return {
    shared: cloneValue(model.initialState.shared),
    players: Object.fromEntries(players.map((playerId) => [playerId, cloneValue(model.initialState.player)])),
    clients: Object.fromEntries(players.map((playerId) => [playerId, cloneValue(model.initialState.client)])),
    connections: Object.fromEntries(players.map((playerId) => [playerId, connected.has(playerId) ? 'connected' as const : 'disconnected' as const])),
    connectionEpochs: Object.fromEntries(players.map((playerId) => [playerId, 1])),
  };
}

function playerFor(ref: GameplayStateRef, eventPlayerId: string | null): string {
  const playerId = ref.playerId ?? eventPlayerId;
  if (playerId === null || playerId === undefined) throw new Error(`状态 ${ref.scope}:${ref.path} 缺少玩家路由。`);
  return playerId;
}

function rootFor(state: GameplayRuntimeState, ref: GameplayStateRef, eventPlayerId: string | null): Record<string, GameplayValue> {
  if (ref.scope === 'shared') return state.shared;
  const playerId = playerFor(ref, eventPlayerId);
  const root = ref.scope === 'player' ? state.players[playerId] : state.clients[playerId];
  if (root === undefined) throw new Error(`玩家 ${playerId} 不在测试场景中。`);
  return root;
}

function readState(state: GameplayRuntimeState, ref: GameplayStateRef, eventPlayerId: string | null): GameplayValue | undefined {
  let current: GameplayValue | undefined = rootFor(state, ref, eventPlayerId);
  for (const segment of ref.path.split('.')) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) return undefined;
    current = current[segment];
  }
  return current;
}

function writeState(state: GameplayRuntimeState, ref: GameplayStateRef, eventPlayerId: string | null, value: GameplayValue): void {
  const segments = ref.path.split('.');
  let current: Record<string, GameplayValue> = rootFor(state, ref, eventPlayerId);
  for (const segment of segments.slice(0, -1)) {
    const child = current[segment];
    if (child === undefined) current[segment] = {};
    else if (typeof child !== 'object' || child === null || Array.isArray(child)) throw new Error(`状态路径 ${ref.scope}:${ref.path} 的中间字段 ${segment} 不是对象。`);
    current = current[segment] as Record<string, GameplayValue>;
  }
  current[segments.at(-1)!] = cloneValue(value);
}

function compare(operator: 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte', left: GameplayValue | undefined, right: GameplayValue): boolean {
  if (operator === 'eq' || operator === 'ne') {
    const equal = left !== undefined && stableJson(left) === stableJson(right);
    return operator === 'eq' ? equal : !equal;
  }
  if ((typeof left !== 'number' && typeof left !== 'string') || (typeof right !== 'number' && typeof right !== 'string')) return false;
  if (typeof left !== typeof right) return false;
  if (operator === 'gt') return left > right;
  if (operator === 'gte') return left >= right;
  if (operator === 'lt') return left < right;
  return left <= right;
}

function evaluate(expression: GameplayExpression, state: GameplayRuntimeState, playerId: string | null): GameplayValue {
  if (expression.kind === 'literal') return cloneValue(expression.value);
  if (expression.kind === 'read') {
    const value = readState(state, expression.ref, playerId);
    if (value === undefined) throw new Error(`状态路径 ${expression.ref.scope}:${expression.ref.path} 未定义。`);
    return value;
  }
  if (expression.kind === 'not') return !evaluate(expression.value, state, playerId);
  if ('values' in expression) return expression.kind === 'all'
    ? expression.values.every((value) => Boolean(evaluate(value, state, playerId)))
    : expression.values.some((value) => Boolean(evaluate(value, state, playerId)));
  return compare(expression.operator, evaluate(expression.left, state, playerId), evaluate(expression.right, state, playerId));
}

function matchingBranch(
  branches: readonly GameplayBranch[],
  state: GameplayRuntimeState,
  playerId: string | null,
): { branch: GameplayBranch | null; ambiguousBranchIds: string[] } {
  const conditional = branches.filter((branch) => branch.when !== undefined && Boolean(evaluate(branch.when, state, playerId)));
  if (conditional.length > 1) return { branch: null, ambiguousBranchIds: conditional.map((branch) => branch.branchId) };
  if (conditional.length === 1) return { branch: conditional[0]!, ambiguousBranchIds: [] };
  return { branch: branches.find((branch) => branch.when === undefined) ?? null, ambiguousBranchIds: [] };
}

function invariantPlayers(invariant: GameplayInvariant, players: readonly string[]): Array<string | null> {
  return invariant.ref.scope === 'shared' ? [null] : invariant.ref.playerId === undefined ? [...players] : [invariant.ref.playerId];
}

function checkInvariants(
  model: GameplayModel,
  state: GameplayRuntimeState,
  players: readonly string[],
  stepIndex: number,
  failures: GameplayFailure[],
): void {
  for (const invariant of model.invariants) for (const playerId of invariantPlayers(invariant, players)) {
    const actual = readState(state, invariant.ref, playerId);
    let passed = true;
    if (invariant.kind === 'non-negative') passed = typeof actual === 'number' && actual >= 0;
    else if (invariant.kind === 'equals') passed = compare('eq', actual, invariant.value);
    else passed = typeof actual === 'number'
      && (invariant.minimum === undefined || actual >= invariant.minimum)
      && (invariant.maximum === undefined || actual <= invariant.maximum);
    if (!passed) failures.push({
      code: 'INVARIANT_FAILED',
      stepIndex,
      message: `不变量 ${invariant.invariantId} 失败${playerId === null ? '' : `（玩家 ${playerId}）`}。`,
      ref: { ...invariant.ref, ...(playerId === null ? {} : { playerId }) },
      ...(actual === undefined ? {} : { actual }),
    });
  }
}

function validateLimits(model: GameplayModel, scenario: GameplayScenario): boolean {
  const limits = Object.values(scenario.limits);
  const players = new Set(scenario.players);
  const routedPlayers = scenario.steps.flatMap((step) => {
    if (step.kind === 'dispatch') return step.playerId === undefined ? [] : [step.playerId];
    if (step.kind === 'parallel') return step.actions.flatMap((action) => action.playerId === undefined ? [] : [action.playerId]);
    if (step.kind === 'join' || step.kind === 'leave') return [step.playerId];
    if (step.kind === 'expect' && step.ref.playerId !== undefined) return [step.ref.playerId];
    return [];
  });
  return limits.every((value) => Number.isSafeInteger(value) && value > 0)
    && scenario.players.length > 0
    && new Set(scenario.players).size === scenario.players.length
    && routedPlayers.every((playerId) => players.has(playerId))
    && (scenario.initialConnectedPlayers === undefined
      || (new Set(scenario.initialConnectedPlayers).size === scenario.initialConnectedPlayers.length
        && scenario.initialConnectedPlayers.every((playerId) => players.has(playerId))))
    && (model.multiplayer === undefined || scenario.players.length <= model.multiplayer.maximumPlayers);
}

export function runGameplayScenario(
  model: GameplayModel,
  scenario: GameplayScenario,
  options: RunGameplayScenarioOptions = {},
): GameplaySimulationResult {
  const staticGate = reviewGameplayStaticGate(model, options.projectDiagnostics, options.eventMetadata);
  const staticFindings = staticGate.findings.map((entry) => ({
    code: entry.code,
    severity: entry.severity,
    message: entry.message,
    evidence: entry.evidence,
    nextAction: entry.nextAction,
  }));
  const expectedBinding = { modelId: model.modelId, modelFingerprint: gameplayModelFingerprint(model), ...model.project };
  if (stableJson(scenario.modelBinding) !== stableJson(expectedBinding)) staticFindings.push({
    code: 'SCENARIO_MODEL_BINDING_MISMATCH', severity: 'error', message: '测试场景绑定的模型、工程或场景快照与当前玩法模型不一致。',
    evidence: 'STATIC_LOCAL', nextAction: '基于当前模型和场景快照重新确认测试场景。',
  });
  if (options.currentProject !== undefined && stableJson(options.currentProject) !== stableJson(model.project)) staticFindings.push({
    code: 'CURRENT_PROJECT_BINDING_MISMATCH', severity: 'error', message: '当前插件工程或场景快照与玩法模型绑定不一致。',
    evidence: 'STATIC_LOCAL', nextAction: '刷新当前场景证据并重新生成或迁移玩法模型。',
  });
  const declaredExternalEvents = new Set(model.externalEvents);
  const undeclaredDispatch = scenario.steps.flatMap((step) => step.kind === 'dispatch'
    ? [step.event]
    : step.kind === 'parallel' ? step.actions.map((action) => action.event) : [])
    .find((event) => !declaredExternalEvents.has(event));
  if (undeclaredDispatch !== undefined) staticFindings.push({
    code: 'UNDECLARED_EXTERNAL_EVENT', severity: 'error', message: `场景直接分发了未声明的外部事件 ${undeclaredDispatch}。`,
    evidence: 'STATIC_LOCAL', nextAction: '将真实入口加入 externalEvents 并声明权威策略，或改为由已建模处理器发出。',
  });
  const policiesForScenario = new Map((model.eventPolicies ?? []).map((policy) => [policy.event, policy]));
  const conflictingTarget = scenario.steps.flatMap((step) => step.kind === 'dispatch'
    ? [step]
    : step.kind === 'parallel' ? step.actions : [])
    .find((action) => action.targetSide !== undefined && policiesForScenario.get(action.event)?.targetSide !== undefined
      && action.targetSide !== policiesForScenario.get(action.event)?.targetSide);
  if (conflictingTarget !== undefined) staticFindings.push({
    code: 'SCENARIO_TARGET_POLICY_CONFLICT', severity: 'error', message: `场景动作 ${conflictingTarget.event} 试图覆盖事件策略的目标端。`,
    evidence: 'STATIC_LOCAL', nextAction: '删除场景动作 targetSide，并以 eventPolicies 为唯一目标端。',
  });
  const state = initialState(model, scenario.players, scenario.initialConnectedPlayers ?? scenario.players);
  const requiredBranches = model.handlers.flatMap((handler) => handler.branches
    .filter((branch) => branch.coverageRequired !== false)
    .map((branch) => `${handler.handlerId}:${branch.branchId}`));
  const base = {
    schemaVersion: 1 as const,
    modelId: model.modelId,
    scenarioId: scenario.scenarioId,
    mode: scenario.players.length === 1 ? 'single-player' as const : 'multiplayer' as const,
    playerCount: scenario.players.length,
    staticFindings,
    failures: [] as GameplayFailure[],
    editorRequirements: model.evidenceRequirements.filter((requirement) => !isGameplayEvidenceSatisfied(requirement)),
    trace: [] as GameplaySimulationResult['trace'],
    finalState: state,
    coverage: { totalBranches: requiredBranches.length, visitedBranches: 0, ratio: 0, unvisitedBranchIds: requiredBranches },
    readyInterleavings: { choices: [] as number[], branchWidths: [] as number[] },
  };
  const finalize = (status: GameplaySimulationResult['status'], visited = new Set<string>()): GameplaySimulationResult => {
    const unvisitedBranchIds = requiredBranches.filter((branch) => !visited.has(branch));
    const coverage = {
      totalBranches: requiredBranches.length,
      visitedBranches: requiredBranches.length - unvisitedBranchIds.length,
      ratio: requiredBranches.length === 0 ? 1 : (requiredBranches.length - unvisitedBranchIds.length) / requiredBranches.length,
      unvisitedBranchIds,
    };
    const content = { ...base, status, coverage };
    return { ...content, reportId: sha256Hex(stableJson(content)) };
  };
  if (staticFindings.some((entry) => entry.severity === 'error') || !validateLimits(model, scenario)) {
    if (!validateLimits(model, scenario)) base.staticFindings.push({
      code: 'INVALID_SCENARIO_LIMITS', severity: 'error', message: '测试场景边界或玩家列表无效。',
      evidence: 'STATIC_LOCAL', nextAction: '修正为正整数边界和唯一玩家列表。',
    });
    return finalize('blocked');
  }

  checkInvariants(model, state, scenario.players, -1, base.failures);

  const handlers = new Map<string, GameplayModel['handlers']>();
  for (const handler of model.handlers) {
    const values = handlers.get(handler.event) ?? [];
    values.push(handler);
    handlers.set(handler.event, values);
  }
  const queue: QueuedEvent[] = [];
  const visitedBranches = new Set<string>();
  const visitedStates = new Set<string>([sha256Hex(stableJson(state))]);
  let virtualMilliseconds = 0;
  let nextSequence = 0;
  let processedEvents = 0;
  let stopped = false;
  const readyChoiceVector = options.readyEventChoices ?? [];
  const readyInterleavings = base.readyInterleavings;
  const delivered = new Set<string>();
  const policies = new Map((model.eventPolicies ?? []).map((policy) => [policy.event, policy]));

  const concreteTargetSides = (
    event: string,
    requested: GameplayEventTargetSide | undefined,
  ): Array<Exclude<GameplayEventTargetSide, 'both'>> => {
    const selected = policies.get(event)?.targetSide ?? requested;
    if (selected === 'both') return ['server', 'client'];
    if (selected === 'server' || selected === 'client') return [selected];
    const sides = [...new Set((handlers.get(event) ?? []).map((handler) => handler.side))];
    if (sides.length === 1) return [sides[0]!];
    return ['server'];
  };
  const enqueueOne = (
    event: string,
    playerId: string | null,
    due: number,
    stepIndex: number,
    source: NonNullable<GameplayDispatchAction['source']>,
    deliveryId: string | null = null,
    targetSide: Exclude<GameplayEventTargetSide, 'both'>,
    routing: QueuedEvent['routing'] = 'direct',
    broadcastId: string | null = null,
    broadcastExpectedPlayerIds: string[] | null = null,
  ): void => {
    queue.push({
      event,
      playerId,
      playerEpoch: playerId === null ? null : state.connectionEpochs[playerId] ?? null,
      source,
      deliveryId,
      targetSide,
      routing,
      broadcastId,
      broadcastExpectedPlayerIds,
      due,
      stepIndex,
      sequence: nextSequence += 1,
    });
    queue.sort((left, right) => left.due - right.due || left.sequence - right.sequence);
  };
  const enqueue = (
    event: string,
    playerId: string | null,
    due: number,
    stepIndex: number,
    source: NonNullable<GameplayDispatchAction['source']> = 'server',
    deliveryId: string | null = null,
    targetSide?: GameplayEventTargetSide,
    routing: QueuedEvent['routing'] = 'direct',
    broadcastId: string | null = null,
    broadcastExpectedPlayerIds: string[] | null = null,
  ): void => {
    for (const concrete of concreteTargetSides(event, targetSide)) {
      enqueueOne(event, playerId, due, stepIndex, source, deliveryId, concrete, routing, broadcastId, broadcastExpectedPlayerIds);
    }
  };
  const fail = (failure: GameplayFailure): void => { base.failures.push(failure); };
  const drain = (until: number): void => {
    while (!stopped && queue[0] !== undefined && queue[0].due <= until) {
      if (processedEvents >= scenario.limits.maxEvents) {
        fail({ code: 'EVENT_LIMIT_EXCEEDED', stepIndex: queue[0].stepIndex, message: `事件数量超过 ${scenario.limits.maxEvents}。` });
        stopped = true;
        break;
      }
      let selectedQueueIndex = 0;
      if (scenario.exploreReadyEventInterleavings === true) {
        const earliestDue = queue[0].due;
        const readyCount = queue.findIndex((candidate) => candidate.due !== earliestDue);
        const width = readyCount < 0 ? queue.length : readyCount;
        const readyEvents = queue.slice(0, width);
        if (width > 1 && (
          readyEvents.some((candidate) => candidate.routing !== 'direct')
          || new Set(readyEvents.map((candidate) => candidate.targetSide)).size > 1
        )) {
          const decisionIndex = readyInterleavings.branchWidths.length;
          const requestedChoice = readyChoiceVector[decisionIndex] ?? 0;
          selectedQueueIndex = requestedChoice >= 0 && requestedChoice < width ? requestedChoice : 0;
          readyInterleavings.branchWidths.push(width);
          readyInterleavings.choices.push(selectedQueueIndex);
        }
      }
      const event = queue.splice(selectedQueueIndex, 1)[0]!;
      virtualMilliseconds = event.due;
      const handlerIds: string[] = [];
      const branchIds: string[] = [];
      const policy = policies.get(event.event);
      const unauthorized = (policy?.authority === 'server-only' && event.source !== 'server')
        || (policy?.authority === 'engine' && event.source !== 'engine')
        || (policy?.authority === 'client-request' && event.source !== 'client');
      if (policy?.playerRequired === true && event.playerId === null) {
        processedEvents += 1;
        fail({ code: 'PLAYER_ROUTING_MISSING', stepIndex: event.stepIndex, message: `事件 ${event.event} 缺少回调玩家。` });
        base.trace.push({
          sequence: processedEvents, virtualMilliseconds, stepIndex: event.stepIndex, event: event.event,
          playerId: null, source: event.source, targetSide: event.targetSide, deliveryId: event.deliveryId,
          routing: event.routing, broadcastId: event.broadcastId, broadcastExpectedPlayerIds: event.broadcastExpectedPlayerIds, deliveryOutcome: 'rejected-player-routing', handlers: [], branches: [],
        });
        continue;
      }
      if (unauthorized) {
        processedEvents += 1;
        fail({ code: 'UNAUTHORIZED_EVENT_SOURCE', stepIndex: event.stepIndex, message: `事件 ${event.event} 的来源 ${event.source ?? 'unknown'} 没有权限。` });
        base.trace.push({
          sequence: processedEvents, virtualMilliseconds, stepIndex: event.stepIndex, event: event.event,
          playerId: event.playerId, source: event.source, targetSide: event.targetSide, deliveryId: event.deliveryId,
          routing: event.routing, broadcastId: event.broadcastId, broadcastExpectedPlayerIds: event.broadcastExpectedPlayerIds, deliveryOutcome: 'rejected-authority', handlers: [], branches: [],
        });
        continue;
      }
      if (
        event.playerId !== null
        && (state.connections[event.playerId] !== 'connected' || state.connectionEpochs[event.playerId] !== event.playerEpoch)
      ) {
        processedEvents += 1;
        const wasQueuedWhileDisconnected = state.connections[event.playerId] !== 'connected'
          && state.connectionEpochs[event.playerId] === event.playerEpoch;
        fail({
          code: wasQueuedWhileDisconnected ? 'PLAYER_NOT_CONNECTED' : 'LATE_EVENT_FOR_DISCONNECTED_PLAYER',
          stepIndex: event.stepIndex,
          message: wasQueuedWhileDisconnected
            ? `玩家 ${event.playerId} 当前未连接，拒绝事件 ${event.event}。`
            : `玩家 ${event.playerId} 已离开或重连，拒绝迟到事件 ${event.event}。`,
        });
        base.trace.push({
          sequence: processedEvents,
          virtualMilliseconds,
          stepIndex: event.stepIndex,
          event: event.event,
          playerId: event.playerId,
          source: event.source,
          targetSide: event.targetSide,
          deliveryId: event.deliveryId,
          routing: event.routing,
          broadcastId: event.broadcastId,
          broadcastExpectedPlayerIds: event.broadcastExpectedPlayerIds,
          deliveryOutcome: 'rejected-connection',
          handlers: [],
          branches: [],
        });
        continue;
      }
      const selectedHandlers = (handlers.get(event.event) ?? []).filter((candidate) => candidate.side === event.targetSide);
      if (selectedHandlers.length === 0) {
        processedEvents += 1;
        fail({ code: 'NO_HANDLER_FOR_TARGET', stepIndex: event.stepIndex, message: `事件 ${event.event} 的 ${event.targetSide} 目标端没有处理器。` });
        base.trace.push({
          sequence: processedEvents, virtualMilliseconds, stepIndex: event.stepIndex, event: event.event,
          playerId: event.playerId, source: event.source, targetSide: event.targetSide, deliveryId: event.deliveryId,
          routing: event.routing, broadcastId: event.broadcastId, broadcastExpectedPlayerIds: event.broadcastExpectedPlayerIds, deliveryOutcome: 'no-handler', handlers: [], branches: [],
        });
        continue;
      }
      const duplicateKey = event.deliveryId === null
        ? null
        : `${event.event}\0${event.targetSide}\0${event.playerId ?? ''}\0${event.deliveryId}`;
      const duplicate = duplicateKey !== null && delivered.has(duplicateKey);
      const beforeEventState = duplicate ? sha256Hex(stableJson(state)) : null;
      const beforeQueuedEffects = duplicate ? sha256Hex(stableJson(queue)) : null;
      const beforeObservableState = policy?.observableEffectRequired === true ? sha256Hex(stableJson(state)) : null;
      const beforeObservableQueue = policy?.observableEffectRequired === true ? sha256Hex(stableJson(queue)) : null;
      if (duplicateKey !== null) delivered.add(duplicateKey);
      let simulationErrored = false;
      try {
        for (const handler of selectedHandlers) {
          handlerIds.push(handler.handlerId);
          const match = matchingBranch(handler.branches, state, event.playerId);
          if (match.ambiguousBranchIds.length > 0) {
            fail({
              code: 'AMBIGUOUS_BRANCH_MATCH', stepIndex: event.stepIndex,
              message: `处理器 ${handler.handlerId} 同时命中多个条件分支：${match.ambiguousBranchIds.join(', ')}。`,
            });
            continue;
          }
          const branch = match.branch;
          if (branch === null) continue;
          const branchId = `${handler.handlerId}:${branch.branchId}`;
          branchIds.push(branchId);
          visitedBranches.add(branchId);
          if (visitedBranches.size > scenario.limits.maxBranches) {
            fail({ code: 'BRANCH_LIMIT_EXCEEDED', stepIndex: event.stepIndex, message: `分支数量超过 ${scenario.limits.maxBranches}。` });
            stopped = true;
            break;
          }
          for (const effect of branch.effects) {
            if (effect.kind === 'emit') {
              if (effect.routing === 'broadcast') {
                const broadcastId = `broadcast-${event.sequence}-${handler.handlerId}-${branch.branchId}`;
                const expectedPlayerIds = Object.entries(state.connections)
                  .filter(([, connection]) => connection === 'connected')
                  .map(([targetPlayerId]) => targetPlayerId)
                  .sort((left, right) => left.localeCompare(right, 'en'));
                for (const targetPlayerId of expectedPlayerIds) {
                  enqueue(
                    effect.event, targetPlayerId, virtualMilliseconds + effect.delayMilliseconds, event.stepIndex,
                    handler.side, null, effect.targetSide, 'broadcast', broadcastId, expectedPlayerIds,
                  );
                }
              } else {
                enqueue(
                  effect.event,
                  effect.routing === 'without-player' ? null : event.playerId,
                  virtualMilliseconds + effect.delayMilliseconds,
                  event.stepIndex,
                  handler.side,
                  null,
                  effect.targetSide,
                  effect.routing ?? 'same-player',
                );
              }
            } else if (effect.kind === 'set') {
              writeState(state, effect.target, event.playerId, evaluate(effect.value, state, event.playerId));
            } else {
              const current = readState(state, effect.target, event.playerId);
              const amount = evaluate(effect.value, state, event.playerId);
              if (typeof current !== 'number' || typeof amount !== 'number' || !Number.isFinite(current + amount)) throw new Error(`add 目标 ${effect.target.path} 不是有限数值。`);
              writeState(state, effect.target, event.playerId, current + amount);
            }
          }
        }
      } catch (error) {
        simulationErrored = true;
        fail({ code: 'SIMULATION_ERROR', stepIndex: event.stepIndex, message: error instanceof Error ? error.message : '未知模拟错误。' });
        stopped = true;
      }
      processedEvents += 1;
      base.trace.push({
        sequence: processedEvents,
        virtualMilliseconds,
        stepIndex: event.stepIndex,
        event: event.event,
        playerId: event.playerId,
        source: event.source,
        targetSide: event.targetSide,
        deliveryId: event.deliveryId,
        routing: event.routing,
        broadcastId: event.broadcastId,
        broadcastExpectedPlayerIds: event.broadcastExpectedPlayerIds,
        deliveryOutcome: simulationErrored ? 'simulation-error' : 'handled',
        handlers: handlerIds,
        branches: branchIds,
      });
      checkInvariants(model, state, scenario.players, event.stepIndex, base.failures);
      if (
        policy?.observableEffectRequired === true
        && beforeObservableState === sha256Hex(stableJson(state))
        && beforeObservableQueue === sha256Hex(stableJson(queue))
      ) fail({
        code: 'NO_OBSERVABLE_EFFECT', stepIndex: event.stepIndex,
        message: `事件 ${event.event} 已要求可观察结果，但选中分支没有产生状态或后续事件变化。`,
      });
      if (
        duplicate
        && policy?.duplicatePolicy === 'must-be-idempotent'
        && (
          beforeEventState !== sha256Hex(stableJson(state))
          || beforeQueuedEffects !== sha256Hex(stableJson(queue))
        )
      ) {
        fail({
          code: 'DUPLICATE_EVENT_CHANGED_STATE',
          stepIndex: event.stepIndex,
          message: `重复投递 ${event.event}（${event.deliveryId}）再次修改了状态。`,
        });
      }
      visitedStates.add(sha256Hex(stableJson(state)));
      if (visitedStates.size > scenario.limits.maxVisitedStates) {
        fail({ code: 'STATE_LIMIT_EXCEEDED', stepIndex: event.stepIndex, message: `状态数量超过 ${scenario.limits.maxVisitedStates}。` });
        stopped = true;
      }
    }
    virtualMilliseconds = Math.max(virtualMilliseconds, until);
  };

  for (const [stepIndex, step] of scenario.steps.entries()) {
    if (stopped) break;
    if (step.kind === 'dispatch') {
      enqueue(
        step.event, step.playerId ?? null, virtualMilliseconds, stepIndex, step.source ?? 'server',
        step.deliveryId ?? null, step.targetSide,
      );
      drain(virtualMilliseconds);
    } else if (step.kind === 'parallel') {
      for (const action of step.actions) {
        enqueue(
          action.event, action.playerId ?? null, virtualMilliseconds, stepIndex, action.source ?? 'server',
          action.deliveryId ?? null, action.targetSide,
        );
      }
      drain(virtualMilliseconds);
    } else if (step.kind === 'leave') {
      if (state.connections[step.playerId] !== 'connected') {
        fail({ code: 'PLAYER_NOT_CONNECTED', stepIndex, message: `玩家 ${step.playerId} 不能重复离开。` });
      } else {
        state.connections[step.playerId] = 'disconnected';
        state.connectionEpochs[step.playerId] = (state.connectionEpochs[step.playerId] ?? 0) + 1;
        checkInvariants(model, state, scenario.players, stepIndex, base.failures);
      }
    } else if (step.kind === 'join') {
      if (state.connections[step.playerId] === 'connected') {
        fail({ code: 'PLAYER_ALREADY_CONNECTED', stepIndex, message: `玩家 ${step.playerId} 已连接，不能重复加入。` });
      } else {
        if (model.multiplayer?.rejoinPolicy === 'reset-all') state.players[step.playerId] = cloneValue(model.initialState.player);
        state.clients[step.playerId] = cloneValue(model.initialState.client);
        state.connectionEpochs[step.playerId] = (state.connectionEpochs[step.playerId] ?? 0) + 1;
        state.connections[step.playerId] = 'connected';
        checkInvariants(model, state, scenario.players, stepIndex, base.failures);
      }
    } else if (step.kind === 'advance') {
      if (!Number.isSafeInteger(step.milliseconds) || step.milliseconds < 0 || virtualMilliseconds + step.milliseconds > scenario.limits.maxVirtualMilliseconds) {
        fail({ code: 'VIRTUAL_TIME_LIMIT_EXCEEDED', stepIndex, message: `虚拟时间超过 ${scenario.limits.maxVirtualMilliseconds} ms。` });
        stopped = true;
      } else {
        drain(virtualMilliseconds + step.milliseconds);
      }
    } else {
      try {
        const actual = readState(state, step.ref, step.ref.playerId ?? null);
        if (!compare(step.operator, actual, step.value)) fail({
          code: 'EXPECTATION_FAILED', stepIndex, message: `期望 ${step.ref.scope}:${step.ref.path} ${step.operator} 未满足。`,
          ref: step.ref, expected: step.value, ...(actual === undefined ? {} : { actual }),
        });
      } catch (error) {
        fail({ code: 'SIMULATION_ERROR', stepIndex, message: error instanceof Error ? error.message : '未知断言错误。' });
      }
    }
  }
  const pendingCritical = queue.filter((event) => policies.get(event.event)?.completion === 'must-drain');
  if (pendingCritical.length > 0) {
    fail({
      code: 'PENDING_CRITICAL_EVENTS',
      stepIndex: pendingCritical[0]!.stepIndex,
      message: `场景结束时仍有 ${pendingCritical.length} 个必须处理的关键事件未执行：${[...new Set(pendingCritical.map((event) => event.event))].join(', ')}。`,
    });
  }
  checkInvariants(model, state, scenario.players, scenario.steps.length, base.failures);
  const status = base.failures.length > 0 ? 'fail' : base.editorRequirements.length > 0 ? 'needs-editor' : 'pass';
  return finalize(status, visitedBranches);
}

function permutations(actions: readonly GameplayDispatchAction[], maximum: number): { values: GameplayDispatchAction[][]; truncated: boolean } {
  const output: GameplayDispatchAction[][] = [];
  const used = new Array(actions.length).fill(false) as boolean[];
  const current: GameplayDispatchAction[] = [];
  const visit = (): void => {
    if (output.length > maximum) return;
    if (current.length === actions.length) {
      output.push([...current]);
      return;
    }
    const seen = new Set<string>();
    for (const [index, action] of actions.entries()) {
      if (used[index]) continue;
      const key = `${action.event}\0${action.playerId ?? ''}\0${action.source ?? ''}\0${action.deliveryId ?? ''}\0${action.targetSide ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      used[index] = true;
      current.push(action);
      visit();
      current.pop();
      used[index] = false;
      if (output.length > maximum) return;
    }
  };
  visit();
  return { values: output.slice(0, maximum), truncated: output.length > maximum };
}

function expandInterleavings(
  scenario: GameplayScenario,
  maximum: number,
): { variants: Array<{ steps: GameplayScenarioStep[]; order: GameplayDispatchAction[] }>; truncated: boolean } {
  let variants: Array<{ steps: GameplayScenarioStep[]; order: GameplayDispatchAction[] }> = [{ steps: [], order: [] }];
  let truncated = false;
  for (const step of scenario.steps) {
    if (step.kind !== 'parallel' || step.exploreInterleavings !== true || step.actions.length < 2) {
      variants = variants.map((variant) => ({ ...variant, steps: [...variant.steps, step] }));
      continue;
    }
    const orders = permutations(step.actions, maximum);
    truncated ||= orders.truncated;
    const expanded = variants.flatMap((variant) => orders.values.map((order) => ({
      steps: [...variant.steps, { kind: 'parallel' as const, actions: order, exploreInterleavings: false }],
      order: [...variant.order, ...order],
    })));
    if (expanded.length > maximum) truncated = true;
    variants = expanded.slice(0, maximum);
  }
  return { variants, truncated };
}

export function runGameplayMultiplayerMatrix(
  model: GameplayModel,
  scenario: GameplayScenario,
  options: {
    maxSchedules?: number;
    projectDiagnostics?: readonly ProjectDiagnostic[];
    currentProject?: GameplayModel['project'];
    eventMetadata?: ReadonlyMap<string, ResolvedEventMetadata>;
  } = {},
): GameplayMultiplayerMatrixResult {
  const maximum = options.maxSchedules ?? 32;
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 256) throw new Error('多人时序上限必须在 1 到 256 之间。');
  const expanded = expandInterleavings(scenario, maximum);
  const schedules: GameplayMultiplayerMatrixResult['schedules'] = [];
  let truncated = expanded.truncated;
  variantLoop: for (const variant of expanded.variants) {
    const pendingChoices: number[][] = [[]];
    const seenChoices = new Set<string>();
    while (pendingChoices.length > 0) {
      if (schedules.length >= maximum) {
        truncated = true;
        break variantLoop;
      }
      const choices = pendingChoices.shift()!;
      const choiceKey = choices.join(',');
      if (seenChoices.has(choiceKey)) continue;
      seenChoices.add(choiceKey);
      const result = runGameplayScenario(model, { ...scenario, steps: variant.steps }, {
        ...(options.projectDiagnostics === undefined ? {} : { projectDiagnostics: options.projectDiagnostics }),
        ...(options.currentProject === undefined ? {} : { currentProject: options.currentProject }),
        ...(options.eventMetadata === undefined ? {} : { eventMetadata: options.eventMetadata }),
        readyEventChoices: choices,
      });
      schedules.push({
        scheduleId: `schedule-${schedules.length + 1}`,
        dispatchOrder: variant.order,
        scenarioSteps: variant.steps,
        result,
      });
      for (const [decisionIndex, width] of result.readyInterleavings.branchWidths.entries()) {
        const actualChoices = result.readyInterleavings.choices;
        for (let alternate = 0; alternate < width; alternate += 1) {
          if (alternate === actualChoices[decisionIndex]) continue;
          const candidate = [...actualChoices.slice(0, decisionIndex), alternate];
          while (candidate.at(-1) === 0) candidate.pop();
          pendingChoices.push(candidate);
        }
      }
    }
  }
  const order = { blocked: 3, fail: 2, 'needs-editor': 1, pass: 0 } as const;
  let status = schedules.reduce<GameplaySimulationResult['status']>((current, entry) => (
    order[entry.result.status] > order[current] ? entry.result.status : current
  ), 'pass');
  if (truncated && status === 'pass') status = 'needs-editor';
  return {
    schemaVersion: 1,
    status,
    schedulesExplored: schedules.length,
    truncated,
    schedules,
  };
}

const POPULATION_COUNTS = [1, 2, 4, 8] as const;

export function runGameplayPopulationMatrix(
  model: GameplayModel,
  scenarios: readonly GameplayScenario[],
  options: {
    maxSchedules?: number;
    projectDiagnostics?: readonly ProjectDiagnostic[];
    currentProject?: GameplayModel['project'];
    eventMetadata?: ReadonlyMap<string, ResolvedEventMetadata>;
    requiredPlayerCounts?: readonly number[];
  } = {},
): GameplayPopulationMatrixResult {
  const requiredPlayerCounts = [...(options.requiredPlayerCounts ?? POPULATION_COUNTS)];
  if (
    requiredPlayerCounts.length === 0
    || requiredPlayerCounts.some((count) => !Number.isSafeInteger(count) || count < 1 || count > 64)
    || new Set(requiredPlayerCounts).size !== requiredPlayerCounts.length
  ) throw new Error('人口测试矩阵必须包含唯一的正整数人数。');
  if (scenarios.length > 32) throw new Error('玩法测试场景总数超过 32 个上限。');
  const byCount = new Map<number, GameplayScenario[]>();
  for (const scenario of scenarios) {
    const samePopulation = byCount.get(scenario.players.length) ?? [];
    samePopulation.push(scenario);
    byCount.set(scenario.players.length, samePopulation);
  }
  const missing = requiredPlayerCounts.filter((count) => !byCount.has(count));
  if (missing.length > 0) throw new Error(`缺少 ${missing.join('/')} 人玩法测试场景。`);
  const populations = requiredPlayerCounts.map((playerCount) => {
    const populationScenarios = byCount.get(playerCount)!;
    const scenarioMatrices = populationScenarios.map((scenario) => ({ scenario, matrix: runGameplayMultiplayerMatrix(model, scenario, options) }));
    const order = { blocked: 3, fail: 2, 'needs-editor': 1, pass: 0 } as const;
    const status = scenarioMatrices.reduce<GameplaySimulationResult['status']>((current, entry) => (
      order[entry.matrix.status] > order[current] ? entry.matrix.status : current
    ), 'pass');
    const combinedSchedules = scenarioMatrices.flatMap(({ scenario, matrix }) => matrix.schedules.map((schedule) => ({
      ...schedule,
      scheduleId: `${scenario.scenarioId}:${schedule.scheduleId}`,
    })));
    const matrix: GameplayMultiplayerMatrixResult = {
      schemaVersion: 1,
      status,
      schedulesExplored: combinedSchedules.length,
      truncated: scenarioMatrices.some((entry) => entry.matrix.truncated),
      schedules: combinedSchedules,
    };
    return {
      playerCount,
      mode: playerCount === 1 ? 'single-player' as const : 'multiplayer' as const,
      scenarioId: populationScenarios.length === 1 ? populationScenarios[0]!.scenarioId : `${playerCount}-player-suite`,
      status: matrix.status,
      schedulesExplored: matrix.schedulesExplored,
      truncated: matrix.truncated,
      matrix,
      scenarioResults: scenarioMatrices.map(({ scenario, matrix: scenarioMatrix }) => ({
        scenarioId: scenario.scenarioId, status: scenarioMatrix.status,
        schedulesExplored: scenarioMatrix.schedulesExplored, truncated: scenarioMatrix.truncated,
      })),
    };
  });
  const order = { blocked: 3, fail: 2, 'needs-editor': 1, pass: 0 } as const;
  const status = populations.reduce<GameplaySimulationResult['status']>((current, entry) => (
    order[entry.status] > order[current] ? entry.status : current
  ), 'pass');
  return { schemaVersion: 1, status, requiredPlayerCounts, populations };
}
