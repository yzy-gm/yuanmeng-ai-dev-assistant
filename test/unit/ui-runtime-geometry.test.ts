import { describe, expect, it } from 'vitest';

import type { UiSnapshot } from '../../src/core/model.js';
import {
  auditUiRuntimeGeometry,
  containsUiGeometryMarker,
  createUiGeometryProbeToken,
  generateUiGeometryProbe,
  parseUiGeometryProbeLog,
  type UiGeometryProbeContext,
} from '../../src/core/ui/runtime-geometry.js';

const context: UiGeometryProbeContext = {
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
    { id: '1000', name: 'HUD', type: 'unknown', parentId: null, path: '/HUD', depth: 0, siblingIndex: 0, sourceFile: 'src/Data/CustomUIData2.lua', sourceRange: null },
    { id: '1001', name: '按钮A', type: 'unknown', parentId: '1000', path: '/HUD/按钮A', depth: 1, siblingIndex: 0, sourceFile: 'src/Data/CustomUIData2.lua', sourceRange: null },
    { id: '1002', name: '按钮B', type: 'unknown', parentId: '1000', path: '/HUD/按钮B', depth: 1, siblingIndex: 1, sourceFile: 'src/Data/CustomUIData2.lua', sourceRange: null },
  ],
};

function bytes(lines: readonly string[]): Uint8Array {
  return new TextEncoder().encode(`${lines.join('\n')}\n`);
}

function common(ids: readonly string[]): string {
  return [
    `token=${createUiGeometryProbeToken(context, ids)}`,
    `snapshot=${context.uiSnapshotId}`,
    `selection=${[...ids].sort().join(',')}`,
  ].join(' ');
}

describe('UI runtime geometry', () => {
  it('generates a bounded read-only probe bound to the exact snapshot and selected IDs', () => {
    const source = generateUiGeometryProbe(snapshot, ['1002', '1001']);
    expect(source).toContain('UI:GetPosition');
    expect(source).toContain('UI:GetSize');
    expect(source).toContain('UI:UIPositionToScreenPosition');
    expect(source).toContain('UI:CheckWidgetByScreenPosition');
    expect(source).toContain('local function YMAI_Center(value)');
    expect(source).toContain('YMAI_Number(value.AlignmentX)');
    expect(source).toContain('center = YMAI_Center(UI:GetWidgetCenter(itemId))');
    expect(source).toContain('MiscService:GetLocalScreenSize');
    expect(source).toContain('[YMAI_UI_GEOMETRY_ENV]');
    expect(source).toContain('[YMAI_UI_GEOMETRY]');
    expect(source).not.toMatch(/UI:Set(?:Position|Size|Visible|Transparency|RenderScale)/u);
    expect(source).toContain('local YMAI_UI_IDS = {\n    1001,\n    1002\n}');
  });

  it('parses exact bound environment and widget measurements without retaining unrelated log text', () => {
    const log = bytes([
      `prefix retry=777 [YMAI_UI_GEOMETRY_ENV] ${common(['1001', '1002'])} status=ok screenSize=1920,1080 uiSize=1920,1080`,
      `noise [YMAI_UI_GEOMETRY] ${common(['1001', '1002'])} id=1001 status=ok position=-100,-50 size=200,100 anchored=-100,-50,0,0,0,0 screenRect=860,490,1060,590 normalizedRect=0.447916667,0.453703704,0.552083333,0.546296296 angle=0 center=0.5,0.5 zOrder=3 parent=1000 centerHit=1001`,
      `noise [YMAI_UI_GEOMETRY] ${common(['1001', '1002'])} id=1002 status=error reason=api-failed`,
    ]);
    expect(containsUiGeometryMarker(log)).toBe(true);

    const parsed = parseUiGeometryProbeLog(log, { context, importedAt: '2026-08-23T01:00:00.000Z' });

    expect(parsed).toMatchObject({
      schemaVersion: 1,
      importedAt: '2026-08-23T01:00:00.000Z',
      ...context,
      selectedIds: ['1001', '1002'],
      screenSize: { x: 1920, y: 1080 },
      uiSystemSize: { x: 1920, y: 1080 },
      evidence: 'STANDALONE_LOG',
    });
    expect(parsed.entries).toEqual([
      expect.objectContaining({ id: '1001', status: 'ok', screenRect: { left: 860, top: 490, right: 1060, bottom: 590 }, centerHitId: '1001' }),
      expect.objectContaining({ id: '1002', status: 'error', reason: 'api-failed' }),
    ]);
    expect(parsed.issues).toEqual([]);
    expect(JSON.stringify(parsed)).not.toContain('retry=777');
  });

  it('rejects a log bound to another UI snapshot', () => {
    const log = bytes([
      `[YMAI_UI_GEOMETRY_ENV] ${common(['1001']).replace(context.uiSnapshotId, 'b'.repeat(64))} status=ok screenSize=1920,1080 uiSize=1920,1080`,
    ]);
    expect(() => parseUiGeometryProbeLog(log, { context })).toThrowError(
      expect.objectContaining({ code: 'UI_GEOMETRY_EVIDENCE_INSUFFICIENT' }),
    );
  });

  it('reports clipping, center occlusion, failed measurement and significant sibling overlap', () => {
    const parsed = parseUiGeometryProbeLog(bytes([
      `[YMAI_UI_GEOMETRY_ENV] ${common(['1001', '1002'])} status=ok screenSize=100,100 uiSize=100,100`,
      `[YMAI_UI_GEOMETRY] ${common(['1001', '1002'])} id=1001 status=ok position=0,0 size=60,60 anchored=0,0,0,0,0,0 screenRect=-10,10,50,70 normalizedRect=-0.1,0.1,0.5,0.7 angle=0 center=0.5,0.5 zOrder=1 parent=1000 centerHit=1002`,
      `[YMAI_UI_GEOMETRY] ${common(['1001', '1002'])} id=1002 status=ok position=0,0 size=50,50 anchored=0,0,0,0,0,0 screenRect=10,20,60,70 normalizedRect=0.1,0.2,0.6,0.7 angle=0 center=0.5,0.5 zOrder=2 parent=1000 centerHit=1002`,
    ]), { context });

    const report = auditUiRuntimeGeometry(parsed, snapshot, { includePotentialSiblingOverlap: true });

    expect(report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'PARTIALLY_CLIPPED', widgetIds: ['1001'] }),
      expect.objectContaining({ code: 'CENTER_OCCLUDED', widgetIds: ['1001', '1002'] }),
      expect.objectContaining({ code: 'POTENTIAL_SIBLING_OVERLAP', widgetIds: ['1001', '1002'] }),
    ]));
  });
});
