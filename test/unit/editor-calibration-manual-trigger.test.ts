import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

const gameEntryPath = fileURLToPath(
  new URL('../../work/editor-calibration/src/GameEntry.lua', import.meta.url),
);

describe('editor calibration manual signal-box trigger', () => {
  test('never moves the player automatically', async () => {
    const source = await readFile(gameEntryPath, 'utf8');

    expect(source).not.toContain('Character:MoveToPosition');
    expect(source).not.toContain('System:SendToClient');
    expect(source).not.toContain('System:BindNotify');
    expect(source).not.toContain('TEST_MOVE_PLAYER_MESSAGE_ID');
  });

  test('drops the cabinet only after player one enters signal box 517', async () => {
    const source = await readFile(gameEntryPath, 'utf8');
    const enterHandlerStart = source.indexOf('local function OnCharacterEnterSignalBox');
    const cabinetDropCall =
      'AlignElementsToFloor(TEST_CABINET_MEMBER_IDS, TEST_CABINET_SUPPORT_IDS, "货柜")';
    const cabinetDrop = source.indexOf(cabinetDropCall);

    expect(source).not.toContain('Events.ON_PLAYER_TOUCH_ELEMENT');
    expect(source).toContain('Events.ON_CHARACTER_ENTER_SIGNAL_BOX');
    expect(enterHandlerStart).toBeGreaterThan(-1);
    expect(source).toContain('signalBoxId ~= TEST_SIGNAL_BOX_ID');
    expect(source).toContain('playerId ~= selectedPlayerId');
    expect(cabinetDrop).toBeGreaterThan(enterHandlerStart);
    expect(source.indexOf(cabinetDropCall)).toBe(source.lastIndexOf(cabinetDropCall));
  });

  test('uses only the two cabinet feet as floor-contact probes', async () => {
    const source = await readFile(gameEntryPath, 'utf8');

    expect(source).toContain('local TEST_CABINET_SUPPORT_IDS = { 511, 512 }');
    expect(source).toContain(
      'AlignElementsToFloor(TEST_CABINET_MEMBER_IDS, TEST_CABINET_SUPPORT_IDS, "货柜")',
    );
    expect(source).not.toContain(
      'AlignElementsToFloor(TEST_CABINET_MEMBER_IDS, "货柜")',
    );
  });
});
