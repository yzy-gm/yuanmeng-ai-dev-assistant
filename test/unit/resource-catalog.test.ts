import { describe, expect, it } from 'vitest';

import {
  buildResourceCatalog,
  parseResourceCatalogDocument,
  searchResourceCatalog,
} from '../../src/core/api/resource-catalog.js';

describe('local official resource documentation catalog', () => {
  it('parses named markdown tables with provenance and searchable ID domains', () => {
    const document = parseResourceCatalogDocument({
      relativePath: 'PropId.md',
      source: [
        '# 道具列表',
        '| 道具名字 | 道具ID |',
        '| --- | --- |',
        '| 喷气背包 | 1106007000000000  |',
      ].join('\n'),
    });
    const catalog = buildResourceCatalog([document]);

    expect(catalog.records).toEqual([expect.objectContaining({
      domain: 'prop', name: '喷气背包', id: '1106007000000000',
      sources: [expect.objectContaining({ relativePath: 'PropId.md', sha256: expect.stringMatching(/^[a-f0-9]{64}$/u) })],
    })]);
    expect(searchResourceCatalog(catalog, '喷气')).toEqual(catalog.records);
    expect(searchResourceCatalog(catalog, '1106007000000000')).toEqual(catalog.records);
  });

  it('deduplicates identical ItemId/IteamId rows and reports conflicting local docs without guessing', () => {
    const first = parseResourceCatalogDocument({
      relativePath: 'ItemId.md',
      source: '| 物品类型 | 物品名字 | 物品ID |\n| --- | --- | --- |\n| 货币 | 金币 | 101001 |\n',
    });
    const second = parseResourceCatalogDocument({
      relativePath: 'IteamId.md',
      source: '| 物品类型 | 物品名字 | 物品ID |\n| --- | --- | --- |\n| 货币 | 金币 | 101001 |\n| 货币 | 错误名称 | 101001 |\n',
    });
    const catalog = buildResourceCatalog([first, second]);

    expect(catalog.records).toHaveLength(1);
    expect(catalog.records[0]?.sources).toHaveLength(2);
    expect(catalog.issues).toEqual([expect.objectContaining({ code: 'RESOURCE_ID_CONFLICT', domain: 'item', id: '101001' })]);
  });
});
