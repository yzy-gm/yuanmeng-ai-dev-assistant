import { cp, mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { nodeFileIO } from '../../src/core/fs.js';
import {
  buildProjectIdentity,
  discoverProjects,
} from '../../src/core/project/context.js';

const temporaryDirectories: string[] = [];

async function copyFixture(name: 'alpha' | 'beta'): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), 'ymai-project-'));
  temporaryDirectories.push(parent);
  const target = join(parent, name);
  await cp(new URL(`../fixtures/projects/${name}`, import.meta.url), target, { recursive: true });
  return target;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('project discovery', () => {
  it('never merges two workspace roots and persists distinct identities', async () => {
    const alphaRoot = await copyFixture('alpha');
    const betaRoot = await copyFixture('beta');

    const first = await discoverProjects([alphaRoot, betaRoot], nodeFileIO);
    const second = await discoverProjects([alphaRoot, betaRoot], nodeFileIO);

    expect(first.map((project) => basename(project.root))).toEqual(['alpha', 'beta']);
    expect(first[0]?.projectInstanceId).not.toBe(first[1]?.projectInstanceId);
    expect(second.map((project) => project.projectInstanceId)).toEqual(first.map((project) => project.projectInstanceId));
    expect(first.every((project) => project.mapFingerprint === null)).toBe(true);
  });

  it('rejects a folder without both src and src/GameEntry.lua', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'ymai-invalid-project-'));
    temporaryDirectories.push(parent);
    const missingSrc = join(parent, 'missing-src');
    const missingEntry = join(parent, 'missing-entry');
    await mkdir(missingSrc);
    await mkdir(join(missingEntry, 'src'), { recursive: true });

    expect(await discoverProjects([missingSrc, missingEntry], nodeFileIO)).toEqual([]);
  });

  it('stores only UUID and root hash in project metadata', async () => {
    const root = await copyFixture('alpha');
    const [project] = await discoverProjects([root], nodeFileIO);

    const metadata = await readFile(join(root, '.yuanmeng-inspector', 'meta.json'), 'utf8');

    expect(JSON.parse(metadata)).toEqual({
      projectInstanceId: project?.projectInstanceId,
      projectRootHash: project?.projectRootHash,
      schemaVersion: 1,
    });
    expect(metadata).not.toContain(root);
  });
});

describe('project identity', () => {
  it('does not create a map fingerprint from unverified map information', () => {
    const identity = buildProjectIdentity({
      canonicalRoot: 'C:/fictional/project',
      projectInstanceId: '00000000-0000-4000-8000-000000000001',
      hasSrc: true,
      hasGameEntry: true,
      mapInfo: {
        mapName: 'Fictional map',
        currentLayerId: 'layer-a',
        layers: [{ layerId: 'layer-a', layerName: 'Fictional layer' }],
        evidence: 'STATIC_LOCAL',
      },
    });

    expect(identity).toMatchObject({ mapFingerprint: null, mapName: null, layers: [] });
  });

  it('sorts official layer evidence before fingerprinting', () => {
    const base = {
      canonicalRoot: 'C:/fictional/project',
      projectInstanceId: '00000000-0000-4000-8000-000000000001',
      hasSrc: true,
      hasGameEntry: true,
    } as const;
    const first = buildProjectIdentity({
      ...base,
      mapInfo: {
        mapName: 'Fictional map',
        currentLayerId: 'layer-a',
        layers: [
          { layerId: 'layer-b', layerName: 'Layer B' },
          { layerId: 'layer-a', layerName: 'Layer A' },
        ],
        evidence: 'OFFICIAL_EDITOR_SINGLE',
      },
    });
    const second = buildProjectIdentity({
      ...base,
      mapInfo: {
        mapName: 'Fictional map',
        currentLayerId: 'layer-a',
        layers: [...first.layers].reverse(),
        evidence: 'OFFICIAL_EDITOR_SINGLE',
      },
    });

    expect(first.layers.map((layer) => layer.layerId)).toEqual(['layer-a', 'layer-b']);
    expect(first.mapFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(second.mapFingerprint).toBe(first.mapFingerprint);
  });
});
