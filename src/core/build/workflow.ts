import { join, resolve } from 'node:path';

import { ProductError, type EvidenceLevel } from '../errors.js';
import { nodeFileIO, type FileIO } from '../fs.js';
import { sha256Hex } from '../hash.js';
import { waitForStableExport } from '../../integrations/official/files.js';

export const BUILD_ARTIFACTS = ['dist/play.lua', 'dist/play.min.lua'] as const;
export const BUILD_CLEAN_WARNING = '官方扩展说明：合成脚本可能自动清理 dist 目录；请先备份并管理 dist 内容。' as const;
export const DEFAULT_BUILD_OBSERVATION = Object.freeze({
  sampleMilliseconds: 150,
  stableSampleCount: 3,
  splitCollectionMilliseconds: 2_000,
  totalTimeoutMilliseconds: 60_000,
});

export type BuildArtifact = (typeof BUILD_ARTIFACTS)[number];

export interface BuildPreparation {
  root: string;
  artifacts: Array<{ relativePath: BuildArtifact; sha256: string | null }>;
  warning: typeof BUILD_CLEAN_WARNING;
}

export interface BuildRunResult {
  outcome: 'cancelled' | 'requested';
}

export interface BuildObservationResult {
  outcome: 'artifact-updated' | 'timeout' | 'failed';
  reasonCode: 'ARTIFACT_UPDATED' | 'ARTIFACT_UNCHANGED_TIMEOUT' | 'ARTIFACT_NOT_STABLE';
  updatedArtifacts: BuildArtifact[];
  hashes: Partial<Record<BuildArtifact, string>>;
  gameRuntimePassed: false;
  evidence: EvidenceLevel;
}

export interface BuildObservationOptions {
  sampleMilliseconds?: number;
  stableSampleCount?: number;
  splitCollectionMilliseconds?: number;
  totalTimeoutMilliseconds?: number;
}

interface RunOptions {
  confirmed: boolean;
  commandAvailable: boolean;
  execute(): Promise<void>;
}

async function optionalHash(io: FileIO, path: string): Promise<string | null> {
  try {
    const stat = await io.stat(path);
    return stat.isFile() ? sha256Hex(await io.readBytes(path)) : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export class BuildWorkflow {
  readonly #io: FileIO;
  readonly #observation: Required<BuildObservationOptions>;

  constructor(options: BuildObservationOptions = {}, io: FileIO = nodeFileIO) {
    this.#io = io;
    this.#observation = { ...DEFAULT_BUILD_OBSERVATION, ...options };
  }

  async prepare(root: string): Promise<BuildPreparation> {
    const resolvedRoot = resolve(root);
    const artifacts = await Promise.all(BUILD_ARTIFACTS.map(async (relativePath) => ({
      relativePath,
      sha256: await optionalHash(this.#io, join(resolvedRoot, ...relativePath.split('/'))),
    })));
    return { root: resolvedRoot, artifacts, warning: BUILD_CLEAN_WARNING };
  }

  async confirmAndRun(_preparation: BuildPreparation, options: RunOptions): Promise<BuildRunResult> {
    if (!options.confirmed) return { outcome: 'cancelled' };
    if (!options.commandAvailable) {
      throw new ProductError(
        'OFFICIAL_COMMAND_MISSING',
        '官方合成游戏脚本命令不可用：dreamhelper.scriptGen',
        ['安装或启用官方元梦开发助手并重新载入窗口。'],
        'STATIC_LOCAL',
      );
    }
    await options.execute();
    return { outcome: 'requested' };
  }

  async observeResult(
    preparation: BuildPreparation,
    evidence: EvidenceLevel = 'UNIT_E2E',
  ): Promise<BuildObservationResult> {
    const absolutePaths = BUILD_ARTIFACTS.map((relativePath) => join(preparation.root, ...relativePath.split('/')));
    const baselineHashes = Object.fromEntries(preparation.artifacts.map((artifact) => [
      join(preparation.root, ...artifact.relativePath.split('/')),
      artifact.sha256,
    ]));
    try {
      const stable = await waitForStableExport({
        io: this.#io,
        paths: absolutePaths,
        baselineHashes,
        ...this.#observation,
      });
      const updatedArtifacts = stable.files.map((file) => (
        file.path === absolutePaths[0] ? BUILD_ARTIFACTS[0] : BUILD_ARTIFACTS[1]
      ));
      const hashes: Partial<Record<BuildArtifact, string>> = {};
      for (let index = 0; index < stable.files.length; index += 1) {
        hashes[updatedArtifacts[index]!] = stable.files[index]!.sha256;
      }
      return {
        outcome: 'artifact-updated',
        reasonCode: 'ARTIFACT_UPDATED',
        updatedArtifacts,
        hashes,
        gameRuntimePassed: false,
        evidence,
      };
    } catch (error) {
      if (error instanceof ProductError && error.code === 'EXPORT_TIMEOUT') {
        return {
          outcome: 'timeout',
          reasonCode: 'ARTIFACT_UNCHANGED_TIMEOUT',
          updatedArtifacts: [],
          hashes: {},
          gameRuntimePassed: false,
          evidence,
        };
      }
      if (error instanceof ProductError && error.code === 'SOURCE_NOT_STABLE') {
        return {
          outcome: 'failed',
          reasonCode: 'ARTIFACT_NOT_STABLE',
          updatedArtifacts: [],
          hashes: {},
          gameRuntimePassed: false,
          evidence,
        };
      }
      throw error;
    }
  }
}
