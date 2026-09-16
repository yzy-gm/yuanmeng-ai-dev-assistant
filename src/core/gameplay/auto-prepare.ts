import type { ResolvedEventMetadata } from '../api/event-doc-index.js';
import { sha256Hex } from '../hash.js';
import type { LuaSourceFile, LuaSourceIndex } from '../lua/source-index.js';
import type { RegistryDocument, UiSnapshot } from '../model.js';
import type { CapabilityEvidenceResolution } from '../scene/probe-evidence.js';
import { resolveSceneInstanceIntelligence } from '../scene/semantic-catalog.js';
import type { SceneSnapshot } from '../scene/types.js';
import { extractGameplayLuaFacts } from './lua-facts.js';
import { gameplayModelFingerprint } from './model.js';
import { resolveGameplayProductionScope } from './production-scope.js';
import { parseGameplayModel, parseGameplayScenario } from './scenario-schema.js';
import type {
  GameplayAutoPreparation,
  GameplayDispatchAction,
  GameplayEffect,
  GameplayEventFact,
  GameplayModel,
  GameplayPreparationFinding,
  GameplayScenario,
  GameplaySkippedFlow,
  GameplaySourceEvidence,
} from './types.js';

const INTERACTION_BY_EVENT = new Map<string, NonNullable<GameplayModel['sceneEventBindings']>[number]['interaction']>([
  ['Events.ON_CHARACTER_ENTER_SIGNAL_BOX', 'character-enter-trigger'],
  ['Events.ON_CHARACTER_LEAVE_SIGNAL_BOX', 'character-leave-trigger'],
  ['Events.ON_ELEMENT_ENTER_TRIGGER', 'element-enter-trigger'],
  ['Events.ON_ELEMENT_LEAVE_TRIGGER', 'element-leave-trigger'],
  ['Events.ON_LOGIC_ACTOR_ENTER_TRIGGER', 'logic-element-enter-trigger'],
  ['Events.ON_LOGIC_ACTOR_LEAVE_TRIGGER', 'logic-element-leave-trigger'],
  ['Events.ON_CREATURE_ENTER_TRIGGER', 'creature-enter-trigger'],
  ['Events.ON_CREATURE_LEAVE_TRIGGER', 'creature-leave-trigger'],
  ['Events.ON_PLAYER_TOUCH_ELEMENT', 'player-touch-element'],
  ['Events.ON_ELEMENT_TOUCH_PLAYER', 'element-touch-player'],
]);

function sourcePoint(evidence: GameplaySourceEvidence): { path: string; line: number; column: number } {
  return { path: evidence.path, line: evidence.line, column: evidence.column };
}

function finding(
  code: string,
  severity: GameplayPreparationFinding['severity'],
  scope: GameplayPreparationFinding['scope'],
  message: string,
  nextAction: string,
  evidence: GameplayPreparationFinding['evidence'] = [],
): GameplayPreparationFinding {
  return { code, severity, scope, message, nextAction, evidence };
}

function flowId(fact: GameplayEventFact): string {
  const evidence = fact.evidence.find((entry) => entry.kind === 'event-registration') ?? fact.evidence[0]!;
  return `flow-${sha256Hex(`${fact.event}\0${fact.side}\0${evidence.path}\0${evidence.line}\0${evidence.column}`).slice(0, 20)}`;
}

function handlerId(fact: GameplayEventFact): string {
  return `auto-handler-${flowId(fact).slice('flow-'.length)}`;
}

function branchId(fact: GameplayEventFact): string {
  return `auto-branch-${sha256Hex(`${flowId(fact)}\0branch`).slice(0, 20)}`;
}

function registrationEvidence(fact: GameplayEventFact): GameplaySourceEvidence {
  return fact.evidence.find((entry) => entry.kind === 'event-registration') ?? fact.evidence[0]!;
}

function executable(fact: GameplayEventFact): boolean {
  return fact.side !== 'unknown'
    && (fact.writes.length > 0 || fact.emits.length > 0 || fact.observableCalls.length > 0);
}

function metadataFor(
  event: string,
  metadata: ReadonlyMap<string, ResolvedEventMetadata>,
): ResolvedEventMetadata | undefined {
  return metadata.get(event) ?? metadata.get(event.replace(/^Events\./u, ''));
}

function eventSource(policy: NonNullable<GameplayModel['eventPolicies']>[number]): 'client' | 'server' | 'engine' {
  if (policy.authority === 'engine') return 'engine';
  if (policy.authority === 'client-request') return 'client';
  return 'server';
}

function scenarioLimits(): GameplayScenario['limits'] {
  return { maxEvents: 100, maxVirtualMilliseconds: 60_000, maxVisitedStates: 500, maxBranches: 500 };
}

function dispatchFor(
  handler: GameplayModel['handlers'][number],
  policy: NonNullable<GameplayModel['eventPolicies']>[number],
  playerId: string,
  deliveryId: string,
): GameplayDispatchAction {
  return {
    event: handler.event,
    source: eventSource(policy),
    targetSide: handler.side,
    deliveryId,
    ...(policy.playerRequired ? { playerId } : {}),
  };
}

function scenariosFor(
  model: GameplayModel,
  findings: GameplayPreparationFinding[],
  skippedFlows: GameplaySkippedFlow[],
): GameplayScenario[] {
  const handlers = [...model.handlers].sort((a, b) => a.handlerId.localeCompare(b.handlerId, 'en'));
  const policies = new Map((model.eventPolicies ?? []).map((policy) => [policy.event, policy]));
  const emitted = new Set(handlers.flatMap((handler) => handler.branches.flatMap((branch) => branch.effects
    .flatMap((effect) => effect.kind === 'emit' ? [effect.event] : []))));
  // Each dispatch executes all handlers of the same event and side. Prefer chain roots,
  // then stable independent entrances; six scenarios per entrance fit the 32-scenario budget.
  const entrances = [...new Map(handlers.map((handler) => [`${handler.side}\0${handler.event}`, handler])).values()]
    .sort((a, b) => Number(emitted.has(a.event)) - Number(emitted.has(b.event))
      || a.handlerId.localeCompare(b.handlerId, 'en'));
  const selected = entrances.slice(0, 5);
  for (const entrance of entrances.slice(5)) {
    const omitted = handlers.filter((handler) => handler.event === entrance.event && handler.side === entrance.side);
    for (const handler of omitted) skippedFlows.push({
      flowId: handler.handlerId.replace(/^auto-handler-/u, 'flow-'),
      reasonCode: 'GAMEPLAY_ENTRANCE_SCENARIO_BUDGET', needsEditor: true, evidence: [],
    });
  }
  if (entrances.length > selected.length) findings.push(finding(
    'GAMEPLAY_ENTRANCE_SCENARIO_BUDGET', 'partial', 'flow',
    `自动入口预算已覆盖 ${selected.length}/${entrances.length} 个事件/运行端组合；其余入口未单独验证多人竞争。`,
    '按未覆盖入口拆分人工场景后复查，并保留官方编辑器多人验收。',
  ));
  const binding = () => ({ modelId: model.modelId, modelFingerprint: gameplayModelFingerprint(model), ...model.project });
  const output: GameplayScenario[] = [];
  for (const handler of selected) {
    const policy = policies.get(handler.event);
    if (policy === undefined) continue;
    const hash = sha256Hex(handler.handlerId).slice(0, 12);
    const base = { schemaVersion: 1 as const, modelBinding: binding(), limits: scenarioLimits() };
    const dispatch = (player: string, purpose: string) => dispatchFor(handler, policy, player, `${purpose}-${hash}`);
    output.push({
      ...base, scenarioId: `auto-single-${hash}`, name: `自动单人入口及事件链：${handler.event}（${handler.side}）`,
      players: ['p1'], steps: [{ kind: 'dispatch', ...dispatch('p1', 'single') }],
    });
    const duplicate = dispatch('p1', 'duplicate');
    output.push({
      ...base, scenarioId: `auto-duplicate-${hash}`, name: `自动重复回调：${handler.event}（${handler.side}）`,
      players: ['p1'], steps: [{ kind: 'dispatch', ...duplicate }, { kind: 'dispatch', ...duplicate }],
    });
    output.push({
      ...base, scenarioId: `auto-rejoin-${hash}`, name: `自动离开重进：${handler.event}（${handler.side}）`,
      players: ['p1'], steps: [
        { kind: 'leave', playerId: 'p1' }, { kind: 'join', playerId: 'p1' },
        { kind: 'dispatch', ...dispatch('p1', 'rejoin') },
      ],
    });
    for (const count of [2, 4, 8]) {
      const players = Array.from({ length: count }, (_, index) => `p${index + 1}`);
      output.push({
        ...base, scenarioId: count === 2 ? `auto-interleaving-${hash}` : `auto-population-${count}-${hash}`,
        name: `自动${count}人同帧竞争：${handler.event}（${handler.side}）`,
        players, exploreReadyEventInterleavings: true,
        steps: [{
          kind: 'parallel', exploreInterleavings: true,
          actions: players.map((player) => dispatch(player, `population-${count}-${player}`)),
        }],
      });
    }
  }
  // Preserve dedicated chain diagnostics without exceeding the existing 32-scenario cap.
  for (const handler of selected.filter((entry) => !emitted.has(entry.event)
    && entry.branches.some((branch) => branch.effects.some((effect) => effect.kind === 'emit'))).slice(0, 2)) {
    const policy = policies.get(handler.event)!;
    const hash = sha256Hex(`chain\0${handler.handlerId}`).slice(0, 12);
    output.push({
      schemaVersion: 1, scenarioId: `auto-chain-${hash}`, name: `自动事件链路：${handler.event}（${handler.side}）`,
      modelBinding: binding(), limits: scenarioLimits(), players: ['p1'],
      steps: [{ kind: 'dispatch', ...dispatchFor(handler, policy, 'p1', `chain-${hash}`) }],
    });
  }
  return output.map((scenario) => parseGameplayScenario(scenario));
}

function relevantSceneIds(input: {
  productionSourceIndex: LuaSourceIndex;
  productionPaths: ReadonlySet<string>;
  facts: readonly GameplayEventFact[];
  sceneSnapshot: SceneSnapshot | null;
  focus?: { text: string | null; changedFiles: string[] };
}): Set<string> {
  const ids = new Set<string>();
  // 配置字段和普通 Element API 参数也会被 source-index 标成
  // scene-instance；它们并不等于“这个触发盒是本次事件入口”。只有回调
  // 明确守卫、事实守卫、已观察信号或用户 focus 才能进入自动绑定候选。
  for (const call of input.productionSourceIndex.calls) {
    if (!input.productionPaths.has(call.path)) continue;
    for (const id of call.sceneInstanceGuards ?? []) ids.add(id);
  }
  for (const fact of input.facts) for (const id of fact.sceneInstanceGuards) ids.add(id);

  const usedSignals = new Set(input.productionSourceIndex.signalReferences
    .filter((reference) => input.productionPaths.has(reference.path))
    .map((reference) => reference.value));
  for (const instance of input.sceneSnapshot?.instances ?? []) {
    if (instance.signals.state === 'observed' && instance.signals.value.some((signal) => usedSignals.has(signal.name))) {
      ids.add(instance.instanceId);
    }
  }
  for (const match of input.focus?.text?.matchAll(/(?<!\d)\d{1,32}(?!\d)/gu) ?? []) ids.add(match[0]);
  return ids;
}

export function autoPrepareGameplay(input: {
  project: GameplayModel['project'];
  luaFiles: readonly LuaSourceFile[];
  productionSourceIndex: LuaSourceIndex;
  eventMetadata: ReadonlyMap<string, ResolvedEventMetadata>;
  registry: RegistryDocument;
  uiSnapshot: UiSnapshot | null;
  sceneSnapshot: SceneSnapshot | null;
  runtimeCapabilities: ReadonlyMap<string, CapabilityEvidenceResolution>;
  focus?: { text: string | null; changedFiles: string[] };
}): GameplayAutoPreparation {
  const productionScope = resolveGameplayProductionScope(input.luaFiles);
  const productionPaths = new Set(productionScope.reachablePaths);
  const productionFiles = input.luaFiles
    .map((file) => ({ ...file, path: file.path.replace(/\\/gu, '/') }))
    .filter((file) => productionPaths.has(file.path));
  const luaFacts = extractGameplayLuaFacts({ files: productionFiles, eventMetadata: input.eventMetadata });
  const findings: GameplayPreparationFinding[] = [...productionScope.findings, ...luaFacts.findings];
  const skippedFlows: GameplaySkippedFlow[] = [];

  for (const entry of luaFacts.unmodeled) findings.push(finding(
    entry.code,
    'partial',
    'flow',
    entry.reason,
    '保留该流程供官方编辑器补测，不从动态 Lua 猜测效果。',
    [sourcePoint(entry.evidence)],
  ));

  const executableFacts: GameplayEventFact[] = [];
  for (const fact of luaFacts.events) {
    if (!executable(fact)) {
      const reasonCode = fact.side === 'unknown'
        ? 'GAMEPLAY_EVENT_SIDE_UNMODELED'
        : 'GAMEPLAY_HANDLER_NO_OBSERVABLE_EFFECT';
      skippedFlows.push({
        flowId: flowId(fact),
        reasonCode,
        needsEditor: true,
        evidence: [sourcePoint(registrationEvidence(fact))],
      });
      findings.push(finding(
        reasonCode, 'partial', 'flow',
        fact.side === 'unknown' ? `事件 ${fact.event} 的运行端不能安全确定。` : `事件 ${fact.event} 没有可建模的可观察效果。`,
        '在官方文档或编辑器中确认运行端和实际效果。',
        [sourcePoint(registrationEvidence(fact))],
      ));
      continue;
    }
    if (fact.event.startsWith('Events.') && metadataFor(fact.event, input.eventMetadata)?.generationEligibility !== 'allowed') {
      skippedFlows.push({
        flowId: flowId(fact), reasonCode: 'GAMEPLAY_EVENT_METADATA_BLOCKED', needsEditor: true,
        evidence: [sourcePoint(registrationEvidence(fact))],
      });
      findings.push(finding(
        'GAMEPLAY_EVENT_METADATA_BLOCKED', 'partial', 'flow',
        `官方事件 ${fact.event} 缺少无冲突的运行端和回调元数据。`,
        '刷新官方事件文档，或在编辑器中补测该独立流程。',
        [sourcePoint(registrationEvidence(fact))],
      ));
      continue;
    }
    executableFacts.push(fact);
  }

  const executableEvents = new Set(executableFacts.map((fact) => fact.event));
  const emittedTo = new Map<string, Array<{ fact: GameplayEventFact; playerRouted: boolean }>>();
  for (const fact of executableFacts) for (const emit of fact.emits) {
    const entries = emittedTo.get(emit.event) ?? [];
    entries.push({ fact, playerRouted: emit.playerParameterIndex !== null || emit.routing === 'broadcast' });
    emittedTo.set(emit.event, entries);
  }

  const sharedMarkerState: Record<string, boolean> = {};
  const clientMarkerState: Record<string, boolean> = {};
  const handlers: GameplayModel['handlers'] = executableFacts.map((fact) => {
    const marker = `e_${sha256Hex(flowId(fact)).slice(0, 20)}`;
    const markerScope = fact.side === 'client' ? 'client' : 'shared';
    (markerScope === 'client' ? clientMarkerState : sharedMarkerState)[marker] = false;
    const effects: GameplayEffect[] = [];
    for (const emit of fact.emits) {
      if (!executableEvents.has(emit.event)) {
        findings.push(finding(
          'GAMEPLAY_EMIT_TARGET_UNMODELED', 'partial', 'flow',
          `事件 ${fact.event} 发送到未建模目标 ${emit.event}。`,
          '保留该发送链供官方编辑器验证。',
          [sourcePoint(emit.evidence)],
        ));
        continue;
      }
      if (emit.delay?.unit === 'frames') {
        findings.push(finding(
          'GAMEPLAY_FRAME_TIMER_NEEDS_EDITOR', 'partial', 'flow',
          `事件 ${emit.event} 使用帧延时，不能无证据换算为毫秒。`,
          '在官方编辑器验证帧计时顺序。',
          [sourcePoint(emit.evidence)],
        ));
        continue;
      }
      effects.push({
        kind: 'emit',
        event: emit.event,
        delayMilliseconds: emit.delay?.value ?? 0,
        ...(emit.routing === 'unknown' ? {} : {
          routing: emit.routing === 'same-player' && emit.playerParameterIndex === null ? 'without-player' as const : emit.routing,
        }),
        ...(emit.targetSide === 'unknown' ? {} : { targetSide: emit.targetSide }),
      });
    }
    if (fact.writes.length > 0) findings.push(finding(
      'GAMEPLAY_STATE_OWNERSHIP_UNMODELED', 'partial', 'flow',
      `事件 ${fact.event} 存在可定位状态写，但共享/玩家/客户端所有权没有证明。`,
      '自动模型只记录处理器已执行；在确认所有权前不解释业务状态。',
      fact.writes.map((write) => sourcePoint(write.evidence)),
    ));
    effects.push({
      kind: 'set',
      target: { scope: markerScope, path: `__observed.${marker}` },
      value: { kind: 'literal', value: true },
    });
    return {
      handlerId: handlerId(fact),
      event: fact.event,
      side: fact.side as 'server' | 'client',
      branches: [{ branchId: branchId(fact), effects, coverageRequired: false }],
    };
  });

  const handlerByFlow = new Map(executableFacts.map((fact, index) => [flowId(fact), handlers[index]!]));
  const policyEvents = [...new Set(executableFacts.map((fact) => fact.event))].sort((left, right) => left.localeCompare(right, 'en'));
  const eventPolicies: NonNullable<GameplayModel['eventPolicies']> = policyEvents.map((event) => {
    const eventFacts = executableFacts.filter((fact) => fact.event === event);
    const sides = new Set(eventFacts.map((fact) => fact.side));
    const producers = emittedTo.get(event) ?? [];
    const engineEvent = event.startsWith('Events.');
    return {
      event,
      authority: engineEvent ? 'engine' as const : producers.some((entry) => entry.fact.side === 'client') ? 'client-request' as const : 'server-only' as const,
      // 客户端本地状态天然按玩家隔离；即使官方回调本身没有显式
      // playerId 参数，模型分发也必须绑定到当前玩家，才能安全模拟
      // 双人隔离而不把 client state 当成共享状态。
      playerRequired: INTERACTION_BY_EVENT.has(event)
        || eventFacts.some((fact) => fact.side === 'client')
        || producers.some((entry) => entry.playerRouted),
      duplicatePolicy: 'allow' as const,
      targetSide: sides.size > 1 ? 'both' as const : eventFacts[0]!.side as 'server' | 'client',
      // 自动模型只证明处理器可达；marker 不是业务效果，不能据此要求每次重复投递都改变状态。
      observableEffectRequired: false,
    };
  });

  const relevantIds = relevantSceneIds({
    productionSourceIndex: input.productionSourceIndex,
    productionPaths,
    facts: luaFacts.events,
    sceneSnapshot: input.sceneSnapshot,
    ...(input.focus === undefined ? {} : { focus: input.focus }),
  });
  const sceneEventBindings: NonNullable<GameplayModel['sceneEventBindings']> = [];
  const sceneInstances = new Map<string, NonNullable<typeof input.sceneSnapshot>['instances']>();
  for (const instance of input.sceneSnapshot?.instances ?? []) {
    const entries = sceneInstances.get(instance.instanceId) ?? [];
    entries.push(instance);
    sceneInstances.set(instance.instanceId, entries);
  }
  const unresolvedRelevantTriggers: Array<{ id: string; evidence: GameplayPreparationFinding['evidence'] }> = [];
  for (const id of [...relevantIds].sort((left, right) => left.localeCompare(right, 'en'))) {
    const candidates = sceneInstances.get(id) ?? [];
    if (candidates.length !== 1) {
      unresolvedRelevantTriggers.push({ id, evidence: [] });
      continue;
    }
    const runtime = input.runtimeCapabilities.get(id);
    const intelligence = resolveSceneInstanceIntelligence(
      candidates[0]!, runtime?.state === 'unique' ? runtime.evidence : null,
    );
    if (intelligence.actorFamily !== 'trigger-box') continue;
    const facts = executableFacts.filter((fact) => fact.sceneInstanceGuards.includes(id) && INTERACTION_BY_EVENT.has(fact.event));
    if (facts.length !== 1) {
      const evidence = luaFacts.events
        .filter((fact) => fact.sceneInstanceGuards.includes(id))
        .map((fact) => sourcePoint(registrationEvidence(fact)));
      unresolvedRelevantTriggers.push({ id, evidence });
      continue;
    }
    const fact = facts[0]!;
    const handler = handlerByFlow.get(flowId(fact))!;
    sceneEventBindings.push({
      instanceId: id,
      status: 'event-bound',
      interaction: INTERACTION_BY_EVENT.get(fact.event)!,
      eventName: fact.event,
      handlerId: handler.handlerId,
    });
  }

  for (const unresolved of unresolvedRelevantTriggers) {
    const severity = handlers.length === 0 ? 'fatal' : 'partial';
    findings.push(finding(
      'GAMEPLAY_RELEVANT_TRIGGER_UNMODELED', severity, 'flow',
      `生产 Lua 引用了信号触发盒 ${unresolved.id}，但事件、运行端或唯一处理器不能闭合。`,
      severity === 'fatal' ? '先确认该唯一入口的官方事件、运行端和 handler。' : '跳过该独立流程，并在官方编辑器中补测。',
      unresolved.evidence,
    ));
    skippedFlows.push({
      flowId: `trigger-${sha256Hex(unresolved.id).slice(0, 20)}`,
      reasonCode: 'GAMEPLAY_RELEVANT_TRIGGER_UNMODELED',
      needsEditor: true,
      evidence: unresolved.evidence,
    });
  }

  if (handlers.length === 0) findings.push(finding(
    'GAMEPLAY_NO_EXECUTABLE_HANDLERS', 'fatal', 'flow',
    '生产范围没有运行端和可观察效果均可确定的处理器。',
    '补齐官方事件元数据或在编辑器确认至少一个玩法入口。',
  ));

  const modelCandidate: GameplayModel = {
    schemaVersion: 1,
    modelId: `auto-${sha256Hex(`${input.project.projectInstanceId}\0${input.project.knowledgeFingerprint}\0${executableFacts.map(flowId).join('\0')}`).slice(0, 24)}`,
    project: { ...input.project },
    externalEvents: policyEvents,
    eventPolicies,
    initialState: {
      shared: Object.keys(sharedMarkerState).length === 0 ? {} : { __observed: sharedMarkerState },
      player: {},
      client: Object.keys(clientMarkerState).length === 0 ? {} : { __observed: clientMarkerState },
    },
    handlers,
    invariants: [],
    evidenceRequirements: [{
      requirementId: 'official-editor-runtime',
      kind: 'network-ordering',
      state: 'unverified',
      description: '模型模拟不能替代官方编辑器中的引擎、网络与真实多人验证。',
    }],
    ...(sceneEventBindings.length === 0 ? {} : { sceneEventBindings }),
    multiplayer: { maximumPlayers: 8, rejoinPolicy: 'retain-player-reset-client' },
  };
  const model = parseGameplayModel(modelCandidate);
  const scenarios = findings.some((entry) => entry.severity === 'fatal') ? [] : scenariosFor(model, findings, skippedFlows);
  if (scenarios.length === 0 && !findings.some((entry) => entry.code === 'GAMEPLAY_NO_EXECUTABLE_HANDLERS')) findings.push(finding(
    'GAMEPLAY_NO_EXECUTABLE_SCENARIOS', 'fatal', 'artifact',
    '自动准备没有生成任何非空玩法场景。',
    '确认至少一个可执行事件入口后重试。',
  ));

  return { mode: 'auto', model, scenarios, productionScope, findings, skippedFlows };
}
