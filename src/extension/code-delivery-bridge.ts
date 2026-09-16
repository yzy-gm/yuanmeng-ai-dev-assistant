import { readdir, readFile, rm, stat } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';

import * as vscode from 'vscode';

import { sha256Hex } from '../core/hash.js';
import { ProductError } from '../core/errors.js';
import type { InspectorStatus, UiSnapshot } from '../core/model.js';
import { auditProject } from '../integrations/audit/project-audit.js';
import {
  parsePlayBuildEvidence,
  runCodeDelivery,
  type CodeDeliveryArtifact,
  type CodeDeliveryDependencies
} from './code-delivery.js';
import {
  cleanupStaleBridgeTemporaryFiles,
  writeBridgeJson,
  type CodeDeliveryBridgeRequest,
  type CodeDeliveryBridgeResponse,
  type CodeDeliveryHostLease
} from '../mcp/code-delivery.js';
import {
  DEFAULT_BRIDGE_LEASE_REFRESH_MILLISECONDS,
  DEFAULT_BRIDGE_POLL_MILLISECONDS,
  shouldRefreshBridgeLease,
} from '../core/status/bridge-heartbeat.js';

interface DeliveryProject {
  project: { root: string; projectInstanceId: string; projectRootHash: string };
  snapshot: UiSnapshot | null;
  status: InspectorStatus;
}

interface DeliveryProjectManager {
  list(): DeliveryProject[];
  refreshUi(root: string): Promise<unknown>;
}

export { DEFAULT_BRIDGE_LEASE_REFRESH_MILLISECONDS, DEFAULT_BRIDGE_POLL_MILLISECONDS, shouldRefreshBridgeLease } from '../core/status/bridge-heartbeat.js';

function inside(root: string, path: string): boolean {
  const child = relative(root, path);
  return child === '' || (!child.startsWith('..') && !isAbsolute(child));
}

async function artifact(path: string, root: string): Promise<CodeDeliveryArtifact | null> {
  try {
    const metadata = await stat(path);
    if (!metadata.isFile()) return null;
    return {
      relativePath: relative(root, path).replace(/\\/gu, '/'),
      size: metadata.size,
      mtimeMs: metadata.mtimeMs,
      sha256: sha256Hex(await readFile(path))
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function dirtyLua(root: string): string[] {
  return vscode.workspace.textDocuments
    .filter((document) => document.uri.scheme === 'file'
      && document.isDirty
      && document.uri.fsPath.toLowerCase().endsWith('.lua')
      && inside(root, document.uri.fsPath))
    .map((document) => document.uri.fsPath);
}

async function createDependencies(
  target: DeliveryProject,
  manager: DeliveryProjectManager,
): Promise<CodeDeliveryDependencies> {
  const { project } = target;
  const configuration = vscode.workspace.getConfiguration('yuanmengAi', vscode.Uri.file(project.root));
  return {
    projectRoot: project.root,
    projectInstanceId: project.projectInstanceId,
    workspaceRoots: (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath),
    listDirtyLua: () => dirtyLua(project.root),
    saveAll: async () => {
      await vscode.commands.executeCommand('workbench.action.files.saveAll');
      return dirtyLua(project.root).length === 0;
    },
    runStaticChecks: async () => {
      try {
        await manager.refreshUi(project.root);
      } catch (error) {
        return {
          ok: false,
          summary: `当前工程诊断刷新失败：${error instanceof Error ? error.message : 'UNKNOWN'}`,
          freshness: 'unknown'
        };
      }
      const refreshed = manager.list().find((item) => item.project.root === project.root);
      const errors = refreshed?.status.issueCounts.error ?? 0;
      const freshness = refreshed?.status.ui.freshness === 'fresh' ? 'fresh'
        : refreshed?.status.ui.freshness === 'stale' ? 'stale' : 'unknown';
      return {
        ok: refreshed !== undefined && errors === 0,
        summary: errors === 0 ? '当前 VS Code 静态检查门无错误。' : `当前 VS Code 静态检查门有 ${errors} 个错误。`,
        freshness
      };
    },
    runProjectAudit: async () => {
      const refreshed = manager.list().find((item) => item.project.root === project.root);
      if (refreshed === undefined) {
        return {
          ok: false,
          summary: '当前工程在项目审计前已离线。',
          reasonCode: 'OFFLINE',
          evidence: 'EXTENSION_HOST' as const,
        };
      }
      try {
        const audit = await auditProject({
          root: project.root,
          projectInstanceId: project.projectInstanceId,
          status: refreshed.status,
          snapshot: refreshed.snapshot,
        });
        return {
          ok: audit.issueCounts.error === 0,
          summary: audit.issueCounts.error === 0
            ? '当前工程全量静态审计无错误。'
            : `当前工程全量静态审计有 ${audit.issueCounts.error} 个错误。`,
          reasonCode: audit.issueCounts.error === 0 ? 'AUDIT_PASSED' : 'AUDIT_ERRORS',
          evidence: 'STATIC_LOCAL' as const,
        };
      } catch (error) {
        if (error instanceof ProductError) {
          return {
            ok: false,
            summary: error.message,
            reasonCode: error.code,
            ...(typeof error.details?.file === 'string' ? { file: error.details.file } : {}),
            nextActions: [...error.nextActions],
            evidence: 'STATIC_LOCAL' as const,
          };
        }
        throw error;
      }
    },
    isOfficialCommandAvailable: async () => new Set(await vscode.commands.getCommands(false)).has('dreamhelper.scriptGen'),
    executeOfficialBuild: async () => vscode.commands.executeCommand('dreamhelper.scriptGen'),
    snapshotArtifacts: async () => {
      const distRoot = join(project.root, 'dist');
      let names: string[];
      try {
        names = await readdir(distRoot);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
      }
      const allowed = names.filter((name) => name === 'play.lua'
        || name === 'play.min.lua'
        || /^code_\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.zip$/u.test(name));
      return (await Promise.all(allowed.map((name) => artifact(join(distRoot, name), project.root))))
        .filter((item): item is CodeDeliveryArtifact => item !== null)
        .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
    },
    readPlayBuildEvidence: async () => {
      try {
        return parsePlayBuildEvidence(
          await readFile(join(project.root, 'dist', 'play.json'), 'utf8'),
          project.root
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    },
    now: () => new Date(),
    wait: async (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds)),
    observation: {
      timeoutMilliseconds: configuration.get<number>('buildTimeoutSeconds', 60) * 1_000,
      sampleMilliseconds: configuration.get<number>('fileStableSampleMilliseconds', 150),
      stableSampleCount: configuration.get<number>('fileStableSampleCount', 3)
    }
  };
}

export class CodeDeliveryBridgeHost implements vscode.Disposable {
  readonly #manager: DeliveryProjectManager;
  readonly #processing = new Set<string>();
  readonly #timer: NodeJS.Timeout;
  readonly #leaseRefreshMilliseconds: number;
  readonly #pollMilliseconds: number;
  #disposed = false;
  readonly #lastCleanup = new Map<string, number>();
  readonly #lastLeaseWrite = new Map<string, number>();
  #ticking = false;

  constructor(manager: DeliveryProjectManager, options: {
    pollMilliseconds?: number;
    leaseRefreshMilliseconds?: number;
  } = {}) {
    this.#manager = manager;
    this.#pollMilliseconds = options.pollMilliseconds ?? DEFAULT_BRIDGE_POLL_MILLISECONDS;
    this.#leaseRefreshMilliseconds = options.leaseRefreshMilliseconds ?? DEFAULT_BRIDGE_LEASE_REFRESH_MILLISECONDS;
    this.#timer = setInterval(() => { void this.#tick().catch(() => undefined); }, this.#pollMilliseconds);
    this.#timer.unref();
    void this.#tick().catch(() => undefined);
  }

  async #tick(): Promise<void> {
    if (this.#disposed || this.#ticking) return;
    this.#ticking = true;
    try {
      const projects = this.#manager.list();
      const roots = new Set(projects.map((target) => target.project.root));
      for (const root of this.#lastLeaseWrite.keys()) {
        if (!roots.has(root)) this.#lastLeaseWrite.delete(root);
      }
      for (const target of projects) {
        const project = target.project;
        const bridgeRoot = join(project.root, '.yuanmeng-inspector', 'mcp-bridge');
        const now = Date.now();
        if (now - (this.#lastCleanup.get(project.root) ?? 0) >= 10_000) {
          await cleanupStaleBridgeTemporaryFiles(bridgeRoot, {
            nowMilliseconds: now,
            staleAfterMilliseconds: 30_000,
            maximumFiles: 50
          });
          this.#lastCleanup.set(project.root, now);
        }
        if (shouldRefreshBridgeLease(now, this.#lastLeaseWrite.get(project.root), this.#leaseRefreshMilliseconds)) {
          const lease: CodeDeliveryHostLease = {
            schemaVersion: 1,
            projectInstanceId: project.projectInstanceId,
            projectRootHash: project.projectRootHash,
            updatedAt: new Date().toISOString()
          };
          await writeBridgeJson(join(bridgeRoot, 'host.json'), lease);
          this.#lastLeaseWrite.set(project.root, now);
        }
        let names: string[];
        try {
          names = (await readdir(join(bridgeRoot, 'requests'))).filter((name) => /^[0-9a-f-]{36}\.json$/u.test(name));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw error;
        }
        for (const name of names) {
          const requestId = name.slice(0, -5);
          if (this.#processing.has(requestId)) continue;
          this.#processing.add(requestId);
          void this.#handle(target, bridgeRoot, name)
            .catch(() => undefined)
            .finally(() => this.#processing.delete(requestId));
        }
      }
    } finally {
      this.#ticking = false;
    }
  }

  async #handle(target: DeliveryProject, bridgeRoot: string, name: string): Promise<void> {
    const { project } = target;
    const requestPath = join(bridgeRoot, 'requests', name);
    try {
      const request = JSON.parse(await readFile(requestPath, 'utf8')) as CodeDeliveryBridgeRequest;
      if (
        request.schemaVersion !== 1
        || request.action !== 'build-and-send-code'
        || `${request.requestId}.json` !== name
        || request.projectInstanceId !== project.projectInstanceId
        || request.projectRootHash !== project.projectRootHash
      ) return;
      const response: CodeDeliveryBridgeResponse = {
        schemaVersion: 1,
        requestId: request.requestId,
        projectInstanceId: project.projectInstanceId,
        result: await runCodeDelivery(await createDependencies(target, this.#manager))
      };
      await writeBridgeJson(join(bridgeRoot, 'responses', name), response);
    } finally {
      await rm(requestPath, { force: true });
    }
  }

  dispose(): void {
    this.#disposed = true;
    clearInterval(this.#timer);
    this.#lastLeaseWrite.clear();
    this.#lastCleanup.clear();
  }
}
