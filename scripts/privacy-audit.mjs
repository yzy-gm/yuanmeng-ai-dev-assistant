import { lstat, readdir, readFile } from 'node:fs/promises';
import { basename, relative, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const repositoryIndex = args.indexOf('--repository');
const rootIndex = args.indexOf('--root');
const selectedRootIndex = repositoryIndex >= 0 ? repositoryIndex : rootIndex;
const root = resolve(selectedRootIndex >= 0 ? args[selectedRootIndex + 1] ?? '.' : '.');
const json = args.includes('--json');
const history = args.includes('--history');

const SKIP_DIRECTORIES = new Set([
  '.git', '.vscode-test', 'node_modules', 'out', 'outputs', 'coverage', 'work', '.yuanmeng-inspector',
]);
const TEXT_EXTENSIONS = new Set([
  '.cjs', '.csv', '.json', '.js', '.lua', '.md', '.mjs', '.ps1', '.ts', '.txt', '.yaml', '.yml', '.cmd', '.log',
]);
const SECRET_PATTERNS = [
  /(?:ghp|github_pat|sk|xox[baprs])_[A-Za-z0-9_-]{12,}/u,
  /\bBearer\s+[A-Za-z0-9._-]{12,}/iu,
];
const ABSOLUTE_MAP_PATH = /\b[A-Za-z]:\\[^\r\n"']*(?:src\\|dist\\|CustomUIData|GameEntry\.lua|\.yuanmeng-inspector)[^\r\n"']*/iu;

const findings = [];

function addRelative(category, relativePath, detail) {
  findings.push({ category, relativePath: relativePath.replaceAll('\\', '/'), detail });
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

await lstat(root);
await walk(root);
if (history) scanGitHistory();
findings.sort((left, right) => left.relativePath.localeCompare(right.relativePath) || left.category.localeCompare(right.category));
const result = { schemaVersion: 1, findings };
if (json) {
  process.stdout.write(`${JSON.stringify(result)}\n`);
} else {
  process.stdout.write(findings.length === 0 ? 'privacy audit passed\n' : `${findings.length} privacy finding(s)\n`);
  for (const finding of findings) process.stdout.write(`${finding.category}: ${finding.relativePath} (${finding.detail})\n`);
}
process.exitCode = findings.length === 0 ? 0 : 1;
