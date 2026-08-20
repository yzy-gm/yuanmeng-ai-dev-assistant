import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const repoRoot = resolve(import.meta.dirname, '..', '..');

interface AuditFinding {
  category: string;
  relativePath: string;
  detail: string;
}

interface AuditResult {
  schemaVersion: 1;
  findings: AuditFinding[];
}

async function runAudit(root: string, history = false): Promise<{ code: number; result: AuditResult; stderr: string }> {
  try {
    const output = await execFileAsync(
      process.execPath,
      ['scripts/privacy-audit.mjs', '--repository', root, ...(history ? ['--history'] : []), '--json'],
      { cwd: repoRoot, encoding: 'utf8' },
    );
    return { code: 0, result: JSON.parse(output.stdout) as AuditResult, stderr: output.stderr };
  } catch (error) {
    const failure = error as { code: number; stdout: string; stderr: string };
    return { code: failure.code, result: failure.stdout === '' ? { schemaVersion: 1, findings: [] } : JSON.parse(failure.stdout) as AuditResult, stderr: failure.stderr };
  }
}

describe('privacy audit', () => {
  it('reports tokens, absolute map paths, raw exports, logs, and official binaries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ymai-privacy-fixture-'));
    try {
      await mkdir(join(root, 'src', 'Data'), { recursive: true });
      await mkdir(join(root, 'official'), { recursive: true });
      await writeFile(join(root, 'secrets.txt'), 'token=ghp_abcdefghijklmnopqrstuvwxyz0123456789\n', 'utf8');
      await writeFile(join(root, 'map-path.txt'), 'D:\\private-map\\src\\GameEntry.lua\n', 'utf8');
      await writeFile(join(root, 'src', 'Data', 'CustomUIData.lua'), 'return { _uid = 1, _name = "anonymous" }\n', 'utf8');
      await writeFile(join(root, 'session.log'), 'local test log\n', 'utf8');
      await writeFile(join(root, 'official', 'extension.js'), 'module.exports = {};\n', 'utf8');
      const audited = await runAudit(root);
      expect(audited.code).toBe(1);
      expect(audited.stderr).toBe('');
      expect(new Set(audited.result.findings.map((finding) => finding.category))).toEqual(new Set([
        'secret', 'absolute-map-path', 'raw-ui-export', 'log', 'official-binary',
      ]));
      expect(audited.result.findings.every((finding) => !finding.relativePath.includes(root))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('passes on the repository and never scans ignored calibration data', async () => {
    const audited = await runAudit(repoRoot);
    expect(audited.code).toBe(0);
    expect(audited.result.findings).toEqual([]);
    expect(await readFile(join(repoRoot, 'scripts', 'privacy-audit.mjs'), 'utf8')).toContain('raw-ui-export');
  });

  it('finds a secret that was committed and then removed when history scanning is requested', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ymai-privacy-history-'));
    try {
      await execFileAsync('git', ['init'], { cwd: root, encoding: 'utf8' });
      await execFileAsync('git', ['config', 'user.email', 'privacy-test@example.invalid'], { cwd: root, encoding: 'utf8' });
      await execFileAsync('git', ['config', 'user.name', 'Privacy Test'], { cwd: root, encoding: 'utf8' });
      await writeFile(join(root, 'deleted-secret.txt'), 'token=ghp_abcdefghijklmnopqrstuvwxyz0123456789\n', 'utf8');
      await execFileAsync('git', ['add', 'deleted-secret.txt'], { cwd: root, encoding: 'utf8' });
      await execFileAsync('git', ['commit', '-m', 'seed historical secret'], { cwd: root, encoding: 'utf8' });
      await rm(join(root, 'deleted-secret.txt'));
      await execFileAsync('git', ['add', '-u'], { cwd: root, encoding: 'utf8' });
      await execFileAsync('git', ['commit', '-m', 'remove historical secret'], { cwd: root, encoding: 'utf8' });

      const workingTreeOnly = await runAudit(root);
      expect(workingTreeOnly.code).toBe(0);
      expect(workingTreeOnly.result.findings).toEqual([]);

      const withHistory = await runAudit(root, true);
      expect(withHistory.code).toBe(1);
      expect(withHistory.stderr).toBe('');
      expect(withHistory.result.findings).toContainEqual(expect.objectContaining({
        category: 'secret',
        relativePath: 'deleted-secret.txt',
      }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not exempt unreviewed files under test fixtures', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ymai-privacy-test-fixtures-'));
    try {
      const fixtureRoot = join(root, 'test', 'fixtures', 'unreviewed');
      await mkdir(fixtureRoot, { recursive: true });
      await writeFile(join(fixtureRoot, 'CustomUIData.lua'), 'return { _uid = 9 }\n', 'utf8');
      await writeFile(join(fixtureRoot, 'secret.txt'), 'token=ghp_abcdefghijklmnopqrstuvwxyz0123456789\n', 'utf8');
      await writeFile(join(fixtureRoot, 'path.txt'), 'D:\\private-map\\src\\GameEntry.lua\n', 'utf8');
      const audited = await runAudit(root);
      expect(audited.code).toBe(1);
      expect(new Set(audited.result.findings.map((finding) => finding.category))).toEqual(new Set([
        'raw-ui-export', 'secret', 'absolute-map-path',
      ]));
      expect(audited.result.findings.every((finding) => finding.relativePath.startsWith('test/fixtures/'))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
