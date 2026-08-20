import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import {
  validateCliLauncherManifest,
  validateLauncherBinding,
  type CliLauncherManifest,
  type LauncherInvocation,
} from '../../src/core/launcher/manifest.js';

const manifest: CliLauncherManifest = {
  schemaVersion: 1,
  extensionId: 'bujianxingguang.yuanmeng-ai-dev-assistant',
  extensionVersion: '0.1.0',
  extensionRootHash: 'a'.repeat(64),
  cliPath: 'C:/fictional extension/out/cli.cjs',
  cliSha256: 'b'.repeat(64),
  projectInstanceId: '00000000-0000-4000-8000-000000000001',
  projectRootHash: 'c'.repeat(64),
  generatedAt: '2026-08-19T00:00:00.000Z',
};

const invocation: LauncherInvocation = {
  extensionId: manifest.extensionId,
  extensionVersion: manifest.extensionVersion,
  extensionRootHash: manifest.extensionRootHash,
  cliPath: manifest.cliPath,
  cliSha256: manifest.cliSha256,
  projectInstanceId: manifest.projectInstanceId,
  projectRootHash: manifest.projectRootHash,
};

describe('CLI launcher manifest', () => {
  it('returns a binding only when every extension and project identity matches', () => {
    expect(validateLauncherBinding(manifest, invocation)).toEqual({
      cliPath: manifest.cliPath,
      projectInstanceId: manifest.projectInstanceId,
      projectRootHash: manifest.projectRootHash,
    });
  });

  it('rejects a launcher copied from another project', () => {
    expect(() => validateLauncherBinding(manifest, {
      ...invocation,
      projectRootHash: 'd'.repeat(64),
    })).toThrowError(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
  });

  it('rejects unknown fields and malformed hashes', () => {
    expect(() => validateCliLauncherManifest({
      ...manifest,
      cliSha256: 'not-a-hash',
      executable: 'unknown.exe',
    })).toThrowError(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
  });

  it('requires every extension and project binding field in the JSON schema', async () => {
    const raw = await readFile(new URL('../../schemas/cli-launcher.schema.json', import.meta.url), 'utf8');
    const schema = JSON.parse(raw) as {
      required: string[];
      properties: { extensionId: { const: string } };
    };

    expect(schema.required).toEqual([
      'schemaVersion',
      'extensionId',
      'extensionVersion',
      'extensionRootHash',
      'cliPath',
      'cliSha256',
      'projectInstanceId',
      'projectRootHash',
      'generatedAt',
    ]);
    expect(schema.properties.extensionId.const).toBe('bujianxingguang.yuanmeng-ai-dev-assistant');
  });
});
