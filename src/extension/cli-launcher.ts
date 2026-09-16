import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, realpath, rename, stat, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative } from 'node:path';

import { ProductError } from '../core/errors.js';
import { sha256Hex, stableJson } from '../core/hash.js';
import {
  EXTENSION_ID,
  validateCliLauncherManifest,
  validateMcpLauncherManifest,
  type CliLauncherManifest,
  type McpLauncherManifest,
} from '../core/launcher/manifest.js';
import type { YuanmengMcpToolProfile } from '../mcp/contracts.js';
import { sourcePathEnvironment, type SourcePathSettings } from '../core/environment/source-paths.js';

export interface CliLauncherInput {
  sourcePaths?: SourcePathSettings;
  projectRoot: string;
  projectInstanceId: string;
  projectRootHash: string;
  extensionRoot: string;
  extensionVersion: string;
  cliPath: string;
  generatedAt?: string;
}

export interface CliLauncherResult {
  manifestPath: string;
  launcherPath: string;
  validatorPath: string;
  changed: boolean;
}

export interface McpLauncherInput {
  sourcePaths?: SourcePathSettings;
  projectRoot: string;
  projectInstanceId: string;
  projectRootHash: string;
  extensionRoot: string;
  extensionVersion: string;
  mcpPath: string;
  toolProfile?: YuanmengMcpToolProfile;
  generatedAt?: string;
}

export type McpLauncherResult = CliLauncherResult;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const RENAME_DELAYS = [50, 100, 200, 400, 800] as const;
const RETRY_CODES = new Set(['EACCES', 'EBUSY', 'EEXIST', 'EPERM']);

function fail(message: string): never {
  throw new ProductError('VALIDATION_FAILED', message, ['重新初始化当前工程的 CLI 启动器。'], 'STATIC_LOCAL');
}

function normalizeRoot(path: string): string {
  let value = path.replace(/\\/gu, '/').replace(/\/+$/u, '');
  if (/^[A-Za-z]:/u.test(value)) {
    value = `${value[0]!.toLowerCase()}${value.slice(1)}`;
  }
  return value;
}

function isInside(root: string, path: string): boolean {
  const child = relative(root, path);
  return child !== '' && !child.startsWith('..') && !isAbsolute(child);
}

function base64(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64');
}

function renderTargetValidator(
  manifest: CliLauncherManifest | McpLauncherManifest,
  extensionRoot: string,
  projectRoot: string,
  target: {
    manifestName: string;
    pathKey: 'cliPath' | 'mcpPath';
    shaKey: 'cliSha256' | 'mcpSha256';
    targetPath: string;
    targetSha256: string;
    bindingMessage: string;
    fixedArguments?: readonly string[];
  },
  sourcePaths: SourcePathSettings,
): string {
  const expected = {
    sourceEnvironment: sourcePathEnvironment(sourcePaths, projectRoot),
    targetPathB64: base64(target.targetPath),
    targetSha256: target.targetSha256,
    pathKey: target.pathKey,
    shaKey: target.shaKey,
    extensionRootB64: base64(extensionRoot),
    extensionRootHash: manifest.extensionRootHash,
    extensionId: manifest.extensionId,
    extensionVersionB64: base64(manifest.extensionVersion),
    projectRootB64: base64(projectRoot),
    projectInstanceId: manifest.projectInstanceId,
    projectRootHash: manifest.projectRootHash,
    messages: {
      missing: base64('元梦 AI 开发助手已卸载或安装路径失效'),
      binding: base64(target.bindingMessage),
      validation: base64(`${target.bindingMessage.replace('工程绑定无效', '')}校验失败`),
      version: base64('需要 Node.js 20 或更高版本'),
    },
  };
  const expectedProfile = target.fixedArguments?.[0] === '--profile'
    ? target.fixedArguments[1] ?? null
    : null;
  return [
    "'use strict';",
    "const { createHash } = require('node:crypto');",
    "const { spawnSync } = require('node:child_process');",
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    `const EXPECTED = ${JSON.stringify(expected)};`,
    "const decode = (value) => Buffer.from(value, 'base64').toString('utf8');",
    "const message = (key) => decode(EXPECTED.messages[key]);",
    "const fail = (text, code) => { process.stderr.write(`${text}\\n`); process.exit(code); };",
    "const readJson = (file, text, code) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { fail(text, code); } };",
    "const normalize = (value) => { let result = path.resolve(value).replace(/\\\\/gu, '/').replace(/\\/+$/u, ''); if (/^[A-Za-z]:/u.test(result)) result = result[0].toLowerCase() + result.slice(1); return result; };",
    "const hashText = (value) => createHash('sha256').update(value, 'utf8').digest('hex');",
    "const hashFile = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');",
    `const manifestPath = path.join(__dirname, ${JSON.stringify(target.manifestName)});`,
    "const manifest = readJson(manifestPath, message('missing'), 2);",
    "const expectedTarget = decode(EXPECTED.targetPathB64);",
    "const expectedRoot = decode(EXPECTED.extensionRootB64);",
    "const expectedProject = decode(EXPECTED.projectRootB64);",
    "let executable; let root; let project;",
    "try { if (!fs.statSync(expectedTarget).isFile() || !fs.statSync(expectedRoot).isDirectory() || !fs.statSync(expectedProject).isDirectory()) fail(message('missing'), 2); executable = fs.realpathSync(expectedTarget); root = fs.realpathSync(expectedRoot); project = fs.realpathSync(expectedProject); } catch { fail(message('missing'), 2); }",
    "const child = path.relative(root, executable);",
    "let bad = manifest.schemaVersion !== 1 || manifest.extensionId !== EXPECTED.extensionId || manifest.extensionVersion !== decode(EXPECTED.extensionVersionB64) || manifest[EXPECTED.shaKey] !== EXPECTED.targetSha256 || manifest.projectInstanceId !== EXPECTED.projectInstanceId || manifest.projectRootHash !== EXPECTED.projectRootHash;",
    `bad ||= ${JSON.stringify(expectedProfile)} !== null && (manifest.toolProfile ?? 'full') !== ${JSON.stringify(expectedProfile)};`,
    "bad ||= normalize(manifest[EXPECTED.pathKey]) !== normalize(executable) || hashText(normalize(root)) !== manifest.extensionRootHash || manifest.extensionRootHash !== EXPECTED.extensionRootHash || hashText(normalize(project)) !== EXPECTED.projectRootHash || child === '' || child.startsWith('..') || path.isAbsolute(child);",
    "const catalogPath = path.join(path.dirname(root), 'extensions.json');",
    "if (fs.existsSync(catalogPath)) { const entries = readJson(catalogPath, message('missing'), 2); if (!Array.isArray(entries) || !entries.some((entry) => entry && entry.identifier && entry.identifier.id === EXPECTED.extensionId)) fail(message('missing'), 2); }",
    "const meta = readJson(path.join(project, '.yuanmeng-inspector', 'meta.json'), message('binding'), 6);",
    "bad ||= meta.projectInstanceId !== EXPECTED.projectInstanceId || meta.projectRootHash !== EXPECTED.projectRootHash;",
    "if (bad || hashFile(executable) !== EXPECTED.targetSha256) fail(message('validation'), 6);",
    "const major = Number.parseInt(process.versions.node.split('.')[0] || '', 10);",
    "if (!Number.isInteger(major) || major < 20) fail(message('version'), 2);",
    "const argCount = Number.parseInt(process.env.YMAI_ARG_COUNT || '0', 10);",
    "if (!Number.isInteger(argCount) || argCount < 0 || argCount > 512) fail(message('validation'), 6);",
    "const forwarded = Array.from({ length: argCount }, (_unused, index) => process.env[`YMAI_ARG_${index}`] || '');",
    `const childResult = spawnSync(process.execPath, [executable, '--launcher-manifest', manifestPath, '--project', project, ...${JSON.stringify(target.fixedArguments ?? [])}, ...forwarded], { stdio: 'inherit', env: { ...process.env, ...EXPECTED.sourceEnvironment } });`,
    "process.exit(Number.isInteger(childResult.status) ? childResult.status : 2);",
    '',
  ].join('\n');
}

function renderNodeValidator(manifest: CliLauncherManifest, extensionRoot: string, projectRoot: string, sourcePaths: SourcePathSettings): string {
  return renderTargetValidator(manifest, extensionRoot, projectRoot, {
    manifestName: 'cli-launcher.json',
    pathKey: 'cliPath',
    shaKey: 'cliSha256',
    targetPath: manifest.cliPath,
    targetSha256: manifest.cliSha256,
    bindingMessage: 'CLI 启动器工程绑定无效',
  }, sourcePaths);
}

function renderMcpNodeValidator(manifest: McpLauncherManifest, extensionRoot: string, projectRoot: string, sourcePaths: SourcePathSettings): string {
  return renderTargetValidator(manifest, extensionRoot, projectRoot, {
    manifestName: 'mcp-launcher.json',
    pathKey: 'mcpPath',
    shaKey: 'mcpSha256',
    targetPath: manifest.mcpPath,
    targetSha256: manifest.mcpSha256,
    bindingMessage: 'MCP 启动器工程绑定无效',
    fixedArguments: ['--profile', manifest.toolProfile ?? 'full'],
  }, sourcePaths);
}

function renderLauncher(validatorName = 'ymai.cjs'): string {
  return [
    '@echo off',
    '"%SystemRoot%\\System32\\chcp.com" 65001 >nul',
    'setlocal',
    'set "YMAI_BIN_ROOT=%~dp0"',
    'set "YMAI_ARG_COUNT=0"',
    ':ymai_collect_args',
    'if "%~1"=="" goto ymai_run',
    'set "YMAI_ARG_%YMAI_ARG_COUNT%=%~1"',
    'set /a YMAI_ARG_COUNT+=1 >nul',
    'shift',
    'goto ymai_collect_args',
    ':ymai_run',
    'where node.exe >nul 2>nul',
    'if errorlevel 1 (echo 未找到 Node.js 20 或更高版本 1>&2 & exit /b 2)',
    `node.exe "%YMAI_BIN_ROOT%${validatorName}"`,
    'exit /b %ERRORLEVEL%',
    '',
  ].join('\r\n');
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function atomicWriteText(target: string, content: string): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  const temporary = join(dirname(target), `.${Buffer.from(target).toString('hex').slice(-16)}.${randomBytes(8).toString('hex')}.tmp`);
  const handle = await open(temporary, 'wx');
  try {
    await handle.writeFile(content, { encoding: 'utf8' });
    await handle.sync();
  } finally {
    await handle.close();
  }
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(temporary, target);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const wait = RENAME_DELAYS[attempt];
      if (wait === undefined || code === undefined || !RETRY_CODES.has(code)) {
        try {
          await unlink(temporary);
        } catch {
          // Preserve the rename error.
        }
        throw error;
      }
      await delay(wait);
    }
  }
}

async function sameBytes(path: string, expected: string): Promise<boolean> {
  try {
    return (await readFile(path, 'utf8')) === expected;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

function sameIdentity(left: CliLauncherManifest, right: CliLauncherManifest): boolean {
  return left.extensionId === right.extensionId
    && left.extensionVersion === right.extensionVersion
    && left.extensionRootHash === right.extensionRootHash
    && left.cliPath === right.cliPath
    && left.cliSha256 === right.cliSha256
    && left.projectInstanceId === right.projectInstanceId
    && left.projectRootHash === right.projectRootHash;
}

function sameMcpIdentity(left: McpLauncherManifest, right: McpLauncherManifest): boolean {
  return left.extensionId === right.extensionId
    && left.extensionVersion === right.extensionVersion
    && left.extensionRootHash === right.extensionRootHash
    && left.mcpPath === right.mcpPath
    && left.mcpSha256 === right.mcpSha256
    && left.projectInstanceId === right.projectInstanceId
    && left.projectRootHash === right.projectRootHash
    && (left.toolProfile ?? 'full') === (right.toolProfile ?? 'full');
}

interface PreparedLauncherTarget {
  projectRoot: string;
  extensionRoot: string;
  targetPath: string;
  targetSha256: string;
  extensionRootHash: string;
  generatedAt: string;
}

async function prepareLauncherTarget(
  input: {
    projectRoot: string;
    projectInstanceId: string;
    projectRootHash: string;
    extensionRoot: string;
    extensionVersion: string;
    generatedAt?: string;
  },
  targetPathInput: string,
  targetLabel: 'CLI' | 'MCP',
): Promise<PreparedLauncherTarget> {
  if (
    !UUID_PATTERN.test(input.projectInstanceId)
    || !SHA256_PATTERN.test(input.projectRootHash)
    || input.extensionVersion.length === 0
  ) {
    fail(`${targetLabel} 启动器输入身份无效。`);
  }
  const [projectRoot, extensionRoot, targetPath] = await Promise.all([
    realpath(input.projectRoot),
    realpath(input.extensionRoot),
    realpath(targetPathInput),
  ]);
  if (!(await stat(targetPath)).isFile() || !isInside(extensionRoot, targetPath)) {
    fail(`${targetLabel} 目标必须是扩展安装目录内的文件。`);
  }
  if (sha256Hex(normalizeRoot(projectRoot)) !== input.projectRootHash) {
    fail('工程根目录指纹与启动器输入不匹配。');
  }
  let metadata: Record<string, unknown>;
  try {
    metadata = JSON.parse(await readFile(join(projectRoot, '.yuanmeng-inspector', 'meta.json'), 'utf8')) as Record<string, unknown>;
  } catch {
    fail('工程尚未初始化或元数据损坏。');
  }
  if (metadata.projectInstanceId !== input.projectInstanceId || metadata.projectRootHash !== input.projectRootHash) {
    fail('工程元数据与启动器绑定不匹配。');
  }
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  if (!generatedAt.endsWith('Z') || !Number.isFinite(Date.parse(generatedAt))) {
    fail(`${targetLabel} 启动器生成时间无效。`);
  }
  return {
    projectRoot,
    extensionRoot,
    targetPath,
    targetSha256: sha256Hex(await readFile(targetPath)),
    extensionRootHash: sha256Hex(normalizeRoot(extensionRoot)),
    generatedAt,
  };
}

export async function createOrRefreshCliLauncher(input: CliLauncherInput): Promise<CliLauncherResult> {
  const prepared = await prepareLauncherTarget(input, input.cliPath, 'CLI');
  const { projectRoot, extensionRoot, targetPath: cliPath, generatedAt } = prepared;
  const manifest: CliLauncherManifest = {
    schemaVersion: 1,
    extensionId: EXTENSION_ID,
    extensionVersion: input.extensionVersion,
    extensionRootHash: prepared.extensionRootHash,
    cliPath,
    cliSha256: prepared.targetSha256,
    projectInstanceId: input.projectInstanceId,
    projectRootHash: input.projectRootHash,
    generatedAt,
  };
  validateCliLauncherManifest(manifest);
  const binRoot = join(projectRoot, '.yuanmeng-inspector', 'bin');
  const manifestPath = join(binRoot, 'cli-launcher.json');
  const launcherPath = join(binRoot, 'ymai.cmd');
  const validatorPath = join(binRoot, 'ymai.cjs');
  let existing: CliLauncherManifest | null = null;
  try {
    const value: unknown = JSON.parse(await readFile(manifestPath, 'utf8'));
    validateCliLauncherManifest(value);
    existing = value;
  } catch {
    existing = null;
  }
  const effectiveManifest = existing !== null && sameIdentity(existing, manifest) ? existing : manifest;
  const manifestText = stableJson(effectiveManifest);
  const launcherText = renderLauncher();
  const validatorText = renderNodeValidator(effectiveManifest, extensionRoot, projectRoot, input.sourcePaths ?? {});
  const unchanged = existing !== null
    && sameIdentity(existing, manifest)
    && await sameBytes(manifestPath, manifestText)
    && await sameBytes(launcherPath, launcherText)
    && await sameBytes(validatorPath, validatorText);
  if (unchanged) {
    return { manifestPath, launcherPath, validatorPath, changed: false };
  }
  await atomicWriteText(join(projectRoot, '.yuanmeng-inspector', '.gitignore'), '*\n!.gitignore\n');
  await atomicWriteText(manifestPath, stableJson(manifest));
  await atomicWriteText(validatorPath, renderNodeValidator(manifest, extensionRoot, projectRoot, input.sourcePaths ?? {}));
  await atomicWriteText(launcherPath, renderLauncher());
  return { manifestPath, launcherPath, validatorPath, changed: true };
}

export async function createOrRefreshMcpLauncher(input: McpLauncherInput): Promise<McpLauncherResult> {
  const prepared = await prepareLauncherTarget(input, input.mcpPath, 'MCP');
  const { projectRoot, extensionRoot, targetPath: mcpPath, generatedAt } = prepared;
  const manifest: McpLauncherManifest = {
    schemaVersion: 1,
    extensionId: EXTENSION_ID,
    extensionVersion: input.extensionVersion,
    extensionRootHash: prepared.extensionRootHash,
    mcpPath,
    mcpSha256: prepared.targetSha256,
    projectInstanceId: input.projectInstanceId,
    projectRootHash: input.projectRootHash,
    generatedAt,
    toolProfile: input.toolProfile ?? 'full',
  };
  validateMcpLauncherManifest(manifest);
  const binRoot = join(projectRoot, '.yuanmeng-inspector', 'bin');
  const manifestPath = join(binRoot, 'mcp-launcher.json');
  const launcherPath = join(binRoot, 'ymai-mcp.cmd');
  const validatorPath = join(binRoot, 'ymai-mcp.cjs');
  let existing: McpLauncherManifest | null = null;
  try {
    const value: unknown = JSON.parse(await readFile(manifestPath, 'utf8'));
    validateMcpLauncherManifest(value);
    existing = value;
  } catch {
    existing = null;
  }
  const effectiveManifest = existing !== null && sameMcpIdentity(existing, manifest) ? existing : manifest;
  const manifestText = stableJson(effectiveManifest);
  const launcherText = renderLauncher('ymai-mcp.cjs');
  const validatorText = renderMcpNodeValidator(effectiveManifest, extensionRoot, projectRoot, input.sourcePaths ?? {});
  const unchanged = existing !== null
    && sameMcpIdentity(existing, manifest)
    && await sameBytes(manifestPath, manifestText)
    && await sameBytes(launcherPath, launcherText)
    && await sameBytes(validatorPath, validatorText);
  if (unchanged) {
    return { manifestPath, launcherPath, validatorPath, changed: false };
  }
  await atomicWriteText(join(projectRoot, '.yuanmeng-inspector', '.gitignore'), '*\n!.gitignore\n');
  await atomicWriteText(manifestPath, stableJson(manifest));
  await atomicWriteText(validatorPath, renderMcpNodeValidator(manifest, extensionRoot, projectRoot, input.sourcePaths ?? {}));
  await atomicWriteText(launcherPath, renderLauncher('ymai-mcp.cjs'));
  return { manifestPath, launcherPath, validatorPath, changed: true };
}
