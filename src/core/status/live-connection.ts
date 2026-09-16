import { join } from 'node:path';

import { atomicWriteJson, type FileIO } from '../fs.js';
import type { OfficialConnectionObservation } from '../logs/official-connection.js';

const LIVE_CONNECTION_RELATIVE_PATH = ['.yuanmeng-inspector', 'status', 'live-connection.json'] as const;
/** The extension host refreshes this record far more often than this window. */
export const LIVE_CONNECTION_MAX_AGE_MS = 15_000;

export interface LiveOfficialConnectionDocument {
  schemaVersion: 1;
  projectInstanceId: string;
  projectRootHash: string;
  updatedAt: string;
  observation: OfficialConnectionObservation;
}

function path(root: string): string {
  return join(root, ...LIVE_CONNECTION_RELATIVE_PATH);
}

function validObservation(value: unknown): value is OfficialConnectionObservation {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const observation = value as Partial<OfficialConnectionObservation>;
  return (observation.state === 'online' || observation.state === 'offline' || observation.state === 'unknown')
    && (observation.observedAt === null
      || (typeof observation.observedAt === 'string' && Number.isFinite(Date.parse(observation.observedAt))))
    && (observation.projectName === null || typeof observation.projectName === 'string')
    && observation.source === 'official-output-log';
}

function validate(value: unknown): asserts value is LiveOfficialConnectionDocument {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('LIVE_CONNECTION_INVALID');
  const document = value as Partial<LiveOfficialConnectionDocument>;
  if (
    document.schemaVersion !== 1
    || typeof document.projectInstanceId !== 'string'
    || typeof document.projectRootHash !== 'string'
    || typeof document.updatedAt !== 'string'
    || !Number.isFinite(Date.parse(document.updatedAt))
    || !validObservation(document.observation)
  ) throw new Error('LIVE_CONNECTION_INVALID');
}

export async function writeLiveOfficialConnection(
  projectRoot: string,
  projectInstanceId: string,
  projectRootHash: string,
  observation: OfficialConnectionObservation,
  io: FileIO,
  now: Date = new Date(),
): Promise<void> {
  const document: LiveOfficialConnectionDocument = {
    schemaVersion: 1,
    projectInstanceId,
    projectRootHash,
    updatedAt: now.toISOString(),
    observation,
  };
  await atomicWriteJson(io, path(projectRoot), document, validate);
}

/**
 * Read only the short-lived, project-bound bridge record. A stale or malformed
 * record is treated as absent so an old extension host cannot claim a live link.
 */
export async function readLiveOfficialConnection(
  projectRoot: string,
  projectInstanceId: string,
  projectRootHash: string,
  io: FileIO,
  now: Date = new Date(),
): Promise<OfficialConnectionObservation | null> {
  let value: unknown;
  try {
    value = JSON.parse(await io.readFile(path(projectRoot), 'utf8')) as unknown;
    validate(value);
  } catch {
    return null;
  }
  if (value.projectInstanceId !== projectInstanceId || value.projectRootHash !== projectRootHash) return null;
  const age = now.getTime() - Date.parse(value.updatedAt);
  if (!Number.isFinite(age) || age < -2_000 || age > LIVE_CONNECTION_MAX_AGE_MS) return null;
  return value.observation.state === 'unknown' ? null : value.observation;
}
