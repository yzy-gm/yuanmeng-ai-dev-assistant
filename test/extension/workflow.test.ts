import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as vscode from 'vscode';

import { nodeFileIO } from '../../src/core/fs.js';
import type { UiSearchResult } from '../../src/core/ui/index.js';
import {
  adaptSyntheticUiTablesForTests,
  parseSyntheticUiExportFilesForTests,
} from '../../src/core/ui/adapter.js';
import { guardedAtomicWriteJson, WorkspaceContextManager } from '../../src/extension/workspaces.js';
import {
  createSceneSourceBinding,
  saveSceneSourceBinding,
} from '../../src/integrations/scene/source.js';
import type { ExtensionTestCase } from './index.js';

interface CompanionApi {
  listContexts(): Array<{ root: string; projectInstanceId: string; snapshotId: string | null }>;
  findUi(root: string, query: string): Promise<UiSearchResult>;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function varint(value: bigint): number[] {
  const bytes: number[] = [];
  let rest = value;
  do {
    let byte = Number(rest & 0x7fn);
    rest >>= 7n;
    if (rest !== 0n) byte |= 0x80;
    bytes.push(byte);
  } while (rest !== 0n);
  return bytes;
}

function tag(field: number, wire: 0 | 2 | 5): number[] {
  return varint(BigInt((field << 3) | wire));
}

function v(field: number, value: bigint): number[] {
  return [...tag(field, 0), ...varint(value)];
}

function b(field: number, value: number[]): number[] {
  return [...tag(field, 2), ...varint(BigInt(value.length)), ...value];
}

function f32(field: number, value: number): number[] {
  const buffer = new ArrayBuffer(4);
  new DataView(buffer).setFloat32(0, value, true);
  return [...tag(field, 5), ...new Uint8Array(buffer)];
}

async function writeExternalSceneFixture(directory: string, instanceId: bigint): Promise<string> {
  await mkdir(directory, { recursive: true });
  const vec = (x: number, y: number, z: number): number[] => [
    ...f32(1, x), ...f32(2, y), ...f32(3, z),
  ];
  const transform = [...b(1, vec(1, 2, 3)), ...b(2, vec(0, 0, 0)), ...b(3, vec(1, 1, 1))];
  const commonBase = b(1, transform);
  const instance = [...v(1, 7000n), ...v(2, instanceId), ...v(3, instanceId), ...b(6, b(11, b(1, commonBase)))];
  const body = b(24, [...v(1, 7000n), ...b(2, instance)]);
  const source = join(directory, 'LayerData.pbin');
  await writeFile(source, Uint8Array.from(b(5, body)));
  return source;
}

async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMilliseconds = 6_000,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMilliseconds) {
    if (await predicate()) return;
    await delay(50);
  }
  throw new Error('timed out waiting for Extension Host state');
}

export const workflowTests: ExtensionTestCase[] = [{
  name: 'workspace workflow stays inert and returns a bounded error when no Yuanmeng project exists',
  async run() {
    const manager = await WorkspaceContextManager.create([], {
      uiAdapter: adaptSyntheticUiTablesForTests,
      uiPartParser: parseSyntheticUiExportFilesForTests,
      sourceEvidence: 'EXTENSION_HOST',
    });
    try {
      assert.deepEqual(manager.list(), []);
      await assert.rejects(
        manager.choose(),
        (error: unknown) => (error as { code?: unknown }).code === 'VALIDATION_FAILED',
      );
    } finally {
      manager.dispose();
    }
  },
}, {
  name: 'guarded UI writes roll back when the lifecycle expires only after rename committed',
  async run() {
    const root = await mkdtemp(join(tmpdir(), 'ymai-ui-post-commit-'));
    const target = join(root, 'current.json');
    await writeFile(target, JSON.stringify({ value: 'old' }), 'utf8');
    let guardCalls = 0;
    const validate = (value: unknown): asserts value is { value: string } => {
      assert.ok(typeof value === 'object' && value !== null && typeof (value as { value?: unknown }).value === 'string');
    };
    try {
      await assert.rejects(guardedAtomicWriteJson(target, { value: 'new' }, validate, () => {
        guardCalls += 1;
        if (guardCalls === 4) {
          const error = new Error('expired after rename');
          error.name = 'AbortError';
          throw error;
        }
      }), (error: unknown) => (error as { name?: unknown }).name === 'AbortError');
      assert.deepEqual(JSON.parse(await readFile(target, 'utf8')), { value: 'old' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
}, {
  name: 'UI file watcher debounces saved exports and refreshes only the matching root',
  async run() {
    const rootA = process.env.YMAI_EXTENSION_TEST_ROOT_A;
    const rootB = process.env.YMAI_EXTENSION_TEST_ROOT_B;
    assert.ok(rootA);
    assert.ok(rootB);
    const extension = vscode.extensions.getExtension<CompanionApi>('bujianxingguang.yuanmeng-ai-dev-assistant');
    assert.ok(extension);
    const api = await extension.activate();
    const rootBBefore = api.listContexts().find((item) => item.root === rootB)?.snapshotId ?? null;
    const dataDirectory = join(rootA, 'src', 'Data');
    await mkdir(dataDirectory, { recursive: true });
    await writeFile(join(dataDirectory, 'CustomUIData.lua'), [
      'return { schemaVersion = 1, roots = {',
      "  { id = '701', name = 'Debounce-Old', type = 'Text', children = {} },",
      '} }',
      '',
    ].join('\n'), 'utf8');
    await writeFile(join(dataDirectory, 'CustomUIData.lua'), [
      'return { schemaVersion = 1, roots = {',
      "  { id = '702', name = 'Debounce-Latest', type = 'Text', children = {} },",
      '} }',
      '',
    ].join('\n'), 'utf8');

    await waitFor(async () => (await api.findUi(rootA, 'Debounce-Latest')).kind === 'unique');
    assert.equal((await api.findUi(rootA, 'Debounce-Old')).kind, 'not-found');
    assert.equal(api.listContexts().find((item) => item.root === rootB)?.snapshotId ?? null, rootBBefore);
  },
}, {
  name: 'clipboard scene ID import reads explicitly, validates decimal input, confirms, and binds one project',
  async run() {
    const rootA = process.env.YMAI_EXTENSION_TEST_ROOT_A;
    const rootB = process.env.YMAI_EXTENSION_TEST_ROOT_B;
    assert.ok(rootA);
    assert.ok(rootB);
    const extension = vscode.extensions.getExtension<CompanionApi>('bujianxingguang.yuanmeng-ai-dev-assistant');
    assert.ok(extension);
    const api = await extension.activate();
    const projectB = api.listContexts().find((item) => item.root === rootB);
    assert.ok(projectB);

    await vscode.env.clipboard.writeText('not-an-instance');
    await assert.rejects(
      vscode.commands.executeCommand('yuanmengAi.importSceneIdFromClipboard', rootB, 'Clipboard Scene', 'confirm'),
      (error: unknown) => (error as { code?: unknown }).code === 'VALIDATION_FAILED',
    );

    await vscode.env.clipboard.writeText('90210');
    const cancelled = await vscode.commands.executeCommand<{ committed: boolean }>(
      'yuanmengAi.importSceneIdFromClipboard', rootB, 'Clipboard Scene', 'cancel',
    );
    assert.equal(cancelled?.committed, false);

    const committed = await vscode.commands.executeCommand<{ committed: boolean; value: string }>(
      'yuanmengAi.importSceneIdFromClipboard', rootB, 'Clipboard Scene', 'confirm',
    );
    assert.deepEqual(committed, { committed: true, value: '90210' });
    const registry = JSON.parse(await readFile(
      join(rootB, '.yuanmeng-inspector', 'registry', 'registry.json'),
      'utf8',
    )) as { records: Array<Record<string, unknown>> };
    const record = registry.records.find((candidate) => candidate.value === '90210');
    assert.ok(record);
    assert.equal(record.kind, 'scene-instance');
    assert.equal(record.projectInstanceId, projectB.projectInstanceId);
    assert.equal(record.mapFingerprint, null);
    assert.equal(record.validity, 'pending');
    assert.deepEqual(record.source, {
      kind: 'user-entry',
      relativePath: null,
      sha256: record.source && (record.source as { sha256: unknown }).sha256,
      observedAt: record.source && (record.source as { observedAt: unknown }).observedAt,
      officialExtensionVersion: null,
      evidence: 'USER_ATTESTED',
    });
  },
}, {
  name: 'AI command binds a saved scene source outside the Lua project without a project-root preflight',
  async run() {
    const rootA = process.env.YMAI_EXTENSION_TEST_ROOT_A;
    const temporaryRoot = process.env.YMAI_EXTENSION_TEST_TEMP;
    assert.ok(rootA);
    assert.ok(temporaryRoot);
    const source = await writeExternalSceneFixture(join(temporaryRoot, 'external-scene-a'), 81001n);

    const snapshot = await vscode.commands.executeCommand<{ instances: Array<{ instanceId: string }> }>(
      'yuanmengAi.bindSceneSource', rootA, source,
    );

    assert.ok(snapshot);
    assert.equal(snapshot.instances.some((instance) => instance.instanceId === '81001'), true);
  },
}, {
  name: 'refresh reloads a matching scene binding written to disk after extension activation',
  async run() {
    const rootB = process.env.YMAI_EXTENSION_TEST_ROOT_B;
    const temporaryRoot = process.env.YMAI_EXTENSION_TEST_TEMP;
    assert.ok(rootB);
    assert.ok(temporaryRoot);
    const source = await writeExternalSceneFixture(join(temporaryRoot, 'external-scene-b'), 82001n);
    const meta = JSON.parse(await readFile(
      join(rootB, '.yuanmeng-inspector', 'meta.json'),
      'utf8',
    )) as { projectInstanceId: string; projectRootHash: string };
    const binding = await createSceneSourceBinding({
      io: nodeFileIO,
      projectInstanceId: meta.projectInstanceId,
      projectRootHash: meta.projectRootHash,
      role: 'raw-pbin',
      sourcePath: source,
    });
    await saveSceneSourceBinding(rootB, binding, nodeFileIO);

    const snapshot = await vscode.commands.executeCommand<{
      bindingId: string;
      instances: Array<{ instanceId: string }>;
    }>('yuanmengAi.refreshScene', rootB);

    assert.ok(snapshot);
    assert.equal(snapshot.bindingId, binding.bindingId);
    assert.equal(snapshot.instances.some((instance) => instance.instanceId === '82001'), true);
  },
}];
