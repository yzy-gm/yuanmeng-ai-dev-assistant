import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { inspectOfficialSources } from '../../src/core/environment/official-sources.js';

const roots: string[] = [];

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('read-only official source index', () => {
  it('indexes the extension, game version, static filenames, and UGC block usage without exposing absolute paths', async () => {
    const root = await temporaryRoot('ymai-official-index-');
    const extensions = join(root, 'extensions');
    const official = join(extensions, 'dreamhelper.dream-helper-1.4.7');
    await mkdir(join(official, 'res', 'lib'), { recursive: true });
    await writeFile(join(official, 'package.json'), JSON.stringify({
      publisher: 'dreamhelper', name: 'dream-helper', version: '1.4.7',
      contributes: { commands: [{ command: 'dreamhelper.GetCustomUIData' }] },
    }), 'utf8');
    await writeFile(join(official, 'res', 'lib', 'Events.d.lua'), '--- declarations', 'utf8');

    const game = join(root, 'game');
    await mkdir(join(game, 'LetsGo', 'Content', 'Flag'), { recursive: true });
    await mkdir(join(game, 'LetsGo', 'GameData', 'Saved', 'PersistentDownloadDir'), { recursive: true });
    await writeFile(join(game, 'LetsGo', 'Content', 'Flag', 'versionJson.json'), JSON.stringify({ version: '1.5.82.1' }), 'utf8');
    await writeFile(join(game, 'LetsGo', 'GameData', 'Saved', 'PersistentDownloadDir', 'UGCEditorMapTemplate.pbin'), 'opaque', 'utf8');
    await writeFile(join(game, 'LetsGo', 'GameData', 'Saved', 'PersistentDownloadDir', 'static.zip'), 'archive', 'utf8');

    const ugc = join(root, 'ugc');
    await mkdir(ugc, { recursive: true });
    await writeFile(join(ugc, 'UGCPDeviceInfo.json'), JSON.stringify({
      undefined_BLOCK_USED_Action_Player_S19SetQuitText: true,
      undefined_BLOCK_USED_Condition_Global_IsInStandalone: false,
      unrelated: true,
    }), 'utf8');
    const privateMapPath = ['C:', 'private', 'map', 'src'].join('\\');
    await writeFile(join(ugc, 'UGCScriptProjectInfo.ini'), `[Project1]\nPath=${privateMapPath}\n[Project2]\n`, 'utf8');

    const index = await inspectOfficialSources({
      extensionsRoot: extensions,
      gameInstallPath: game,
      ugcDataPath: ugc,
    });

    expect(index.extension).toMatchObject({ state: 'selected', id: 'dreamhelper.dream-helper', version: '1.4.7', declarationCount: 1, commands: ['dreamhelper.GetCustomUIData'] });
    expect(index.game).toMatchObject({ state: 'indexed', version: '1.5.82.1', versionSource: 'LetsGo/Content/Flag/versionJson.json' });
    expect(index.game?.staticConfig.names).toEqual(['static.zip', 'UGCEditorMapTemplate.pbin']);
    expect(index.ugc).toMatchObject({
      state: 'indexed',
      projectRecordCount: 2,
      usedBlockKeys: ['Action_Player_S19SetQuitText', 'Condition_Global_IsInStandalone'],
    });
    expect(JSON.stringify(index)).not.toMatch(/[A-Za-z]:[\\/]/u);
    expect(JSON.stringify(index)).not.toContain('private\\map');
  });

  it('reports optional sources as not-configured and malformed configured data as invalid', async () => {
    const root = await temporaryRoot('ymai-official-index-empty-');
    const malformed = join(root, 'bad');
    await mkdir(malformed, { recursive: true });
    await writeFile(join(malformed, 'UGCPDeviceInfo.json'), '{bad', 'utf8');

    const index = await inspectOfficialSources({ ugcDataPath: malformed });
    expect(index.game).toMatchObject({ state: 'not-configured' });
    expect(index.ugc).toMatchObject({ state: 'invalid' });
    expect(index.warnings.length).toBeGreaterThan(0);
  });
});
