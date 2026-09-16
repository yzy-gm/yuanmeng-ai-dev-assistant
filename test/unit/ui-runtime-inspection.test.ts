import { describe, expect, it } from 'vitest';

import type { UiSnapshot } from '../../src/core/model.js';
import {
  containsUiRuntimeInspectionMarker,
  createUiRuntimeWidgetProbeToken,
  createUiScreenPointProbeToken,
  generateUiRuntimeWidgetProbe,
  generateUiScreenPointProbe,
  parseUiRuntimeWidgetProbeLog,
  parseUiScreenPointProbeLog,
  type UiRuntimeProbeContext,
  type UiScreenPointRequest,
} from '../../src/core/ui/runtime-inspection.js';

const context: UiRuntimeProbeContext = {
  projectInstanceId: '33333333-3333-4333-8333-333333333333',
  uiSnapshotId: 'a'.repeat(64),
};

const snapshot: UiSnapshot = {
  schemaVersion: 1,
  snapshotId: context.uiSnapshotId,
  createdAt: '2026-08-23T00:00:00.000Z',
  projectInstanceId: context.projectInstanceId,
  mapFingerprint: null,
  sources: [],
  duplicateNames: [],
  nodes: [
    { id: '1000', name: 'HUD', type: 'Canvas', parentId: null, path: '/HUD', depth: 0, siblingIndex: 0, sourceFile: 'src/Data/CustomUIData2.lua', sourceRange: null },
    { id: '1001', name: '按钮A', type: 'Button', parentId: '1000', path: '/HUD/按钮A', depth: 1, siblingIndex: 0, sourceFile: 'src/Data/CustomUIData2.lua', sourceRange: null },
    { id: '1002', name: '按钮B', type: 'Button', parentId: '1000', path: '/HUD/按钮B', depth: 1, siblingIndex: 1, sourceFile: 'src/Data/CustomUIData2.lua', sourceRange: null },
  ],
};

function bytes(lines: readonly string[]): Uint8Array {
  return new TextEncoder().encode(`${lines.join('\n')}\n`);
}

describe('P0 UI runtime inspection', () => {
  it('generates and parses an exact read-only screen-point probe', () => {
    const request: UiScreenPointRequest = { x: 960, y: 540, includeGroup: false, groupId: '0' };
    const token = createUiScreenPointProbeToken(context, request);
    const source = generateUiScreenPointProbe(snapshot, request);
    expect(source).toContain('UI:CheckWidgetByScreenPosition({X = 960, Y = 540}, false, 0)');
    expect(source).toContain('MiscService:GetLocalScreenSize');
    expect(source).not.toMatch(/UI:Set(?:Position|Size|Visible|Transparency|RenderScale)/u);

    const log = bytes([
      `[YMAI_UI_SCREEN_POINT_ENV] token=${token} snapshot=${context.uiSnapshotId} point=960,540 includeGroup=false group=0 status=ok screenSize=1920,1080 uiSize=1920,1080`,
      `[YMAI_UI_SCREEN_POINT] token=${token} snapshot=${context.uiSnapshotId} point=960,540 includeGroup=false group=0 status=ok hit=1002`,
    ]);
    expect(containsUiRuntimeInspectionMarker(log)).toBe(true);
    expect(parseUiScreenPointProbeLog(log, { snapshot, request, importedAt: '2026-08-23T01:00:00.000Z' })).toMatchObject({
      evidence: 'STANDALONE_LOG',
      request,
      hitId: '1002',
      hit: { classification: 'static', node: { id: '1002', path: '/HUD/按钮B' } },
      screenSize: { x: 1920, y: 1080 },
    });
  });

  it('rejects screen-point evidence for a different exact request', () => {
    const request: UiScreenPointRequest = { x: 10, y: 20, includeGroup: true, groupId: '1000' };
    const token = createUiScreenPointProbeToken(context, request);
    const log = bytes([
      `[YMAI_UI_SCREEN_POINT_ENV] token=${token} snapshot=${context.uiSnapshotId} point=11,20 includeGroup=true group=1000 status=ok screenSize=100,100 uiSize=100,100`,
    ]);
    expect(() => parseUiScreenPointProbeLog(log, { snapshot, request })).toThrowError(
      expect.objectContaining({ code: 'UI_RUNTIME_EVIDENCE_INSUFFICIENT' }),
    );
  });

  it('discovers a bounded runtime tree and classifies duplicate/list IDs without guessing', () => {
    const token = createUiRuntimeWidgetProbeToken(context, '1000');
    const source = generateUiRuntimeWidgetProbe(snapshot, '1000');
    expect(source).toContain('UI:GetAllChildren');
    expect(source).toContain('UI:GetParent');
    expect(source).toContain('UI:GetUIName');
    expect(source).toContain('local YMAI_MAX_WIDGETS = 500');
    expect(source).not.toMatch(/UI:(?:DuplicateWidget|InitListView|Set|MoveTo)/u);

    const common = `token=${token} snapshot=${context.uiSnapshotId} root=1000`;
    const log = bytes([
      `[YMAI_UI_RUNTIME_TREE_ENV] ${common} status=ok count=3 truncated=false`,
      `[YMAI_UI_RUNTIME_WIDGET] ${common} id=1000 parent=none name=HUD zOrder=1`,
      `[YMAI_UI_RUNTIME_WIDGET] ${common} id=9001 parent=1000 name=%E5%8A%A8%E6%80%81A zOrder=2`,
      `[YMAI_UI_DYNAMIC_DUPLICATE] ${common} id=9001 template=1001 parent=1000`,
      `[YMAI_UI_LIST_ITEM] ${common} id=9002 list=1000 item=200 templateChild=1001 parent=1000 name=%E5%88%97%E8%A1%A8%E5%AD%90%E9%A1%B9`,
    ]);
    const parsed = parseUiRuntimeWidgetProbeLog(log, { snapshot, rootId: '1000', importedAt: '2026-08-23T01:00:00.000Z' });
    expect(parsed.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: '1000', classification: 'static', origins: ['tree'] }),
      expect.objectContaining({ id: '9001', classification: 'dynamic', origins: ['duplicate', 'tree'], duplicate: { templateId: '1001' } }),
      expect.objectContaining({ id: '9002', classification: 'dynamic', origins: ['list-item'], listItem: { listViewId: '1000', itemId: '200', templateChildId: '1001' } }),
    ]));
    expect(JSON.stringify(parsed)).not.toContain('YMAI_UI_RUNTIME_WIDGET');
  });

  it('rejects runtime trees beyond the 500-node safety limit', () => {
    const token = createUiRuntimeWidgetProbeToken(context, '1000');
    const common = `token=${token} snapshot=${context.uiSnapshotId} root=1000`;
    const lines = [
      `[YMAI_UI_RUNTIME_TREE_ENV] ${common} status=ok count=501 truncated=false`,
      ...Array.from({ length: 501 }, (_, index) => `[YMAI_UI_RUNTIME_WIDGET] ${common} id=${2000 + index} parent=1000 name=N${index} zOrder=1`),
    ];
    expect(() => parseUiRuntimeWidgetProbeLog(bytes(lines), { snapshot, rootId: '1000' })).toThrowError(
      expect.objectContaining({ code: 'UI_RUNTIME_EVIDENCE_INSUFFICIENT' }),
    );
  });
});
