import { describe, expect, it } from 'vitest';

import { runCodeDelivery, type CodeDeliveryDependencies } from '../../src/extension/code-delivery.js';

function dependencies(overrides: Partial<CodeDeliveryDependencies> = {}) {
  const order: string[] = [];
  let dirty = ['Z:\\fixture-project\\Entry.lua'];
  let snapshots = 0;
  const deps: CodeDeliveryDependencies = {
    projectRoot: 'Z:\\fixture-project',
    projectInstanceId: '44444444-4444-4444-8444-444444444444',
    workspaceRoots: ['Z:\\fixture-project'],
    listDirtyLua: () => dirty,
    saveAll: async () => { order.push('saveAll'); dirty = []; return true; },
    runStaticChecks: async () => { order.push('checks'); return { ok: true, summary: 'PASS', freshness: 'fresh' }; },
    runProjectAudit: async () => { order.push('audit'); return { ok: true, summary: 'PASS', evidence: 'STATIC_LOCAL' }; },
    isOfficialCommandAvailable: async () => true,
    executeOfficialBuild: async () => { order.push('scriptGen'); return undefined; },
    snapshotArtifacts: async () => {
      snapshots += 1;
      const version = snapshots === 1 ? 1 : 2;
      return [{ relativePath: 'dist/play.lua', size: version, mtimeMs: version, sha256: String(version) }];
    },
    now: () => new Date('2026-08-22T06:00:00.000Z'),
    wait: async () => undefined,
    observation: { timeoutMilliseconds: 50, sampleMilliseconds: 5, stableSampleCount: 3 },
    ...overrides
  };
  return { deps, order };
}

describe('automatic code delivery workflow', () => {
  it('sanitizes play.json without retaining the password field or an absolute project path', async () => {
    const module = await import('../../src/extension/code-delivery.js') as Record<string, unknown>;
    expect(module.parsePlayBuildEvidence).toBeTypeOf('function');
    const parse = module.parsePlayBuildEvidence as (content: string, projectRoot: string) => unknown;

    const evidence = parse(JSON.stringify({
      type: 'pack',
      pack: 'Z:\\fixture-project\\generated\\code_2026-08-23-09-30-00.zip',
      time: '2026-08-23-09-30-00',
      pwd: 'NEVER-EXPOSE-THIS'
    }), 'Z:\\fixture-project');

    expect(evidence).toEqual({
      type: 'pack',
      pack: 'generated/code_2026-08-23-09-30-00.zip',
      time: '2026-08-23-09-30-00'
    });
    expect(JSON.stringify(evidence)).not.toMatch(/pwd|NEVER-EXPOSE-THIS|Z:\\\\fixture-project/iu);
  });

  it('runs saveAll then checks then dreamhelper.scriptGen and reports artifact evidence', async () => {
    const item = dependencies();
    const result = await runCodeDelivery(item.deps);
    expect(item.order).toEqual(['saveAll', 'checks', 'audit', 'scriptGen']);
    expect(result).toMatchObject({
      projectPath: 'Z:\\fixture-project',
      dirtyBefore: ['Entry.lua'],
      dirtyAfter: [],
      savedFiles: ['Entry.lua'],
      commandAvailable: true,
      status: 'BUILT',
      evidenceLevel: 'EXTENSION_HOST'
    });
    expect(result.artifactChanges).toHaveLength(1);
  });

  it('stops when saveAll leaves dirty Lua or static checks fail', async () => {
    const saveFailed = dependencies({ saveAll: async () => false });
    expect((await runCodeDelivery(saveFailed.deps)).status).toBe('SAVE_FAILED');
    expect(saveFailed.order).toEqual([]);

    const checkFailed = dependencies({ runStaticChecks: async () => ({ ok: false, summary: 'Lua error', freshness: 'fresh' }) });
    expect((await runCodeDelivery(checkFailed.deps)).status).toBe('CHECK_FAILED');
    expect(checkFailed.order).not.toContain('scriptGen');
  });

  it('blocks the official command when the fresh full project audit finds invalid Lua', async () => {
    const item = dependencies();
    const deps = {
      ...item.deps,
      runProjectAudit: async () => ({
        ok: false,
        summary: 'Lua 语法无效：src/Client/Broken_backup.lua',
        reasonCode: 'INVALID_LUA_SYNTAX',
        file: 'src/Client/Broken_backup.lua',
        nextActions: ['修正 Lua 源文件或索引配置后重试。'],
        evidence: 'STATIC_LOCAL' as const,
      }),
    };

    const result = await runCodeDelivery(deps);

    expect(result).toMatchObject({
      status: 'CHECK_FAILED',
      nextAction: expect.stringContaining('src/Client/Broken_backup.lua'),
    });
    expect(item.order).not.toContain('scriptGen');
  });

  it('reports missing command, unchanged artifacts, or explicit official sent evidence accurately', async () => {
    const missing = dependencies({ isOfficialCommandAvailable: async () => false });
    expect((await runCodeDelivery(missing.deps)).status).toBe('COMMAND_UNAVAILABLE');
    expect(missing.order).not.toContain('scriptGen');

    const unchanged = dependencies({
      snapshotArtifacts: async () => [{ relativePath: 'dist/play.lua', size: 1, mtimeMs: 1, sha256: 'same' }]
    });
    expect((await runCodeDelivery(unchanged.deps)).status).toBe('EVIDENCE_INSUFFICIENT');

    const sent = dependencies({
      snapshotArtifacts: async () => [],
      executeOfficialBuild: async () => '工程代码已经发送'
    });
    expect(await runCodeDelivery(sent.deps)).toMatchObject({
      status: 'SENT',
      officialOutputEvidence: ['工程代码已经发送'],
      evidenceLevel: 'EXTENSION_HOST'
    });
  });

  it('returns only the type, pack, and time whitelist from play.json evidence', async () => {
    let snapshot = 0;
    const item = dependencies({
      readPlayBuildEvidence: async () => ({
        type: 'pack',
        pack: 'dist/code_2026-08-23-09-30-00.zip',
        time: '2026-08-23-09-30-00'
      }),
      snapshotArtifacts: async () => {
        snapshot += 1;
        const version = snapshot === 1 ? 1 : 2;
        return [{
          relativePath: 'dist/code_2026-08-23-09-30-00.zip',
          size: version,
          mtimeMs: version,
          sha256: String(version)
        }];
      }
    } as Partial<CodeDeliveryDependencies>);

    const result = await runCodeDelivery(item.deps);

    expect(result).toMatchObject({
      playBuildEvidence: {
        type: 'pack',
        pack: 'dist/code_2026-08-23-09-30-00.zip',
        time: '2026-08-23-09-30-00',
        matchesChangedArtifact: true
      }
    });
    expect(JSON.stringify(result)).not.toContain('pwd');
  });

  it('does not fail a completed artifact observation when optional play.json evidence is locked', async () => {
    const item = dependencies({
      readPlayBuildEvidence: async () => {
        throw Object.assign(new Error('locked'), { code: 'EPERM' });
      }
    });

    await expect(runCodeDelivery(item.deps)).resolves.toMatchObject({
      status: 'BUILT',
      playBuildEvidence: null
    });
  });

  it('rejects unknown or ambiguous roots and never claims map publish/share success', async () => {
    const ambiguous = dependencies({ workspaceRoots: ['Z:\\fixture-project', 'z:\\fixture-project\\'] });
    expect((await runCodeDelivery(ambiguous.deps)).status).toBe('PROJECT_AMBIGUOUS');
    expect(ambiguous.order).toEqual([]);

    const result = await runCodeDelivery(dependencies().deps);
    expect(JSON.stringify(result)).not.toMatch(/地图(?:保存|发布)成功|游戏内共享成功/u);
  });

  it('detects a delayed real code_*.zip after the command returns', async () => {
    let sample = 0;
    const item = dependencies({
      snapshotArtifacts: async () => {
        sample += 1;
        return sample < 4 ? [] : [{
          relativePath: 'dist/code_2026-08-22-14-00-00.zip', size: 12, mtimeMs: 10, sha256: 'zip-final'
        }];
      },
      executeOfficialBuild: async () => undefined
    });
    const result = await runCodeDelivery(item.deps);
    expect(result.status).toBe('BUILT');
    expect(result.artifactChanges).toEqual(expect.arrayContaining([
      expect.objectContaining({ relativePath: 'dist/code_2026-08-22-14-00-00.zip' })
    ]));
    expect(sample).toBeGreaterThanOrEqual(6);
  });

  it('waits for a chunked zip to become stable and handles dist cleanup before replacement', async () => {
    const snapshots = [
      [{ relativePath: 'dist/play.lua', size: 9, mtimeMs: 1, sha256: 'old' }],
      [],
      [{ relativePath: 'dist/code_2026-08-22-14-01-00.zip', size: 2, mtimeMs: 2, sha256: 'part-1' }],
      [{ relativePath: 'dist/code_2026-08-22-14-01-00.zip', size: 8, mtimeMs: 3, sha256: 'part-2' }],
      [{ relativePath: 'dist/code_2026-08-22-14-01-00.zip', size: 8, mtimeMs: 3, sha256: 'part-2' }],
      [{ relativePath: 'dist/code_2026-08-22-14-01-00.zip', size: 8, mtimeMs: 3, sha256: 'part-2' }],
    ];
    let index = 0;
    const item = dependencies({
      snapshotArtifacts: async () => snapshots[Math.min(index++, snapshots.length - 1)]!
    });
    const result = await runCodeDelivery(item.deps);
    expect(result.status).toBe('BUILT');
    expect(result.artifactChanges).toEqual(expect.arrayContaining([
      expect.objectContaining({ relativePath: 'dist/play.lua', after: null }),
      expect.objectContaining({ relativePath: 'dist/code_2026-08-22-14-01-00.zip', before: null })
    ]));
    expect(index).toBeGreaterThanOrEqual(6);
  });

  it('times out as evidence-insufficient when no generated artifact changes', async () => {
    let samples = 0;
    const item = dependencies({
      snapshotArtifacts: async () => {
        samples += 1;
        return [{ relativePath: 'dist/play.min.lua', size: 1, mtimeMs: 1, sha256: 'same' }];
      }
    });
    const result = await runCodeDelivery(item.deps);
    expect(result.status).toBe('EVIDENCE_INSUFFICIENT');
    expect(samples).toBe(11);
  });

  it('blocks stale or unknown diagnostics before calling the official command', async () => {
    const stale = dependencies({
      runStaticChecks: async () => ({ ok: true, summary: 'old zero', freshness: 'stale' })
    });
    const result = await runCodeDelivery(stale.deps);
    expect(result.status).toBe('CHECK_FAILED');
    expect(stale.order).not.toContain('scriptGen');
  });
});
