import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { BuildWorkflow, DEFAULT_BUILD_OBSERVATION } from '../../src/core/build/workflow.js';

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ymai-build-中文-'));
  await mkdir(join(root, 'dist'), { recursive: true });
  return root;
}

describe('official script build observation', () => {
  it('declares a 60 second timeout and requires command availability and confirmation', async () => {
    expect(DEFAULT_BUILD_OBSERVATION.totalTimeoutMilliseconds).toBe(60_000);
    const root = await project();
    const workflow = new BuildWorkflow();
    const prepared = await workflow.prepare(root);
    let calls = 0;
    const execute = async () => { calls += 1; };

    expect(await workflow.confirmAndRun(prepared, { confirmed: false, commandAvailable: true, execute })).toMatchObject({
      outcome: 'cancelled',
    });
    expect(calls).toBe(0);
    await expect(workflow.confirmAndRun(prepared, { confirmed: true, commandAvailable: false, execute })).rejects.toMatchObject({
      code: 'OFFICIAL_COMMAND_MISSING',
    });
    expect(calls).toBe(0);
    expect(await workflow.confirmAndRun(prepared, { confirmed: true, commandAvailable: true, execute })).toMatchObject({
      outcome: 'requested',
    });
    expect(calls).toBe(1);
  });

  it.each([
    ['play.lua', ['dist/play.lua']],
    ['play.min.lua', ['dist/play.min.lua']],
    ['both', ['dist/play.lua', 'dist/play.min.lua']],
  ] as const)('reports %s changes only as artifact-updated', async (_name, expected) => {
    const root = await project();
    await writeFile(join(root, 'dist', 'play.lua'), 'old play\n', 'utf8');
    await writeFile(join(root, 'dist', 'play.min.lua'), 'old min\n', 'utf8');
    const workflow = new BuildWorkflow({
      sampleMilliseconds: 10,
      stableSampleCount: 2,
      splitCollectionMilliseconds: 30,
      totalTimeoutMilliseconds: 300,
    });
    const prepared = await workflow.prepare(root);
    const writer = (async () => {
      await delay(20);
      if (expected.includes('dist/play.lua')) await writeFile(join(root, 'dist', 'play.lua'), 'new play\n', 'utf8');
      if (expected.includes('dist/play.min.lua')) await writeFile(join(root, 'dist', 'play.min.lua'), 'new min\n', 'utf8');
    })();
    const result = await workflow.observeResult(prepared);
    await writer;

    expect(result.outcome).toBe('artifact-updated');
    expect(result.updatedArtifacts).toEqual(expected);
    expect(result.gameRuntimePassed).toBe(false);
    expect(result.evidence).toBe('UNIT_E2E');
  });

  it('returns a distinct unchanged timeout without claiming a successful build', async () => {
    const root = await project();
    await writeFile(join(root, 'dist', 'play.lua'), 'unchanged\n', 'utf8');
    const workflow = new BuildWorkflow({
      sampleMilliseconds: 10,
      stableSampleCount: 2,
      splitCollectionMilliseconds: 20,
      totalTimeoutMilliseconds: 50,
    });
    const prepared = await workflow.prepare(root);

    await expect(workflow.observeResult(prepared)).resolves.toMatchObject({
      outcome: 'timeout',
      reasonCode: 'ARTIFACT_UNCHANGED_TIMEOUT',
      updatedArtifacts: [],
      gameRuntimePassed: false,
    });
  });
});
