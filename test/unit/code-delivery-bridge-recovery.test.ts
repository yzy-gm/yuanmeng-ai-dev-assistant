import { mkdir, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import type * as FsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const renameControl = vi.hoisted(() => ({ remainingEperm: 0, attempts: 0 }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  return {
    ...actual,
    rename: async (from: string, to: string) => {
      renameControl.attempts += 1;
      if (renameControl.remainingEperm > 0) {
        renameControl.remainingEperm -= 1;
        throw Object.assign(new Error('locked'), { code: 'EPERM' });
      }
      return actual.rename(from, to);
    }
  };
});

import { FileCodeDeliveryClient, writeBridgeJson } from '../../src/mcp/code-delivery.js';

const roots: string[] = [];

afterEach(async () => {
  renameControl.remainingEperm = 0;
  renameControl.attempts = 0;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('code delivery bridge recovery', () => {
  it('retries a short EPERM lock and leaves no plugin temporary file', async () => {
    const root = join(tmpdir(), `ymai-bridge-retry-${process.pid}-${Date.now()}`);
    roots.push(root);
    await mkdir(root, { recursive: true });
    renameControl.remainingEperm = 2;
    const target = join(root, 'host.json');

    await writeBridgeJson(target, { schemaVersion: 1, state: 'ready' });

    expect(renameControl.attempts).toBe(3);
    expect(JSON.parse(await readFile(target, 'utf8'))).toEqual({ schemaVersion: 1, state: 'ready' });
    expect((await readdir(root)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('removes only strictly named stale plugin bridge temporary files', async () => {
    const root = join(tmpdir(), `ymai-bridge-cleanup-${process.pid}-${Date.now()}`);
    roots.push(root);
    const requests = join(root, 'requests');
    await mkdir(requests, { recursive: true });
    const stale = join(requests, 'host.json.123.11111111-1111-4111-8111-111111111111.tmp');
    const unrelated = join(requests, 'user-file.tmp');
    await writeFile(stale, 'stale', 'utf8');
    await writeFile(unrelated, 'keep', 'utf8');
    await utimes(stale, new Date(0), new Date(0));
    const module = await import('../../src/mcp/code-delivery.js') as Record<string, unknown>;
    expect(module.cleanupStaleBridgeTemporaryFiles).toBeTypeOf('function');
    const cleanup = module.cleanupStaleBridgeTemporaryFiles as (
      bridgeRoot: string,
      options: { nowMilliseconds: number; staleAfterMilliseconds: number; maximumFiles: number }
    ) => Promise<{ removed: number }>;

    expect(await cleanup(root, {
      nowMilliseconds: 60_000,
      staleAfterMilliseconds: 30_000,
      maximumFiles: 10
    })).toEqual({ removed: 1 });
    expect(await readdir(requests)).toEqual(['user-file.tmp']);
  });

  it('waits briefly for an active host to refresh an expired lease', async () => {
    const root = join(tmpdir(), `ymai-bridge-lease-${process.pid}-${Date.now()}`);
    roots.push(root);
    const projectInstanceId = '22222222-2222-4222-8222-222222222222';
    const projectRootHash = 'a'.repeat(64);
    const bridgeRoot = join(root, '.yuanmeng-inspector', 'mcp-bridge');
    await mkdir(join(bridgeRoot, 'requests'), { recursive: true });
    await writeFile(join(bridgeRoot, 'host.json'), JSON.stringify({
      schemaVersion: 1,
      projectInstanceId,
      projectRootHash,
      updatedAt: '2000-01-01T00:00:00.000Z'
    }), 'utf8');
    const client = new FileCodeDeliveryClient({
      projectRoot: root,
      projectInstanceId,
      projectRootHash,
      timeoutMilliseconds: 2_000,
      leaseMaxAgeMilliseconds: 500,
      leaseRecoveryMilliseconds: 500,
      leasePollMilliseconds: 20
    } as ConstructorParameters<typeof FileCodeDeliveryClient>[0]);
    const responder = setInterval(() => {
      void (async () => {
        const requests = await readdir(join(bridgeRoot, 'requests'));
        const name = requests.find((candidate) => candidate.endsWith('.json'));
        if (name === undefined) return;
        let request: { requestId: string };
        try {
          request = JSON.parse(await readFile(join(bridgeRoot, 'requests', name), 'utf8')) as { requestId: string };
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
          throw error;
        }
        await writeBridgeJson(join(bridgeRoot, 'responses', name), {
          schemaVersion: 1,
          requestId: request.requestId,
          projectInstanceId,
          result: {
            projectPath: root,
            savedFiles: [], dirtyBefore: [], dirtyAfter: [], commandAvailable: true,
            buildStartedAt: null, artifactChanges: [], officialOutputEvidence: [], playBuildEvidence: null,
            status: 'BUILT', nextAction: 'done', evidenceLevel: 'EXTENSION_HOST'
          }
        });
      })();
    }, 20);
    const refreshTimer = setTimeout(() => {
      void writeFile(join(bridgeRoot, 'host.json'), JSON.stringify({
        schemaVersion: 1,
        projectInstanceId,
        projectRootHash,
        updatedAt: new Date().toISOString()
      }), 'utf8');
    }, 60);
    try {
      const result = await client.deliver(new AbortController().signal);
      expect(result.status).toBe('BUILT');
    } finally {
      clearInterval(responder);
      clearTimeout(refreshTimer);
    }
  });
});
