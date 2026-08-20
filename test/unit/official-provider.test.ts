import { describe, expect, it } from 'vitest';

import { discoverOfficialCommandProvider } from '../../src/integrations/official/provider.js';

describe('official command provider discovery', () => {
  it('discovers a unique provider by its contributed public command without an extension ID dependency', () => {
    expect(discoverOfficialCommandProvider([
      { id: 'unrelated.extension', packageJSON: { version: '1.0.0', contributes: { commands: [] } } },
      {
        id: 'publisher.changing-identifier',
        packageJSON: {
          version: '1.4.7',
          contributes: { commands: [{ command: 'dreamhelper.GetCustomUIData' }] },
        },
      },
    ])).toEqual({ extensionId: 'publisher.changing-identifier', version: '1.4.7' });
  });

  it.each([
    { name: 'no provider', extensions: [] },
    {
      name: 'ambiguous providers',
      extensions: [
        { id: 'one', packageJSON: { version: '1', contributes: { commands: [{ command: 'dreamhelper.GetCustomUIData' }] } } },
        { id: 'two', packageJSON: { version: '2', contributes: { commands: [{ command: 'dreamhelper.GetCustomUIData' }] } } },
      ],
    },
    {
      name: 'provider with unknown version',
      extensions: [{ id: 'one', packageJSON: { contributes: { commands: [{ command: 'dreamhelper.GetCustomUIData' }] } } }],
    },
  ])('returns unknown for $name', ({ extensions }) => {
    expect(discoverOfficialCommandProvider(extensions)).toBeNull();
  });
});
