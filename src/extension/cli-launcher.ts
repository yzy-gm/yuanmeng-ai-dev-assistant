import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, realpath, rename, stat, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative } from 'node:path';

import { ProductError } from '../core/errors.js';
import { sha256Hex, stableJson } from '../core/hash.js';
import {
  EXTENSION_ID,
  validateCliLauncherManifest,
  type CliLauncherManifest,
} from '../core/launcher/manifest.js';

export interface CliLauncherInput {
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
  changed: boolean;
}

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

function renderLauncher(
  manifest: CliLauncherManifest,
  extensionRoot: string,
  projectRoot: string,
): string {
  const script = [
    "$ErrorActionPreference='Stop'",
    '$utf8=New-Object Text.UTF8Encoding($false);[Console]::OutputEncoding=$utf8;$OutputEncoding=$utf8',
    '$manifestPath=$env:YMAI_MANIFEST',
    "function Decode([string]$v){[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($v))}",
    '$missing=Decode $env:YMAI_MSG_MISSING_B64',
    "function Norm([string]$p){$v=[IO.Path]::GetFullPath($p).Replace([IO.Path]::DirectorySeparatorChar,'/').TrimEnd('/');if($v -match '^[A-Za-z]:'){$v=$v.Substring(0,1).ToLowerInvariant()+$v.Substring(1)};$v}",
    "function HashText([string]$v){$h=[Security.Cryptography.SHA256]::Create();try{(($h.ComputeHash([Text.Encoding]::UTF8.GetBytes($v))|ForEach-Object{$_.ToString('x2')})-join '')}finally{$h.Dispose()}}",
    "if(!(Test-Path -LiteralPath $manifestPath -PathType Leaf)){[Console]::Error.WriteLine($missing);exit 2}",
    'try{$m=Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8|ConvertFrom-Json}catch{[Console]::Error.WriteLine($missing);exit 2}',
    '$expectedCli=Decode $env:YMAI_EXPECTED_CLI_B64',
    '$expectedRoot=Decode $env:YMAI_EXPECTED_ROOT_B64',
    '$projectRoot=Decode $env:YMAI_PROJECT_ROOT_B64',
    "if(!(Test-Path -LiteralPath $expectedCli -PathType Leaf)){[Console]::Error.WriteLine($missing);exit 2}",
    "if(!(Test-Path -LiteralPath $expectedRoot -PathType Container)){[Console]::Error.WriteLine($missing);exit 2}",
    'try{$cli=(Get-Item -LiteralPath $expectedCli).FullName;$root=(Get-Item -LiteralPath $expectedRoot).FullName;$project=(Get-Item -LiteralPath $projectRoot).FullName}catch{[Console]::Error.WriteLine($missing);exit 2}',
    "$catalog=Join-Path (Split-Path -Parent $root) 'extensions.json';if(Test-Path -LiteralPath $catalog -PathType Leaf){try{$entries=@(Get-Content -LiteralPath $catalog -Raw -Encoding UTF8|ConvertFrom-Json);$registered=@($entries|Where-Object{$null-ne$_.identifier-and$_.identifier.id-eq$env:YMAI_EXTENSION_ID});if($registered.Count-eq0){[Console]::Error.WriteLine($missing);exit 2}}catch{[Console]::Error.WriteLine($missing);exit 2}}",
    "$bad=($m.schemaVersion -ne 1)-or($m.extensionId -ne $env:YMAI_EXTENSION_ID)-or($m.extensionVersion -ne (Decode $env:YMAI_EXTENSION_VERSION_B64))-or($m.cliSha256 -ne $env:YMAI_EXPECTED_CLI_SHA)-or($m.projectInstanceId -ne $env:YMAI_PROJECT_ID)-or($m.projectRootHash -ne $env:YMAI_PROJECT_HASH)",
    '$bad=$bad-or((Norm $m.cliPath)-ne(Norm $cli))-or((HashText (Norm $root))-ne $m.extensionRootHash)-or($m.extensionRootHash-ne$env:YMAI_EXTENSION_ROOT_HASH)-or((HashText (Norm $project))-ne$env:YMAI_PROJECT_HASH)',
    '$prefix=$root.TrimEnd([IO.Path]::DirectorySeparatorChar)+[IO.Path]::DirectorySeparatorChar;$bad=$bad-or(!$cli.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase))',
    "$metaPath=Join-Path $project '.yuanmeng-inspector/meta.json';if(!(Test-Path -LiteralPath $metaPath -PathType Leaf)){[Console]::Error.WriteLine((Decode $env:YMAI_MSG_BINDING_B64));exit 6}",
    'try{$meta=Get-Content -LiteralPath $metaPath -Raw -Encoding UTF8|ConvertFrom-Json}catch{[Console]::Error.WriteLine((Decode $env:YMAI_MSG_BINDING_B64));exit 6}',
    '$bad=$bad-or($meta.projectInstanceId-ne$env:YMAI_PROJECT_ID)-or($meta.projectRootHash-ne$env:YMAI_PROJECT_HASH)',
    'if($bad){[Console]::Error.WriteLine((Decode $env:YMAI_MSG_VALIDATION_B64));exit 6}',
    "Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Utility/Microsoft.PowerShell.Utility.psd1') -ErrorAction Stop",
    '$actualHash=(Get-FileHash -LiteralPath $cli -Algorithm SHA256).Hash.ToLowerInvariant();if($actualHash-ne$env:YMAI_EXPECTED_CLI_SHA){[Console]::Error.WriteLine((Decode $env:YMAI_MSG_VALIDATION_B64));exit 6}',
    '$node=Get-Command node -CommandType Application -ErrorAction SilentlyContinue|Select-Object -First 1;if($null-eq$node){[Console]::Error.WriteLine((Decode $env:YMAI_MSG_NODE_MISSING_B64));exit 2}',
    "$version=& $node.Source --version 2>$null;if($LASTEXITCODE-ne 0-or$version-notmatch '^v([0-9]+)\\.') {[Console]::Error.WriteLine((Decode $env:YMAI_MSG_NODE_VERSION_B64));exit 2}",
    'if([int]$Matches[1]-lt 20){[Console]::Error.WriteLine((Decode $env:YMAI_MSG_NODE_REQUIRED_B64));exit 2}',
    "$forwarded=@();for($i=0;$i-lt[int]$env:YMAI_ARG_COUNT;$i++){$forwarded+=[Environment]::GetEnvironmentVariable(('YMAI_ARG_'+$i))};$nodeArgs=@($cli,'--launcher-manifest',$manifestPath,'--project',$project)+$forwarded;& $node.Source @nodeArgs;exit $LASTEXITCODE",
  ].join(';');
  return [
    '@echo off',
    'setlocal',
    'set "YMAI_MANIFEST=%~dp0cli-launcher.json"',
    `set "YMAI_EXPECTED_CLI_B64=${base64(manifest.cliPath)}"`,
    `set "YMAI_EXPECTED_CLI_SHA=${manifest.cliSha256}"`,
    `set "YMAI_EXPECTED_ROOT_B64=${base64(extensionRoot)}"`,
    `set "YMAI_EXTENSION_ROOT_HASH=${manifest.extensionRootHash}"`,
    `set "YMAI_EXTENSION_ID=${manifest.extensionId}"`,
    `set "YMAI_EXTENSION_VERSION_B64=${base64(manifest.extensionVersion)}"`,
    `set "YMAI_PROJECT_ROOT_B64=${base64(projectRoot)}"`,
    `set "YMAI_PROJECT_ID=${manifest.projectInstanceId}"`,
    `set "YMAI_PROJECT_HASH=${manifest.projectRootHash}"`,
    `set "YMAI_MSG_MISSING_B64=${base64('元梦 AI 开发助手已卸载或安装路径失效')}"`,
    `set "YMAI_MSG_BINDING_B64=${base64('CLI 启动器工程绑定无效')}"`,
    `set "YMAI_MSG_VALIDATION_B64=${base64('CLI 启动器校验失败')}"`,
    `set "YMAI_MSG_NODE_MISSING_B64=${base64('未找到 Node.js 20 或更高版本')}"`,
    `set "YMAI_MSG_NODE_VERSION_B64=${base64('无法确认 Node.js 版本')}"`,
    `set "YMAI_MSG_NODE_REQUIRED_B64=${base64('需要 Node.js 20 或更高版本')}"`,
    'set "YMAI_ARG_COUNT=0"',
    ':ymai_collect_args',
    'if "%~1"=="" goto ymai_run',
    'set "YMAI_ARG_%YMAI_ARG_COUNT%=%~1"',
    'set /a YMAI_ARG_COUNT+=1 >nul',
    'shift',
    'goto ymai_collect_args',
    ':ymai_run',
    `"%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "& { ${script} }"`,
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

export async function createOrRefreshCliLauncher(input: CliLauncherInput): Promise<CliLauncherResult> {
  if (
    !UUID_PATTERN.test(input.projectInstanceId)
    || !SHA256_PATTERN.test(input.projectRootHash)
    || input.extensionVersion.length === 0
  ) {
    fail('CLI 启动器输入身份无效。');
  }
  const [projectRoot, extensionRoot, cliPath] = await Promise.all([
    realpath(input.projectRoot),
    realpath(input.extensionRoot),
    realpath(input.cliPath),
  ]);
  if (!(await stat(cliPath)).isFile() || !isInside(extensionRoot, cliPath)) {
    fail('CLI 目标必须是扩展安装目录内的文件。');
  }
  const actualProjectHash = sha256Hex(normalizeRoot(projectRoot));
  if (actualProjectHash !== input.projectRootHash) {
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
    fail('CLI 启动器生成时间无效。');
  }
  const manifest: CliLauncherManifest = {
    schemaVersion: 1,
    extensionId: EXTENSION_ID,
    extensionVersion: input.extensionVersion,
    extensionRootHash: sha256Hex(normalizeRoot(extensionRoot)),
    cliPath,
    cliSha256: sha256Hex(await readFile(cliPath)),
    projectInstanceId: input.projectInstanceId,
    projectRootHash: input.projectRootHash,
    generatedAt,
  };
  validateCliLauncherManifest(manifest);
  const binRoot = join(projectRoot, '.yuanmeng-inspector', 'bin');
  const manifestPath = join(binRoot, 'cli-launcher.json');
  const launcherPath = join(binRoot, 'ymai.cmd');
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
  const launcherText = renderLauncher(effectiveManifest, extensionRoot, projectRoot);
  const unchanged = existing !== null
    && sameIdentity(existing, manifest)
    && await sameBytes(manifestPath, manifestText)
    && await sameBytes(launcherPath, launcherText);
  if (unchanged) {
    return { manifestPath, launcherPath, changed: false };
  }
  await atomicWriteText(join(projectRoot, '.yuanmeng-inspector', '.gitignore'), '*\n!.gitignore\n');
  await atomicWriteText(manifestPath, stableJson(manifest));
  await atomicWriteText(launcherPath, renderLauncher(manifest, extensionRoot, projectRoot));
  return { manifestPath, launcherPath, changed: true };
}
