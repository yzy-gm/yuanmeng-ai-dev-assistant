import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

import { parse } from 'yaml';

import type { ExtensionTestCase } from './index.js';
import { atomicWriteJson, nodeFileIO, readJsonValidated } from '../../src/core/fs.js';
import { sha256Hex } from '../../src/core/hash.js';
import { parseLuaLiteralDocument } from '../../src/core/lua/literal-parser.js';

interface ProbeDocument {
  schemaVersion: 1;
  value: string;
}

function validateProbe(value: unknown): asserts value is ProbeDocument {
  assert.equal(typeof value, 'object');
  assert.ok(value !== null);
  assert.equal((value as ProbeDocument).schemaVersion, 1);
  assert.equal(typeof (value as ProbeDocument).value, 'string');
}

export const runtimeCapabilityTests: ExtensionTestCase[] = [{
  name: 'runtime capabilities execute inside the VSCode Extension Host',
  run: async () => {
    const temporaryRoot = process.env.YMAI_EXTENSION_TEST_TEMP;
    assert.ok(temporaryRoot);
    const nodeMajor = Number(process.versions.node.split('.')[0]);
    assert.ok(nodeMajor >= 16, `unexpected embedded Node ${process.versions.node}`);
    console.log(`EXTENSION_HOST_NODE=${process.versions.node}`);
    assert.equal(randomBytes(32).byteLength, 32);
    assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    const path = join(temporaryRoot, 'runtime-probe', 'probe.json');
    await atomicWriteJson(nodeFileIO, path, { schemaVersion: 1, value: '中文' }, validateProbe);
    assert.deepEqual(await readJsonValidated(nodeFileIO, path, validateProbe), { schemaVersion: 1, value: '中文' });
    assert.deepEqual(parseLuaLiteralDocument('return { ok = true }').value, { ok: true });
    assert.deepEqual(parse('name: 元梦\nitems:\n  - one\n'), { name: '元梦', items: ['one'] });
  },
}];
