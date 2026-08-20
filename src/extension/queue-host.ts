import { join } from 'node:path';

import * as vscode from 'vscode';

import { systemClock } from '../core/clock.js';
import { ProductError } from '../core/errors.js';
import { atomicWriteJson, nodeFileIO } from '../core/fs.js';
import {
  createQueueSession,
  RequestQueueHost,
  type QueueSession,
} from '../integrations/queue/protocol.js';
import type { WorkspaceContextManager } from './workspaces.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const TOKEN_PATTERN = /^[a-f0-9]{64}$/u;

function validateSession(value: unknown): asserts value is QueueSession {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ProductError('VALIDATION_FAILED', '请求队列会话必须是对象。', ['重新加载窗口。'], 'STATIC_LOCAL');
  }
  const session = value as Partial<QueueSession>;
  if (
    session.schemaVersion !== 1
    || typeof session.token !== 'string'
    || !TOKEN_PATTERN.test(session.token)
    || typeof session.projectInstanceId !== 'string'
    || !UUID_PATTERN.test(session.projectInstanceId)
    || typeof session.createdAt !== 'string'
    || typeof session.expiresAt !== 'string'
  ) {
    throw new ProductError('VALIDATION_FAILED', '请求队列会话字段无效。', ['重新加载窗口。'], 'STATIC_LOCAL');
  }
}

export class WorkspaceRequestQueue implements vscode.Disposable {
  readonly #manager: WorkspaceContextManager;
  #disposables: vscode.Disposable[] = [];

  constructor(manager: WorkspaceContextManager) {
    this.#manager = manager;
  }

  dispose(): void {
    for (const disposable of this.#disposables.splice(0)) {
      disposable.dispose();
    }
  }

  async reset(): Promise<void> {
    this.dispose();
    const enabled = vscode.workspace.getConfiguration('yuanmengAi').get<boolean>('enableRequestQueue', true);
    if (!enabled) {
      return;
    }
    for (const context of this.#manager.list()) {
      const runtimeRoot = join(context.project.root, '.yuanmeng-inspector', 'runtime');
      const session = createQueueSession(context.project.projectInstanceId, systemClock);
      await atomicWriteJson(nodeFileIO, join(runtimeRoot, 'session.json'), session, validateSession);
      const host = new RequestQueueHost({
        clock: systemClock,
        io: nodeFileIO,
        runtimeRoot,
        session,
        refreshUi: async () => this.#manager.refreshUi(context.project.root),
      });
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(
        context.project.root,
        '.yuanmeng-inspector/runtime/requests/pending/*.json',
      ), false, true, true);
      this.#disposables.push(
        watcher,
        watcher.onDidCreate((uri) => {
          void host.processFile(uri.fsPath).catch((error: unknown) => {
            const message = error instanceof Error ? error.message : '请求队列处理失败。';
            void vscode.window.showErrorMessage(message);
          });
        }),
      );
    }
  }
}
