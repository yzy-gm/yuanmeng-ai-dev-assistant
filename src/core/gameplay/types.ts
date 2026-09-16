import type { EvidenceLevel } from '../errors.js';

export type GameplayPrimitive = null | boolean | number | string;
export type GameplayValue = GameplayPrimitive | GameplayValue[] | { [key: string]: GameplayValue };
export type GameplayStateScope = 'shared' | 'player' | 'client';
export type GameplayEventTargetSide = 'server' | 'client' | 'both';
export type GameplayRunMode = 'auto' | 'manual';
export type GameplayRunClassification =
  | 'model-pass'
  | 'model-fail'
  | 'partial-needs-editor'
  | 'not-run-fatal';

export interface GameplayPreparationFinding {
  code: string;
  severity: 'fatal' | 'partial' | 'info';
  scope: 'project' | 'flow' | 'artifact';
  message: string;
  nextAction: string;
  evidence: Array<{ path: string; line: number; column: number }>;
}

export interface GameplaySkippedFlow {
  flowId: string;
  reasonCode: string;
  needsEditor: boolean;
  evidence: Array<{ path: string; line: number; column: number }>;
}

export interface GameplaySimulationGate {
  schemaVersion: 1;
  status: 'pass' | 'blocked';
  fatalFindings: GameplayPreparationFinding[];
  skippedFindings: GameplayPreparationFinding[];
}

export interface GameplayRunSummary {
  mode: GameplayRunMode;
  classification: GameplayRunClassification;
  strictStaticGate: 'pass' | 'blocked';
  simulationGate: GameplaySimulationGate['status'];
  executedScenarioIds: string[];
  skippedFlows: GameplaySkippedFlow[];
  truncated: boolean;
}

export interface GameplayRunManifest {
  schemaVersion: 1;
  runId: string;
  mode: GameplayRunMode;
  project: GameplayModel['project'];
  modelFingerprint: string;
  scenarioFingerprint: string;
  strictStaticGate: 'pass' | 'blocked';
  simulationGate: GameplaySimulationGate['status'];
  classification: GameplayRunClassification;
  completed: true;
  artifactSha256: Record<string, string>;
}

export interface GameplayLatestPointer {
  schemaVersion: 1;
  runId: string;
  projectInstanceId: string;
  knowledgeFingerprint: string;
  mode: GameplayRunMode;
  classification: GameplayRunClassification;
}

export interface GameplayProductionScope {
  entryPath: 'src/GameEntry.lua';
  reachablePaths: string[];
  excludedPaths: string[];
  unresolvedRequires: Array<{ from: string; module: string }>;
  findings: GameplayPreparationFinding[];
}

export interface GameplaySourceEvidence {
  path: string;
  line: number;
  column: number;
  kind: 'event-registration' | 'state-write' | 'event-emission' | 'timer' | 'observable-call' | 'scene-guard';
}

export interface GameplayDelayFact {
  unit: 'frames' | 'milliseconds';
  value: number;
}

export interface GameplayStateWriteFact {
  target: string;
  operation: 'set' | 'add';
  value: GameplayPrimitive;
  delay: GameplayDelayFact | null;
  evidence: GameplaySourceEvidence;
}

export interface GameplayEmitFact {
  event: string;
  targetSide: 'server' | 'client' | 'unknown';
  routing: 'same-player' | 'broadcast' | 'without-player' | 'unknown';
  playerParameterIndex: number | null;
  delay: GameplayDelayFact | null;
  evidence: GameplaySourceEvidence;
}

export interface GameplayEventFact {
  event: string;
  side: 'server' | 'client' | 'unknown';
  callbackParameters: string[];
  sceneInstanceGuards: string[];
  writes: GameplayStateWriteFact[];
  emits: GameplayEmitFact[];
  observableCalls: GameplaySourceEvidence[];
  evidence: GameplaySourceEvidence[];
}

export interface GameplayUnmodeledFact {
  code: string;
  reason: string;
  evidence: GameplaySourceEvidence;
}

export interface GameplayLuaFacts {
  schemaVersion: 1;
  events: GameplayEventFact[];
  unmodeled: GameplayUnmodeledFact[];
  findings: GameplayPreparationFinding[];
}

export interface GameplayAutoPreparation {
  mode: 'auto';
  model: GameplayModel;
  scenarios: GameplayScenario[];
  productionScope: GameplayProductionScope;
  findings: GameplayPreparationFinding[];
  skippedFlows: GameplaySkippedFlow[];
}

export interface GameplayStateRef {
  scope: GameplayStateScope;
  path: string;
  playerId?: string;
}

export type GameplayExpression =
  | { kind: 'literal'; value: GameplayValue }
  | { kind: 'read'; ref: GameplayStateRef }
  | { kind: 'not'; value: GameplayExpression }
  | { kind: 'all' | 'any'; values: GameplayExpression[] }
  | {
    kind: 'compare';
    operator: 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte';
    left: GameplayExpression;
    right: GameplayExpression;
  };

export type GameplayEffect =
  | { kind: 'set'; target: GameplayStateRef; value: GameplayExpression; allowCrossPlayer?: boolean }
  | { kind: 'add'; target: GameplayStateRef; value: GameplayExpression; allowCrossPlayer?: boolean }
  | {
    kind: 'emit';
    event: string;
    delayMilliseconds: number;
    routing?: 'same-player' | 'broadcast' | 'without-player';
    targetSide?: GameplayEventTargetSide;
  };

export interface GameplayBranch {
  branchId: string;
  when?: GameplayExpression;
  effects: GameplayEffect[];
  coverageRequired?: boolean;
}

export interface GameplayHandler {
  handlerId: string;
  event: string;
  side: 'server' | 'client';
  branches: GameplayBranch[];
}

export type GameplayInvariant =
  | { invariantId: string; kind: 'non-negative'; ref: GameplayStateRef }
  | { invariantId: string; kind: 'range'; ref: GameplayStateRef; minimum?: number; maximum?: number }
  | { invariantId: string; kind: 'equals'; ref: GameplayStateRef; value: GameplayValue };

export interface GameplayEvidenceRequirement {
  requirementId: string;
  kind: 'npc-reachability' | 'physics-contact' | 'camera-appearance' | 'network-ordering' | 'scene-bounds';
  state: 'confirmed' | 'unverified' | 'stale';
  description: string;
  evidence?: EvidenceLevel;
}

export interface GameplaySceneEventBinding {
  instanceId: string;
  status: 'unconfirmed' | 'event-bound' | 'not-used';
  interaction:
    | 'character-enter-trigger'
    | 'character-leave-trigger'
    | 'element-enter-trigger'
    | 'element-leave-trigger'
    | 'logic-element-enter-trigger'
    | 'logic-element-leave-trigger'
    | 'creature-enter-trigger'
    | 'creature-leave-trigger'
    | 'player-touch-element'
    | 'element-touch-player'
    | null;
  eventName: string | null;
  handlerId: string | null;
}

export interface GameplayModel {
  schemaVersion: 1;
  modelId: string;
  project: {
    projectInstanceId: string;
    mapFingerprint: string | null;
    sceneSnapshotId: string | null;
    knowledgeFingerprint: string;
  };
  externalEvents: string[];
  eventPolicies?: Array<{
    event: string;
    authority: 'client-request' | 'server-only' | 'engine';
    playerRequired: boolean;
    duplicatePolicy: 'allow' | 'must-be-idempotent';
    completion?: 'must-drain' | 'may-remain';
    targetSide?: GameplayEventTargetSide;
    observableEffectRequired: boolean;
  }>;
  initialState: {
    shared: Record<string, GameplayValue>;
    player: Record<string, GameplayValue>;
    client: Record<string, GameplayValue>;
  };
  handlers: GameplayHandler[];
  invariants: GameplayInvariant[];
  evidenceRequirements: GameplayEvidenceRequirement[];
  sceneEventBindings?: GameplaySceneEventBinding[];
  multiplayer?: {
    maximumPlayers: number;
    rejoinPolicy: 'retain-player-reset-client' | 'reset-all';
  };
}

export interface GameplayDispatchAction {
  event: string;
  playerId?: string;
  source?: 'client' | 'server' | 'engine';
  deliveryId?: string;
  targetSide?: GameplayEventTargetSide;
}

export type GameplayScenarioStep =
  | ({ kind: 'dispatch' } & GameplayDispatchAction)
  | { kind: 'parallel'; actions: GameplayDispatchAction[]; exploreInterleavings?: boolean }
  | { kind: 'join'; playerId: string }
  | { kind: 'leave'; playerId: string }
  | { kind: 'advance'; milliseconds: number }
  | {
    kind: 'expect';
    ref: GameplayStateRef;
    operator: 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte';
    value: GameplayValue;
  };

export interface GameplayScenario {
  schemaVersion: 1;
  scenarioId: string;
  name: string;
  modelBinding: GameplayModel['project'] & { modelId: string; modelFingerprint: string };
  players: string[];
  initialConnectedPlayers?: string[];
  exploreReadyEventInterleavings?: boolean;
  limits: {
    maxEvents: number;
    maxVirtualMilliseconds: number;
    maxVisitedStates: number;
    maxBranches: number;
  };
  steps: GameplayScenarioStep[];
}

export interface GameplayStaticFinding {
  code: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
  evidence: 'STATIC_LOCAL';
  nextAction: string;
}

export interface GameplayStaticGateFinding extends GameplayStaticFinding {
  source: 'model' | 'project' | 'event-documentation';
}

export interface GameplayStaticGate {
  schemaVersion: 1;
  status: 'pass' | 'blocked';
  findings: GameplayStaticGateFinding[];
}

export interface GameplayRuntimeState {
  shared: Record<string, GameplayValue>;
  players: Record<string, Record<string, GameplayValue>>;
  clients: Record<string, Record<string, GameplayValue>>;
  connections: Record<string, 'connected' | 'disconnected'>;
  connectionEpochs: Record<string, number>;
}

export interface GameplayTraceEntry {
  sequence: number;
  virtualMilliseconds: number;
  stepIndex: number;
  event: string;
  playerId: string | null;
  source: 'client' | 'server' | 'engine';
  targetSide: Exclude<GameplayEventTargetSide, 'both'>;
  deliveryId: string | null;
  routing: 'direct' | 'same-player' | 'broadcast' | 'without-player';
  broadcastId: string | null;
  broadcastExpectedPlayerIds: string[] | null;
  deliveryOutcome: 'handled' | 'rejected-player-routing' | 'rejected-authority' | 'rejected-connection' | 'no-handler' | 'simulation-error';
  handlers: string[];
  branches: string[];
}

export interface GameplayFailure {
  code: 'EXPECTATION_FAILED' | 'INVARIANT_FAILED' | 'EVENT_LIMIT_EXCEEDED' | 'VIRTUAL_TIME_LIMIT_EXCEEDED'
    | 'STATE_LIMIT_EXCEEDED' | 'BRANCH_LIMIT_EXCEEDED' | 'PLAYER_NOT_CONNECTED'
    | 'LATE_EVENT_FOR_DISCONNECTED_PLAYER' | 'PLAYER_ROUTING_MISSING' | 'UNAUTHORIZED_EVENT_SOURCE'
    | 'DUPLICATE_EVENT_CHANGED_STATE' | 'PENDING_CRITICAL_EVENTS' | 'NO_HANDLER_FOR_TARGET'
    | 'NO_OBSERVABLE_EFFECT' | 'PLAYER_ALREADY_CONNECTED' | 'AMBIGUOUS_BRANCH_MATCH' | 'SIMULATION_ERROR';
  stepIndex: number;
  message: string;
  ref?: GameplayStateRef;
  expected?: GameplayValue;
  actual?: GameplayValue;
}

export interface GameplaySimulationResult {
  schemaVersion: 1;
  reportId: string;
  modelId: string;
  scenarioId: string;
  status: 'blocked' | 'fail' | 'needs-editor' | 'pass';
  mode: 'single-player' | 'multiplayer';
  playerCount: number;
  staticFindings: GameplayStaticFinding[];
  failures: GameplayFailure[];
  editorRequirements: GameplayEvidenceRequirement[];
  trace: GameplayTraceEntry[];
  finalState: GameplayRuntimeState;
  coverage: {
    totalBranches: number;
    visitedBranches: number;
    ratio: number;
    unvisitedBranchIds: string[];
  };
  readyInterleavings: {
    choices: number[];
    branchWidths: number[];
  };
}

export interface GameplayScheduleResult {
  scheduleId: string;
  dispatchOrder: GameplayDispatchAction[];
  scenarioSteps: GameplayScenarioStep[];
  result: GameplaySimulationResult;
}

export interface GameplayMultiplayerMatrixResult {
  schemaVersion: 1;
  status: GameplaySimulationResult['status'];
  schedulesExplored: number;
  truncated: boolean;
  schedules: GameplayScheduleResult[];
}

export interface GameplayPopulationResult {
  playerCount: number;
  mode: 'single-player' | 'multiplayer';
  scenarioId: string;
  status: GameplaySimulationResult['status'];
  schedulesExplored: number;
  truncated: boolean;
  matrix: GameplayMultiplayerMatrixResult;
  scenarioResults: Array<{
    scenarioId: string;
    status: GameplaySimulationResult['status'];
    schedulesExplored: number;
    truncated: boolean;
  }>;
}

export interface GameplayPopulationMatrixResult {
  schemaVersion: 1;
  status: GameplaySimulationResult['status'];
  requiredPlayerCounts: number[];
  populations: GameplayPopulationResult[];
}

export type GameplayKnowledgeNodeKind =
  | 'lua-file'
  | 'lua-signal'
  | 'registry-record'
  | 'ui-control'
  | 'scene-instance'
  | 'scene-group'
  | 'scene-signal'
  | 'scene-property'
  | 'scene-metadata';

export interface GameplayKnowledgeNode {
  nodeId: string;
  kind: GameplayKnowledgeNodeKind;
  label: string;
  externalId: string | null;
  evidence: 'confirmed' | 'inferred' | 'candidate';
}

export interface GameplayKnowledgeEdge {
  edgeId: string;
  kind: 'declares' | 'references' | 'parent-of' | 'member-of' | 'same-value';
  from: string;
  to: string;
}

export interface GameplayKnowledgeGraph {
  schemaVersion: 1;
  nodes: GameplayKnowledgeNode[];
  edges: GameplayKnowledgeEdge[];
}

export interface GameplayDraftAssumption {
  assumptionId: string;
  kind: 'signal-semantics' | 'state-ownership' | 'idempotency' | 'ui-result' | 'scene-meaning'
    | 'scene-event-compatibility' | 'scene-event-capability' | 'resource-bounds' | 'transaction-contract' | 'task-prerequisite' | 'upgrade-prerequisite';
  status: 'needs-user-confirmation';
  prompt: string;
  evidenceNodeIds: string[];
}

export interface GameplayKnowledgeDraft {
  schemaVersion: 1;
  requiresUserConfirmation: true;
  model: GameplayModel;
  graph: GameplayKnowledgeGraph;
  assumptions: GameplayDraftAssumption[];
  sourceFindings: GameplayStaticFinding[];
}

export interface GameplayTestReportFinding {
  source: 'model' | 'project' | 'event-documentation' | 'scenario';
  code: string;
  severity: GameplayStaticFinding['severity'];
  message: string;
  nextAction: string;
}

export interface GameplayTestReport {
  schemaVersion: 1;
  reportId: string;
  modelFingerprint: string;
  reviewPackageId: string;
  modelId: string;
  project: GameplayModel['project'];
  status: GameplaySimulationResult['status'];
  evidence: {
    staticReview: 'STATIC_LOCAL';
    modelSimulation: 'UNIT_E2E';
    sceneEvidence: 'CONFIRMED' | 'CANDIDATE' | 'STALE' | 'NOT_AVAILABLE';
    officialEditor: 'REQUIRED_FOR_ENGINE_BEHAVIOR';
  };
  staticGate: GameplayStaticGate['status'];
  runSummary?: GameplayRunSummary;
  findings: GameplayTestReportFinding[];
  populations: Array<{
    playerCount: number;
    mode: GameplayPopulationResult['mode'];
    status: GameplaySimulationResult['status'];
    schedulesExplored: number;
    truncated: boolean;
    scenarios: GameplayPopulationResult['scenarioResults'];
    firstFailure: GameplayFailure | null;
    firstFailingScheduleId: string | null;
    minimalReproduction: {
      scenarioSteps: GameplayScenarioStep[];
      trace: Array<Pick<GameplayTraceEntry, 'sequence' | 'stepIndex' | 'event' | 'playerId' | 'source' | 'targetSide' | 'routing'>>;
      readyInterleavings: GameplaySimulationResult['readyInterleavings'];
    } | null;
    playerStateDiffs: Array<{
      playerId: string;
      serverChangedKeys: string[];
      clientChangedKeys: string[];
    }>;
    broadcastDeliveries: Array<{
      scheduleId: string;
      broadcastId: string;
      event: string;
      expectedRecipientPlayerIds: string[];
      actualRecipientPlayerIds: string[];
      missingRecipientPlayerIds: string[];
      unexpectedRecipientPlayerIds: string[];
    }>;
    crossPlayerIsolation: 'no-modeled-contamination-observed' | 'failed' | 'not-exercised';
    sharedOutcomes: Array<Record<string, GameplayValue>>;
    editorRequirementIds: string[];
  }>;
  coverage: {
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
      byPlayer: Array<{
        playerId: string;
        visitedBranches: number;
        totalBranches: number;
        ratio: number;
      }>;
    }>;
  };
  nextActions: Array<{
    actionId: string;
    kind: 'fix-static-model' | 'confirm-model-contract' | 'add-regression-scenario' | 'official-editor-test';
    description: string;
    previewTarget: 'spec.json' | 'scenarios' | 'source-review' | 'official-editor';
    evidenceRequired: 'STATIC_LOCAL' | 'UNIT_E2E' | 'OFFICIAL_EDITOR_SINGLE' | 'OFFICIAL_EDITOR_MULTI';
    autoApply: false;
  }>;
  editorRetest: string[];
}
