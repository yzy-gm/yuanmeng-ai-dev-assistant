import assert from 'node:assert/strict';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import * as vscode from 'vscode';

import { sha256Hex } from '../../src/core/hash.js';
import { createRuntimeOnlyProbeContext, createSceneProbeToken, type SceneProbeContext } from '../../src/core/scene/probe-evidence.js';
import { buildUiSnapshot } from '../../src/core/ui/index.js';
import { createUiGeometryProbeToken } from '../../src/core/ui/runtime-geometry.js';
import { createUiRuntimeWidgetProbeToken, createUiScreenPointProbeToken } from '../../src/core/ui/runtime-inspection.js';
import type { SceneSnapshot } from '../../src/core/scene/types.js';
import type { ExtensionTestCase } from './index.js';

interface CompanionApi {
  listContexts(): Array<{ root: string; projectInstanceId: string }>;
}

export const sceneProbeEvidenceTests: ExtensionTestCase[] = [{
  name: 'import log binds scene probe evidence without persisting raw lines',
  run: async () => {
    const root = process.env.YMAI_EXTENSION_TEST_ROOT_A;
    assert.ok(root);
    const extension = vscode.extensions.getExtension<CompanionApi>('bujianxingguang.yuanmeng-ai-dev-assistant');
    assert.ok(extension);
    const api = await extension.activate();
    const projectInstanceId = api.listContexts().find((item) => item.root === root)?.projectInstanceId;
    assert.ok(projectInstanceId);
    const context: SceneProbeContext = {
      projectInstanceId,
      bindingId: 'b'.repeat(64),
      snapshotId: 'a'.repeat(64),
      sceneSourceSha256: 'c'.repeat(64),
    };
    const fieldEvidence = { state: 'observed-repeatable' as const, source: 'anonymous', confidence: 0.9 };
    const snapshot: SceneSnapshot = {
      schemaVersion: 1,
      snapshotId: context.snapshotId,
      bindingId: context.bindingId,
      role: 'raw-pbin',
      sourceSha256: context.sceneSourceSha256,
      observedAt: '2026-08-21T04:00:00.000Z',
      adapterId: 'observed-v1',
      groups: [],
      issues: [],
      unknownFields: [],
      instances: [{
        instanceId: '901', elementTypeId: '7000', ownerId: null, variant: 'standard', evidence: fieldEvidence,
        transform: { state: 'absent' }, customProperties: { state: 'absent' }, signals: { state: 'absent' },
        resources: { state: 'absent' }, bounds: { state: 'absent' }, unknownFields: [],
      }],
    };
    const sceneRoot = join(root, '.yuanmeng-inspector', 'scene');
    await mkdir(join(sceneRoot, 'snapshots'), { recursive: true });
    await writeFile(join(sceneRoot, 'heads.json'), JSON.stringify({
      schemaVersion: 1,
      manualSnapshotId: null,
      autoSnapshotId: null,
      rawSnapshotId: snapshot.snapshotId,
      preferredSnapshotId: snapshot.snapshotId,
    }), 'utf8');
    await writeFile(join(sceneRoot, 'snapshots', `${snapshot.snapshotId}.json`), JSON.stringify(snapshot), 'utf8');
    const token = createSceneProbeToken(context, 'alignment', ['900', '901']);
    const privatePrefix = 'anonymous-private-prefix session=fixture-line-456';
    const logPath = join(root, 'anonymous-scene-probe.log');
    const validLog = `${privatePrefix} [YMAI_AUTO_ALIGN] token=${token} snapshot=${context.snapshotId} source=${context.sceneSourceSha256} support=900 movers=901 status=planned supportTopZ=10 lowestZ=7 deltaZ=3\n`;
    await writeFile(logPath, validLog, 'utf8');

    const imported = await vscode.commands.executeCommand<{
      sceneEvidenceOutput: string;
      sceneEvidence: { entries: unknown[]; issues: unknown[] };
    }>('yuanmengAi.importLog', root, logPath);
    assert.ok(imported);
    assert.equal(imported.sceneEvidence.entries.length, 1);
    assert.equal(imported.sceneEvidence.issues.length, 0);
    const saved = await readFile(imported.sceneEvidenceOutput, 'utf8');
    assert.doesNotMatch(saved, /anonymous-private-prefix/iu);
    assert.doesNotMatch(saved, /raw/iu);
    assert.match(saved, /"kind": "alignment-plan"/u);
    await assert.rejects(access(join(
      root,
      '.yuanmeng-inspector',
      'logs',
      'imported',
      `${sha256Hex(new TextEncoder().encode(validLog))}.json`,
    )), { code: 'ENOENT' });

    const invalidLog = `${privatePrefix} [YMAI_AUTO_ALIGN] token=${'f'.repeat(64)} snapshot=${context.snapshotId} source=${context.sceneSourceSha256} support=900 movers=901 status=planned supportTopZ=10 lowestZ=7 deltaZ=3\n`;
    const invalidLogPath = join(root, 'anonymous-invalid-scene-probe.log');
    await writeFile(invalidLogPath, invalidLog, 'utf8');
    await assert.rejects(
      vscode.commands.executeCommand('yuanmengAi.importLog', root, invalidLogPath),
      (error: unknown) => (error as { code?: unknown }).code === 'SCENE_EVIDENCE_INSUFFICIENT',
    );
    await assert.rejects(access(join(
      root,
      '.yuanmeng-inspector',
      'logs',
      'imported',
      `${sha256Hex(new TextEncoder().encode(invalidLog))}.json`,
    )), { code: 'ENOENT' });
  },
}, {
  name: 'import log binds runtime-only evidence to an explicit scene instance without a snapshot',
  run: async () => {
    const root = process.env.YMAI_EXTENSION_TEST_ROOT_B;
    assert.ok(root);
    const extension = vscode.extensions.getExtension<CompanionApi>('bujianxingguang.yuanmeng-ai-dev-assistant');
    assert.ok(extension);
    const api = await extension.activate();
    const projectInstanceId = api.listContexts().find((item) => item.root === root)?.projectInstanceId;
    assert.ok(projectInstanceId);
    const registryDirectory = join(root, '.yuanmeng-inspector', 'registry');
    const sceneDirectory = join(root, '.yuanmeng-inspector', 'scene');
    await mkdir(registryDirectory, { recursive: true });
    await mkdir(sceneDirectory, { recursive: true });
    const sourceSha256 = 'd'.repeat(64);
    const recordId = 'runtime-only-extension-test';
    await writeFile(join(registryDirectory, 'registry.json'), JSON.stringify({
      schemaVersion: 1,
      records: [{
        recordId, kind: 'scene-instance', name: 'Runtime only test', value: '9901', scope: 'workspace',
        projectInstanceId, mapFingerprint: null, layerId: null, environment: 'test', validity: 'pending',
        source: { kind: 'user-entry', relativePath: null, sha256: sourceSha256, observedAt: '2026-08-22T00:00:00.000Z', officialExtensionVersion: null, evidence: 'USER_ATTESTED' },
        lastConfirmedAt: null, notes: 'extension test',
      }],
    }), 'utf8');
    await writeFile(join(sceneDirectory, 'heads.json'), JSON.stringify({
      schemaVersion: 1, manualSnapshotId: null, autoSnapshotId: null, rawSnapshotId: null, preferredSnapshotId: null,
    }), 'utf8');
    const context = createRuntimeOnlyProbeContext(projectInstanceId, recordId, sourceSha256);
    const token = createSceneProbeToken(context, 'alignment', ['9901', '9902']);
    const logPath = join(root, 'runtime-only-scene-probe.log');
    await writeFile(logPath, `[YMAI_AUTO_ALIGN] token=${token} snapshot=${context.snapshotId} source=${sourceSha256} support=9901 movers=9902 status=planned supportTopZ=2 lowestZ=1 deltaZ=1\n`, 'utf8');
    const imported = await vscode.commands.executeCommand<{
      sceneEvidenceOutput: string;
      sceneEvidence: { snapshotId: string; entries: unknown[]; issues: unknown[] };
    }>('yuanmengAi.importLog', root, logPath);
    assert.ok(imported);
    assert.equal(imported.sceneEvidence.snapshotId, context.snapshotId);
    assert.equal(imported.sceneEvidence.entries.length, 1);
    assert.equal(imported.sceneEvidence.issues.length, 0);
    const saved = await readFile(imported.sceneEvidenceOutput, 'utf8');
    assert.match(saved, new RegExp(context.snapshotId, 'u'));
    assert.doesNotMatch(saved, /runtime-only-scene-probe/iu);
  },
}, {
  name: 'import log binds UI screen geometry to the current UI snapshot without persisting raw lines',
  run: async () => {
    const root = process.env.YMAI_EXTENSION_TEST_ROOT_A;
    assert.ok(root);
    const extension = vscode.extensions.getExtension<CompanionApi>('bujianxingguang.yuanmeng-ai-dev-assistant');
    assert.ok(extension);
    const api = await extension.activate();
    const projectInstanceId = api.listContexts().find((item) => item.root === root)?.projectInstanceId;
    assert.ok(projectInstanceId);
    const snapshot = buildUiSnapshot({
      createdAt: '2026-08-23T00:00:00.000Z',
      projectInstanceId,
      mapFingerprint: null,
      sources: [],
      nodes: [{
        id: '1001', name: '匿名按钮', type: 'unknown', parentId: null, path: '/匿名按钮', depth: 0,
        siblingIndex: 0, sourceFile: 'src/Data/CustomUIData2.lua', sourceRange: null,
      }],
    });
    const uiDirectory = join(root, '.yuanmeng-inspector', 'ui');
    await mkdir(uiDirectory, { recursive: true });
    await writeFile(join(uiDirectory, 'current.json'), JSON.stringify(snapshot), 'utf8');
    const context = { projectInstanceId, uiSnapshotId: snapshot.snapshotId };
    const token = createUiGeometryProbeToken(context, ['1001']);
    const common = `token=${token} snapshot=${snapshot.snapshotId} selection=1001`;
    const privatePrefix = 'anonymous-ui-private-prefix session=fixture-789';
    const log = [
      `${privatePrefix} [YMAI_UI_GEOMETRY_ENV] ${common} status=ok screenSize=1920,1080 uiSize=1920,1080`,
      `[YMAI_UI_GEOMETRY] ${common} id=1001 status=ok position=10,20 size=100,40 anchored=10,20,0,0,0,0 screenRect=10,20,110,60 normalizedRect=0.005208333,0.018518519,0.057291667,0.055555556 angle=0 center=0.5,0.5 zOrder=3 parent=none centerHit=1001`,
      '',
    ].join('\n');
    const logPath = join(root, 'anonymous-ui-geometry.log');
    await writeFile(logPath, log, 'utf8');

    const imported = await vscode.commands.executeCommand<{
      uiGeometryOutput: string;
      uiGeometry: { selectedIds: string[]; entries: Array<{ id: string; status: string }> };
    }>('yuanmengAi.importLog', root, logPath);
    assert.ok(imported);
    assert.deepEqual(imported.uiGeometry.selectedIds, ['1001']);
    assert.equal(imported.uiGeometry.entries.length, 1);
    assert.equal(imported.uiGeometry.entries[0]?.id, '1001');
    assert.equal(imported.uiGeometry.entries[0]?.status, 'ok');
    const saved = await readFile(imported.uiGeometryOutput, 'utf8');
    assert.doesNotMatch(saved, /anonymous-ui-private-prefix/iu);
    assert.match(saved, /"screenRect"/u);
    assert.equal(await readFile(join(uiDirectory, 'runtime', 'current.json'), 'utf8'), saved);
  },
}, {
  name: 'import log binds screen-point and dynamic UI evidence to the current UI snapshot',
  run: async () => {
    const root = process.env.YMAI_EXTENSION_TEST_ROOT_A;
    assert.ok(root);
    const extension = vscode.extensions.getExtension<CompanionApi>('bujianxingguang.yuanmeng-ai-dev-assistant');
    assert.ok(extension);
    const api = await extension.activate();
    const projectInstanceId = api.listContexts().find((item) => item.root === root)?.projectInstanceId;
    assert.ok(projectInstanceId);
    const snapshot = buildUiSnapshot({
      createdAt: '2026-08-23T02:00:00.000Z', projectInstanceId, mapFingerprint: null, sources: [],
      nodes: [
        { id: '1000', name: 'HUD', type: 'Canvas', parentId: null, path: '/HUD', depth: 0, siblingIndex: 0, sourceFile: 'src/Data/CustomUIData2.lua', sourceRange: null },
        { id: '1001', name: '模板', type: 'Button', parentId: '1000', path: '/HUD/模板', depth: 1, siblingIndex: 0, sourceFile: 'src/Data/CustomUIData2.lua', sourceRange: null },
      ],
    });
    const uiDirectory = join(root, '.yuanmeng-inspector', 'ui');
    await mkdir(uiDirectory, { recursive: true });
    await writeFile(join(uiDirectory, 'current.json'), JSON.stringify(snapshot), 'utf8');
    const context = { projectInstanceId, uiSnapshotId: snapshot.snapshotId };
    const request = { x: 320, y: 240, includeGroup: false, groupId: '0' } as const;
    const pointToken = createUiScreenPointProbeToken(context, request);
    const treeToken = createUiRuntimeWidgetProbeToken(context, '1000');
    const privatePrefix = 'private-ui-runtime-line-should-not-persist';
    const log = [
      `${privatePrefix} [YMAI_UI_SCREEN_POINT_ENV] token=${pointToken} snapshot=${snapshot.snapshotId} point=320,240 includeGroup=false group=0 status=ok screenSize=1280,720 uiSize=1280,720`,
      `[YMAI_UI_SCREEN_POINT] token=${pointToken} snapshot=${snapshot.snapshotId} point=320,240 includeGroup=false group=0 status=ok hit=9001`,
      `[YMAI_UI_RUNTIME_TREE_ENV] token=${treeToken} snapshot=${snapshot.snapshotId} root=1000 status=ok count=2 truncated=false`,
      `[YMAI_UI_RUNTIME_WIDGET] token=${treeToken} snapshot=${snapshot.snapshotId} root=1000 id=1000 parent=none name=HUD zOrder=1`,
      `[YMAI_UI_DYNAMIC_DUPLICATE] token=${treeToken} snapshot=${snapshot.snapshotId} root=1000 id=9001 template=1001 parent=1000`,
      '',
    ].join('\n');
    const logPath = join(root, 'anonymous-ui-runtime.log');
    await writeFile(logPath, log, 'utf8');

    const imported = await vscode.commands.executeCommand<{
      uiScreenPointOutput: string;
      uiRuntimeWidgetsOutput: string;
      uiScreenPoint: { hitId: string; hit: { classification: string } };
      uiRuntimeWidgets: { entries: Array<{ id: string; classification: string }> };
    }>('yuanmengAi.importLog', root, logPath);
    assert.ok(imported);
    assert.equal(imported.uiScreenPoint.hitId, '9001');
    assert.equal(imported.uiScreenPoint.hit.classification, 'dynamic');
    assert.ok(imported.uiRuntimeWidgets.entries.some((entry) => entry.id === '9001' && entry.classification === 'dynamic'));
    for (const output of [imported.uiScreenPointOutput, imported.uiRuntimeWidgetsOutput]) {
      const saved = await readFile(output, 'utf8');
      assert.doesNotMatch(saved, /private-ui-runtime-line-should-not-persist/iu);
    }
    await access(join(uiDirectory, 'screen-points', 'current.json'));
    await access(join(uiDirectory, 'runtime-widgets', 'current.json'));
  },
}];
