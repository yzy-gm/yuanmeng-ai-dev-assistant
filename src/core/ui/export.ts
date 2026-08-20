import { stableJson } from '../hash.js';
import type { UiNode, UiSnapshot } from '../model.js';

export type UiExportFormat = 'json' | 'csv' | 'md';

function csvCell(value: string | number): string {
  const text = String(value);
  return /[",\r\n]/u.test(text) ? `"${text.replace(/"/gu, '""')}"` : text;
}

function csvRow(values: readonly (string | number)[]): string {
  return `${values.map(csvCell).join(',')}\r\n`;
}

function markdownCell(value: string | number): string {
  return String(value).replace(/\|/gu, '\\|').replace(/\r?\n/gu, '<br>');
}

function nodeValues(node: UiNode): readonly (string | number)[] {
  return [
    node.id,
    node.name,
    node.type,
    node.parentId ?? '',
    node.path,
    node.depth,
    node.siblingIndex,
    node.sourceFile,
  ];
}

export function renderUiExport(snapshot: UiSnapshot, format: UiExportFormat): string {
  if (format === 'json') {
    return stableJson(snapshot);
  }
  if (format === 'csv') {
    const header = ['id', 'name', 'type', 'parentId', 'path', 'depth', 'siblingIndex', 'sourceFile'];
    return `\uFEFF${csvRow(header)}${snapshot.nodes.map((node) => csvRow(nodeValues(node))).join('')}`;
  }
  const rows = snapshot.nodes.map((node) => {
    const values = [node.id, node.name, node.type, node.path, node.parentId ?? '', node.sourceFile];
    return `| ${values.map(markdownCell).join(' | ')} |`;
  });
  return [
    '# UI 控件清单',
    '',
    `快照：${snapshot.snapshotId}`,
    '',
    '| ID | 名称 | 类型 | 完整路径 | 父级 ID | 来源 |',
    '|---|---|---|---|---|---|',
    ...rows,
    '',
  ].join('\n');
}
