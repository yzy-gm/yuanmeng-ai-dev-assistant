import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { buildResourceCatalog, parseResourceCatalogDocument, type ResourceCatalog } from '../../core/api/resource-catalog.js';
import { ProductError } from '../../core/errors.js';

const MAX_DOCUMENTS = 64;

export async function loadLocalResourceCatalog(
  configuredDirectory: string | null,
  userProfile: string | undefined = process.env.USERPROFILE,
): Promise<ResourceCatalog | null> {
  const directory = configuredDirectory
    ?? (userProfile === undefined ? null : join(userProfile, 'Desktop', 'API文档&通用数据定义', '通用数据定义'));
  if (directory === null) return null;
  let names: string[];
  try {
    names = (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right, 'en'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  if (names.length > MAX_DOCUMENTS) {
    throw new ProductError('VALIDATION_FAILED', '通用数据定义文档数量超过安全上限。', ['检查配置的资源文档目录。'], 'STATIC_LOCAL');
  }
  return buildResourceCatalog(await Promise.all(names.map(async (relativePath) => parseResourceCatalogDocument({
    relativePath,
    source: await readFile(join(directory, relativePath), 'utf8'),
  }))));
}
