import { ProductError } from '../../core/errors.js';

export type OfficialCommand =
  | 'refreshUi'
  | 'getCustomProperty'
  | 'sendCustomProperty'
  | 'build'
  | 'startWork'
  | 'endWork';

export interface OfficialCapabilities {
  refreshUi: boolean;
  getCustomProperty: boolean;
  sendCustomProperty: boolean;
  build: boolean;
  startWork: boolean;
  endWork: boolean;
}

export interface CommandHost {
  getCommands(includeInternal?: boolean): Promise<readonly string[]>;
  executeCommand(command: string, ...args: readonly unknown[]): Promise<unknown>;
}

const COMMAND_IDS: Readonly<Record<OfficialCommand, string>> = {
  refreshUi: 'dreamhelper.GetCustomUIData',
  getCustomProperty: 'dreamhelper.GetCustomPropertyData',
  sendCustomProperty: 'dreamhelper.sendCustomPropertyData',
  build: 'dreamhelper.scriptGen',
  startWork: 'dreamhelper.startWork',
  endWork: 'dreamhelper.endWork',
};

export class OfficialCommandAdapter {
  readonly #host: CommandHost;

  constructor(host: CommandHost) {
    this.#host = host;
  }

  async detect(): Promise<OfficialCapabilities> {
    const registered = new Set(await this.#host.getCommands(false));
    return {
      refreshUi: registered.has(COMMAND_IDS.refreshUi),
      getCustomProperty: registered.has(COMMAND_IDS.getCustomProperty),
      sendCustomProperty: registered.has(COMMAND_IDS.sendCustomProperty),
      build: registered.has(COMMAND_IDS.build),
      startWork: registered.has(COMMAND_IDS.startWork),
      endWork: registered.has(COMMAND_IDS.endWork),
    };
  }

  async execute(command: OfficialCommand, ...args: readonly unknown[]): Promise<void> {
    const commandId = COMMAND_IDS[command];
    const registered = new Set(await this.#host.getCommands(false));
    if (!registered.has(commandId)) {
      throw new ProductError(
        'OFFICIAL_COMMAND_MISSING',
        `官方命令不可用：${commandId}`,
        ['安装或启用官方元梦开发助手并重新载入窗口。'],
        'STATIC_LOCAL',
      );
    }
    await this.#host.executeCommand(commandId, ...args);
  }
}
