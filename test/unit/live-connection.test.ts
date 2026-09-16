import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { nodeFileIO } from '../../src/core/fs.js';
import {
  readLiveOfficialConnection,
  writeLiveOfficialConnection,
} from '../../src/core/status/live-connection.js';

const projectInstanceId = '11111111-1111-4111-8111-111111111111';
const projectRootHash = 'a'.repeat(64);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('live official connection handoff', () => {
  it('shares a fresh redacted observation with CLI/MCP and expires it quickly', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ymai-live-connection-'));
    roots.push(root);
    const observedAt = new Date('2026-08-30T03:01:24.000Z');
    await writeLiveOfficialConnection(root, projectInstanceId, projectRootHash, {
      state: 'online',
      observedAt: observedAt.toISOString(),
      projectName: 'sample_map_alpha',
      source: 'official-output-log',
    }, nodeFileIO, observedAt);

    await expect(readLiveOfficialConnection(
      root,
      projectInstanceId,
      projectRootHash,
      nodeFileIO,
      new Date('2026-08-30T03:01:30.000Z'),
    )).resolves.toMatchObject({ state: 'online', projectName: 'sample_map_alpha' });
    await expect(readLiveOfficialConnection(
      root,
      projectInstanceId,
      projectRootHash,
      nodeFileIO,
      new Date('2026-08-30T03:01:45.000Z'),
    )).resolves.toBeNull();
  });

  it('rejects a live observation belonging to another project identity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ymai-live-connection-mismatch-'));
    roots.push(root);
    const now = new Date('2026-08-30T03:01:24.000Z');
    await writeLiveOfficialConnection(root, projectInstanceId, projectRootHash, {
      state: 'online', observedAt: now.toISOString(), projectName: null, source: 'official-output-log'
    }, nodeFileIO, now);
    await expect(readLiveOfficialConnection(
      root,
      '22222222-2222-4222-8222-222222222222',
      projectRootHash,
      nodeFileIO,
      now,
    )).resolves.toBeNull();
  });
});
