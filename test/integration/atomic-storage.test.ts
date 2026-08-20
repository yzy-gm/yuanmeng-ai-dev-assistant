import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ProductError } from '../../src/core/errors.js';
import {
  atomicWriteJson,
  nodeFileIO,
  readJsonValidated,
  type FileIO,
} from '../../src/core/fs.js';
import { sha256Hex, stableJson } from '../../src/core/hash.js';

const temporaryDirectories: string[] = [];

async function makeTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'ymai-atomic-'));
  temporaryDirectories.push(directory);
  return directory;
}

function validateV1(value: unknown): asserts value is { schemaVersion: 1; ok: boolean } {
  if (
    typeof value !== 'object'
    || value === null
    || !('schemaVersion' in value)
    || value.schemaVersion !== 1
    || !('ok' in value)
    || typeof value.ok !== 'boolean'
  ) {
    throw new ProductError('VALIDATION_FAILED', 'Expected schema version 1.', ['检查输入数据。'], 'UNIT_E2E');
  }
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('stable JSON and hashing', () => {
  it('serializes object keys deterministically', () => {
    expect(stableJson({ z: 1, nested: { y: 3, b: 4 }, a: 2 })).toBe(
      '{\n  "a": 2,\n  "nested": {\n    "b": 4,\n    "y": 3\n  },\n  "z": 1\n}\n',
    );
  });

  it('uses lowercase SHA-256 hex', () => {
    expect(sha256Hex('fictional')).toBe('a524644266885e16a3bb16166ae38bdbfb36af08fc51036f4dbb91423c7cbcc1');
  });
});

describe('atomic JSON storage', () => {
  it('does not replace a valid file when validation fails', async () => {
    const directory = await makeTemporaryDirectory();
    const target = join(directory, 'state.json');
    await writeFile(target, '{"schemaVersion":1,"ok":true}', 'utf8');

    await expect(atomicWriteJson(nodeFileIO, target, { schemaVersion: 2 }, validateV1)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });

    expect(await readFile(target, 'utf8')).toBe('{"schemaVersion":1,"ok":true}');
    expect(await readdir(directory)).toEqual(['state.json']);
  });

  it('retries a transient Windows rename collision without deleting the old target', async () => {
    const directory = await makeTemporaryDirectory();
    const target = join(directory, 'state.json');
    await writeFile(target, stableJson({ schemaVersion: 1, ok: false }), 'utf8');
    let renameAttempts = 0;
    const io: FileIO = {
      ...nodeFileIO,
      async rename(from, to) {
        renameAttempts += 1;
        if (renameAttempts < 3) {
          const error = new Error('busy') as NodeJS.ErrnoException;
          error.code = 'EBUSY';
          throw error;
        }
        await nodeFileIO.rename(from, to);
      },
    };

    await atomicWriteJson(io, target, { schemaVersion: 1, ok: true }, validateV1);

    expect(renameAttempts).toBe(3);
    expect(await readJsonValidated(nodeFileIO, target, validateV1)).toEqual({ schemaVersion: 1, ok: true });
    expect(await readdir(directory)).toEqual(['state.json']);
  });
});
