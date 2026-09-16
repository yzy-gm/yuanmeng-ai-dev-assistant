import { describe, expect, it } from 'vitest';
import luaparse from 'luaparse';

import {
  createGameplayTraceInsertion,
  createGameplayTraceRemoval,
  parseGameplayTraceLog,
} from '../../src/core/logs/gameplay-trace.js';

const projectInstanceId = '33333333-3333-4333-8333-333333333333';

describe('gameplay trace probes', () => {
  it('creates a previewable removable Lua probe with bounded structured fields', () => {
    const source = '-- @server\nlocal function Buy(playerId, shelfId, position)\n    local inventory = 3\nend\n';
    const inserted = createGameplayTraceInsertion({
      projectInstanceId, targetPath: 'src/GameServer.lua', source, insertBeforeLine: 4,
      phase: 'purchase.before', side: 'server', event: 'purchase.request',
      expressions: { player: 'playerId', instance: 'shelfId', position: 'position', state: { inventory: 'inventory' } },
      createdAt: '2026-08-21T05:00:00.000Z',
    });
    expect(() => luaparse.parse(inserted.proposal.newContent, { luaVersion: '5.3' })).not.toThrow();
    expect(inserted.proposal.newContent).toContain('[YMAI_GAMEPLAY_TRACE]');
    expect(inserted.proposal.newContent).toContain('phase=purchase.before');
    expect(inserted.proposal.newContent).toContain('player=" .. YMAI_TraceSafe(playerId)');
    expect(inserted.proposal.newContent).toContain('position=" .. YMAI_TraceVector(position)');
    expect(inserted.proposal.newContent).toContain(`YMAI_TRACE_PROBE_BEGIN:${inserted.probeId}`);

    const removed = createGameplayTraceRemoval({
      projectInstanceId, targetPath: 'src/GameServer.lua', source: inserted.proposal.newContent,
      probeId: inserted.probeId, createdAt: '2026-08-21T05:01:00.000Z',
    });
    expect(removed.newContent).toBe(source);
  });

  it('rejects executable expressions instead of injecting arbitrary Lua', () => {
    expect(() => createGameplayTraceInsertion({
      projectInstanceId, targetPath: 'src/GameServer.lua', source: 'return true\n', insertBeforeLine: 1,
      phase: 'x', side: 'server', event: 'x', expressions: { player: 'GetPlayer()' },
      createdAt: '2026-08-21T05:00:00.000Z',
    })).toThrowError(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
  });

  it('parses a selected time range into structured evidence without retaining raw log lines', () => {
    const log = new TextEncoder().encode([
      '[2026-08-21T05:00:00.000Z] [INFO] [YMAI_GAMEPLAY_TRACE] schema=1 probe=' + 'a'.repeat(64)
        + ' phase=purchase.before side=server event=purchase.request player=100 instance=517 position=1,2,3 state.inventory=3',
      '[2026-08-21T05:02:00.000Z] [INFO] [YMAI_GAMEPLAY_TRACE] schema=1 probe=' + 'a'.repeat(64)
        + ' phase=purchase.after side=server event=purchase.success player=100 instance=517 position=1,2,3 state.inventory=2',
    ].join('\n'));
    const parsed = parseGameplayTraceLog(log, { from: '2026-08-21T05:01:00.000Z' });
    expect(parsed.entries).toEqual([expect.objectContaining({
      phase: 'purchase.after', side: 'server', event: 'purchase.success', player: '100', instance: '517',
      position: [1, 2, 3], state: { inventory: '2' },
    })]);
    expect(JSON.stringify(parsed)).not.toContain('[INFO]');
    expect(JSON.stringify(parsed)).not.toContain('YMAI_GAMEPLAY_TRACE');
  });

  it('accepts a gameplay trace copied directly from the official editor log format', () => {
    const log = new TextEncoder().encode(
      '[2026-8-21 15:33:24] [INFO]: [Standalone] [YMAI_GAMEPLAY_TRACE] schema=1 probe=' + 'b'.repeat(64)
      + ' phase=trigger.enter side=server event=character.enter player=100 instance=517 position=1,2,3',
    );
    expect(parseGameplayTraceLog(log).entries).toEqual([expect.objectContaining({
      timestamp: '2026-8-21 15:33:24', phase: 'trigger.enter', player: '100', instance: '517',
    })]);
  });
});
