import { describe, expect, it } from 'vitest';

import { shouldRefreshBridgeLease } from '../../src/core/status/bridge-heartbeat.js';

describe('code delivery bridge heartbeat policy', () => {
  it('writes immediately, then throttles lease rewrites to the configured interval', () => {
    expect(shouldRefreshBridgeLease(1_000, undefined)).toBe(true);
    expect(shouldRefreshBridgeLease(2_000, 1_500, 2_000)).toBe(false);
    expect(shouldRefreshBridgeLease(3_500, 1_500, 2_000)).toBe(true);
  });
});
