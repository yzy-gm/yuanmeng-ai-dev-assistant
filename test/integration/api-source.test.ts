import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { discoverOfficialApiSource } from '../../src/integrations/official/api-source.js';

async function createExtension(name: string, version: string, official: boolean): Promise<{
  id: string;
  extensionPath: string;
  packageJSON: unknown;
}> {
  const extensionPath = await mkdtemp(join(tmpdir(), `ymai-api-${name}-`));
  const packageJSON = {
    name,
    publisher: 'fixture',
    version,
    contributes: {
      commands: official ? [{ command: 'dreamhelper.GetCustomUIData', title: 'fixture' }] : [],
    },
  };
  await mkdir(join(extensionPath, 'res', 'lib'), { recursive: true });
  await writeFile(join(extensionPath, 'package.json'), JSON.stringify(packageJSON), 'utf8');
  await writeFile(
    join(extensionPath, 'res', 'lib', 'UI.d.lua'),
    await readFile(new URL('../fixtures/api/UI.d.lua', import.meta.url), 'utf8'),
    'utf8',
  );
  return { id: `fixture.${name}`, extensionPath, packageJSON };
}

describe('official API source discovery', () => {
  it('selects the unique command provider and returns only relative declaration paths', async () => {
    const official = await createExtension('official', '1.2.3', true);
    const unrelated = await createExtension('unrelated', '9.9.9', false);

    const selection = await discoverOfficialApiSource([official, unrelated], null);

    expect(selection).toMatchObject({
      state: 'selected',
      extensionId: 'fixture.official',
      officialExtensionVersion: '1.2.3',
      declarationPaths: ['res/lib/UI.d.lua'],
    });
    expect(JSON.stringify(selection)).not.toContain(await readFile(
      join(official.extensionPath, 'res', 'lib', 'UI.d.lua'),
      'utf8',
    ));
  });

  it('requires explicit override when multiple providers are present', async () => {
    const first = await createExtension('first', '1.0.0', true);
    const second = await createExtension('second', '2.0.0', true);

    const ambiguous = await discoverOfficialApiSource([first, second], null);
    const selected = await discoverOfficialApiSource([first, second], second.extensionPath);

    expect(ambiguous).toMatchObject({ state: 'ambiguous', candidates: expect.any(Array) });
    if (ambiguous.state === 'ambiguous') {
      expect(ambiguous.candidates).toHaveLength(2);
    }
    expect(selected).toMatchObject({
      state: 'selected',
      extensionId: 'fixture.second',
      officialExtensionVersion: '2.0.0',
    });
  });

  it('returns missing for unrelated extensions and rejects an invalid override', async () => {
    const unrelated = await createExtension('unrelated-only', '1.0.0', false);

    expect(await discoverOfficialApiSource([unrelated], null)).toEqual({ state: 'missing' });
    await expect(discoverOfficialApiSource([unrelated], unrelated.extensionPath)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });
});
