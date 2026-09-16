import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { listZipEntries, runOfficialReverseAudit, saveOfficialApiBaseline } from '../../src/core/official/reverse-audit.js';

const roots: string[] = [];

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

function fakeZip(names: readonly string[]): Uint8Array {
  const encoded = names.map((name) => new TextEncoder().encode(name));
  const directorySize = encoded.reduce((total, name) => total + 46 + name.length, 0);
  const bytes = new Uint8Array(directorySize + 22);
  const view = new DataView(bytes.buffer);
  let offset = 0;
  for (const name of encoded) {
    view.setUint32(offset, 0x02014b50, true);
    view.setUint16(offset + 8, 0x800, true);
    view.setUint32(offset + 20, 0, true);
    view.setUint32(offset + 24, 0, true);
    view.setUint16(offset + 28, name.length, true);
    bytes.set(name, offset + 46);
    offset += 46 + name.length;
  }
  view.setUint32(offset, 0x06054b50, true);
  view.setUint16(offset + 8, names.length, true);
  view.setUint16(offset + 10, names.length, true);
  view.setUint32(offset + 12, directorySize, true);
  view.setUint32(offset + 16, 0, true);
  return bytes;
}

async function fixture(): Promise<{ root: string; official: string; dreamcode: string; ugc: string }> {
  const root = await import('node:fs/promises').then(({ mkdtemp }) => mkdtemp(join(tmpdir(), 'ymai-official-audit-')));
  roots.push(root);
  const official = join(root, 'dream-helper');
  const dreamcode = join(root, 'dreamcode');
  const ugc = join(root, 'ugc');
  await mkdir(join(root, 'src', '.vscode'), { recursive: true });
  await mkdir(join(root, 'src', 'Client'), { recursive: true });
  await mkdir(join(root, 'src', 'Common'), { recursive: true });
  await mkdir(join(root, 'src', 'Server'), { recursive: true });
  await writeFile(join(root, 'src', 'GameEntry.lua'), 'return {}\n');
  await writeFile(join(root, 'src', 'Client', 'GameClient.lua'), 'return {}\n');
  await mkdir(join(official, 'res', 'lib'), { recursive: true });
  await mkdir(join(official, 'res', 'template'), { recursive: true });
  await writeFile(join(official, 'package.json'), JSON.stringify({ name: 'dream-helper', publisher: 'dreamhelper', version: '1.4.7', contributes: { commands: [{ command: 'dreamhelper.GetCustomUIData' }] } }));
  await writeFile(join(official, 'res', 'lib', 'UI.d.lua'), [
    '--- @module "UI"',
    '--- @param id string -- 控件 ID',
    'function UI:Find(id) end',
  ].join('\n'));
  await writeFile(join(official, 'res', 'template', 'template.zip'), fakeZip([
    'src/.vscode/settings.json', 'src/Client/GameClient.lua', 'src/Common/NetMsg.lua', 'src/GameEntry.lua', 'src/Server/GameServer.lua',
  ]));
  await mkdir(join(dreamcode, 'assets'), { recursive: true });
  await writeFile(join(dreamcode, 'package.json'), JSON.stringify({ name: 'dreamcode', publisher: 'antoniozhou', version: '0.1.8' }));
  await writeFile(join(dreamcode, 'assets', 'simple-toolbox.js'), 'Event_Element_OnSignal; GetValue_Element_GetElementPrefab; BIND_GAME_UI_DATA;');
  await mkdir(ugc, { recursive: true });
  await writeFile(join(ugc, 'script1.zip'), fakeZip(['src/GameEntry.lua', 'src/Server/GameServer.lua']));
  return { root, official, dreamcode, ugc };
}

describe('official reverse audit', () => {
  it('lists bounded zip directories without extracting or executing official content', () => {
    expect(listZipEntries(fakeZip(['src/GameEntry.lua', 'src/Server/GameServer.lua']))).toEqual([
      { name: 'src/GameEntry.lua', compressedSize: 0, uncompressedSize: 0 },
      { name: 'src/Server/GameServer.lua', compressedSize: 0, uncompressedSize: 0 },
    ]);
  });

  it('combines official API diff, DreamCode toolbox, template and script archive evidence', async () => {
    const input = await fixture();
    const extensionsRoot = join(input.root, 'extensions');
    await mkdir(extensionsRoot, { recursive: true });
    await import('node:fs/promises').then(({ cp }) => cp(input.official, join(extensionsRoot, 'dreamhelper.dream-helper-1.4.7'), { recursive: true }));
    await import('node:fs/promises').then(({ cp }) => cp(input.dreamcode, join(extensionsRoot, 'antoniozhou.dreamcode-0.1.8'), { recursive: true }));
    const first = await runOfficialReverseAudit({ projectRoot: input.root, extensionsRoot, ugcDataPath: input.ugc });
    expect(first.report.api).toMatchObject({ state: 'current', baselineState: 'missing', currentVersion: '1.4.7', currentCount: 1 });
    expect(first.report.dreamcode.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'event', symbol: 'Event_Element_OnSignal' }),
      expect.objectContaining({ kind: 'value', symbol: 'GetValue_Element_GetElementPrefab' }),
      expect.objectContaining({ kind: 'binding', symbol: 'BIND_GAME_UI_DATA' }),
    ]));
    expect(first.report.template).toMatchObject({ state: 'partial', presentFiles: ['src/Client/GameClient.lua', 'src/GameEntry.lua'] });
    expect(first.report.scripts).toMatchObject({ state: 'indexed', archiveCount: 1 });
    await saveOfficialApiBaseline(input.root, first.currentApi!);
    const second = await runOfficialReverseAudit({ projectRoot: input.root, extensionsRoot, ugcDataPath: input.ugc });
    expect(second.report.api).toMatchObject({ baselineState: 'present', baselineVersion: '1.4.7', diff: { added: [], removed: [], changed: [] } });
    expect(await readFile(join(input.root, '.yuanmeng-inspector', 'official', 'api-index-baseline.json'), 'utf8')).toContain('UI:Find');
  });
});
