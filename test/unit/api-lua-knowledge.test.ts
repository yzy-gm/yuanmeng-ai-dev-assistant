import { describe, expect, it } from 'vitest';

import { buildLuaApiKnowledge, classifyApiIdDomain } from '../../src/core/api/lua-knowledge.js';
import type { ApiDeclaration, ApiIndex } from '../../src/core/api/declaration-index.js';
import { buildLuaSourceIndex } from '../../src/core/lua/source-index.js';

function declaration(module: string, name: string, parameterName: string): ApiDeclaration {
  return {
    key: `${module}:${name}`,
    module,
    name,
    callStyle: 'colon',
    description: '',
    signature: `${module}:${name}(${parameterName})`,
    params: [{ name: parameterName, type: 'number', description: '' }],
    returns: [],
    officialExtensionVersion: '1.4.7',
    source: { relativePath: `${module}.d.lua`, sha256: 'a'.repeat(64) },
  };
}

describe('official API Lua knowledge', () => {
  it('classifies scene, UI, player and resource IDs without collapsing them into one registry domain', () => {
    expect(classifyApiIdDomain('signalBoxId')).toBe('scene-instance');
    expect(classifyApiIdDomain('elementTypeId')).toBe('element-type');
    expect(classifyApiIdDomain('groupId')).toBe('scene-group');
    expect(classifyApiIdDomain('controlId')).toBe('ui-control');
    expect(classifyApiIdDomain('PlayerID')).toBe('player');
    expect(classifyApiIdDomain('PropId')).toBe('prop');
    expect(classifyApiIdDomain('ImageId')).toBe('image');
    expect(classifyApiIdDomain('EffectId')).toBe('effect');
    expect(classifyApiIdDomain('ItemUID')).toBe('item');
    expect(classifyApiIdDomain('retryCount')).toBeNull();
  });

  it('preserves parameter domains while only treating actual signal names as signal references', () => {
    const declarations = [
      declaration('TriggerBox', 'Contains', 'signalBoxId'),
      declaration('Player', 'Teleport', 'playerId'),
      declaration('Prop', 'Use', 'propId'),
      declaration('Event', 'Send', 'signalName'),
    ];
    const index: ApiIndex = {
      schemaVersion: 2,
      officialExtensionVersion: '1.4.7',
      declarations,
      constants: [],
      enums: [],
    };
    const knowledge = buildLuaApiKnowledge(index);
    const sourceIndex = buildLuaSourceIndex([{
      path: 'src/GameServer.lua',
      source: [
        'TriggerBox:Contains(517)',
        'Player:Teleport(2001)',
        'Prop:Use(1108005004001007)',
        'Event:Send("round_started")',
      ].join('\n'),
    }], { schemaVersion: 1, records: [] }, knowledge);

    expect(sourceIndex.idReferences).toEqual([
      expect.objectContaining({ value: '517', idDomain: 'scene-instance' }),
      expect.objectContaining({ value: '2001', idDomain: 'player' }),
      expect.objectContaining({ value: '1108005004001007', idDomain: 'prop' }),
    ]);
    expect(sourceIndex.signalReferences).toEqual([
      expect.objectContaining({ value: 'round_started', role: 'send' }),
    ]);
  });
});
