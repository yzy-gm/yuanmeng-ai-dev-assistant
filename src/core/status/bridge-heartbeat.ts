export const DEFAULT_BRIDGE_POLL_MILLISECONDS = 1_000;
export const DEFAULT_BRIDGE_LEASE_REFRESH_MILLISECONDS = 2_000;

export function shouldRefreshBridgeLease(
  nowMilliseconds: number,
  lastWriteMilliseconds: number | undefined,
  refreshMilliseconds = DEFAULT_BRIDGE_LEASE_REFRESH_MILLISECONDS,
): boolean {
  return lastWriteMilliseconds === undefined
    || !Number.isFinite(lastWriteMilliseconds)
    || nowMilliseconds - lastWriteMilliseconds >= refreshMilliseconds;
}
