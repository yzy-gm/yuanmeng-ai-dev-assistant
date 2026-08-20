import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { ExtensionTestCase } from './index.js';

export const hostNoiseProbeTests: ExtensionTestCase[] = [{
  name: 'VSCode 1.70.2 host-noise probe writes a Lua file without activating the product',
  run: async () => {
    const root = process.env.YMAI_EXTENSION_TEST_ROOT_A;
    assert.ok(root);
    const dataDirectory = join(root, 'src', 'Data');
    await mkdir(dataDirectory, { recursive: true });
    await writeFile(join(dataDirectory, 'CustomUIData.lua'), 'return {}\n', 'utf8');
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  },
}];
