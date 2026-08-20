import { systemClock, type Clock } from '../clock.js';
import type { InspectorStatus, ProjectIdentity } from '../model.js';

export interface SuccessfulRefreshAttempt {
  outcome: 'success';
  completedAt: string;
  reasonCode: 'REFRESH_SUCCEEDED' | 'REFRESH_SUCCEEDED_UNCHANGED';
  observedStableNewFiles: boolean;
  parseSucceeded: boolean;
  mapFingerprint: string | null;
}

export interface FailedRefreshAttempt {
  outcome: 'timeout' | 'offline';
  completedAt: string;
}

export interface UnverifiedSchemaRefreshAttempt {
  outcome: 'schema-unverified';
  completedAt: string;
}

export type RefreshAttempt = SuccessfulRefreshAttempt | FailedRefreshAttempt | UnverifiedSchemaRefreshAttempt;

export interface StatusSnapshotInput {
  lastRefreshAt: string;
  sourceHashes: Readonly<Record<string, string>>;
  mapFingerprint: string | null;
  officialExtensionVersion: string | null;
  verifiedFresh: boolean;
}

export interface StatusInput {
  commandsPresent: boolean | Readonly<Record<string, boolean>>;
  refreshAttempt: RefreshAttempt | null;
  snapshot: StatusSnapshotInput | null;
  project?: ProjectIdentity;
  clock?: Clock;
  staleAfterMinutes?: number;
  currentSourceHashes?: Readonly<Record<string, string>>;
  currentMapFingerprint?: string | null;
  currentOfficialExtensionVersion?: string | null;
  issueCounts?: Readonly<Record<'error' | 'warning' | 'info', number>>;
}

const EMPTY_PROJECT: ProjectIdentity = {
  schemaVersion: 1,
  projectInstanceId: '00000000-0000-4000-8000-000000000000',
  projectRootHash: '0'.repeat(64),
  hasSrc: false,
  hasGameEntry: false,
  mapFingerprint: null,
  mapName: null,
  currentLayerId: null,
  layers: [],
};

function commandRecord(value: StatusInput['commandsPresent']): Record<string, boolean> {
  return typeof value === 'boolean' ? { detected: value } : { ...value };
}

function hasAnyCommand(value: StatusInput['commandsPresent']): boolean {
  return typeof value === 'boolean' ? value : Object.values(value).some(Boolean);
}

function hashesMatch(
  expected: Readonly<Record<string, string>>,
  actual: Readonly<Record<string, string>>,
): boolean {
  const expectedKeys = Object.keys(expected).sort();
  const actualKeys = Object.keys(actual).sort();
  return expectedKeys.length === actualKeys.length
    && expectedKeys.every((key, index) => key === actualKeys[index] && expected[key] === actual[key]);
}

function canProveSuccessfulRefresh(attempt: RefreshAttempt | null, project: ProjectIdentity): boolean {
  if (
    attempt?.outcome !== 'success'
    || !attempt.parseSucceeded
    || attempt.reasonCode !== 'REFRESH_SUCCEEDED'
    || !attempt.observedStableNewFiles
  ) {
    return false;
  }
  return attempt.mapFingerprint === null
    || project.mapFingerprint === null
    || attempt.mapFingerprint === project.mapFingerprint;
}

export function reduceStatus(input: StatusInput): InspectorStatus {
  const project = input.project ?? EMPTY_PROJECT;
  const clock = input.clock ?? systemClock;
  const staleAfterMinutes = input.staleAfterMinutes ?? 30;
  const commandAvailable = hasAnyCommand(input.commandsPresent);
  const successfulRefresh = canProveSuccessfulRefresh(input.refreshAttempt, project);
  let linkState: 'unknown' | 'online' | 'offline';
  let linkReason: string;
  if (!commandAvailable) {
    linkState = 'offline';
    linkReason = 'OFFICIAL_COMMANDS_MISSING';
  } else if (input.refreshAttempt === null) {
    linkState = 'unknown';
    linkReason = 'COMMANDS_PRESENT_UNPROBED';
  } else if (input.refreshAttempt.outcome === 'timeout') {
    linkState = 'offline';
    linkReason = 'REFRESH_TIMEOUT';
  } else if (input.refreshAttempt.outcome === 'offline') {
    linkState = 'offline';
    linkReason = 'OFFICIAL_LINK_OFFLINE';
  } else if (input.refreshAttempt.outcome === 'schema-unverified') {
    linkState = 'unknown';
    linkReason = 'OFFICIAL_SCHEMA_UNVERIFIED';
  } else if (
    input.refreshAttempt.outcome === 'success'
    && input.refreshAttempt.reasonCode === 'REFRESH_SUCCEEDED_UNCHANGED'
  ) {
    linkState = 'unknown';
    linkReason = 'REFRESH_SUCCEEDED_UNCHANGED';
  } else if (input.refreshAttempt.outcome === 'success' && successfulRefresh) {
    linkState = 'online';
    linkReason = input.refreshAttempt.reasonCode;
  } else {
    linkState = 'unknown';
    linkReason = 'REFRESH_UNVERIFIED';
  }

  const reasonCodes: string[] = input.refreshAttempt?.outcome === 'schema-unverified'
    ? ['OFFICIAL_SCHEMA_UNVERIFIED']
    : [];
  if (input.snapshot !== null) {
    if (!input.snapshot.verifiedFresh) {
      reasonCodes.push('UNVERIFIED_SNAPSHOT');
    }
    if (
      input.currentSourceHashes !== undefined
      && !hashesMatch(input.snapshot.sourceHashes, input.currentSourceHashes)
    ) {
      reasonCodes.push('SOURCE_HASH_MISMATCH');
    }
    if (input.refreshAttempt?.outcome === 'timeout') {
      reasonCodes.push('REFRESH_TIMEOUT');
    } else if (input.refreshAttempt?.outcome === 'offline') {
      reasonCodes.push('OFFICIAL_LINK_OFFLINE');
    } else if (input.refreshAttempt?.outcome === 'schema-unverified') {
      // Already recorded above so missing and stale snapshots expose the same explicit gate.
    } else if (input.refreshAttempt?.outcome === 'success') {
      if (!input.refreshAttempt.observedStableNewFiles && input.refreshAttempt.reasonCode !== 'REFRESH_SUCCEEDED_UNCHANGED') {
        reasonCodes.push('NO_STABLE_NEW_EXPORT');
      }
      if (!input.refreshAttempt.parseSucceeded) {
        reasonCodes.push('EXPORT_PARSE_FAILED');
      }
      if (
        input.refreshAttempt.mapFingerprint !== null
        && project.mapFingerprint !== null
        && input.refreshAttempt.mapFingerprint !== project.mapFingerprint
      ) {
        reasonCodes.push('MAP_FINGERPRINT_CHANGED');
      }
    }
    if (
      input.currentMapFingerprint !== undefined
      && input.snapshot.mapFingerprint !== input.currentMapFingerprint
    ) {
      if (!reasonCodes.includes('MAP_FINGERPRINT_CHANGED')) {
        reasonCodes.push('MAP_FINGERPRINT_CHANGED');
      }
    }
    if (
      input.currentOfficialExtensionVersion !== undefined
      && input.snapshot.officialExtensionVersion !== input.currentOfficialExtensionVersion
    ) {
      reasonCodes.push('OFFICIAL_EXTENSION_VERSION_CHANGED');
    }
    const ageMilliseconds = clock.now().getTime() - Date.parse(input.snapshot.lastRefreshAt);
    if (!Number.isFinite(ageMilliseconds) || ageMilliseconds > staleAfterMinutes * 60_000) {
      reasonCodes.push('SNAPSHOT_EXPIRED');
    }
  }

  return {
    schemaVersion: 1,
    project,
    officialCommands: commandRecord(input.commandsPresent),
    link: {
      state: linkState,
      reasonCode: linkReason,
      lastProbeAt: input.refreshAttempt?.completedAt ?? null,
    },
    ui: {
      freshness: input.snapshot === null ? 'missing' : reasonCodes.length === 0 ? 'fresh' : 'stale',
      lastRefreshAt: input.snapshot?.lastRefreshAt ?? null,
      sourceHashes: { ...(input.snapshot?.sourceHashes ?? {}) },
      reasonCodes,
    },
    issueCounts: {
      error: input.issueCounts?.error ?? 0,
      warning: input.issueCounts?.warning ?? 0,
      info: input.issueCounts?.info ?? 0,
    },
  };
}
