import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

import type { ApiIndex } from '../../core/api/declaration-index.js';
import {
  parseEventDocumentation,
  resolveEventMetadata,
  type EventDocumentationIndex,
  type ResolvedEventMetadata,
} from '../../core/api/event-doc-index.js';

export async function loadLocalEventDocumentation(configuredPath: string | null): Promise<EventDocumentationIndex | null> {
  const candidate = configuredPath?.trim() === '' || configuredPath === null
    ? join(homedir(), 'Desktop', 'API文档&通用数据定义', 'API分类', 'Events.md')
    : (isAbsolute(configuredPath) ? configuredPath : resolve(configuredPath));
  let source: string;
  try {
    source = await readFile(candidate, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  return parseEventDocumentation({ sourceId: 'local-api-docs/Events.md', source });
}

export async function loadLocalEventMetadata(
  apiIndex: ApiIndex,
  configuredPath: string | null,
): Promise<ReadonlyMap<string, ResolvedEventMetadata>> {
  const documentation = await loadLocalEventDocumentation(configuredPath);
  return new Map(resolveEventMetadata(apiIndex, documentation).map((event) => [event.name, event]));
}
