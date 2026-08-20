import { describe, expect, it } from 'vitest';

import {
  buildAcceptanceChecklist,
  buildHealthReport,
  buildHandoffReport,
  renderReportMarkdown,
} from '../../src/core/audit/report.js';

const logEvidence = { sourceHash: 'a'.repeat(64), importedAt: '2026-08-20T01:00:00.000Z', entryCount: 3 };

describe('evidence-classified project reports', () => {
  it('does not mark editor or multiplayer gates from local logs', () => {
    const report = buildAcceptanceChecklist({
      staticPassed: true,
      unitPassed: true,
      extensionHostPassed: true,
      vsixPassed: false,
      importedLogs: [logEvidence],
      manualEvidence: [],
    });
    expect(report.gates.static.status).toBe('verified');
    expect(report.gates.localLogs.status).toBe('verified');
    expect(report.gates.officialEditorSingle.status).toBe('unverified');
    expect(report.gates.officialEditorMulti.status).toBe('unverified');
    expect(report.gates.vsix.status).toBe('unverified');
  });

  it('creates deterministic health, checklist, handoff JSON and Markdown sections', () => {
    const checklist = buildAcceptanceChecklist({
      staticPassed: true, unitPassed: true, extensionHostPassed: false, vsixPassed: false,
      importedLogs: [], manualEvidence: [{ level: 'OFFICIAL_EDITOR_SINGLE', note: 'anonymous test completed' }],
    });
    const health = buildHealthReport({ issueCounts: { error: 1, warning: 2, info: 3 }, stale: true });
    const handoff = buildHandoffReport({ projectLabel: 'anonymous-project', health, checklist });
    const markdown = renderReportMarkdown(handoff);
    expect(handoff.schemaVersion).toBe(1);
    expect(markdown).toContain('## 静态与单元测试');
    expect(markdown).toContain('## Extension Host');
    expect(markdown).toContain('## VSIX');
    expect(markdown).toContain('## 本机导入日志');
    expect(markdown).toContain('## 官方编辑器单人');
    expect(markdown).toContain('## 多人实测');
    expect(JSON.stringify(handoff)).not.toContain('TBD');
  });
});
