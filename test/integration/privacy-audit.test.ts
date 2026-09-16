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

function storedZipEntry(name: string, content: Uint8Array): Buffer {
  const nameBytes = Buffer.from(name, 'utf8');
  const payload = Buffer.from(content);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(payload.length, 18);
  local.writeUInt32LE(payload.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(payload.length, 20);
  central.writeUInt32LE(payload.length, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  const centralOffset = local.length + nameBytes.length + payload.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + nameBytes.length, 12);
  end.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([local, nameBytes, payload, central, nameBytes, end]);
}

async function runAudit(
  root: string,
  history = false,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<{ code: number; result: AuditResult; stderr: string }> {
  try {
    const output = await execFileAsync(
      process.execPath,
      ['scripts/privacy-audit.mjs', '--repository', root, ...(history ? ['--history'] : []), '--json'],
      { cwd: repoRoot, encoding: 'utf8', env: environment },
    );
    return { code: 0, result: JSON.parse(output.stdout) as AuditResult, stderr: output.stderr };
  } catch (error) {
    const failure = error as { code: number; stdout: string; stderr: string };
    return { code: failure.code, result: failure.stdout === '' ? { schemaVersion: 1, findings: [] } : JSON.parse(failure.stdout) as AuditResult, stderr: failure.stderr };
  }
}

async function runPrivateDataAudit(root: string): Promise<{ code: number; result: AuditResult & { summary: Array<{ category: string; count: number }> }; stdout: string; stderr: string }> {
  try {
    const output = await execFileAsync(
      process.execPath,
      ['scripts/privacy-audit.mjs', '--private-data', root, '--json'],
      { cwd: repoRoot, encoding: 'utf8' },
    );
    return { code: 0, result: JSON.parse(output.stdout) as AuditResult & { summary: Array<{ category: string; count: number }> }, stdout: output.stdout, stderr: output.stderr };
  } catch (error) {
    const failure = error as { code: number; stdout: string; stderr: string };
    return {
      code: failure.code,
      result: JSON.parse(failure.stdout) as AuditResult & { summary: Array<{ category: string; count: number }> },
      stdout: failure.stdout,
      stderr: failure.stderr,
    };
  }
}

async function runVsixInspection(vsixPath: string): Promise<{ code: number; result: AuditResult; stderr: string }> {
  try {
    const output = await execFileAsync(
      process.execPath,
      ['scripts/inspect-vsix.mjs', vsixPath, '--json'],
      { cwd: repoRoot, encoding: 'utf8' },
    );
    return { code: 0, result: JSON.parse(output.stdout) as AuditResult, stderr: output.stderr };
  } catch (error) {
    const failure = error as { code: number; stdout: string; stderr: string };
    return { code: failure.code, result: JSON.parse(failure.stdout) as AuditResult, stderr: failure.stderr };
  }
}

describe('privacy audit', () => {
  it('does not treat an identifier containing task_completion_check as an access token', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ymai-privacy-identifier-'));
    try {
      await writeFile(join(root, 'prompt.txt'), 'yuanmeng_task_completion_check\n', 'utf8');
      const audited = await runAudit(root);
      expect(audited.code).toBe(0);
      expect(audited.stderr).toBe('');
      expect(audited.result.findings).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not report an identifier containing task_completion_check as a VSIX secret', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ymai-vsix-identifier-'));
    try {
      const vsixPath = join(root, 'identifier.vsix');
      await writeFile(vsixPath, storedZipEntry(
        'extension/prompt.txt',
        Buffer.from('yuanmeng_task_completion_check\n', 'utf8'),
      ));
      const inspected = await runVsixInspection(vsixPath);
      expect(inspected.stderr).toBe('');
      expect(inspected.result.findings).not.toContainEqual(expect.objectContaining({ category: 'secret' }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects committed gameplay run artifacts inside a VSIX', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ymai-vsix-gameplay-run-'));
    try {
      const vsixPath = join(root, 'gameplay-run.vsix');
      await writeFile(vsixPath, storedZipEntry(
        'extension/.yuanmeng-inspector/gameplay/runs/run-1/manifest.json',
        Buffer.from('{"schemaVersion":1}', 'utf8'),
      ));
      const inspected = await runVsixInspection(vsixPath);
      expect(inspected.code).toBe(1);
      expect(inspected.stderr).toBe('');
      expect(inspected.result.findings).toContainEqual(expect.objectContaining({
        category: 'private-scene-data',
        relativePath: 'extension/.yuanmeng-inspector/gameplay/runs/run-1/manifest.json',
      }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

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

  it('detects private map paths written with slash, UNC, and common Unix path styles', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ymai-privacy-path-styles-'));
    try {
      await writeFile(join(root, 'paths.txt'), [
        'D:/private-map/src/GameEntry.lua',
        String.raw`\\server\private-map\src\GameEntry.lua`,
        '//server/private-map/src/GameEntry.lua',
        '/home/creator/private-map/src/GameEntry.lua',
      ].join('\n'), 'utf8');

      const audited = await runAudit(root);
      expect(audited.code).toBe(1);
      expect(audited.stderr).toBe('');
      expect(audited.result.findings).toContainEqual(expect.objectContaining({
        category: 'absolute-map-path',
        relativePath: 'paths.txt',
      }));
      expect(audited.result.findings).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not treat generated source comments as forward-slash UNC paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ymai-privacy-generated-comment-'));
    try {
      await writeFile(join(root, 'bundle.js'), '// node_modules/yaml/dist/nodes/identity.js\n', 'utf8');
      const audited = await runAudit(root);
      expect(audited.code).toBe(0);
      expect(audited.stderr).toBe('');
      expect(audited.result.findings).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fails closed when a Git repository inventory cannot be read', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ymai-privacy-git-failure-'));
    try {
      await mkdir(join(root, '.git'), { recursive: true });
      await writeFile(join(root, 'ordinary.txt'), 'anonymous\n', 'utf8');
      const audited = await runAudit(root, false, { ...process.env, PATH: '' });
      expect(audited.code).toBe(2);
      expect(audited.stderr).toBe('');
      expect(audited.result.findings).toContainEqual(expect.objectContaining({
        category: 'audit-read-error',
        relativePath: '.',
      }));
      expect(JSON.stringify(audited.result)).not.toContain(root);
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

  it('audits force-tracked private cache content even though its directory is normally skipped', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ymai-privacy-tracked-cache-'));
    try {
      const snapshotDirectory = join(root, '.yuanmeng-inspector', 'scene', 'snapshots');
      const gameplayRunsDirectory = join(root, '.yuanmeng-inspector', 'gameplay', 'runs', 'run-1');
      await mkdir(snapshotDirectory, { recursive: true });
      await mkdir(gameplayRunsDirectory, { recursive: true });
      await writeFile(join(root, '.gitignore'), '.yuanmeng-inspector/\n', 'utf8');
      await writeFile(join(snapshotDirectory, `${'c'.repeat(64)}.json`), JSON.stringify({
        schemaVersion: 1,
        snapshotId: 'c'.repeat(64),
        sourceSha256: 'd'.repeat(64),
        instances: [{ instanceId: '123' }],
        groups: [],
      }), 'utf8');
      await writeFile(join(root, '.yuanmeng-inspector', 'gameplay', 'latest.json'), '{"runId":"run-1"}\n', 'utf8');
      await writeFile(join(gameplayRunsDirectory, 'manifest.json'), '{"runId":"run-1"}\n', 'utf8');
      await execFileAsync('git', ['init'], { cwd: root, encoding: 'utf8' });
      await execFileAsync('git', ['add', '.gitignore'], { cwd: root, encoding: 'utf8' });
      await execFileAsync('git', ['add', '-f', '.yuanmeng-inspector'], { cwd: root, encoding: 'utf8' });

      const audited = await runAudit(root);
      expect(audited.code).toBe(1);
      expect(audited.stderr).toBe('');
      expect(audited.result.findings).toContainEqual(expect.objectContaining({
        category: 'private-cache',
        relativePath: `.yuanmeng-inspector/scene/snapshots/${'c'.repeat(64)}.json`,
      }));
      expect(audited.result.findings).toContainEqual(expect.objectContaining({
        category: 'private-cache',
        relativePath: '.yuanmeng-inspector/gameplay/latest.json',
      }));
      expect(audited.result.findings).toContainEqual(expect.objectContaining({
        category: 'private-cache',
        relativePath: '.yuanmeng-inspector/gameplay/runs/run-1/manifest.json',
      }));
      expect(audited.result.findings).toContainEqual(expect.objectContaining({ category: 'scene-snapshot' }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('optionally scans local private caches and VSIX artifacts without logging private contents', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ymai-private-data-scan-'));
    try {
      await mkdir(join(root, '.yuanmeng-inspector', 'scene', 'snapshots'), { recursive: true });
      await mkdir(join(root, '.yuanmeng-inspector', 'reports'), { recursive: true });
      await mkdir(join(root, '.yuanmeng-inspector', 'logs'), { recursive: true });
      await writeFile(join(root, '.yuanmeng-inspector', 'scene', 'snapshots', `${'a'.repeat(64)}.json`), JSON.stringify({
        schemaVersion: 1,
        snapshotId: 'a'.repeat(64),
        sourceSha256: 'b'.repeat(64),
        instances: [{ instanceId: 'anonymous-instance', ownerId: null }],
        groups: [],
        issues: [],
        unknownFields: [],
      }), 'utf8');
      await writeFile(join(root, '.yuanmeng-inspector', 'reports', 'private.txt'), 'D:\\private-ugc\\Saved\\LayerData.pbin\n', 'utf8');
      await writeFile(join(root, '.yuanmeng-inspector', 'logs', 'session.log'), 'anonymous runtime line\n', 'utf8');
      await writeFile(join(root, 'private.vsix'), storedZipEntry('extension/LayerData.pbin', Buffer.from([0x2a, 0x02, 0x08, 0x01])));
      await writeFile(join(root, 'LayerData.pbin'), Buffer.from([0x2a, 0x02, 0x08, 0x01]));

      const audited = await runPrivateDataAudit(root);
      expect(audited.code).toBe(1);
      expect(audited.stderr).toBe('');
      expect(new Set(audited.result.findings.map((finding) => finding.category))).toEqual(new Set([
        'absolute-ugc-path', 'layerdata-reference', 'private-cache', 'private-log', 'private-report',
        'raw-scene-data', 'scene-instance-list', 'scene-snapshot', 'zip-magic',
      ]));
      expect(audited.result.summary.every((entry) => entry.count > 0)).toBe(true);
      expect(audited.result.findings.every((finding) => !finding.relativePath.includes(root))).toBe(true);
      expect(audited.result.findings.every((finding) => (
        JSON.stringify(Object.keys(finding).sort()) === JSON.stringify(['category', 'relativePath'])
      ))).toBe(true);
      expect(audited.result.findings).toContainEqual(expect.objectContaining({
        category: 'raw-scene-data',
        relativePath: 'private.vsix!/extension/LayerData.pbin',
      }));
      expect(audited.stdout).not.toContain('private-ugc');
      expect(audited.stdout).not.toContain('anonymous-instance');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('detects private UGC paths with forward slashes and Unix roots without echoing them', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ymai-private-path-styles-'));
    try {
      await writeFile(join(root, 'paths.txt'), [
        'D:/private-ugc/Saved/LayerData.pbin',
        '//server/private-ugc/Saved/LayerData-Auto.dat',
        '/home/creator/private-ugc/Saved/LayerData.pbin',
      ].join('\n'), 'utf8');
      const audited = await runPrivateDataAudit(root);
      expect(audited.code).toBe(1);
      expect(audited.stderr).toBe('');
      expect(audited.result.findings).toContainEqual({ category: 'absolute-ugc-path', relativePath: 'paths.txt' });
      expect(audited.stdout).not.toContain('private-ugc');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reports private scan failures without printing the absolute private path to stderr or stdout', async () => {
    const missing = join(tmpdir(), `ymai-missing-private-${Date.now()}`);
    const audited = await runPrivateDataAudit(missing);
    expect(audited.code).not.toBe(0);
    expect(audited.stderr).toBe('');
    expect(audited.result.findings).toContainEqual({ category: 'scan-error', relativePath: '.' });
    expect(audited.stdout).not.toContain(missing);
  });
});
