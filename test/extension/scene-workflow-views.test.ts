import assert from 'node:assert/strict';

import * as vscode from 'vscode';

import type { SceneChangeJournalEntry } from '../../src/core/scene/change-journal.js';
import type { ScenePlacementPlan } from '../../src/core/scene/placement-plan.js';
import type { SceneSnapshot } from '../../src/core/scene/types.js';
import type { SceneController, SceneProjectState } from '../../src/extension/scene-controller.js';
import {
  SceneChangesProvider,
  ScenePlansProvider,
  parseScenePlacementRequest,
} from '../../src/extension/scene-workflow-views.js';
import type { ExtensionTestCase } from './index.js';

const evidence = { state: 'observed-repeatable' as const, source: 'anonymous', confidence: 0.9 };

function snapshot(): SceneSnapshot {
  return {
    schemaVersion: 1,
    snapshotId: 'a'.repeat(64),
    bindingId: 'binding-anonymous',
    role: 'raw-pbin',
    sourceSha256: 'b'.repeat(64),
    observedAt: '2026-08-21T00:00:00.000Z',
    adapterId: 'observed-v1',
    instances: [], groups: [], issues: [], unknownFields: [],
  };
}

function controllerWith(current: SceneSnapshot | null): { controller: SceneController; emitter: vscode.EventEmitter<void>; state: SceneProjectState } {
  const emitter = new vscode.EventEmitter<void>();
  const state: SceneProjectState = {
    root: 'C:\\anonymous-workspace',
    bindings: [],
    heads: { schemaVersion: 1, manualSnapshotId: null, autoSnapshotId: null, rawSnapshotId: null, preferredSnapshotId: null },
    snapshot: current,
    refreshing: false,
    refreshPhase: null,
    lastError: null,
  };
  return {
    emitter,
    state,
    controller: {
      onDidChange: emitter.event,
      list: () => [state],
      get: () => state,
    } as unknown as SceneController,
  };
}

export const sceneWorkflowViewTests: ExtensionTestCase[] = [{
  name: 'scene plan JSON boundary rejects incomplete operation fields before calling the core planner',
  async run() {
    assert.throws(
      () => parseScenePlacementRequest({ kind: 'floor-align', targetIds: ['101'] }),
      (error: unknown) => (error as { code?: unknown }).code === 'VALIDATION_FAILED',
    );
    assert.deepEqual(parseScenePlacementRequest({
      kind: 'floor-align', targetIds: ['101'], supportId: '102', preserveGroupRelative: true,
    }), {
      kind: 'floor-align', targetIds: ['101'], supportId: '102', preserveGroupRelative: true,
    });
  },
}, {
  name: 'scene changes view journals a same-lineage controller refresh before reloading the tree',
  async run() {
    const before = snapshot();
    const host = controllerWith(before);
    const saved: SceneChangeJournalEntry[] = [];
    const provider = new SceneChangesProvider(
      host.controller,
      async () => [],
      async (_root, entry) => { saved.push(entry); },
    );
    try {
      host.state.snapshot = {
        ...before,
        snapshotId: '9'.repeat(64),
        sourceSha256: '8'.repeat(64),
        observedAt: '2026-08-21T00:01:00.000Z',
        instances: [{
          instanceId: '101', elementTypeId: '7000', ownerId: null, variant: 'standard', evidence,
          transform: { state: 'absent' }, customProperties: { state: 'absent' }, signals: { state: 'absent' },
          resources: { state: 'absent' }, bounds: { state: 'absent' }, unknownFields: [],
        }],
      };
      host.emitter.fire();
      for (let attempt = 0; attempt < 20 && saved.length === 0; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.equal(saved.length, 1);
      assert.equal(saved[0]?.fromSnapshotId, before.snapshotId);
      assert.equal(saved[0]?.toSnapshotId, host.state.snapshot.snapshotId);
      assert.deepEqual(saved[0]?.summary, [{ kind: 'added', count: 1 }]);
    } finally {
      provider.dispose();
      host.emitter.dispose();
    }
  },
}, {
  name: 'scene changes view loads only the current binding timeline and labels summary evidence',
  async run() {
    const current = snapshot();
    const { controller, emitter } = controllerWith(current);
    const entry: SceneChangeJournalEntry = {
      schemaVersion: 1,
      journalId: 'c'.repeat(64),
      bindingId: current.bindingId,
      role: current.role,
      adapterId: current.adapterId,
      fromSnapshotId: 'd'.repeat(64),
      toSnapshotId: current.snapshotId,
      fromSourceSha256: 'e'.repeat(64),
      toSourceSha256: current.sourceSha256,
      fromObservedAt: '2026-08-20T23:59:00.000Z',
      toObservedAt: current.observedAt,
      changeCount: 2,
      summary: [{ kind: 'added', count: 2 }],
    };
    const calls: unknown[] = [];
    const provider = new SceneChangesProvider(controller, async (root, options) => {
      calls.push({ root, options });
      return [entry];
    });
    try {
      const project = (await provider.getChildren())[0]!;
      const children = await provider.getChildren(project);
      assert.deepEqual(calls, [{
        root: 'C:\\anonymous-workspace',
        options: { bindingId: current.bindingId, role: current.role, adapterId: current.adapterId, currentSnapshotId: current.snapshotId, limit: 200 },
      }]);
      assert.equal(children[0]?.kind, 'change-entry');
      const item = provider.getTreeItem(children[0]!);
      assert.match(item.label as string, /2 项变更/u);
      assert.match(item.description as string, /新增实例/u);
      assert.match(item.tooltip as string, /只保存摘要/u);
    } finally {
      provider.dispose();
      emitter.dispose();
    }
  },
}, {
  name: 'scene changes and plans views state unknown/evidence-insufficient without pretending certainty',
  async run() {
    const absent = controllerWith(null);
    const changes = new SceneChangesProvider(absent.controller, async () => []);
    const present = controllerWith(snapshot());
    const plans = new ScenePlansProvider(present.controller);
    try {
      const changeProject = (await changes.getChildren())[0]!;
      const empty = (await changes.getChildren(changeProject))[0]!;
      assert.equal(empty.kind, 'change-empty');
      assert.match(changes.getTreeItem(empty).label as string, /证据不足/u);

      let refreshCount = 0;
      const disposable = plans.onDidChangeTreeData(() => { refreshCount += 1; });
      const plan: ScenePlacementPlan = {
        schemaVersion: 1,
        planId: 'f'.repeat(64),
        snapshotId: snapshot().snapshotId,
        bindingId: snapshot().bindingId,
        operation: 'axis-align',
        requestedTargetIds: ['101'],
        affectedInstanceIds: ['101'],
        referenceIds: ['102'],
        status: 'evidence-insufficient',
        reasonCode: 'BOUNDS_EVIDENCE_REQUIRED',
        execute: false,
        changes: [], rollback: { changes: [] }, evidence: [evidence],
        risks: [{ code: 'BOUNDS_UNAVAILABLE', instanceIds: ['101'], message: '缺少可信边界。' }],
      };
      plans.setPlan('C:\\anonymous-workspace', plan);
      assert.equal(refreshCount, 1);
      const planProject = (await plans.getChildren())[0]!;
      const planNode = (await plans.getChildren(planProject))[0]!;
      const item = plans.getTreeItem(planNode);
      assert.match(item.description as string, /证据不足/u);
      assert.match(item.tooltip as string, /仅预览/u);
      assert.equal(plan.execute, false);
      disposable.dispose();
    } finally {
      changes.dispose();
      plans.dispose();
      absent.emitter.dispose();
      present.emitter.dispose();
    }
  },
}, {
  name: 'scene changes view invalidates an in-flight journal capture after dispose',
  async run() {
    const before = snapshot();
    const host = controllerWith(before);
    const saved: string[] = [];
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const provider = new SceneChangesProvider(host.controller, async () => [], (async (_root, entry, context) => {
      await blocked;
      if (context?.isCurrent() ?? true) saved.push(entry.journalId);
    }) as never);
    host.state.snapshot = { ...before, snapshotId: '7'.repeat(64), sourceSha256: '6'.repeat(64), observedAt: '2026-08-21T00:01:00.000Z' };
    host.emitter.fire();
    await new Promise((resolve) => setTimeout(resolve, 5));
    provider.dispose();
    release();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(saved, []);
    host.emitter.dispose();
  },
}, {
  name: 'scene changes view keeps valid lineage entries visible while isolating one damaged journal',
  async run() {
    const current = snapshot();
    const { controller, emitter } = controllerWith(current);
    const entry: SceneChangeJournalEntry = {
      schemaVersion: 1,
      journalId: 'c'.repeat(64),
      bindingId: current.bindingId,
      role: current.role,
      adapterId: current.adapterId,
      fromSnapshotId: 'd'.repeat(64),
      toSnapshotId: current.snapshotId,
      fromSourceSha256: 'e'.repeat(64),
      toSourceSha256: current.sourceSha256,
      fromObservedAt: '2026-08-20T23:59:00.000Z',
      toObservedAt: current.observedAt,
      changeCount: 1,
      summary: [{ kind: 'added', count: 1 }],
    };
    const provider = new SceneChangesProvider(controller, async () => ({
      entries: [entry],
      status: 'evidence-insufficient',
      diagnostics: ['较早的一条日志损坏，已隔离。'],
    }));
    try {
      const project = (await provider.getChildren())[0]!;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const children = await provider.getChildren(project);
        assert.deepEqual(children.map((child) => child.kind), ['change-entry', 'change-diagnostic']);
        assert.match(provider.getTreeItem(children[1]!).label as string, /证据不足/u);
        assert.match(provider.getTreeItem(children[1]!).tooltip as string, /已隔离/u);
      }
    } finally {
      provider.dispose();
      emitter.dispose();
    }
  },
}];
