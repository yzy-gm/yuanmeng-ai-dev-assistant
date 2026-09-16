import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { FixedClock } from '../../src/core/clock.js';
import { nodeFileIO } from '../../src/core/fs.js';
import {
  RequestQueueHost,
  createQueueSession,
  createRefreshUiRequest,
} from '../../src/integrations/queue/protocol.js';

const temporaryDirectories: string[] = [];
const projectInstanceId = '00000000-0000-4000-8000-000000000001';

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'ymai-queue-'));
  temporaryDirectories.push(root);
  const pending = join(root, 'requests', 'pending');
  await mkdir(pending, { recursive: true });
  const clock = new FixedClock('2026-08-19T00:00:30.000Z');
  const session = createQueueSession(projectInstanceId, new FixedClock('2026-08-19T00:00:00.000Z'));
  let refreshCalls = 0;
  const host = new RequestQueueHost({
    clock,
    io: nodeFileIO,
    runtimeRoot: root,
    session,
    refreshUi: async () => { refreshCalls += 1; },
  });
  return { root, pending, clock, session, host, refreshCalls: () => refreshCalls };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('tokenized refresh request queue', () => {
  it('accepts only a current refresh-ui request and writes a result', async () => {
    const context = await setup();
    const request = createRefreshUiRequest(context.session, context.clock);
    const path = join(context.pending, `${request.requestId}.json`);
    await writeFile(path, JSON.stringify(request), 'utf8');

    const result = await context.host.processFile(path);

    expect(result).toMatchObject({ status: 'completed', code: 'OK' });
    expect(context.refreshCalls()).toBe(1);
    expect(await readdir(join(context.root, 'requests', 'results'))).toEqual([`${request.requestId}.json`]);
  });

  it('reports an unchanged structure as a completed request without claiming a new update', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ymai-queue-unchanged-'));
    temporaryDirectories.push(root);
    const session = createQueueSession(projectInstanceId, new FixedClock('2026-08-20T00:00:00.000Z'));
    const request = createRefreshUiRequest(session, new FixedClock('2026-08-20T00:00:01.000Z'));
    const pending = join(root, 'requests', 'pending', `${request.requestId}.json`);
    await mkdir(join(root, 'requests', 'pending'), { recursive: true });
    await writeFile(pending, JSON.stringify(request), 'utf8');
    const host = new RequestQueueHost({
      clock: new FixedClock('2026-08-20T00:00:02.000Z'),
      io: nodeFileIO,
      runtimeRoot: root,
      session,
      refreshUi: async () => ({ reasonCode: 'REFRESH_SUCCEEDED_UNCHANGED' }),
    });

    const result = await host.processFile(pending);

    expect(result).toMatchObject({
      status: 'completed',
      code: 'OK',
      message: '已检查 UI，内容未变化；现有快照仍为最新。',
    });
  });

  it.each([
    ['wrong token', { token: '0'.repeat(64) }, 'QUEUE_TOKEN_INVALID'],
    ['expired', { expiresAt: '2026-08-19T00:00:01.000Z' }, 'QUEUE_REQUEST_EXPIRED'],
    ['wrong project', { projectInstanceId: '00000000-0000-4000-8000-000000000002' }, 'QUEUE_PROJECT_MISMATCH'],
    ['unknown action', { action: 'push-property' }, 'QUEUE_ACTION_REJECTED'],
  ])('rejects %s and never invokes the official adapter', async (_name, change, code) => {
    const context = await setup();
    const request = { ...createRefreshUiRequest(context.session, context.clock), ...change };
    const path = join(context.pending, `${request.requestId}.json`);
    await writeFile(path, JSON.stringify(request), 'utf8');

    const result = await context.host.processFile(path);

    expect(result).toMatchObject({ status: 'rejected', code });
    expect(context.refreshCalls()).toBe(0);
    const written = JSON.parse(await readFile(join(context.root, 'requests', 'results', `${request.requestId}.json`), 'utf8'));
    expect(written).toMatchObject({ requestId: request.requestId, status: 'rejected', code });
  });

  it('rejects a non-atomic tmp request and a duplicate ID', async () => {
    const context = await setup();
    const request = createRefreshUiRequest(context.session, context.clock);
    const temporaryPath = join(context.pending, `${request.requestId}.tmp`);
    await writeFile(temporaryPath, JSON.stringify(request), 'utf8');

    expect(await context.host.processFile(temporaryPath)).toMatchObject({ code: 'QUEUE_NON_ATOMIC_REQUEST' });
    expect(context.refreshCalls()).toBe(0);

    const finalPath = join(context.pending, `${request.requestId}.json`);
    await writeFile(finalPath, JSON.stringify(request), 'utf8');
    expect(await context.host.processFile(finalPath)).toMatchObject({ code: 'OK' });
    expect(await context.host.processFile(finalPath)).toMatchObject({ code: 'QUEUE_DUPLICATE_REQUEST' });
    expect(context.refreshCalls()).toBe(1);
  });
});
