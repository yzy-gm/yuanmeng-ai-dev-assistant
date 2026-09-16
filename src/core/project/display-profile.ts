import { join } from 'node:path';

import { ProductError } from '../errors.js';
import { atomicWriteJson, type FileIO } from '../fs.js';

export interface ProjectDisplayProfile {
  schemaVersion: 1;
  projectInstanceId: string;
  mapDisplayName: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MAX_MAP_DISPLAY_NAME_LENGTH = 80;

export function projectDisplayProfilePath(root: string): string {
  return join(root, '.yuanmeng-inspector', 'project-display.json');
}

function normalizeMapDisplayName(value: string): string {
  const normalized = value.trim();
  const hasForbiddenCharacter = [...normalized].some((character) => {
    const codePoint = character.codePointAt(0)!;
    return character === '|' || codePoint < 32 || codePoint === 127;
  });
  if (
    normalized.length === 0
    || normalized.length > MAX_MAP_DISPLAY_NAME_LENGTH
    || hasForbiddenCharacter
  ) {
    throw new ProductError(
      'VALIDATION_FAILED',
      '地图名称必须为 1 到 80 个字符，且不能包含换行、控制字符或“|”。',
      ['输入便于识别的当前地图名称。'],
      'STATIC_LOCAL',
    );
  }
  return normalized;
}

export function validateProjectDisplayProfile(value: unknown): asserts value is ProjectDisplayProfile {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ProductError('VALIDATION_FAILED', '地图显示配置必须是对象。', ['重新设置当前地图名称。'], 'STATIC_LOCAL');
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expected = ['mapDisplayName', 'projectInstanceId', 'schemaVersion'];
  if (
    keys.length !== expected.length
    || keys.some((key, index) => key !== expected[index])
    || record.schemaVersion !== 1
    || typeof record.projectInstanceId !== 'string'
    || !UUID_PATTERN.test(record.projectInstanceId)
    || typeof record.mapDisplayName !== 'string'
  ) {
    throw new ProductError('VALIDATION_FAILED', '地图显示配置字段无效。', ['重新设置当前地图名称。'], 'STATIC_LOCAL');
  }
  normalizeMapDisplayName(record.mapDisplayName);
}

export async function readProjectDisplayProfile(
  root: string,
  projectInstanceId: string,
  io: FileIO,
): Promise<ProjectDisplayProfile | null> {
  let value: unknown;
  try {
    value = JSON.parse(await io.readFile(projectDisplayProfilePath(root), 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    if (error instanceof SyntaxError) {
      throw new ProductError('VALIDATION_FAILED', '地图显示配置 JSON 已损坏。', ['重新设置当前地图名称。'], 'STATIC_LOCAL', error);
    }
    throw error;
  }
  validateProjectDisplayProfile(value);
  if (value.projectInstanceId !== projectInstanceId) {
    throw new ProductError(
      'VALIDATION_FAILED',
      '地图显示配置属于其他工程。',
      ['确认没有复制其他地图的 .yuanmeng-inspector。'],
      'STATIC_LOCAL',
    );
  }
  return value;
}

export async function writeProjectDisplayProfile(
  root: string,
  projectInstanceId: string,
  mapDisplayName: string,
  io: FileIO,
): Promise<ProjectDisplayProfile> {
  const profile: ProjectDisplayProfile = {
    schemaVersion: 1,
    projectInstanceId,
    mapDisplayName: normalizeMapDisplayName(mapDisplayName),
  };
  await atomicWriteJson(io, projectDisplayProfilePath(root), profile, validateProjectDisplayProfile);
  return profile;
}
