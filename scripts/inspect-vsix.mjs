import { readFile } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';

const args = process.argv.slice(2);
const vsixPath = args.find((value) => !value.startsWith('-'));
const json = args.includes('--json');
if (vsixPath === undefined) {
  console.error('usage: node scripts/inspect-vsix.mjs <file.vsix> [--json]');
  process.exit(2);
}

function u16(bytes, offset) { return bytes.readUInt16LE(offset); }
function u32(bytes, offset) { return bytes.readUInt32LE(offset); }

function entriesFromZip(bytes) {
  const eocd = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
  let end = -1;
  for (let index = bytes.length - 22; index >= Math.max(0, bytes.length - 65557); index -= 1) {
    if (bytes.subarray(index, index + 4).equals(eocd)) { end = index; break; }
  }
  if (end < 0) throw new Error('VSIX ZIP end record not found');
  const count = u16(bytes, end + 10);
  const centralSize = u32(bytes, end + 12);
  const centralOffset = u32(bytes, end + 16);
  const result = [];
  let cursor = centralOffset;
  for (let index = 0; index < count; index += 1) {
    if (u32(bytes, cursor) !== 0x02014b50) throw new Error('invalid VSIX central directory');
    const method = u16(bytes, cursor + 10);
    const compressedSize = u32(bytes, cursor + 20);
    const uncompressedSize = u32(bytes, cursor + 24);
    const nameLength = u16(bytes, cursor + 28);
    const extraLength = u16(bytes, cursor + 30);
    const commentLength = u16(bytes, cursor + 32);
    const localOffset = u32(bytes, cursor + 42);
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    const localNameLength = u16(bytes, localOffset + 26);
    const localExtraLength = u16(bytes, localOffset + 28);
    const payloadStart = localOffset + 30 + localNameLength + localExtraLength;
    const payload = bytes.subarray(payloadStart, payloadStart + compressedSize);
    let content = null;
    if (method === 0) content = payload;
    else if (method === 8) content = inflateRawSync(payload);
    if (content !== null && content.length !== uncompressedSize) throw new Error(`invalid VSIX size for ${name}`);
    result.push({ name, content });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  if (cursor !== centralOffset + centralSize) throw new Error('invalid VSIX central directory length');
  return result;
}

const bytes = await readFile(vsixPath);
const entries = entriesFromZip(bytes);
const findings = [];
const add = (category, entry, detail) => findings.push({ category, relativePath: entry.name, detail });
const secretPatterns = [/(?:ghp|github_pat|sk|xox[baprs])_[A-Za-z0-9_-]{12,}/u, /\bBearer\s+[A-Za-z0-9._-]{12,}/iu];
const absolutePath = /\b[A-Za-z]:\\[^\r\n"']*(?:src\\|dist\\|CustomUIData|GameEntry\.lua|\.yuanmeng-inspector)[^\r\n"']*/iu;
for (const entry of entries) {
  const lower = entry.name.toLowerCase();
  if (lower === 'extension.js' || lower === 'dream-helper.vsix') add('official-binary', entry, '疑似官方扩展入口或二进制');
  if (lower.endsWith('.log') || /(?:customuidata\d*|customproperty_.+)\.lua$/iu.test(lower)) add('private-data', entry, '日志或真实导出文件不能进入 VSIX');
  if (entry.content === null) continue;
  const text = entry.content.toString('utf8');
  if (secretPatterns.some((pattern) => pattern.test(text))) add('secret', entry, '疑似访问令牌或认证头');
  const match = absolutePath.exec(text);
  if (match !== null) add('absolute-map-path', entry, match[0].slice(0, 120));
}
const byName = new Map(entries.map((entry) => [entry.name, entry]));
for (const required of [
  'extension/LICENSE.txt',
  'extension/media/yuanmeng-ai.png',
  'extension/media/yuanmeng-ai.svg',
  'extension/NOTICE.md',
  'extension/THIRD_PARTY_NOTICES.md',
]) {
  if (!byName.has(required)) findings.push({ category: 'missing-required', relativePath: required, detail: '发布包缺少必需文件' });
}
for (const entry of entries) {
  if (entry.name === 'extension/.gitignore' || entry.name.startsWith('extension/docs/')) {
    add('unnecessary-runtime-content', entry, 'Marketplace VSIX 不应包含仓库内部验收或 Git 文件');
  }
}
const icon = byName.get('extension/media/yuanmeng-ai.png')?.content;
if (
  icon === null
  || icon === undefined
  || icon.length < 24
  || !icon.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  || icon.readUInt32BE(16) < 128
  || icon.readUInt32BE(20) < 128
) {
  findings.push({ category: 'invalid-marketplace-icon', relativePath: 'extension/media/yuanmeng-ai.png', detail: 'Marketplace 图标必须是至少 128x128 的 PNG' });
}
const manifestEntry = byName.get('extension/package.json')?.content;
if (manifestEntry === null || manifestEntry === undefined) {
  findings.push({ category: 'missing-required', relativePath: 'extension/package.json', detail: '缺少扩展清单' });
} else {
  try {
    const manifest = JSON.parse(manifestEntry.toString('utf8'));
    if (
      manifest.author !== '不见星光'
      || manifest.icon !== 'media/yuanmeng-ai.png'
      || !String(manifest.description ?? '').startsWith('由不见星光开发')
    ) {
      findings.push({ category: 'invalid-marketplace-metadata', relativePath: 'extension/package.json', detail: '作者、首屏简介或图标契约不一致' });
    }
  } catch {
    findings.push({ category: 'invalid-marketplace-metadata', relativePath: 'extension/package.json', detail: '扩展清单不是有效 JSON' });
  }
}
findings.sort((left, right) => left.relativePath.localeCompare(right.relativePath) || left.category.localeCompare(right.category));
const result = { schemaVersion: 1, entries: entries.map((entry) => entry.name), findings };
if (json) process.stdout.write(`${JSON.stringify(result)}\n`);
else {
  process.stdout.write(findings.length === 0 ? 'VSIX inspection passed\n' : `${findings.length} VSIX finding(s)\n`);
  for (const finding of findings) process.stdout.write(`${finding.category}: ${finding.relativePath} (${finding.detail})\n`);
}
process.exitCode = findings.length === 0 ? 0 : 1;
