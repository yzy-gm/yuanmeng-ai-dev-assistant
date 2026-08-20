export type GateStatus = 'verified' | 'failed' | 'unverified';

export interface ReportGate {
  status: GateStatus;
  evidence: string[];
}

export interface ImportedLogEvidence {
  sourceHash: string;
  importedAt: string;
  entryCount: number;
}

export interface ManualEvidence {
  level: 'OFFICIAL_EDITOR_SINGLE' | 'OFFICIAL_EDITOR_MULTI';
  note: string;
}

export interface AcceptanceChecklist {
  schemaVersion: 1;
  gates: {
    static: ReportGate;
    unit: ReportGate;
    extensionHost: ReportGate;
    vsix: ReportGate;
    localLogs: ReportGate;
    officialEditorSingle: ReportGate;
    officialEditorMulti: ReportGate;
  };
}

export interface HealthReport {
  schemaVersion: 1;
  issueCounts: { error: number; warning: number; info: number };
  stale: boolean;
  status: 'healthy' | 'attention-required';
}

export interface HandoffReport {
  schemaVersion: 1;
  projectLabel: string;
  health: HealthReport;
  checklist: AcceptanceChecklist;
}

function automatic(passed: boolean): ReportGate {
  return passed ? { status: 'verified', evidence: ['automated-pass'] } : { status: 'unverified', evidence: [] };
}

export function buildAcceptanceChecklist(input: {
  staticPassed: boolean;
  unitPassed: boolean;
  extensionHostPassed: boolean;
  vsixPassed: boolean;
  importedLogs: readonly ImportedLogEvidence[];
  manualEvidence: readonly ManualEvidence[];
}): AcceptanceChecklist {
  const single = input.manualEvidence.filter((entry) => entry.level === 'OFFICIAL_EDITOR_SINGLE').map((entry) => entry.note);
  const multi = input.manualEvidence.filter((entry) => entry.level === 'OFFICIAL_EDITOR_MULTI').map((entry) => entry.note);
  return {
    schemaVersion: 1,
    gates: {
      static: automatic(input.staticPassed),
      unit: automatic(input.unitPassed),
      extensionHost: automatic(input.extensionHostPassed),
      vsix: automatic(input.vsixPassed),
      localLogs: input.importedLogs.length === 0
        ? { status: 'unverified', evidence: [] }
        : { status: 'verified', evidence: input.importedLogs.map((entry) => `${entry.sourceHash}:${entry.entryCount}`) },
      officialEditorSingle: { status: single.length > 0 ? 'verified' : 'unverified', evidence: single },
      officialEditorMulti: { status: multi.length > 0 ? 'verified' : 'unverified', evidence: multi },
    },
  };
}

export function buildHealthReport(input: {
  issueCounts: { error: number; warning: number; info: number };
  stale: boolean;
}): HealthReport {
  return {
    schemaVersion: 1,
    issueCounts: { ...input.issueCounts },
    stale: input.stale,
    status: input.stale || input.issueCounts.error > 0 ? 'attention-required' : 'healthy',
  };
}

export function buildHandoffReport(input: {
  projectLabel: string;
  health: HealthReport;
  checklist: AcceptanceChecklist;
}): HandoffReport {
  return { schemaVersion: 1, projectLabel: input.projectLabel, health: input.health, checklist: input.checklist };
}

function gateLine(label: string, gate: ReportGate): string {
  const evidence = gate.evidence.length === 0 ? '无' : gate.evidence.join('；');
  return `- 状态：${gate.status}\n- 证据：${evidence}\n`;
}

export function renderReportMarkdown(report: HandoffReport): string {
  const gates = report.checklist.gates;
  return [
    `# ${report.projectLabel} 开发交接报告`,
    '',
    `健康状态：${report.health.status}；错误 ${report.health.issueCounts.error}，警告 ${report.health.issueCounts.warning}，提示 ${report.health.issueCounts.info}；数据${report.health.stale ? '陈旧' : '未标记陈旧'}。`,
    '',
    '## 静态与单元测试',
    gateLine('静态', gates.static) + gateLine('单元', gates.unit),
    '## Extension Host',
    gateLine('Extension Host', gates.extensionHost),
    '## VSIX',
    gateLine('VSIX', gates.vsix),
    '## 本机导入日志',
    gateLine('本机日志', gates.localLogs),
    '## 官方编辑器单人',
    gateLine('官方编辑器单人', gates.officialEditorSingle),
    '## 多人实测',
    gateLine('多人实测', gates.officialEditorMulti),
  ].join('\n');
}
