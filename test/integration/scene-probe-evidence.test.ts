import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { nodeFileIO } from '../../src/core/fs.js';
import {
  createSceneProbeToken,
  findStoredAlignmentPlanEvidence,
  loadSceneProbeEvidence,
  parseSceneProbeLog,
  saveSceneProbeEvidence,
  type SceneProbeContext,
} from '../../src/core/scene/probe-evidence.js';

const roots: string[] = [];
const context: SceneProbeContext = {
  projectInstanceId: '44444444-4444-4444-8444-444444444444',
  bindingId: 'b'.repeat(64),
  snapshotId: 'a'.repeat(64),
  sceneSourceSha256: 'c'.repeat(64),
};

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe('scene probe evidence storage', () => {
  it('stores only the structured bound document under its log source hash', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ymai-scene-evidence-'));
    roots.push(root);
    const token = createSceneProbeToken(context, 'alignment', ['900', '901', '902']);
    const rawPrefix = 'anonymous-private-prefix session=fixture-line-123';
    const bytes = new TextEncoder().encode(
      `${rawPrefix} [YMAI_AUTO_ALIGN] token=${token} snapshot=${context.snapshotId} source=${context.sceneSourceSha256} `
      + 'support=900 movers=901,902 status=planned supportTopZ=10 lowestZ=7 deltaZ=3\n',
    );
    const document = parseSceneProbeLog(bytes, { context, importedAt: '2026-08-21T03:00:00.000Z' });

    expect(await findStoredAlignmentPlanEvidence(root, context, '900', ['901', '902'], nodeFileIO)).toBeNull();
    const path = await saveSceneProbeEvidence(root, document, nodeFileIO);
    const saved = await readFile(path, 'utf8');

    expect(path).toBe(join(root, '.yuanmeng-inspector', 'scene', 'evidence', `${document.sourceHash}.json`));
    expect(saved).not.toContain(rawPrefix);
    expect(saved).not.toContain('raw');
    expect(await loadSceneProbeEvidence(path, nodeFileIO)).toEqual(document);
    expect(await findStoredAlignmentPlanEvidence(root, context, '900', ['902', '901'], nodeFileIO)).toMatchObject({
      token,
      deltaZ: 3,
    });
    expect(await findStoredAlignmentPlanEvidence(root, context, '900', ['903'], nodeFileIO)).toBeNull();

    const conflictingBytes = new TextEncoder().encode(
      `[YMAI_AUTO_ALIGN] token=${token} snapshot=${context.snapshotId} source=${context.sceneSourceSha256} `
      + 'support=900 movers=901,902 status=planned supportTopZ=10 lowestZ=6 deltaZ=4\n',
    );
    await saveSceneProbeEvidence(root, parseSceneProbeLog(conflictingBytes, {
      context,
      importedAt: '2026-08-21T03:01:00.000Z',
    }), nodeFileIO);
    expect(await findStoredAlignmentPlanEvidence(root, context, '900', ['901', '902'], nodeFileIO)).toBeNull();
  });
});
