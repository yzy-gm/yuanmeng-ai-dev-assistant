import assert from 'node:assert/strict';

import * as vscode from 'vscode';

import type { SceneSnapshot } from '../../src/core/scene/types.js';
import { renderSceneStatus, type SceneController, type SceneProjectState } from '../../src/extension/scene-controller.js';
import { sceneHierarchyPath, sceneJsonSnippet, sceneLuaConstant } from '../../src/extension/scene-commands.js';
import { SceneFieldsProvider, SceneProblemsProvider } from '../../src/extension/scene-inspection-views.js';
import { SceneTreeProvider } from '../../src/extension/scene-views.js';
import type { ExtensionTestCase } from './index.js';

const evidence = { state: 'observed-repeatable' as const, source: 'anonymous', confidence: 0.9 };

function snapshot(count: number): SceneSnapshot {
  return {
    schemaVersion: 1,
    snapshotId: 'a'.repeat(64),
    bindingId: 'binding-anonymous',
    role: 'raw-pbin',
    sourceSha256: 'b'.repeat(64),
    observedAt: '2026-08-21T00:00:00.000Z',
    adapterId: 'observed-v1',
    instances: Array.from({ length: count }, (_value, index) => ({
      instanceId: String(index),
      elementTypeId: '7000',
      ownerId: index === 1 ? '0' : index === 2 ? 'group' : null,
      variant: 'standard' as const,
      evidence,
      transform: { state: 'absent' as const },
      customProperties: { state: 'absent' as const },
      signals: { state: 'absent' as const },
      resources: { state: 'absent' as const },
      bounds: { state: 'absent' as const },
      unknownFields: [],
    })),
    groups: [{ groupId: 'group', memberIds: [], nestedGroupIds: [], evidence }],
    issues: [],
    unknownFields: [],
  };
}

export const sceneTreeTests: ExtensionTestCase[] = [{
  name: 'scene tree materializes one 200-item page and lazily resolves hierarchy children',
  async run() {
    const emitter = new vscode.EventEmitter<void>();
    const currentSnapshot = snapshot(50_000);
    const state: SceneProjectState = {
      root: 'C:\\anonymous-root',
      bindings: [],
      heads: { schemaVersion: 1, manualSnapshotId: null, autoSnapshotId: null, rawSnapshotId: null, preferredSnapshotId: null },
      snapshot: currentSnapshot,
      refreshing: false,
      refreshPhase: null,
      lastError: null,
    };
    const controller = {
      onDidChange: emitter.event,
      list: () => [state],
      get: () => state,
      runtimeCapability: () => null,
    } as unknown as SceneController;
    const provider = new SceneTreeProvider(controller);
    try {
      const project = provider.getChildren()[0]!;
      const instances = provider.getChildren(project).find((node) => node.kind === 'category' && node.category === 'instances')!;
      const first = provider.getChildren(instances);
      assert.equal(first.length, 201);
      assert.deepEqual(first.slice(0, 3).map((node) => node.kind === 'instance' ? node.instance.instanceId : node.kind), ['0', '3', '4']);
      assert.equal(first.at(-1)?.kind, 'load-more');
      const second = provider.getChildren(first.at(-1));
      assert.equal(second.length, 201);
      assert.equal(second[0]?.kind === 'instance' ? second[0].instance.instanceId : '', '202');

      const parent = first[0]!;
      assert.match(provider.getTreeItem(parent).description as string, /证据 可重复/u);
      assert.deepEqual(provider.getChildren(parent).map((node) => node.kind === 'instance' ? node.instance.instanceId : node.kind), ['1']);
      const groups = provider.getChildren(project).find((node) => node.kind === 'category' && node.category === 'groups')!;
      const group = provider.getChildren(groups)[0]!;
      assert.equal(provider.getTreeItem(group).collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);
      assert.deepEqual(provider.getChildren(group).map((node) => node.kind === 'instance' ? node.instance.instanceId : node.kind), ['2']);
    } finally {
      emitter.dispose();
    }
  },
}, {
  name: 'scene status selects the active root and otherwise aggregates multiple roots',
  async run() {
    const firstSnapshot = snapshot(10);
    const secondSnapshot = snapshot(20);
    const states: SceneProjectState[] = [
      {
        root: 'C:\\workspace\\first', bindings: [], heads: { schemaVersion: 1, manualSnapshotId: null, autoSnapshotId: null, rawSnapshotId: null, preferredSnapshotId: null },
        snapshot: firstSnapshot, refreshing: false, refreshPhase: null, lastError: 'first-error',
      },
      {
        root: 'C:\\workspace\\second', bindings: [], heads: { schemaVersion: 1, manualSnapshotId: null, autoSnapshotId: null, rawSnapshotId: null, preferredSnapshotId: null },
        snapshot: secondSnapshot, refreshing: true, refreshPhase: 'normalize', lastError: null,
      },
    ];
    const active = renderSceneStatus(states, states[1]!.root, 7);
    assert.match(active.text, /场景:20 个元件/u);
    assert.match(active.text, /UI:7 个控件/u);
    assert.match(active.text, /读取中/u);
    assert.match(active.text, /规范化/u);
    assert.doesNotMatch(active.tooltip, /normalize/u);
    assert.doesNotMatch(active.text, /first|second/u);
    const aggregate = renderSceneStatus(states, null, 9);
    assert.match(aggregate.text, /场景:30 个元件/u);
    assert.match(aggregate.text, /UI:9 个控件/u);
    assert.doesNotMatch(aggregate.text, /\d+ 工程/u);
  },
}, {
  name: 'scene status explains that no official scene source is available instead of asking for a binding',
  async run() {
    const state = {
      root: 'C:\\workspace\\sample_map_alpha', bindings: [], heads: { schemaVersion: 1, manualSnapshotId: null, autoSnapshotId: null, rawSnapshotId: null, preferredSnapshotId: null },
      snapshot: null, refreshing: false, refreshPhase: null, lastError: null,
    } as SceneProjectState;
    const presentation = renderSceneStatus([state], state.root, 0);
    assert.match(presentation.text, /场景:未接入/u);
    assert.match(presentation.text, /UI:0 个控件/u);
    assert.doesNotMatch(presentation.text, /sample_map_alpha/u);
    assert.match(presentation.tooltip, /LayerData|官方编辑器|内存/u);
    assert.doesNotMatch(presentation.tooltip, /运行“绑定场景数据源/u);
  },
}, {
  name: 'scene status distinguishes explicit scene IDs from a missing full snapshot',
  async run() {
    const state = {
      root: 'C:\\workspace\\sample_map_alpha', bindings: [], heads: { schemaVersion: 1, manualSnapshotId: null, autoSnapshotId: null, rawSnapshotId: null, preferredSnapshotId: null },
      snapshot: null, refreshing: false, refreshPhase: null, lastError: null, registeredSceneInstances: 2,
    } as SceneProjectState;
    const presentation = renderSceneStatus([state], state.root, null);
    assert.match(presentation.text, /场景:2 个元件/u);
    assert.match(presentation.text, /UI:未读取/u);
    assert.doesNotMatch(presentation.text, /sample_map_alpha/u);
    assert.match(presentation.tooltip, /单个元件属性读取|运行时校准/u);
    assert.doesNotMatch(presentation.text, /未接入场景源/u);
  },
}, {
  name: 'scene project tree renders the current worker phase and clears to normal after completion',
  async run() {
    const emitter = new vscode.EventEmitter<void>();
    const state = {
      root: 'C:\\anonymous-root', bindings: [], heads: { schemaVersion: 1, manualSnapshotId: null, autoSnapshotId: null, rawSnapshotId: null, preferredSnapshotId: null },
      snapshot: snapshot(1), refreshing: true, refreshPhase: 'wire', lastError: null,
    } as SceneProjectState;
    const controller = { onDidChange: emitter.event, list: () => [state], get: () => state, runtimeCapability: () => null } as unknown as SceneController;
    try {
      const provider = new SceneTreeProvider(controller);
      const project = provider.getChildren()[0]!;
      assert.match(provider.getTreeItem(project).description as string, /wire/u);
      state.refreshing = false;
      state.refreshPhase = null;
      assert.doesNotMatch(provider.getTreeItem(project).description as string, /wire/u);
    } finally {
      emitter.dispose();
    }
  },
}, {
  name: 'scene context helpers render a stable nested hierarchy path, Lua constant and JSON snippet',
  async run() {
    const current = snapshot(3);
    current.instances[2]!.ownerId = null; // 仅 group.memberIds 也必须恢复出唯一父编组路径。
    current.groups = [
      { groupId: 'root-group', memberIds: [], nestedGroupIds: ['child-group'], evidence },
      { groupId: 'child-group', memberIds: ['2'], nestedGroupIds: [], evidence },
    ];
    const instanceNode = { kind: 'instance' as const, root: 'C:\\anonymous-root', instance: current.instances[2]! };
    const groupNode = { kind: 'group' as const, root: 'C:\\anonymous-root', group: current.groups[1]! };
    assert.equal(sceneHierarchyPath(current, instanceNode), 'group:root-group/group:child-group/instance:2');
    assert.equal(sceneHierarchyPath(current, groupNode), 'group:root-group/group:child-group');
    assert.equal(sceneLuaConstant(instanceNode), 'local SCENE_INSTANCE_ID = 2');
    assert.equal(sceneLuaConstant(groupNode), 'local SCENE_GROUP_ID = "child-group"');
    const groupJson = JSON.parse(sceneJsonSnippet(groupNode)) as {
      kind: string; groupId: string; memberIds: string[];
      intelligence: { actorFamily: string; warnings: string[] };
    };
    assert.equal(groupJson.kind, 'scene-group');
    assert.equal(groupJson.groupId, 'child-group');
    assert.deepEqual(groupJson.memberIds, ['2']);
    assert.equal(groupJson.intelligence.actorFamily, 'scene-group-unknown');
    assert.match(groupJson.intelligence.warnings[0], /不是背包系统/u);
  },
}, {
  name: 'scene tree and JSON expose calibrated signal-box semantics without treating it as collision element',
  async run() {
    const emitter = new vscode.EventEmitter<void>();
    const current = snapshot(1);
    current.instances[0]!.elementTypeId = '1105000000000087';
    current.instances[0]!.variant = 'component6-oneof-1';
    const state = {
      root: 'C:\\anonymous-root', bindings: [], heads: { schemaVersion: 1, manualSnapshotId: null, autoSnapshotId: null, rawSnapshotId: null, preferredSnapshotId: null },
      snapshot: current, refreshing: false, refreshPhase: null, lastError: null,
    } as SceneProjectState;
    const controller = { onDidChange: emitter.event, list: () => [state], get: () => state, runtimeCapability: () => null } as unknown as SceneController;
    try {
      const provider = new SceneTreeProvider(controller);
      const project = provider.getChildren()[0]!;
      const category = provider.getChildren(project).find((node) => node.kind === 'category' && node.category === 'instances')!;
      const node = provider.getChildren(category)[0]!;
      const item = provider.getTreeItem(node);
      assert.match(String(item.label), /信号触发盒/u);
      assert.match(item.description as string, /trigger-box/u);
      assert.match(String(item.tooltip), /ON_CHARACTER_ENTER_SIGNAL_BOX/u);
      assert.doesNotMatch(String(item.tooltip), /适用普通物理碰撞/u);
      const json = JSON.parse(sceneJsonSnippet(node as Extract<typeof node, { kind: 'instance' }>)) as {
        intelligence: { actorFamily: string; capabilities: Array<{ key: string; state: string }> };
      };
      assert.equal(json.intelligence.actorFamily, 'trigger-box');
      assert.equal(json.intelligence.capabilities.find((value) => value.key === 'physical-touch-event')?.state, 'not-applicable');
    } finally {
      emitter.dispose();
    }
  },
}, {
  name: 'scene JSON and field view merge exact runtime family evidence for unknown types',
  async run() {
    const emitter = new vscode.EventEmitter<void>();
    const current = snapshot(1);
    current.instances[0]!.elementTypeId = '9999999999999999';
    current.instances[0]!.variant = 'unknown';
    const runtime = { state: 'unique' as const, evidence: {
      instanceId: '0', snapshotId: current.snapshotId, sceneSourceSha256: current.sourceSha256,
      importedAt: '2026-08-21T02:00:00.000Z', characterState: 'absent' as const,
      creatureState: 'absent' as const, elementState: 'absent' as const,
      logicElementState: 'absent' as const, playerState: 'absent' as const, triggerBoxState: 'present' as const,
      triggerSampleState: 'ok' as const, triggerSample: [1, 2, 3] as [number, number, number],
      fields: { position: { status: 'ok' as const, value: { kind: 'vector' as const, value: [1, 2, 3] as [number, number, number] } } }, fieldConflicts: [],
    } };
    const state = {
      root: 'C:\\anonymous-root', bindings: [], heads: { schemaVersion: 1, manualSnapshotId: null, autoSnapshotId: null, rawSnapshotId: null, preferredSnapshotId: null },
      snapshot: current, runtimeCapabilities: new Map([['0', runtime]]), refreshing: false, refreshPhase: null, lastError: null,
    } as SceneProjectState;
    const controller = {
      onDidChange: emitter.event, list: () => [state], get: () => state,
      runtimeCapability: () => runtime,
    } as unknown as SceneController;
    const fields = new SceneFieldsProvider(controller);
    try {
      const node = { kind: 'instance' as const, root: state.root, instance: current.instances[0]! };
      const json = JSON.parse(sceneJsonSnippet(node, runtime)) as { intelligence: { actorFamily: string; canonicalName: string } };
      assert.equal(json.intelligence.actorFamily, 'trigger-box');
      assert.match(json.intelligence.canonicalName, /运行时确认/u);
      const project = (await fields.getChildren())[0]!;
      const instance = (await fields.getChildren(project)).find((entry) => entry.kind === 'field-instance')!;
      assert.match(fields.getTreeItem(instance).description as string, /trigger-box/u);
      const runtimeField = (await fields.getChildren(instance)).find((entry) => entry.kind === 'runtime-field' && entry.field === 'position');
      assert.ok(runtimeField);
      assert.match(fields.getTreeItem(runtimeField).description as string, /已观测/u);
    } finally {
      fields.dispose();
      emitter.dispose();
    }
  },
}, {
  name: 'scene hierarchy path refuses duplicate or multi-parent group identities as AMBIGUOUS',
  async run() {
    const current = snapshot(1);
    const duplicate = { groupId: 'dup', memberIds: [], nestedGroupIds: [], evidence };
    current.groups = [
      duplicate,
      { ...duplicate },
      { groupId: 'left', memberIds: [], nestedGroupIds: ['dup'], evidence },
      { groupId: 'right', memberIds: [], nestedGroupIds: ['dup'], evidence },
    ];
    assert.throws(
      () => sceneHierarchyPath(current, { kind: 'group', root: 'C:\\anonymous-root', group: duplicate }),
      (error: unknown) => (error as { code?: unknown; message?: unknown }).code === 'SCENE_EVIDENCE_INSUFFICIENT'
        && /AMBIGUOUS/u.test(String((error as { message?: unknown }).message)),
    );
  },
}, {
  name: 'persistent scene field and spatial problem providers keep evidence states explicit',
  async run() {
    const emitter = new vscode.EventEmitter<void>();
    const current = snapshot(2);
    current.instances[0]!.customProperties = { state: 'candidate', wirePaths: ['6.1'], evidence: { state: 'inferred-candidate', source: 'wire', confidence: 0.4 } };
    current.instances[0]!.bounds = { state: 'observed', evidence, value: { min: { x: 0, y: 0, z: 0 }, max: { x: 2, y: 2, z: 2 }, evidence } };
    current.instances[1]!.bounds = { state: 'observed', evidence, value: { min: { x: 1, y: 1, z: 1 }, max: { x: 3, y: 3, z: 3 }, evidence } };
    const state = {
      root: 'C:\\anonymous-root', bindings: [], heads: { schemaVersion: 1, manualSnapshotId: null, autoSnapshotId: null, rawSnapshotId: null, preferredSnapshotId: null },
      snapshot: current, refreshing: false, refreshPhase: null, lastError: null,
    } as SceneProjectState;
    const controller = { onDidChange: emitter.event, list: () => [state], get: () => state, runtimeCapability: () => null } as unknown as SceneController;
    const manager = { listRegistry: async () => [] } as never;
    const fields = new SceneFieldsProvider(controller);
    const problems = new SceneProblemsProvider(controller, manager);
    try {
      const fieldProject = (await fields.getChildren())[0]!;
      const projectChildren = await fields.getChildren(fieldProject);
      const coverageNode = projectChildren.find((node) => node.kind === 'root-info' && node.label === '类型识别覆盖');
      assert.ok(coverageNode);
      assert.match(fields.getTreeItem(coverageNode).description as string, /0\/1 种 · 0\/2 个实例/u);
      assert.match(String(fields.getTreeItem(coverageNode).tooltip), /不能把未覆盖类型自动归类/u);
      const instanceNode = projectChildren.find((node) => node.kind === 'field-instance')!;
      const fieldNodes = await fields.getChildren(instanceNode);
      assert.equal(fieldNodes.filter((node) => node.kind === 'field').length, 5);
      const candidateNode = fieldNodes.find((node) => node.kind === 'field' && node.inspection.field === 'customProperties')!;
      assert.match(fields.getTreeItem(candidateNode).description as string, /候选|需探针/u);

      const problemProject = (await problems.getChildren())[0]!;
      const problemNodes = await problems.getChildren(problemProject);
      assert.ok(problemNodes.some((node) => node.kind === 'spatial-problem' && node.problem.code === 'AABB_VOLUME_OVERLAP'));
      const overlap = problemNodes.find((node) => node.kind === 'spatial-problem' && node.problem.code === 'AABB_VOLUME_OVERLAP')!;
      assert.match(problems.getTreeItem(overlap).description as string, /已确认/u);
    } finally {
      fields.dispose();
      problems.dispose();
      emitter.dispose();
    }
  },
}];
