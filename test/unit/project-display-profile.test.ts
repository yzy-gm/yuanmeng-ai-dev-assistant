import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { nodeFileIO } from '../../src/core/fs.js';
import {
  readProjectDisplayProfile,
  writeProjectDisplayProfile,
} from '../../src/core/project/display-profile.js';

const projectInstanceId = '00000000-0000-4000-8000-000000000901';

describe('project display profile', () => {
  it('persists a trimmed per-project map name and allows replacing it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ymai-display-profile-'));

    await writeProjectDisplayProfile(root, projectInstanceId, '  星光超市  ', nodeFileIO);
    expect(await readProjectDisplayProfile(root, projectInstanceId, nodeFileIO)).toMatchObject({
      schemaVersion: 1,
      projectInstanceId,
      mapDisplayName: '星光超市',
    });

    await writeProjectDisplayProfile(root, projectInstanceId, '星光超市·夜间版', nodeFileIO);
    expect((await readProjectDisplayProfile(root, projectInstanceId, nodeFileIO))?.mapDisplayName)
      .toBe('星光超市·夜间版');
  });

  it('rejects empty names instead of restoring an ambiguous unknown label', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ymai-display-profile-empty-'));
    await expect(writeProjectDisplayProfile(root, projectInstanceId, '   ', nodeFileIO)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });
});
