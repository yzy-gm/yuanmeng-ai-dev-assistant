import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, it } from 'vitest';

import { loadDreamCodeApiCatalog, searchBlockApiCatalog } from '../../src/core/api/block-catalog.js';

describe('DreamCode block API catalog', () => {
  it('loads a bounded catalog with source fingerprint and searches semantic fields', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ymai-dreamcode-api-'));
    await mkdir(root, { recursive: true });
    await writeFile(join(root, 'package.json'), JSON.stringify({ version: '0.1.8' }), 'utf8');
    await writeFile(join(root, 'api.json'), JSON.stringify([{
      category: '玩家', name: '获取玩家位置', service: 'PlayerService',
      method: 'GetPosition(string player)', params: 'vector3', desc: '读取玩家坐标。',
    }]), 'utf8');
    const catalog = await loadDreamCodeApiCatalog({ extensionPath: root });
    expect(catalog.state).toBe('selected');
    expect(catalog.extensionVersion).toBe('0.1.8');
    expect(catalog.source?.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(searchBlockApiCatalog(catalog, '玩家位置')).toHaveLength(1);
    expect(catalog.warnings.join('')).toContain('不证明当前地图存在完整积木连接图');
  });

  it('rejects multiple auto-discovered DreamCode extensions instead of guessing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ymai-dreamcode-extensions-'));
    for (const name of ['antoniozhou.dreamcode-0.1.7', 'antoniozhou.dreamcode-0.1.8']) {
      await mkdir(join(root, name), { recursive: true });
      await writeFile(join(root, name, 'api.json'), '[]', 'utf8');
    }
    const catalog = await loadDreamCodeApiCatalog({ extensionsRoot: root });
    expect(catalog.state).toBe('ambiguous');
    expect(catalog.entries).toEqual([]);
  });
});
