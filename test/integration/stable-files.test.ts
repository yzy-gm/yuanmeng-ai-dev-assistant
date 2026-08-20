import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { nodeFileIO } from '../../src/core/fs.js';
import { sha256Hex } from '../../src/core/hash.js';
import { parseLuaLiteralDocument } from '../../src/core/lua/literal-parser.js';
import {
  DEFAULT_STABLE_EXPORT_OPTIONS,
  waitForStableExport,
} from '../../src/integrations/official/files.js';

const temporaryDirectories: string[] = [];

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'ymai-stable-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('stable official export observation', () => {
  it('declares three 150 ms samples, a 2 second split window, and a 15 second deadline', () => {
    expect(DEFAULT_STABLE_EXPORT_OPTIONS).toEqual({
      sampleMilliseconds: 150,
      stableSampleCount: 3,
      splitCollectionMilliseconds: 2_000,
      totalTimeoutMilliseconds: 15_000,
    });
  });

  it('waits through a half-write and collects a second split part', async () => {
    const directory = await temporaryDirectory();
    const first = join(directory, 'CustomUIData.lua');
    const second = join(directory, 'CustomUIData2.lua');
    const baseline = 'return { old = true }';
    const completeFirst = 'return { schemaVersion = 1, roots = {} }';
    const completeSecond = 'return { schemaVersion = 1, roots = { { id = 41003, name = "结算", type = "Panel", children = {} } } }';
    await writeFile(first, baseline, 'utf8');
    const writer = (async () => {
      await delay(10);
      await writeFile(first, 'return { schemaVersion =', 'utf8');
      await delay(25);
      await writeFile(first, completeFirst, 'utf8');
      await delay(25);
      await writeFile(second, completeSecond, 'utf8');
    })();

    const result = await waitForStableExport({
      io: nodeFileIO,
      paths: [first, second],
      baselineHashes: { [first]: sha256Hex(baseline), [second]: null },
      sampleMilliseconds: 20,
      stableSampleCount: 3,
      splitCollectionMilliseconds: 100,
      totalTimeoutMilliseconds: 600,
      validateContent: (_path, content) => { parseLuaLiteralDocument(content); },
    });
    await writer;

    expect(result.files.map((file) => file.path)).toEqual([first, second]);
    expect(result.files.map((file) => file.content)).toEqual([completeFirst, completeSecond]);
    expect(result.reasonCode).toBe('REFRESH_SUCCEEDED');
  });

  it('accepts already-present stable files when the official command leaves structure unchanged', async () => {
    const directory = await temporaryDirectory();
    const target = join(directory, 'CustomUIData.lua');
    const content = 'return { schemaVersion = 1, roots = {} }';
    await writeFile(target, content, 'utf8');

    const result = await waitForStableExport({
      io: nodeFileIO,
      paths: [target],
      baselineHashes: { [target]: sha256Hex(content) },
      acceptUnchangedStableFiles: true,
      sampleMilliseconds: 10,
      stableSampleCount: 2,
      splitCollectionMilliseconds: 20,
      totalTimeoutMilliseconds: 200,
      validateContent: (_path, value) => { parseLuaLiteralDocument(value); },
    });

    expect(result.files).toHaveLength(1);
    expect(result.reasonCode).toBe('REFRESH_SUCCEEDED_UNCHANGED');
    expect(result.observedSignatureChange).toBe(false);
  });

  it('accepts a same-content rewrite and reports the changed file signature', async () => {
    const directory = await temporaryDirectory();
    const target = join(directory, 'CustomUIData.lua');
    const content = 'return { schemaVersion = 1, roots = {} }';
    await writeFile(target, content, 'utf8');
    const initial = await nodeFileIO.stat(target);
    const baselineSignature = `${initial.size}:${initial.mtimeMs}`;
    await delay(20);
    await writeFile(target, content, 'utf8');

    const result = await waitForStableExport({
      io: nodeFileIO,
      paths: [target],
      baselineHashes: { [target]: sha256Hex(content) },
      baselineSignatures: { [target]: baselineSignature },
      acceptUnchangedStableFiles: true,
      sampleMilliseconds: 10,
      stableSampleCount: 2,
      splitCollectionMilliseconds: 20,
      totalTimeoutMilliseconds: 200,
      validateContent: (_path, value) => { parseLuaLiteralDocument(value); },
    });

    expect(result.reasonCode).toBe('REFRESH_SUCCEEDED_UNCHANGED');
    expect(result.observedSignatureChange).toBe(true);
  });

  it('still times out when the official command produces no UI files', async () => {
    const directory = await temporaryDirectory();
    await expect(waitForStableExport({
      io: nodeFileIO,
      paths: [join(directory, 'CustomUIData.lua')],
      baselineHashes: {},
      sampleMilliseconds: 10,
      stableSampleCount: 2,
      splitCollectionMilliseconds: 20,
      totalTimeoutMilliseconds: 60,
    })).rejects.toMatchObject({ code: 'EXPORT_TIMEOUT' });
  });

  it('throws without replacing a caller-owned old snapshot when new content is invalid', async () => {
    const directory = await temporaryDirectory();
    const target = join(directory, 'CustomUIData.lua');
    const baseline = 'return { old = true }';
    const previousSnapshot = { snapshotId: 'known-good' };
    await writeFile(target, baseline, 'utf8');
    const writer = (async () => {
      await delay(10);
      await writeFile(target, 'return factory()', 'utf8');
    })();

    await expect(waitForStableExport({
      io: nodeFileIO,
      paths: [target],
      baselineHashes: { [target]: sha256Hex(baseline) },
      sampleMilliseconds: 15,
      stableSampleCount: 3,
      splitCollectionMilliseconds: 30,
      totalTimeoutMilliseconds: 300,
      validateContent: (_path, content) => { parseLuaLiteralDocument(content); },
    })).rejects.toMatchObject({ code: 'UNSAFE_LUA_NODE' });
    await writer;

    expect(previousSnapshot).toEqual({ snapshotId: 'known-good' });
  });
});
