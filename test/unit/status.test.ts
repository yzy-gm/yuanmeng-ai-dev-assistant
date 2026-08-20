import { describe, expect, it } from 'vitest';

import { FixedClock } from '../../src/core/clock.js';
import { reduceStatus, type StatusInput } from '../../src/core/status/status.js';

const project = {
  schemaVersion: 1,
  projectInstanceId: '00000000-0000-4000-8000-000000000001',
  projectRootHash: 'a'.repeat(64),
  hasSrc: true,
  hasGameEntry: true,
  mapFingerprint: 'b'.repeat(64),
  mapName: 'Fictional map',
  currentLayerId: 'layer-a',
  layers: [{ layerId: 'layer-a', layerName: 'Fictional layer' }],
} as const;

const freshInput: StatusInput = {
  commandsPresent: true,
  project,
  clock: new FixedClock('2026-08-19T00:30:00.000Z'),
  refreshAttempt: {
    outcome: 'success',
    completedAt: '2026-08-19T00:00:00.000Z',
    reasonCode: 'REFRESH_SUCCEEDED',
    observedStableNewFiles: true,
    parseSucceeded: true,
    mapFingerprint: project.mapFingerprint,
  },
  snapshot: {
    lastRefreshAt: '2026-08-19T00:00:00.000Z',
    sourceHashes: { 'src/Data/CustomUIData.lua': 'c'.repeat(64) },
    mapFingerprint: project.mapFingerprint,
    officialExtensionVersion: '9.9.9-test',
    verifiedFresh: true,
  },
  currentSourceHashes: { 'src/Data/CustomUIData.lua': 'c'.repeat(64) },
  currentMapFingerprint: project.mapFingerprint,
  currentOfficialExtensionVersion: '9.9.9-test',
};

describe('evidence-aware status reduction', () => {
  it('does not claim online from command presence alone', () => {
    expect(reduceStatus({ commandsPresent: true, refreshAttempt: null, snapshot: null }).link.state).toBe('unknown');
  });

  it('keeps an uncalibrated official schema editor-pending instead of claiming a refresh', () => {
    const status = reduceStatus({
      commandsPresent: true,
      refreshAttempt: { outcome: 'schema-unverified', completedAt: '2026-08-19T00:00:00.000Z' },
      snapshot: null,
    });

    expect(status.link).toMatchObject({ state: 'unknown', reasonCode: 'OFFICIAL_SCHEMA_UNVERIFIED' });
    expect(status.ui).toMatchObject({ freshness: 'missing', reasonCodes: ['OFFICIAL_SCHEMA_UNVERIFIED'] });
  });

  it('marks a verified current refresh online and fresh at the 30-minute boundary', () => {
    const status = reduceStatus(freshInput);

    expect(status.link.state).toBe('online');
    expect(status.ui).toMatchObject({ freshness: 'fresh', reasonCodes: [] });
  });

  it('does not claim the editor is online when the command returns without a structure change', () => {
    const status = reduceStatus({
      ...freshInput,
      refreshAttempt: {
        ...freshInput.refreshAttempt!,
        reasonCode: 'REFRESH_SUCCEEDED_UNCHANGED',
        observedStableNewFiles: false,
      },
    });

    expect(status.link).toMatchObject({ state: 'unknown', reasonCode: 'REFRESH_SUCCEEDED_UNCHANGED' });
    expect(status.ui.freshness).toBe('fresh');
  });

  it('ages an unchanged existing snapshot from its original observation time', () => {
    const status = reduceStatus({
      ...freshInput,
      clock: new FixedClock('2026-08-19T00:30:00.001Z'),
      refreshAttempt: {
        ...freshInput.refreshAttempt!,
        completedAt: '2026-08-19T00:29:59.000Z',
        reasonCode: 'REFRESH_SUCCEEDED_UNCHANGED',
        observedStableNewFiles: false,
      },
    });

    expect(status.link).toMatchObject({ state: 'unknown', reasonCode: 'REFRESH_SUCCEEDED_UNCHANGED' });
    expect(status.ui.lastRefreshAt).toBe('2026-08-19T00:00:00.000Z');
    expect(status.ui.freshness).toBe('stale');
    expect(status.ui.reasonCodes).toContain('SNAPSHOT_EXPIRED');
  });

  it.each([
    ['source hash mismatch', { currentSourceHashes: { 'src/Data/CustomUIData.lua': 'd'.repeat(64) } }, 'SOURCE_HASH_MISMATCH'],
    ['refresh timeout', { refreshAttempt: { outcome: 'timeout', completedAt: '2026-08-19T00:01:00.000Z' } }, 'REFRESH_TIMEOUT'],
    ['map fingerprint change', { currentMapFingerprint: 'e'.repeat(64) }, 'MAP_FINGERPRINT_CHANGED'],
    ['official extension update', { currentOfficialExtensionVersion: '10.0.0-test' }, 'OFFICIAL_EXTENSION_VERSION_CHANGED'],
    ['age above 30 minutes', { clock: new FixedClock('2026-08-19T00:30:00.001Z') }, 'SNAPSHOT_EXPIRED'],
  ])('marks stale on %s', (_name, change, reasonCode) => {
    const status = reduceStatus({ ...freshInput, ...change } as StatusInput);

    expect(status.ui.freshness).toBe('stale');
    expect(status.ui.reasonCodes).toContain(reasonCode);
  });

  it('does not call a successful command fresh without stable parsed new files', () => {
    const status = reduceStatus({
      ...freshInput,
      refreshAttempt: {
        outcome: 'success',
        completedAt: '2026-08-19T00:00:00.000Z',
        reasonCode: 'REFRESH_SUCCEEDED',
        observedStableNewFiles: false,
        parseSucceeded: true,
        mapFingerprint: project.mapFingerprint,
      },
    });

    expect(status.link.state).toBe('unknown');
    expect(status.ui.freshness).toBe('stale');
    expect(status.ui.reasonCodes).toContain('NO_STABLE_NEW_EXPORT');
  });

  it('marks a stable parsed refresh stale when its map fingerprint conflicts', () => {
    const status = reduceStatus({
      ...freshInput,
      refreshAttempt: {
        outcome: 'success',
        completedAt: '2026-08-19T00:00:00.000Z',
        reasonCode: 'REFRESH_SUCCEEDED',
        observedStableNewFiles: true,
        parseSucceeded: true,
        mapFingerprint: 'f'.repeat(64),
      },
    });

    expect(status.link.state).toBe('unknown');
    expect(status.ui.freshness).toBe('stale');
    expect(status.ui.reasonCodes).toContain('MAP_FINGERPRINT_CHANGED');
  });
});
