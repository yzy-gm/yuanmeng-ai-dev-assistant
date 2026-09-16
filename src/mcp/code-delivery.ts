import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { CodeDeliveryResult } from '../extension/code-delivery.js';

export interface CodeDeliveryBridgeRequest {
  schemaVersion: 1;
  action: 'build-and-send-code';
  requestId: string;
  projectInstanceId: string;
  projectRootHash: string;
  createdAt: string;
}

export interface CodeDeliveryHostLease {
  schemaVersion: 1;
  projectInstanceId: string;
  projectRootHash: string;
  updatedAt: string;
}

export interface CodeDeliveryBridgeResponse {
  schemaVersion: 1;
  requestId: string;
  projectInstanceId: string;
  result: CodeDeliveryResult;
}

export interface CodeDeliveryClientOptions {
  projectRoot: string;
  projectInstanceId: string;
  projectRootHash: string;
  timeoutMilliseconds?: number;
  leaseMaxAgeMilliseconds?: number;
  leaseRecoveryMilliseconds?: number;
  leasePollMilliseconds?: number;
}

export interface BridgeTemporaryCleanupOptions {
  nowMilliseconds: number;
  staleAfterMilliseconds: number;
  maximumFiles: number;
}

const RENAME_DELAYS = [25, 50, 100, 200, 400] as const;
const RETRYABLE_RENAME_CODES = new Set(['EACCES', 'EBUSY', 'EEXIST', 'EPERM']);
const BRIDGE_TEMPORARY_NAME = /^[A-Za-z0-9._-]+\.json\.\d+\.[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/iu;

function offline(projectRoot: string): CodeDeliveryResult {
  return {
    projectPath: projectRoot,
    savedFiles: [],
    dirtyBefore: [],
    dirtyAfter: [],
    commandAvailable: false,
    buildStartedAt: null,
    artifactChanges: [],
    officialOutputEvidence: [],
    playBuildEvidence: null,
    status: 'LINK_OFFLINE',
    nextAction: '在已安装并激活元梦 AI 开发助手的 VS Code 窗口中打开当前工程后重试。',
    evidenceLevel: 'STATIC_LOCAL'
  };
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, 'utf8');
  let renamed = false;
  try {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await rename(temporary, path);
        renamed = true;
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        const wait = RENAME_DELAYS[attempt];
        if (wait === undefined || code === undefined || !RETRYABLE_RENAME_CODES.has(code)) throw error;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, wait));
      }
    }
  } finally {
    if (!renamed) await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export async function cleanupStaleBridgeTemporaryFiles(
  bridgeRoot: string,
  options: BridgeTemporaryCleanupOptions
): Promise<{ removed: number }> {
  if (options.maximumFiles <= 0 || options.staleAfterMilliseconds < 0) return { removed: 0 };
  let removed = 0;
  for (const directory of [bridgeRoot, join(bridgeRoot, 'requests'), join(bridgeRoot, 'responses')]) {
    let names: string[];
    try {
      names = await readdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    for (const name of names.sort()) {
      if (removed >= options.maximumFiles || !BRIDGE_TEMPORARY_NAME.test(name)) continue;
      const path = join(directory, name);
      try {
        const metadata = await stat(path);
        if (!metadata.isFile() || options.nowMilliseconds - metadata.mtimeMs < options.staleAfterMilliseconds) continue;
        await rm(path, { force: true });
        removed += 1;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }
  return { removed };
}

async function pause(milliseconds: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolvePause, rejectPause) => {
    const timer = setTimeout(resolvePause, milliseconds);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      rejectPause(new Error('REQUEST_CANCELLED'));
    }, { once: true });
  });
}

export class FileCodeDeliveryClient {
  readonly #options: Required<CodeDeliveryClientOptions>;

  constructor(options: CodeDeliveryClientOptions) {
    this.#options = {
      timeoutMilliseconds: 70_000,
      leaseMaxAgeMilliseconds: 10_000,
      leaseRecoveryMilliseconds: 1_000,
      leasePollMilliseconds: 100,
      ...options
    };
  }

  async #validLease(signal: AbortSignal): Promise<CodeDeliveryHostLease | null> {
    const bridgeRoot = join(this.#options.projectRoot, '.yuanmeng-inspector', 'mcp-bridge');
    const deadline = Date.now() + this.#options.leaseRecoveryMilliseconds;
    do {
      try {
        const lease = JSON.parse(await readFile(join(bridgeRoot, 'host.json'), 'utf8')) as CodeDeliveryHostLease;
        if (
          lease.schemaVersion !== 1
          || lease.projectInstanceId !== this.#options.projectInstanceId
          || lease.projectRootHash !== this.#options.projectRootHash
        ) return null;
        const age = Date.now() - Date.parse(lease.updatedAt);
        if (Number.isFinite(age) && age >= 0 && age <= this.#options.leaseMaxAgeMilliseconds) return lease;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
      }
      if (Date.now() >= deadline) break;
      await pause(Math.min(this.#options.leasePollMilliseconds, Math.max(1, deadline - Date.now())), signal);
    } while (Date.now() <= deadline);
    return null;
  }

  async deliver(signal: AbortSignal): Promise<CodeDeliveryResult> {
    const bridgeRoot = join(this.#options.projectRoot, '.yuanmeng-inspector', 'mcp-bridge');
    if (await this.#validLease(signal) === null) return offline(this.#options.projectRoot);

    const requestId = randomUUID();
    const requestPath = join(bridgeRoot, 'requests', `${requestId}.json`);
    const responsePath = join(bridgeRoot, 'responses', `${requestId}.json`);
    const request: CodeDeliveryBridgeRequest = {
      schemaVersion: 1,
      action: 'build-and-send-code',
      requestId,
      projectInstanceId: this.#options.projectInstanceId,
      projectRootHash: this.#options.projectRootHash,
      createdAt: new Date().toISOString()
    };
    await atomicJson(requestPath, request);
    const deadline = Date.now() + this.#options.timeoutMilliseconds;
    try {
      while (Date.now() < deadline) {
        if (signal.aborted) throw new Error('REQUEST_CANCELLED');
        try {
          const response = JSON.parse(await readFile(await realpath(responsePath), 'utf8')) as CodeDeliveryBridgeResponse;
          if (
            response.schemaVersion !== 1
            || response.requestId !== requestId
            || response.projectInstanceId !== this.#options.projectInstanceId
          ) throw new Error('BRIDGE_RESPONSE_INVALID');
          return response.result;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        await pause(200, signal);
      }
      return offline(this.#options.projectRoot);
    } finally {
      await Promise.all([
        rm(requestPath, { force: true }),
        rm(responsePath, { force: true })
      ]);
    }
  }
}

export { atomicJson as writeBridgeJson };
