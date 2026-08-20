import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  applyProposal,
  createPatchProposal,
  undoBackup,
  validateTarget,
} from '../../src/core/patch/proposal.js';

describe('hash-guarded patch proposals', () => {
  it('protects official generated outputs and workspace boundaries', () => {
    expect(() => validateTarget('dist/play.lua')).toThrowError(expect.objectContaining({ code: 'GENERATED_FILE_PROTECTED' }));
    expect(() => validateTarget('dist/play.min.lua')).toThrowError(expect.objectContaining({ code: 'GENERATED_FILE_PROTECTED' }));
    expect(() => validateTarget('../outside.lua')).toThrowError(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
    expect(() => validateTarget('.yuanmeng-inspector/status.json')).toThrowError(expect.objectContaining({ code: 'GENERATED_FILE_PROTECTED' }));
  });

  it('requires confirmation, creates a hash manifest, and blocks unsafe undo', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ymai patch 中文-'));
    const target = join(root, 'src', 'Generated.lua');
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(target, 'return 1\n', 'utf8');
    const proposal = createPatchProposal({
      projectInstanceId: '00000000-0000-4000-8000-000000000901',
      targetPath: 'src/Generated.lua',
      originalContent: 'return 1\n',
      newContent: 'return 2\n',
      summary: 'anonymous test change',
      createdAt: '2026-08-20T01:02:03.000Z',
    });

    await expect(applyProposal(root, proposal, false)).rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED' });
    expect(await readFile(target, 'utf8')).toBe('return 1\n');
    await expect(applyProposal(root, { ...proposal, originalContent: 'misleading preview\n' }, true)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    expect(await readFile(target, 'utf8')).toBe('return 1\n');

    const applied = await applyProposal(root, proposal, true);
    expect(await readFile(target, 'utf8')).toBe('return 2\n');
    const manifest = JSON.parse(await readFile(applied.manifestPath, 'utf8')) as Record<string, unknown>;
    expect(manifest).toMatchObject({
      targetPath: 'src/Generated.lua',
      originalSha256: proposal.originalSha256,
      newSha256: proposal.newSha256,
      originalExisted: true,
    });
    expect(applied.manifestPath).toContain(join('.yuanmeng-inspector', 'backups'));

    await writeFile(target, 'external change\n', 'utf8');
    await expect(undoBackup(root, applied.manifestPath)).rejects.toMatchObject({ code: 'HASH_CONFLICT' });
    expect(await readFile(target, 'utf8')).toBe('external change\n');

    await writeFile(target, 'return 2\n', 'utf8');
    await undoBackup(root, applied.manifestPath);
    expect(await readFile(target, 'utf8')).toBe('return 1\n');
  });
});
