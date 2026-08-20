import { describe, expect, it } from 'vitest';

import type { UiSnapshot } from '../../src/core/model.js';
import { renderUiExport } from '../../src/core/ui/export.js';

const snapshot: UiSnapshot = {
  schemaVersion: 1,
  snapshotId: 'snapshot-test',
  createdAt: '2026-08-19T00:00:00.000Z',
  projectInstanceId: '00000000-0000-4000-8000-000000000001',
  mapFingerprint: null,
  sources: [],
  nodes: [{
    id: '41001', name: '经验,"值"', type: 'Text', parentId: null, path: '/经验,"值"', depth: 0, siblingIndex: 0,
    sourceFile: 'src/Data/CustomUIData.lua', sourceRange: null,
  }],
  duplicateNames: [],
};

describe('stable UI exports', () => {
  it('renders byte-stable JSON', () => {
    expect(renderUiExport(snapshot, 'json')).toBe(renderUiExport(snapshot, 'json'));
    expect(JSON.parse(renderUiExport(snapshot, 'json'))).toMatchObject({ schemaVersion: 1, snapshotId: 'snapshot-test' });
  });

  it('renders UTF-8 BOM CSV with RFC 4180 quoting', () => {
    const csv = renderUiExport(snapshot, 'csv');

    expect(csv.startsWith('\uFEFFid,name,type,parentId,path,depth,siblingIndex,sourceFile\r\n')).toBe(true);
    expect(csv).toContain('41001,"经验,""值""",Text,,"/经验,""值""",0,0,src/Data/CustomUIData.lua\r\n');
  });

  it('renders a human-readable Markdown table', () => {
    const markdown = renderUiExport(snapshot, 'md');

    expect(markdown).toContain('# UI 控件清单');
    expect(markdown).toContain('| 41001 | 经验,"值" | Text | /经验,"值" |');
  });
});
