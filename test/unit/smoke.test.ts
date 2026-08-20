import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { main } from '../../src/cli/main.js';
import { PRODUCT_NAME } from '../../src/core/model.js';

describe('product identity', () => {
  it('uses the independent companion name', () => {
    expect(PRODUCT_NAME).toBe('Yuanmeng AI Dev Assistant');
  });

  it('declares Node 20 for development and standalone CLI installation', async () => {
    const manifest = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')) as {
      engines?: { node?: string };
    };

    expect(manifest.engines?.node).toBe('>=20');
  });
});
describe('CLI baseline', () => {
  it('returns usage for an empty argument list', async () => {
    const messages: string[] = [];

    const exitCode = await main([], (message) => messages.push(message));

    expect(exitCode).toBe(7);
    expect(messages).toEqual(['用法：ymai <命令> [选项]\n']);
  });
});
