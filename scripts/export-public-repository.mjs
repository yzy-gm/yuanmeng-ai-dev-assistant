import { execFileSync } from 'node:child_process';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

class ExportError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function optionalValue(args, flag) {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new ExportError('INVALID_ARGUMENT', `缺少 ${flag} 的值。`);
  }
  return value;
}

function git(args, cwd, encoding = 'utf8') {
  return execFileSync('git', args, {
    cwd,
    encoding,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
}

function assertDestination(source, destination) {
  const workRoot = resolve(source, 'work');
  const relativeDestination = relative(workRoot, destination);
  if (
    relativeDestination === ''
    || relativeDestination === '..'
    || relativeDestination.startsWith(`..${sep}`)
    || isAbsolute(relativeDestination)
  ) {
    throw new ExportError('DESTINATION_OUTSIDE_WORK', '公开导出目标必须位于源仓库的 work 子目录中。');
  }
}

function assertSafeTrackedPath(path) {
  const normalized = path.replaceAll('\\', '/');
  const lower = normalized.toLowerCase();
  const privateDataShape = lower.endsWith('.log')
    || /(?:^|\/)(?:customuidata\d*|customproperty_.+)\.lua$/iu.test(lower);
  if (
    normalized === '.git'
    || normalized.startsWith('.git/')
    || normalized.startsWith('work/')
    || normalized.startsWith('outputs/')
    || normalized.startsWith('node_modules/')
    || normalized.startsWith('.vscode-test/')
    || normalized.includes('/.yuanmeng-inspector/')
    || lower.endsWith('.vsix')
    || privateDataShape
  ) {
    throw new ExportError('UNSAFE_TRACKED_PATH', '源提交包含不能进入公开仓库的文件。');
  }
}

async function assertEmptyDestination(destination) {
  try {
    if ((await readdir(destination)).length > 0) {
      throw new ExportError('DESTINATION_NOT_EMPTY', '公开导出目标不是空目录。');
    }
  } catch (error) {
    if (error instanceof ExportError) throw error;
    if (error?.code !== 'ENOENT') throw error;
  }
}

async function exportRepository(source, destination) {
  const topLevel = resolve(git(['rev-parse', '--show-toplevel'], source).trim());
  if (topLevel !== source) throw new ExportError('SOURCE_NOT_REPOSITORY_ROOT', '源路径必须是 Git 仓库根目录。');
  if (git(['status', '--porcelain'], source).trim() !== '') {
    throw new ExportError('SOURCE_DIRTY', '源仓库有未提交变更，公开导出已停止。');
  }
  assertDestination(source, destination);
  await assertEmptyDestination(destination);

  const records = git(['ls-tree', '-r', '-z', 'HEAD'], source).split('\0').filter(Boolean);
  const entries = records.map((record) => {
    const tab = record.indexOf('\t');
    if (tab < 0) throw new ExportError('INVALID_GIT_TREE', '无法读取源提交树。');
    const metadata = record.slice(0, tab).split(' ');
    const path = record.slice(tab + 1);
    if (metadata[1] !== 'blob') throw new ExportError('UNSUPPORTED_GIT_ENTRY', '源提交包含不支持的 Git 条目。');
    assertSafeTrackedPath(path);
    return { objectId: metadata[2], path };
  });
  if (entries.length === 0) throw new ExportError('EMPTY_SOURCE', '源提交没有可公开的跟踪文件。');

  await mkdir(destination, { recursive: true });
  for (const entry of entries) {
    const target = resolve(destination, entry.path);
    const relativeTarget = relative(destination, target);
    if (relativeTarget.startsWith(`..${sep}`) || isAbsolute(relativeTarget)) {
      throw new ExportError('UNSAFE_TRACKED_PATH', '源提交包含越界路径。');
    }
    await mkdir(dirname(target), { recursive: true });
    const blob = git(['cat-file', 'blob', entry.objectId], source, null);
    await writeFile(target, blob);
  }

  git(['init', '-b', 'main'], destination);
  git(['config', 'user.name', '不见星光'], destination);
  git(['config', 'user.email', 'noreply@users.noreply.github.com'], destination);
  git(['add', '--all'], destination);
  git(['commit', '-m', 'chore: publish source snapshot'], destination);
  const commitCount = Number.parseInt(git(['rev-list', '--count', 'HEAD'], destination).trim(), 10);
  const status = git(['status', '--porcelain'], destination).trim();
  if (commitCount !== 1 || status !== '') {
    throw new ExportError('EXPORT_VERIFICATION_FAILED', '公开导出仓库没有通过单提交/干净工作树验证。');
  }
  return { commitCount, trackedFileCount: entries.length };
}

const args = process.argv.slice(2);
const json = args.includes('--json');

try {
  const source = resolve(optionalValue(args, '--source') ?? '.');
  const destinationValue = optionalValue(args, '--destination');
  if (destinationValue === undefined) throw new ExportError('INVALID_ARGUMENT', '缺少 --destination 的值。');
  const destination = resolve(destinationValue);
  const exported = await exportRepository(source, destination);
  const result = {
    schemaVersion: 1,
    ok: true,
    code: 'PUBLIC_EXPORT_READY',
    ...exported,
  };
  process.stdout.write(json ? `${JSON.stringify(result)}\n` : 'public source export ready\n');
} catch (error) {
  const failure = error instanceof ExportError
    ? error
    : new ExportError('PUBLIC_EXPORT_FAILED', '公开源码导出失败。');
  const result = { schemaVersion: 1, ok: false, code: failure.code, message: failure.message };
  process.stdout.write(json ? `${JSON.stringify(result)}\n` : `${failure.code}: ${failure.message}\n`);
  process.exitCode = 1;
}
