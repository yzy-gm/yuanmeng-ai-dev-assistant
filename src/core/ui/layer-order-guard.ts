import { join } from 'node:path';

import { ProductError } from '../errors.js';
import { atomicWriteJson, type FileIO } from '../fs.js';
import { sha256Hex } from '../hash.js';
import type { UiNode, UiSnapshot } from '../model.js';

const MIN_REVERSAL_CHILDREN = 3;

export interface UiLayerOrderChild {
  id: string;
  name: string;
  path: string;
  siblingIndex: number;
}

export interface UiLayerOrderGroup {
  parentId: string | null;
  parentPath: string;
  children: UiLayerOrderChild[];
}

export interface UiLayerOrderBaseline {
  schemaVersion: 1;
  projectInstanceId: string;
  mapFingerprint: string | null;
  snapshotId: string;
  createdAt: string;
  groups: UiLayerOrderGroup[];
}

export interface UiLayerOrderReversal {
  parentId: string | null;
  parentPath: string;
  expectedChildIds: string[];
  observedChildIds: string[];
  expectedChildren: UiLayerOrderChild[];
  observedChildren: UiLayerOrderChild[];
}

export interface UiLayerOrderGuardStatus {
  schemaVersion: 1;
  state: 'baseline-created' | 'clean' | 'reversal-detected';
  evaluatedAt: string;
  projectInstanceId: string;
  mapFingerprint: string | null;
  baselineSnapshotId: string;
  candidateSnapshotId: string;
  reversedGroups: UiLayerOrderReversal[];
  evidence: 'STATIC_LOCAL';
  writesOfficialMap: false;
}

export interface UiLayerOrderEvaluation {
  baseline: UiLayerOrderBaseline;
  status: UiLayerOrderGuardStatus;
  promoteCandidate: boolean;
}

export interface UiLayerOrderGuardUpdate extends UiLayerOrderEvaluation {
  baselineRelativePath: string;
  statusRelativePath: string;
  incidentRelativePath: string | null;
}

function parentKey(parentId: string | null): string {
  return parentId === null ? '\u0000ROOT' : parentId;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function orderedChildren(nodes: readonly UiNode[]): UiLayerOrderChild[] | null {
  const seenIds = new Set<string>();
  const seenIndexes = new Set<number>();
  const result: UiLayerOrderChild[] = [];
  for (const node of nodes) {
    if (seenIds.has(node.id) || seenIndexes.has(node.siblingIndex)) return null;
    seenIds.add(node.id);
    seenIndexes.add(node.siblingIndex);
    result.push({
      id: node.id,
      name: node.name,
      path: node.path,
      siblingIndex: node.siblingIndex,
    });
  }
  result.sort((left, right) => left.siblingIndex - right.siblingIndex || compareText(left.id, right.id));
  return result;
}

export function buildUiLayerOrderBaseline(snapshot: UiSnapshot): UiLayerOrderBaseline {
  const nodesById = new Map(snapshot.nodes.map((node) => [node.id, node]));
  const childrenByParent = new Map<string, UiNode[]>();
  for (const node of snapshot.nodes) {
    const key = parentKey(node.parentId);
    const siblings = childrenByParent.get(key) ?? [];
    siblings.push(node);
    childrenByParent.set(key, siblings);
  }

  const groups: UiLayerOrderGroup[] = [];
  for (const siblings of childrenByParent.values()) {
    const children = orderedChildren(siblings);
    if (children === null || children.length === 0) continue;
    const parentId = siblings[0]!.parentId;
    groups.push({
      parentId,
      parentPath: parentId === null ? '/' : nodesById.get(parentId)?.path ?? `#${parentId}`,
      children,
    });
  }
  groups.sort((left, right) => compareText(parentKey(left.parentId), parentKey(right.parentId)));

  return {
    schemaVersion: 1,
    projectInstanceId: snapshot.projectInstanceId,
    mapFingerprint: snapshot.mapFingerprint,
    snapshotId: snapshot.snapshotId,
    createdAt: snapshot.createdAt,
    groups,
  };
}

function sameIds(left: readonly UiLayerOrderChild[], right: readonly UiLayerOrderChild[]): boolean {
  if (left.length !== right.length) return false;
  const rightIds = new Set(right.map((child) => child.id));
  return rightIds.size === right.length && left.every((child) => rightIds.has(child.id));
}

function isExactReverse(left: readonly UiLayerOrderChild[], right: readonly UiLayerOrderChild[]): boolean {
  return left.every((child, index) => child.id === right[right.length - index - 1]?.id);
}

export function detectUiLayerOrderReversals(
  baseline: UiLayerOrderBaseline,
  candidate: UiLayerOrderBaseline,
): UiLayerOrderReversal[] {
  const candidateGroups = new Map(candidate.groups.map((group) => [parentKey(group.parentId), group]));
  const reversals: UiLayerOrderReversal[] = [];
  for (const expected of baseline.groups) {
    if (expected.children.length < MIN_REVERSAL_CHILDREN) continue;
    const observed = candidateGroups.get(parentKey(expected.parentId));
    if (observed === undefined || !sameIds(expected.children, observed.children)) continue;
    if (!isExactReverse(expected.children, observed.children)) continue;
    reversals.push({
      parentId: expected.parentId,
      parentPath: expected.parentPath,
      expectedChildIds: expected.children.map((child) => child.id),
      observedChildIds: observed.children.map((child) => child.id),
      expectedChildren: expected.children,
      observedChildren: observed.children,
    });
  }
  return reversals;
}

function sameIdentity(baseline: UiLayerOrderBaseline, candidate: UiLayerOrderBaseline): boolean {
  return baseline.projectInstanceId === candidate.projectInstanceId
    && baseline.mapFingerprint === candidate.mapFingerprint;
}

function status(
  state: UiLayerOrderGuardStatus['state'],
  baseline: UiLayerOrderBaseline,
  candidate: UiLayerOrderBaseline,
  evaluatedAt: string,
  reversedGroups: UiLayerOrderReversal[],
): UiLayerOrderGuardStatus {
  return {
    schemaVersion: 1,
    state,
    evaluatedAt,
    projectInstanceId: candidate.projectInstanceId,
    mapFingerprint: candidate.mapFingerprint,
    baselineSnapshotId: baseline.snapshotId,
    candidateSnapshotId: candidate.snapshotId,
    reversedGroups,
    evidence: 'STATIC_LOCAL',
    writesOfficialMap: false,
  };
}

export function evaluateUiLayerOrder(
  trustedBaseline: UiLayerOrderBaseline | null,
  candidateSnapshot: UiSnapshot,
  evaluatedAt: string,
): UiLayerOrderEvaluation {
  const candidate = buildUiLayerOrderBaseline(candidateSnapshot);
  if (trustedBaseline === null || !sameIdentity(trustedBaseline, candidate)) {
    return {
      baseline: candidate,
      status: status('baseline-created', candidate, candidate, evaluatedAt, []),
      promoteCandidate: true,
    };
  }

  const reversedGroups = detectUiLayerOrderReversals(trustedBaseline, candidate);
  if (reversedGroups.length > 0) {
    return {
      baseline: trustedBaseline,
      status: status('reversal-detected', trustedBaseline, candidate, evaluatedAt, reversedGroups),
      promoteCandidate: false,
    };
  }

  const promoteCandidate = trustedBaseline.snapshotId !== candidate.snapshotId;
  return {
    baseline: promoteCandidate ? candidate : trustedBaseline,
    status: status('clean', promoteCandidate ? candidate : trustedBaseline, candidate, evaluatedAt, []),
    promoteCandidate,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isLayerOrderChild(value: unknown): value is UiLayerOrderChild {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.name === 'string'
    && typeof value.path === 'string'
    && Number.isSafeInteger(value.siblingIndex);
}

function isLayerOrderGroup(value: unknown): value is UiLayerOrderGroup {
  return isRecord(value)
    && (value.parentId === null || typeof value.parentId === 'string')
    && typeof value.parentPath === 'string'
    && Array.isArray(value.children)
    && value.children.every(isLayerOrderChild);
}

function isLayerOrderReversal(value: unknown): value is UiLayerOrderReversal {
  return isRecord(value)
    && (value.parentId === null || typeof value.parentId === 'string')
    && typeof value.parentPath === 'string'
    && Array.isArray(value.expectedChildIds)
    && value.expectedChildIds.every((id) => typeof id === 'string')
    && Array.isArray(value.observedChildIds)
    && value.observedChildIds.every((id) => typeof id === 'string')
    && Array.isArray(value.expectedChildren)
    && value.expectedChildren.every(isLayerOrderChild)
    && Array.isArray(value.observedChildren)
    && value.observedChildren.every(isLayerOrderChild);
}

export function validateUiLayerOrderBaseline(value: unknown): asserts value is UiLayerOrderBaseline {
  if (!isRecord(value)
    || value.schemaVersion !== 1
    || typeof value.projectInstanceId !== 'string'
    || (value.mapFingerprint !== null && typeof value.mapFingerprint !== 'string')
    || typeof value.snapshotId !== 'string'
    || typeof value.createdAt !== 'string'
    || !Array.isArray(value.groups)
    || !value.groups.every(isLayerOrderGroup)) {
    throw new ProductError('VALIDATION_FAILED', 'UI 层级可信基线字段无效。', ['重新获取 UI 结构以重建本机基线。'], 'STATIC_LOCAL');
  }
}

export function validateUiLayerOrderGuardStatus(value: unknown): asserts value is UiLayerOrderGuardStatus {
  if (!isRecord(value)
    || value.schemaVersion !== 1
    || !['baseline-created', 'clean', 'reversal-detected'].includes(String(value.state))
    || typeof value.evaluatedAt !== 'string'
    || typeof value.baselineSnapshotId !== 'string'
    || typeof value.candidateSnapshotId !== 'string'
    || !Array.isArray(value.reversedGroups)
    || !value.reversedGroups.every(isLayerOrderReversal)
    || value.evidence !== 'STATIC_LOCAL'
    || value.writesOfficialMap !== false) {
    throw new ProductError('VALIDATION_FAILED', 'UI 层级保护状态字段无效。', ['重新获取 UI 结构以重建本机状态。'], 'STATIC_LOCAL');
  }
}

async function readTrustedBaseline(path: string, io: FileIO): Promise<UiLayerOrderBaseline | null> {
  try {
    const value: unknown = JSON.parse(await io.readFile(path, 'utf8'));
    validateUiLayerOrderBaseline(value);
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT'
      || error instanceof SyntaxError
      || (error instanceof ProductError && error.code === 'VALIDATION_FAILED')) return null;
    throw error;
  }
}

/**
 * Updates project-private layer-order evidence only. This function never reads
 * or writes Yuanmeng map resources and never attempts to repair editor state.
 */
export async function updateUiLayerOrderGuard(
  projectRoot: string,
  candidateSnapshot: UiSnapshot,
  evaluatedAt: string,
  io: FileIO,
  commitGuard?: () => void,
): Promise<UiLayerOrderGuardUpdate> {
  const relativeRoot = '.yuanmeng-inspector/ui';
  const baselineRelativePath = `${relativeRoot}/layer-order-baseline.json`;
  const statusRelativePath = `${relativeRoot}/layer-order-status.json`;
  const baselinePath = join(projectRoot, '.yuanmeng-inspector', 'ui', 'layer-order-baseline.json');
  const statusPath = join(projectRoot, '.yuanmeng-inspector', 'ui', 'layer-order-status.json');
  const trustedBaseline = await readTrustedBaseline(baselinePath, io);
  const evaluation = evaluateUiLayerOrder(trustedBaseline, candidateSnapshot, evaluatedAt);
  const writeOptions = commitGuard === undefined ? {} : { commitGuard };

  if (evaluation.promoteCandidate) {
    await atomicWriteJson(io, baselinePath, evaluation.baseline, validateUiLayerOrderBaseline, writeOptions);
  }

  let incidentRelativePath: string | null = null;
  if (evaluation.status.state === 'reversal-detected') {
    const candidateKey = /^[a-f0-9]{64}$/u.test(candidateSnapshot.snapshotId)
      ? candidateSnapshot.snapshotId
      : sha256Hex(candidateSnapshot.snapshotId);
    incidentRelativePath = `${relativeRoot}/layer-order-incidents/${candidateKey}.json`;
    await atomicWriteJson(
      io,
      join(projectRoot, '.yuanmeng-inspector', 'ui', 'layer-order-incidents', `${candidateKey}.json`),
      evaluation.status,
      validateUiLayerOrderGuardStatus,
      writeOptions,
    );
  }

  await atomicWriteJson(io, statusPath, evaluation.status, validateUiLayerOrderGuardStatus, writeOptions);
  return {
    ...evaluation,
    baselineRelativePath,
    statusRelativePath,
    incidentRelativePath,
  };
}
