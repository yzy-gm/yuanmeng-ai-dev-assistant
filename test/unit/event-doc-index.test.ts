import { describe, expect, it } from 'vitest';

import { buildApiIndex, parseDeclarationFile } from '../../src/core/api/declaration-index.js';
import { parseEventDocumentation, resolveEventMetadata } from '../../src/core/api/event-doc-index.js';

function declaration(names: readonly string[]) {
  return buildApiIndex([parseDeclarationFile({
    relativePath: 'res/lib/Events.d.lua',
    source: `--- @module "Events"\nlocal Events_module = {}\n${names.map((name) => `---@const Events.${name}\nEvents_module.${name} = "${name}"`).join('\n')}\n`,
  })], { officialExtensionVersion: '1.4.7-test' });
}

describe('strict local event documentation enrichment', () => {
  it('joins current declarations to confirmed scope and ordered callback parameters', () => {
    const docs = parseEventDocumentation({ sourceId: 'fixture/Events.md', source: `
### Events.ON_CHARACTER_ENTER_SIGNAL_BOX
* 描述: 当角色进入触发盒
* 描述: 在服务端和客户端都能收到
* 描述: 事件传参: playerId:number -- 玩家id
* 描述: 事件传参: signalBoxId:number -- 触发盒id
\`\`\`lua
System:RegisterEvent(Events.ON_CHARACTER_ENTER_SIGNAL_BOX, function (playerId, signalBoxId) end)
\`\`\`
` });
    const resolved = resolveEventMetadata(declaration(['ON_CHARACTER_ENTER_SIGNAL_BOX']), docs);
    expect(resolved).toEqual([expect.objectContaining({
      name: 'ON_CHARACTER_ENTER_SIGNAL_BOX', availability: 'matched', scope: 'both',
      callbackState: 'confirmed', generationEligibility: 'allowed', conflicts: [],
      callbackParameters: [
        expect.objectContaining({ index: 0, name: 'playerId', typeText: 'number' }),
        expect.objectContaining({ index: 1, name: 'signalBoxId', typeText: 'number' }),
      ],
    })]);
  });

  it('blocks callback, registration, doc-only and declaration-only conflicts instead of guessing', () => {
    const docs = parseEventDocumentation({ sourceId: 'fixture/Events.md', source: `
### Events.ON_BROKEN
* 描述: 只有服务端能收到
* 描述: 事件传参: first:number -- one
\`\`\`lua
System:RegisterEvent(Events.WRONG, function (first, second) end)
\`\`\`
### Events.ON_DOC_ONLY
* 描述: 只有客户端能收到
\`\`\`lua
System:RegisterEvent(Events.ON_DOC_ONLY, function () end)
\`\`\`
` });
    const resolved = resolveEventMetadata(declaration(['ON_BROKEN', 'ON_DECLARATION_ONLY']), docs);
    expect(resolved.find((event) => event.name === 'ON_BROKEN')).toMatchObject({
      availability: 'matched', callbackState: 'conflict', generationEligibility: 'blocked',
    });
    expect(resolved.find((event) => event.name === 'ON_DOC_ONLY')).toMatchObject({ availability: 'doc-only', generationEligibility: 'blocked' });
    expect(resolved.find((event) => event.name === 'ON_DECLARATION_ONLY')).toMatchObject({ availability: 'declaration-only', generationEligibility: 'blocked' });
  });

  it('only normalizes known official scope typos by exact event allowlist', () => {
    const docs = parseEventDocumentation({ sourceId: 'fixture/Events.md', source: `
### Events.ON_PLAYER_CLICK_ITEM
* 描述: 只有客户端端能收到
* 描述: 事件传参: ItemId:string -- item
\`\`\`lua
System:RegisterEvent(Events.ON_PLAYER_CLICK_ITEM, function (ItemId) end)
\`\`\`
` });
    expect(docs.events[0]).toMatchObject({ scope: 'client', callbackState: 'confirmed' });
    expect(docs.events[0]!.warnings).toHaveLength(1);
  });

  it('blocks contradictory scope declarations instead of selecting the first one', () => {
    const docs = parseEventDocumentation({ sourceId: 'fixture/Events.md', source: `
### Events.ON_CONFLICTING_SCOPE
* 描述: 只有服务端能收到
* 描述: 只有客户端能收到
\`\`\`lua
System:RegisterEvent(Events.ON_CONFLICTING_SCOPE, function () end)
\`\`\`
` });
    expect(docs.events[0]).toMatchObject({
      scope: 'unknown', callbackState: 'confirmed',
      conflicts: expect.arrayContaining([expect.stringContaining('多个运行端范围')]),
    });
    expect(resolveEventMetadata(declaration(['ON_CONFLICTING_SCOPE']), docs)[0]).toMatchObject({
      generationEligibility: 'blocked',
    });
  });
});
