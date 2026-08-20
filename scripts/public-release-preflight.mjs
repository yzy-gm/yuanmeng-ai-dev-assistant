import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const EXPECTED = Object.freeze({
  name: 'yuanmeng-ai-dev-assistant',
  publisher: 'bujianxingguang',
  author: '不见星光',
  description: '由不见星光开发，为《元梦之星》创作者提供本地 UI、ID、Lua 与 API 检查能力的 VS Code 伴随工具。',
  icon: 'media/yuanmeng-ai.png',
  license: 'UNLICENSED',
  extensionId: 'bujianxingguang.yuanmeng-ai-dev-assistant',
  requiredKeywords: ['元梦之星', '元梦', '开发助手', 'Lua', 'UI', 'Yuanmeng', 'UGC', 'AI'],
});

class PreflightError extends Error {
  constructor(code, message, exitCode = 1) {
    super(message);
    this.code = code;
    this.exitCode = exitCode;
  }
}

function sensitiveArgumentPresent(args) {
  return args.some((argument) => /^--(?:pat|token|vsce-pat|access-token)(?:=|$)/iu.test(argument));
}

function valuesFor(args, flag) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== flag) continue;
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new PreflightError('INVALID_ARGUMENT', `缺少 ${flag} 的值。`, 2);
    }
    values.push(value);
  }
  return values;
}

function optionalValue(args, flag) {
  const values = valuesFor(args, flag);
  if (values.length > 1) throw new PreflightError('INVALID_ARGUMENT', `${flag} 只能出现一次。`, 2);
  return values[0];
}

function authorName(author) {
  if (typeof author === 'string') return author;
  if (author !== null && typeof author === 'object' && typeof author.name === 'string') return author.name;
  return null;
}

function validateManifest(manifest) {
  const failures = [];
  const keywords = Array.isArray(manifest.keywords) ? manifest.keywords : [];
  const categories = Array.isArray(manifest.categories) ? manifest.categories : [];
  if (manifest.name !== EXPECTED.name) failures.push('name');
  if (manifest.publisher !== EXPECTED.publisher) failures.push('publisher');
  if (authorName(manifest.author) !== EXPECTED.author) failures.push('author');
  if (manifest.author !== EXPECTED.author) failures.push('author-format');
  if (manifest.description !== EXPECTED.description) failures.push('description');
  if (manifest.icon !== EXPECTED.icon) failures.push('icon');
  if (manifest.license !== EXPECTED.license) failures.push('license');
  if (manifest.private !== true) failures.push('npm-private');
  if (manifest.pricing !== 'Free') failures.push('pricing');
  if (manifest.main !== './out/extension.cjs') failures.push('main');
  if (manifest.engines?.vscode !== '^1.70.0' || manifest.engines?.node !== '>=20') failures.push('engines');
  if (!categories.includes('Linters') || !categories.includes('Other')) failures.push('categories');
  if (!EXPECTED.requiredKeywords.every((keyword) => keywords.includes(keyword))) failures.push('keywords');
  if (JSON.stringify(manifest).includes('yuanmeng-local')) failures.push('development-identity');
  if (failures.length > 0) {
    throw new PreflightError(
      'PUBLIC_RELEASE_MANIFEST_INVALID',
      `公开发布清单不符合契约：${failures.join(', ')}。`,
    );
  }
}

function runJsonScript(script, args, cwd, failureCode, failureMessage) {
  try {
    const stdout = execFileSync(process.execPath, [script, ...args, '--json'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    });
    return JSON.parse(stdout);
  } catch {
    throw new PreflightError(failureCode, failureMessage);
  }
}

function validateOrigin(repository, expectedOrigins) {
  let origin;
  try {
    origin = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd: repository,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    throw new PreflightError('ORIGIN_MISSING', '没有可验证的 origin，外部发布保持未开始。');
  }
  if (!expectedOrigins.includes(origin)) {
    throw new PreflightError('ORIGIN_MISMATCH', '现有 origin 与已确认的公开仓库不一致，发布已停止。');
  }
}

function githubRepositoryUrl(manifest) {
  const value = typeof manifest.repository === 'string' ? manifest.repository : manifest.repository?.url;
  if (typeof value !== 'string') return null;
  const match = /^https:\/\/github\.com\/([^/]+)\/yuanmeng-ai-dev-assistant(?:\.git)?$/iu.exec(value);
  if (match === null || match[1]?.toLowerCase() === 'example') return null;
  return `https://github.com/${match[1]}/yuanmeng-ai-dev-assistant`;
}

function validateFinalUrls(manifest) {
  const repository = githubRepositoryUrl(manifest);
  if (repository === null) return false;
  const homepage = manifest.homepage;
  const bugs = typeof manifest.bugs === 'string' ? manifest.bugs : manifest.bugs?.url;
  return homepage === `${repository}#readme` && bugs === `${repository}/issues`;
}

function writeResult(result, json) {
  if (json) process.stdout.write(`${JSON.stringify(result)}\n`);
  else process.stdout.write(result.ok ? 'public release preflight passed\n' : `${result.code}: ${result.message}\n`);
}

const args = process.argv.slice(2);
const json = args.includes('--json');

try {
  if (sensitiveArgumentPresent(args)) {
    throw new PreflightError(
      'SENSITIVE_ARGUMENT_REJECTED',
      '发布预检禁止在命令参数中传入凭据。',
      2,
    );
  }
  const manifestPath = resolve(optionalValue(args, '--manifest') ?? 'package.json');
  const repositoryValue = optionalValue(args, '--repository');
  const repository = repositoryValue === undefined ? null : resolve(repositoryValue);
  const vsixValue = optionalValue(args, '--vsix');
  const visibility = optionalValue(args, '--github-visibility');
  const expectedOrigins = valuesFor(args, '--expected-origin');
  const finalMarketplace = args.includes('--final-marketplace');
  const publisherConfirmed = args.includes('--publisher-confirmed');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  validateManifest(manifest);

  if (finalMarketplace && !publisherConfirmed) {
    throw new PreflightError('PUBLISHER_NOT_CONFIRMED', '计划的 Marketplace Publisher 尚未由用户在官方管理页确认。');
  }
  if (finalMarketplace && (
    !validateFinalUrls(manifest)
    || repository === null
    || vsixValue === undefined
    || visibility !== 'PUBLIC'
    || expectedOrigins.length === 0
  )) {
    throw new PreflightError(
      'FINAL_RELEASE_EVIDENCE_MISSING',
      '最终 Marketplace 发布缺少真实 GitHub URL、公开目标、匹配 origin 或已审计 VSIX。',
    );
  }

  if (visibility !== undefined && visibility !== 'PUBLIC') {
    throw new PreflightError('GITHUB_TARGET_NOT_PUBLIC', 'GitHub 目标不是 PUBLIC，发布已停止。');
  }
  if (expectedOrigins.length > 0) {
    if (repository === null) throw new PreflightError('INVALID_ARGUMENT', '--expected-origin 需要 --repository。', 2);
    validateOrigin(repository, expectedOrigins);
  }
  if (repository !== null) {
    const privacy = runJsonScript(
      resolve('scripts/privacy-audit.mjs'),
      ['--repository', repository, ...(args.includes('--history') ? ['--history'] : [])],
      process.cwd(),
      'PRIVACY_REJECTED',
      '仓库隐私或 Git 历史扫描未通过。',
    );
    if (!Array.isArray(privacy.findings) || privacy.findings.length > 0) {
      throw new PreflightError('PRIVACY_REJECTED', '仓库隐私或 Git 历史扫描未通过。');
    }
  }
  if (vsixValue !== undefined) {
    const inspection = runJsonScript(
      resolve('scripts/inspect-vsix.mjs'),
      [resolve(vsixValue)],
      process.cwd(),
      'VSIX_REJECTED',
      'VSIX 不存在、无效或内容审计未通过。',
    );
    if (!Array.isArray(inspection.findings) || inspection.findings.length > 0) {
      throw new PreflightError('VSIX_REJECTED', 'VSIX 不存在、无效或内容审计未通过。');
    }
  }

  writeResult({
    schemaVersion: 1,
    ok: true,
    code: 'PUBLIC_RELEASE_PREFLIGHT_OK',
    extensionId: EXPECTED.extensionId,
    externalTargetVerified: visibility === 'PUBLIC' && expectedOrigins.length > 0,
    publisherConfirmationVerified: finalMarketplace && publisherConfirmed,
  }, json);
} catch (error) {
  const failure = error instanceof PreflightError
    ? error
    : new PreflightError('PUBLIC_RELEASE_PREFLIGHT_FAILED', '公开发布预检失败。');
  writeResult({
    schemaVersion: 1,
    ok: false,
    code: failure.code,
    message: failure.message,
  }, json);
  process.exitCode = failure.exitCode;
}
