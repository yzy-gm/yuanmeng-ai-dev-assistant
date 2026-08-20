import { describe, expect, it } from 'vitest';

import {
  OfficialCommandAdapter,
  type CommandHost,
} from '../../src/integrations/official/commands.js';

function fakeCommands(commands: readonly string[]): CommandHost & { executed: string[] } {
  const executed: string[] = [];
  return {
    executed,
    async getCommands() {
      return [...commands];
    },
    async executeCommand(command) {
      executed.push(command);
    },
  };
}

describe('official command capability adapter', () => {
  it('detects commands dynamically without an extension dependency', async () => {
    const adapter = new OfficialCommandAdapter(fakeCommands(['dreamhelper.GetCustomUIData']));

    expect(await adapter.detect()).toMatchObject({
      refreshUi: true,
      getCustomProperty: false,
      sendCustomProperty: false,
      build: false,
      startWork: false,
      endWork: false,
    });
  });

  it('executes only the exact registered official command', async () => {
    const host = fakeCommands(['dreamhelper.scriptGen']);
    const adapter = new OfficialCommandAdapter(host);

    await adapter.execute('build');

    expect(host.executed).toEqual(['dreamhelper.scriptGen']);
  });

  it('rejects a capability that is not currently registered', async () => {
    const adapter = new OfficialCommandAdapter(fakeCommands([]));

    await expect(adapter.execute('refreshUi')).rejects.toMatchObject({ code: 'OFFICIAL_COMMAND_MISSING' });
  });
});
