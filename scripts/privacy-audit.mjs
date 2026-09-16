import { lstat, open, readdir, readFile } from 'node:fs/promises';
import { basename, relative, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { inflateRawSync } from 'node:zlib';

const args = process.argv.slice(2);
const repositoryIndex = args.indexOf('--repository');
const rootIndex = args.indexOf('--root');
const selectedRootIndex = repositoryIndex >= 0 ? repositoryIndex : rootIndex;
const root = resolve(selectedRootIndex >= 0 ? args[selectedRootIndex + 1] ?? '.' : '.');
const json = args.includes('--json');
const history = args.includes('--history');
const privateDataIndex = args.indexOf('--private-data');
const privateDataRoot = privateDataIndex >= 0 ? resolve(args[privateDataIndex + 1] ?? '.') : null;

const SKIP_DIRECTORIES = new Set([
  '.git', '.vscode-test', 'node_modules', 'out', 'outputs', 'coverage', 'work', '.yuanmeng-inspector',
]);
const TEXT_EXTENSIONS = new Set([
  '.cjs', '.csv', '.json', '.js', '.lua', '.md', '.mjs', '.ps1', '.ts', '.txt', '.yaml', '.yml', '.cmd', '.log',
]);
const SECRET_PATTERNS = [
  /\b(?:ghp|github_pat|sk|xox[baprs])_[A-Za-z0-9_-]{12,}/u,
  /\bBearer\s+[A-Za-z0-9._-]{12,}/iu,
];
// Official exports and Node/JSON logs can spell the same private path with
// either slash. Cover Windows drives, UNC shares, and common absolute Unix
// roots while requiring a map-specific suffix to avoid matching ordinary URLs.
const ABSOLUTE_MAP_PATH = /(?:\b[A-Za-z]:[\\/]|\\\\[A-Za-z0-9._$-][A-Za-z0-9._$ -]{0,254}[\\/][A-Za-z0-9._$ -]{1,255}[\\/]|\/\/[A-Za-z0-9._$-][A-Za-z0-9._$ -]{0,254}\/[A-Za-z0-9._$ -]{1,255}\/|\/(?:Users|home|mnt|opt|srv|var|tmp)\/)[^\r\n"']*(?:src[\\/]|dist[\\/]|CustomUIData|GameEntry\.lua|\.yuanmeng-inspector)[^\r\n"']*/iu;

const findings = [];
const findingKeys = new Set();

function addRelative(category, relativePath, detail) {
  const normalized = relativePath.replaceAll('\\', '/');
  const key = `${category}\0${normalized}`;
  if (findingKeys.has(key)) return;
  findingKeys.add(key);
  findings.push({ category, relativePath: normalized, detail });
}

function shouldSkip(relativePath) {
  return relativePath === 'test/integration/privacy-audit.test.ts';
}

function scanNameAndContent(relativePath, name, content, detailPrefix = '') {
  const lower = name.toLowerCase();
  const detail = (value) => detailPrefix === '' ? value : `${detailPrefix}: ${value}`;
  if (lower === 'customuidata.lua' || /^customuidata\d+\.lua$/iu.test(name) || /^customproperty_.+\.lua$/iu.test(name)) {
    addRelative('raw-ui-export', relativePath, detail('官方 UI/元件属性导出文件名'));
  }
  if (lower === 'layerdata.dat' || lower === 'layerdata-auto.dat' || lower === 'layerdata.pbin') {
    addRelative('raw-scene-data', relativePath, detail('原始场景文件不能进入仓库或分发包'));
  }
  if (lower === 'extension.js' || lower === 'extension.cjs' || lower === 'extension.exe' || lower === 'dream-helper.vsix') {
    addRelative('official-binary', relativePath, detail('疑似官方扩展二进制或入口文件'));
  }
  if (lower.endsWith('.log')) addRelative('log', relativePath, detail('日志文件'));
  if (content === null) return;
  if (SECRET_PATTERNS.some((pattern) => pattern.test(content))) addRelative('secret', relativePath, detail('疑似访问令牌或认证头'));
  const absoluteMatch = ABSOLUTE_MAP_PATH.exec(content);
  if (absoluteMatch !== null) addRelative('absolute-map-path', relativePath, detail('疑似绝对地图工程路径'));
}

async function walk(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    const failedPath = relative(root, directory).replaceAll('\\', '/') || '.';
    addRelative('audit-read-error', failedPath.startsWith('../') ? '.' : failedPath, '无法读取审计目录');
    return;
  }
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    const relativePath = relative(root, path).replaceAll('\\', '/');
    // The audit's own seeded strings and anonymous fixture logs are test inputs,
    // not distributable project data; keep them out of the repository baseline.
    if (shouldSkip(relativePath)) continue;
    if (entry.isDirectory()) {
      if (!SKIP_DIRECTORIES.has(entry.name)) await walk(path);
      continue;
    }
    if (!entry.isFile()) continue;
    const name = basename(path);
    const isText = TEXT_EXTENSIONS.has(path.slice(path.lastIndexOf('.')).toLowerCase());
    let content;
    if (isText) {
      try {
        content = await readFile(path, 'utf8');
      } catch {
        addRelative('audit-read-error', relativePath, '无法读取审计文件');
        content = null;
      }
    } else {
      content = null;
    }
    scanNameAndContent(relativePath, name, content);
  }
}

function scanGitHistory() {
  const objects = execFileSync('git', ['rev-list', '--objects', '--all'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const seen = new Set();
  for (const line of objects.split(/\r?\n/u)) {
    const separator = line.indexOf(' ');
    if (separator < 1) continue;
    const objectId = line.slice(0, separator);
    const relativePath = line.slice(separator + 1).replaceAll('\\', '/');
    if (relativePath === '' || shouldSkip(relativePath)) continue;
    const name = basename(relativePath);
    const extension = relativePath.includes('.') ? relativePath.slice(relativePath.lastIndexOf('.')).toLowerCase() : '';
    const isText = TEXT_EXTENSIONS.has(extension);
    const lower = name.toLowerCase();
    const suspiciousName = lower === 'customuidata.lua'
      || /^customuidata\d+\.lua$/iu.test(name)
      || /^customproperty_.+\.lua$/iu.test(name)
      || lower === 'extension.js'
      || lower === 'extension.cjs'
      || lower === 'extension.exe'
      || lower === 'dream-helper.vsix'
      || lower === 'layerdata.dat'
      || lower === 'layerdata-auto.dat'
      || lower === 'layerdata.pbin'
      || lower.endsWith('.log');
    if (!isText && !suspiciousName) continue;
    const key = `${objectId}:${relativePath}`;
    if (seen.has(key)) continue;
    seen.add(key);
    let content = null;
    if (isText) {
      try {
        content = execFileSync('git', ['cat-file', 'blob', objectId], {
          cwd: root,
          encoding: 'utf8',
          maxBuffer: 16 * 1024 * 1024,
          stdio: ['ignore', 'pipe', 'ignore'],
        });
      } catch {
        content = null;
      }
    }
    scanNameAndContent(relativePath, name, content, `Git 历史对象 ${objectId.slice(0, 12)}`);
  }
}

const PRIVATE_TEXT_LIMIT = 16 * 1024 * 1024;
const PRIVATE_ARCHIVE_LIMIT = 64 * 1024 * 1024;
const PRIVATE_ABSOLUTE_UGC_PATH = /(?:\b[A-Za-z]:[\\/]|\\\\[A-Za-z0-9._$-][A-Za-z0-9._$ -]{0,254}[\\/][A-Za-z0-9._$ -]{1,255}[\\/]|\/\/[A-Za-z0-9._$-][A-Za-z0-9._$ -]{0,254}\/[A-Za-z0-9._$ -]{1,255}\/|\/(?:Users|home|mnt|opt|srv|var|tmp)\/)[^\r\n"']*(?:LayerData(?:-Auto)?\.(?:dat|pbin)|\.yuanmeng-inspector|Saved[\\/])[^\r\n"']*/iu;
const LAYER_DATA_REFERENCE = /LayerData(?:-Auto)?\.(?:dat|pbin)/iu;

async function readPrefix(path, length) {
  const handle = await open(path, 'r');
  try {
    const bytes = Buffer.alloc(length);
    const result = await handle.read(bytes, 0, length, 0);
    return bytes.subarray(0, result.bytesRead);
  } finally {
    await handle.close();
  }
}

function scanPrivateText(relativePath, name, text) {
  if (PRIVATE_ABSOLUTE_UGC_PATH.test(text)) addRelative('absolute-ugc-path', relativePath, '绝对 UGC 路径');
  if (LAYER_DATA_REFERENCE.test(text)) addRelative('layerdata-reference', relativePath, 'LayerData 文件名');
  if (!name.toLowerCase().endsWith('.json')) return;
  try {
    const value = JSON.parse(text);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return;
    if (Array.isArray(value.instances) && value.instances.some((instance) => (
      typeof instance === 'object' && instance !== null && typeof instance.instanceId === 'string'
    ))) {
      addRelative('scene-instance-list', relativePath, '场景实例清单');
    }
    if (
      value.schemaVersion === 1
      && typeof value.snapshotId === 'string'
      && typeof value.sourceSha256 === 'string'
      && Array.isArray(value.instances)
      && Array.isArray(value.groups)
    ) addRelative('scene-snapshot', relativePath, '规范化场景快照');
  } catch {
    // Non-JSON files with a .json suffix are reported only by other matching categories.
  }
}

function entriesFromZip(bytes) {
  let end = -1;
  for (let index = bytes.length - 22; index >= Math.max(0, bytes.length - 65557); index -= 1) {
    if (bytes.readUInt32LE(index) === 0x06054b50) { end = index; break; }
  }
  if (end < 0) return [];
  const count = bytes.readUInt16LE(end + 10);
  const centralOffset = bytes.readUInt32LE(end + 16);
  if (count > 10_000) return [];
  const entries = [];
  let totalUncompressed = 0;
  let cursor = centralOffset;
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > bytes.length || bytes.readUInt32LE(cursor) !== 0x02014b50) return [];
    const method = bytes.readUInt16LE(cursor + 10);
    const compressedSize = bytes.readUInt32LE(cursor + 20);
    const uncompressedSize = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const localOffset = bytes.readUInt32LE(cursor + 42);
    totalUncompressed += uncompressedSize;
    if (uncompressedSize > PRIVATE_TEXT_LIMIT || totalUncompressed > PRIVATE_ARCHIVE_LIMIT || localOffset + 30 > bytes.length) return [];
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    const localNameLength = bytes.readUInt16LE(localOffset + 26);
    const localExtraLength = bytes.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const payload = bytes.subarray(start, start + compressedSize);
    const content = method === 0 ? payload : method === 8 ? inflateRawSync(payload, { maxOutputLength: PRIVATE_TEXT_LIMIT }) : null;
    entries.push({ name, content });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function scanPrivateArchive(relativePath, bytes) {
  let entries;
  try {
    entries = entriesFromZip(bytes);
  } catch {
    return;
  }
  for (const entry of entries) {
    const entryPath = `${relativePath}!/${entry.name.replaceAll('\\', '/')}`;
    const lowerPath = entryPath.toLowerCase();
    const lowerName = basename(entry.name).toLowerCase();
    if (lowerPath.includes('/.yuanmeng-inspector/')) addRelative('private-cache', entryPath, 'VSIX 内私有缓存或派生数据');
    if (lowerName.endsWith('.log') || lowerPath.includes('/logs/')) addRelative('private-log', entryPath, 'VSIX 内日志');
    if (lowerPath.includes('/reports/')) addRelative('private-report', entryPath, 'VSIX 内派生报告');
    if (lowerName === 'layerdata.dat' || lowerName === 'layerdata-auto.dat' || lowerName === 'layerdata.pbin') {
      addRelative('raw-scene-data', entryPath, 'VSIX 内原始场景数据');
      addRelative('layerdata-reference', entryPath, 'VSIX 内 LayerData 文件名');
    }
    if (entry.content !== null) scanPrivateText(entryPath, lowerName, entry.content.toString('utf8'));
  }
}

async function scanPrivateFile(privateRoot, path) {
  const relativePath = relative(privateRoot, path).replaceAll('\\', '/') || basename(path);
  if (shouldSkip(relativePath)) return;
  const lowerPath = relativePath.toLowerCase();
  const lowerName = basename(path).toLowerCase();
  let metadata;
  try {
    metadata = await lstat(path);
  } catch {
    addRelative('scan-error', relativePath.startsWith('../') ? '.' : relativePath, '无法检查私有文件');
    return;
  }
  if (lowerPath.startsWith('.yuanmeng-inspector/')) addRelative('private-cache', relativePath, '本机私有缓存或派生数据');
  if (lowerName.endsWith('.log') || lowerPath.includes('/logs/')) addRelative('private-log', relativePath, '本机日志');
  if (lowerPath.includes('/reports/')) addRelative('private-report', relativePath, '本机派生报告');
  if (lowerName === 'layerdata.dat' || lowerName === 'layerdata-auto.dat' || lowerName === 'layerdata.pbin') {
    addRelative('raw-scene-data', relativePath, '原始场景数据');
    addRelative('layerdata-reference', relativePath, 'LayerData 文件名');
  }
  let prefix;
  try {
    prefix = await readPrefix(path, 8);
  } catch {
    addRelative('scan-error', relativePath, '无法读取私有文件头');
    return;
  }
  const hasZipMagic = prefix.length >= 4 && prefix[0] === 0x50 && prefix[1] === 0x4b && prefix[2] === 0x03 && prefix[3] === 0x04;
  if (hasZipMagic) {
    addRelative('zip-magic', relativePath, 'ZIP 容器魔数');
  }
  const scanArchive = lowerName.endsWith('.vsix') && hasZipMagic && metadata.size <= PRIVATE_ARCHIVE_LIMIT;
  if (metadata.size > PRIVATE_TEXT_LIMIT && !scanArchive) return;
  let bytes;
  try {
    bytes = await readFile(path);
  } catch {
    addRelative('scan-error', relativePath, '无法读取私有文件');
    return;
  }
  if (metadata.size <= PRIVATE_TEXT_LIMIT) scanPrivateText(relativePath, lowerName, bytes.toString('utf8'));
  if (scanArchive) scanPrivateArchive(relativePath, bytes);
}

async function walkPrivate(privateRoot, directory) {
  let metadata;
  try {
    metadata = await lstat(directory);
  } catch {
    const failedPath = relative(privateRoot, directory).replaceAll('\\', '/') || '.';
    addRelative('scan-error', failedPath.startsWith('../') ? '.' : failedPath, '无法检查私有目录');
    return;
  }
  if (metadata.isFile()) {
    await scanPrivateFile(privateRoot, directory);
    return;
  }
  if (!metadata.isDirectory()) return;
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    const failedPath = relative(privateRoot, directory).replaceAll('\\', '/') || '.';
    addRelative('scan-error', failedPath.startsWith('../') ? '.' : failedPath, '无法读取私有目录');
    return;
  }
  for (const entry of entries) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) await walkPrivate(privateRoot, path);
    else if (entry.isFile()) await scanPrivateFile(privateRoot, path);
  }
}

async function scanGitWorkingTreeInventory() {
  // Plain directories are valid audit inputs. Once a Git metadata entry is
  // present, however, its inventory is the only way to see force-tracked files
  // inside intentionally skipped private/cache directories, so failure must be
  // reported instead of silently turning into a false pass.
  try {
    await lstat(resolve(root, '.git'));
  } catch {
    return;
  }
  let output;
  try {
    output = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    addRelative('audit-read-error', '.', '无法读取 Git 工作树清单');
    return;
  }
  const rootPrefix = `${root}${process.platform === 'win32' ? '\\' : '/'}`;
  for (const entry of output.split('\0')) {
    const relativePath = entry.replaceAll('\\', '/');
    if (relativePath === '' || relativePath.includes('\0') || shouldSkip(relativePath)) continue;
    const lowerPath = relativePath.toLowerCase();
    const lowerName = basename(relativePath).toLowerCase();
    const privateCandidate = lowerPath.startsWith('.yuanmeng-inspector/')
      || lowerPath.startsWith('outputs/')
      || lowerName.endsWith('.log')
      || lowerName.endsWith('.vsix')
      || lowerName === 'layerdata.dat'
      || lowerName === 'layerdata-auto.dat'
      || lowerName === 'layerdata.pbin';
    if (!privateCandidate) continue;
    const path = resolve(root, ...relativePath.split('/'));
    if (path !== root && !path.startsWith(rootPrefix)) {
      addRelative('audit-read-error', relativePath, 'Git 工作树路径越界');
      continue;
    }
    let metadata;
    try {
      metadata = await lstat(path);
    } catch {
      addRelative('audit-read-error', relativePath, 'Git 工作树文件不可读');
      continue;
    }
    if (!metadata.isFile()) continue;
    await scanPrivateFile(root, path);
  }
}

if (privateDataRoot === null) {
  try {
    await lstat(root);
    await walk(root);
    await scanGitWorkingTreeInventory();
  } catch {
    addRelative('audit-read-error', '.', '无法扫描仓库');
  }
  if (history) scanGitHistory();
} else {
  try {
    await lstat(privateDataRoot);
    await walkPrivate(privateDataRoot, privateDataRoot);
  } catch {
    addRelative('scan-error', '.', '无法扫描私有数据');
  }
}
findings.sort((left, right) => left.relativePath.localeCompare(right.relativePath) || left.category.localeCompare(right.category));
const counts = new Map();
for (const finding of findings) counts.set(finding.category, (counts.get(finding.category) ?? 0) + 1);
const summary = [...counts].sort(([left], [right]) => left.localeCompare(right)).map(([category, count]) => ({ category, count }));
const reportedFindings = privateDataRoot === null
  ? findings
  : findings.map(({ category, relativePath }) => ({ category, relativePath }));
const result = { schemaVersion: 1, findings: reportedFindings, summary };
if (json) {
  process.stdout.write(`${JSON.stringify(result)}\n`);
} else {
  process.stdout.write(findings.length === 0 ? 'privacy audit passed\n' : `${findings.length} privacy finding(s)\n`);
  for (const finding of findings) {
    process.stdout.write(privateDataRoot === null
      ? `${finding.category}: ${finding.relativePath} (${finding.detail})\n`
      : `${finding.category}: ${finding.relativePath}\n`);
  }
}
process.exitCode = findings.some((finding) => finding.category === 'scan-error' || finding.category === 'audit-read-error')
  ? 2
  : findings.length === 0 ? 0 : 1;
