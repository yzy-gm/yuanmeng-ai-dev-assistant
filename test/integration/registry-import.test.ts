import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { RegistryDocument } from '../../src/core/model.js';
import {
  RegistryStore,
  renderRegistry,
  type RegistryImportFormat,
} from '../../src/core/registry/store.js';

const roots: string[] = [];

async function temporaryRegistry(): Promise<{ root: string; path: string; initial: RegistryDocument }> {
  const root = await mkdtemp(join(tmpdir(), 'ymai-registry-'));
  roots.push(root);
  const path = join(root, 'registry.json');
  const initial: RegistryDocument = { schemaVersion: 1, records: [] };
  await writeFile(path, `${JSON.stringify(initial, null, 2)}\n`, 'utf8');
  return { root, path, initial };
}

async function fixture(format: RegistryImportFormat): Promise<string> {
  return readFile(new URL(`../fixtures/registry/valid.${format === 'yaml' ? 'yaml' : format}`, import.meta.url), 'utf8');
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('transactional registry import', () => {
  it.each(['json', 'yaml', 'csv'] as const)('previews and commits %s without losing orthogonal fields', async (format) => {
    const { path } = await temporaryRegistry();
    const store = await RegistryStore.open(path);

    const preview = await store.previewImport(await fixture(format), format);

    expect(preview.document.records[0]).toMatchObject({ environment: 'test', validity: 'confirmed' });
    expect(preview).toMatchObject({ added: ['fixture-ui'], removed: [], changed: [] });
    await store.commitImport(preview);
    expect((await RegistryStore.open(path)).list()).toEqual([
      expect.objectContaining({ recordId: 'fixture-ui', environment: 'test', validity: 'confirmed' }),
    ]);
  });

  it.each(['json', 'yaml', 'csv'] as const)('round-trips product-owned %s exports', async (format) => {
    const { path } = await temporaryRegistry();
    const store = await RegistryStore.open(path);
    const document = JSON.parse(await fixture('json')) as RegistryDocument;

    const preview = await store.previewImport(renderRegistry(document, format), format);

    expect(preview.document).toEqual(document);
  });

  it.each([
    ['duplicate IDs', 'json', (document: RegistryDocument) => ({ ...document, records: [document.records[0]!, document.records[0]!] })],
    ['invalid environment', 'json', (document: RegistryDocument) => ({ ...document, records: [{ ...document.records[0]!, environment: 'production' }] })],
    ['invalid validity', 'json', (document: RegistryDocument) => ({ ...document, records: [{ ...document.records[0]!, validity: 'trusted' }] })],
    ['mixed fingerprints', 'json', (document: RegistryDocument) => ({
      ...document,
      records: [document.records[0]!, {
        ...document.records[0]!,
        recordId: 'other-map',
        mapFingerprint: 'b'.repeat(64),
      }],
    })],
  ] as const)('rejects %s and leaves the registry byte-identical', async (_name, format, mutate) => {
    const { path } = await temporaryRegistry();
    const store = await RegistryStore.open(path);
    const before = await readFile(path, 'utf8');
    const valid = JSON.parse(await fixture('json')) as RegistryDocument;
    const invalid = JSON.stringify(mutate(valid));

    await expect(store.previewImport(invalid, format)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(await readFile(path, 'utf8')).toBe(before);
  });

  it.each([
    ['malformed CSV quoting', 'csv', 'recordId,kind\n"unterminated,ui-control\n'],
    ['bad YAML row', 'yaml', 'schemaVersion: 1\nrecords:\n  - nope\n'],
  ] as const)('rejects %s without writing', async (_name, format, input) => {
    const { path } = await temporaryRegistry();
    const store = await RegistryStore.open(path);
    const before = await readFile(path, 'utf8');

    await expect(store.previewImport(input, format)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(await readFile(path, 'utf8')).toBe(before);
  });

  it('rejects a stale preview instead of overwriting concurrent changes', async () => {
    const { path } = await temporaryRegistry();
    const store = await RegistryStore.open(path);
    const preview = await store.previewImport(await fixture('json'), 'json');
    await writeFile(path, '{"schemaVersion":1,"records":[]}\n ', 'utf8');

    await expect(store.commitImport(preview)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('rejects deeply nested YAML before parsing it', async () => {
    const { path } = await temporaryRegistry();
    const store = await RegistryStore.open(path);
    const deeplyNested = `schemaVersion: 1\nrecords: ${'['.repeat(256)}${']'.repeat(256)}\n`;

    await expect(store.previewImport(deeplyNested, 'yaml')).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      message: expect.stringContaining('YAML 嵌套深度'),
    });
  });

  it('rejects oversized registry imports before parsing them', async () => {
    const { path } = await temporaryRegistry();
    const store = await RegistryStore.open(path);

    await expect(store.previewImport(`schemaVersion: 1\nrecords: []\n#${'x'.repeat(4 * 1024 * 1024)}`, 'yaml'))
      .rejects.toMatchObject({
        code: 'VALIDATION_FAILED',
        message: expect.stringContaining('导入文件超过'),
      });
  });
});
