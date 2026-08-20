import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { ProductError, type EvidenceLevel } from '../errors.js';
import { atomicWriteJson, type FileIO } from '../fs.js';
import { sha256Hex } from '../hash.js';
import type { ProjectIdentity, ProjectLayer } from '../model.js';

interface ProjectMetadata {
  schemaVersion: 1;
  projectInstanceId: string;
  projectRootHash: string;
}

export interface MapInfoInput {
  mapName: string;
  currentLayerId: string | null;
  layers: readonly ProjectLayer[];
  evidence: EvidenceLevel;
}

export interface ProjectIdentityInput {
  canonicalRoot: string;
  projectInstanceId: string;
  hasSrc: boolean;
  hasGameEntry: boolean;
  mapInfo: MapInfoInput | null;
}

export interface ProjectCandidate extends ProjectIdentity {
  root: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const OFFICIAL_MAP_EVIDENCE: ReadonlySet<EvidenceLevel> = new Set([
  'OFFICIAL_EDITOR_SINGLE',
  'OFFICIAL_EDITOR_MULTI',
]);

function normalizeCanonicalRoot(root: string): string {
  let normalized = root.replace(/\\/gu, '/').replace(/\/+$/u, '');
  if (/^[A-Za-z]:/u.test(normalized)) {
    normalized = `${normalized[0]?.toLowerCase()}${normalized.slice(1)}`;
  }
  return normalized;
}

function validateMetadata(value: unknown): asserts value is ProjectMetadata {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ProductError('VALIDATION_FAILED', '工程元数据必须是对象。', ['重新初始化工程。'], 'STATIC_LOCAL');
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expected = ['projectInstanceId', 'projectRootHash', 'schemaVersion'];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new ProductError('VALIDATION_FAILED', '工程元数据字段无效。', ['检查 .yuanmeng-inspector/meta.json。'], 'STATIC_LOCAL');
  }
  if (
    record.schemaVersion !== 1
    || typeof record.projectInstanceId !== 'string'
    || !UUID_PATTERN.test(record.projectInstanceId)
    || typeof record.projectRootHash !== 'string'
    || !SHA256_PATTERN.test(record.projectRootHash)
  ) {
    throw new ProductError('VALIDATION_FAILED', '工程元数据身份无效。', ['重新初始化工程。'], 'STATIC_LOCAL');
  }
}

async function hasType(io: FileIO, path: string, type: 'file' | 'directory'): Promise<boolean> {
  try {
    const value = await io.stat(path);
    return type === 'file' ? value.isFile() : value.isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

async function readOrCreateMetadata(io: FileIO, root: string, projectRootHash: string): Promise<ProjectMetadata> {
  const metadataPath = join(root, '.yuanmeng-inspector', 'meta.json');
  try {
    const value: unknown = JSON.parse(await io.readFile(metadataPath, 'utf8'));
    validateMetadata(value);
    if (value.projectRootHash !== projectRootHash) {
      throw new ProductError(
        'VALIDATION_FAILED',
        '工程路径指纹与已有元数据不匹配。',
        ['确认没有复制其他工程的 .yuanmeng-inspector。'],
        'STATIC_LOCAL',
      );
    }
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      if (error instanceof SyntaxError) {
        throw new ProductError('VALIDATION_FAILED', '工程元数据 JSON 已损坏。', ['修复或移走元数据后重试。'], 'STATIC_LOCAL', error);
      }
      throw error;
    }
  }

  const metadata: ProjectMetadata = {
    schemaVersion: 1,
    projectInstanceId: randomUUID(),
    projectRootHash,
  };
  await atomicWriteJson(io, metadataPath, metadata, validateMetadata);
  return metadata;
}

export function buildProjectIdentity(input: ProjectIdentityInput): ProjectIdentity {
  const canonicalRoot = normalizeCanonicalRoot(input.canonicalRoot);
  const officialMapInfo = input.mapInfo !== null && OFFICIAL_MAP_EVIDENCE.has(input.mapInfo.evidence)
    ? input.mapInfo
    : null;
  const layers = officialMapInfo === null
    ? []
    : [...officialMapInfo.layers].sort((left, right) => {
      const leftKey = `${left.layerId}\0${left.layerName}`;
      const rightKey = `${right.layerId}\0${right.layerName}`;
      return leftKey.localeCompare(rightKey, 'en');
    });
  const mapFingerprint = officialMapInfo === null
    ? null
    : sha256Hex(`ym-map-v1\0${officialMapInfo.mapName}\0${layers.map((layer) => `${layer.layerId}\0${layer.layerName}`).join('\0')}`);

  return {
    schemaVersion: 1,
    projectInstanceId: input.projectInstanceId,
    projectRootHash: sha256Hex(canonicalRoot),
    hasSrc: input.hasSrc,
    hasGameEntry: input.hasGameEntry,
    mapFingerprint,
    mapName: officialMapInfo?.mapName ?? null,
    currentLayerId: officialMapInfo?.currentLayerId ?? null,
    layers,
  };
}

export async function discoverProjects(roots: readonly string[], io: FileIO): Promise<ProjectCandidate[]> {
  const projects: ProjectCandidate[] = [];
  const seenRoots = new Set<string>();
  for (const root of roots) {
    const canonicalRoot = await io.realpath(root);
    const normalizedRoot = normalizeCanonicalRoot(canonicalRoot);
    if (seenRoots.has(normalizedRoot)) {
      continue;
    }
    seenRoots.add(normalizedRoot);
    const srcPath = join(canonicalRoot, 'src');
    const gameEntryPath = join(srcPath, 'GameEntry.lua');
    const [hasSrc, hasGameEntry] = await Promise.all([
      hasType(io, srcPath, 'directory'),
      hasType(io, gameEntryPath, 'file'),
    ]);
    if (!hasSrc || !hasGameEntry) {
      continue;
    }
    const projectRootHash = sha256Hex(normalizedRoot);
    const metadata = await readOrCreateMetadata(io, canonicalRoot, projectRootHash);
    const identity = buildProjectIdentity({
      canonicalRoot,
      projectInstanceId: metadata.projectInstanceId,
      hasSrc,
      hasGameEntry,
      mapInfo: null,
    });
    projects.push({ root: canonicalRoot, ...identity });
  }
  return projects;
}
