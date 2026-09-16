import { describe, expect, it } from 'vitest';

import { resolveGameplayProductionScope } from '../../src/core/gameplay/production-scope.js';
import type { LuaSourceFile } from '../../src/core/lua/source-index.js';

function file(path: string, source: string): LuaSourceFile {
  return { path, source };
}

describe('gameplay production scope', () => {
  it('walks only static require dependencies reachable from GameEntry', () => {
    const scope = resolveGameplayProductionScope([
      file('src/GameEntry.lua', 'local Feature = require("Feature")\nreturn Feature'),
      file('src/Feature.lua', 'return require("Shared.Config")'),
      file('src/Shared/Config.lua', 'return { Enabled = true }'),
      file('src/Client/GameClient_backup.lua', 'local ='),
    ]);

    expect(scope).toMatchObject({
      entryPath: 'src/GameEntry.lua',
      reachablePaths: ['src/Feature.lua', 'src/GameEntry.lua', 'src/Shared/Config.lua'],
      excludedPaths: ['src/Client/GameClient_backup.lua'],
      unresolvedRequires: [],
    });
    expect(scope.findings.filter((finding) => finding.severity === 'fatal')).toEqual([]);
  });

  it('reports reachable syntax errors without parsing invalid unreachable backups', () => {
    const unreachable = resolveGameplayProductionScope([
      file('src/GameEntry.lua', 'return require("Feature")'),
      file('src/Feature.lua', 'return {}'),
      file('src/Archive/Broken_backup.lua', 'local ='),
    ]);
    expect(unreachable.findings.filter((finding) => finding.severity === 'fatal')).toEqual([]);

    const reachable = resolveGameplayProductionScope([
      file('src/GameEntry.lua', 'return require("Feature")'),
      file('src/Feature.lua', 'local ='),
    ]);
    expect(reachable.findings).toContainEqual(expect.objectContaining({
      code: 'GAMEPLAY_REACHABLE_LUA_INVALID',
      severity: 'fatal',
      evidence: [expect.objectContaining({ path: 'src/Feature.lua' })],
    }));
  });

  it('fails closed when one module matches both supported candidate paths', () => {
    const scope = resolveGameplayProductionScope([
      file('src/GameEntry.lua', 'return require("Feature")'),
      file('src/Feature.lua', 'return {}'),
      file('src/Feature/init.lua', 'return {}'),
    ]);

    expect(scope.reachablePaths).toEqual(['src/GameEntry.lua']);
    expect(scope.unresolvedRequires).toEqual([{ from: 'src/GameEntry.lua', module: 'Feature' }]);
    expect(scope.findings).toContainEqual(expect.objectContaining({
      code: 'GAMEPLAY_REQUIRE_AMBIGUOUS', severity: 'fatal', scope: 'flow',
    }));
  });

  it('rejects traversal, absolute entry paths, and sole dynamic requires', () => {
    const traversal = resolveGameplayProductionScope([
      file('src/GameEntry.lua', 'return require("../Outside")'),
    ]);
    expect(traversal.findings).toContainEqual(expect.objectContaining({
      code: 'GAMEPLAY_REQUIRE_PATH_INVALID', severity: 'fatal',
    }));

    const absoluteEntry = resolveGameplayProductionScope([
      file('src/GameEntry.lua', 'return {}'),
    ], ['C:', 'project', 'src', 'GameEntry.lua'].join('/'));
    expect(absoluteEntry.findings).toContainEqual(expect.objectContaining({
      code: 'GAMEPLAY_ENTRY_PATH_INVALID', severity: 'fatal', scope: 'project',
    }));

    const dynamic = resolveGameplayProductionScope([
      file('src/GameEntry.lua', 'local name = "Feature"\nreturn require(name)'),
      file('src/Feature.lua', 'return {}'),
    ]);
    expect(dynamic.unresolvedRequires).toEqual([{ from: 'src/GameEntry.lua', module: '<dynamic>' }]);
    expect(dynamic.findings).toContainEqual(expect.objectContaining({
      code: 'GAMEPLAY_DYNAMIC_REQUIRE_UNMODELED', severity: 'fatal', scope: 'flow',
    }));
  });

  it('deduplicates repeated and cyclic requires deterministically', () => {
    const scope = resolveGameplayProductionScope([
      file('src/GameEntry.lua', 'require("A")\nreturn require("A")'),
      file('src/A.lua', 'return require("B")'),
      file('src/B.lua', 'return require("A")'),
      file('src/Z.lua', 'return {}'),
    ]);

    expect(scope.reachablePaths).toEqual(['src/A.lua', 'src/B.lua', 'src/GameEntry.lua']);
    expect(scope.excludedPaths).toEqual(['src/Z.lua']);
    expect(scope.findings.filter((finding) => finding.severity === 'fatal')).toEqual([]);
  });

  it('records a dynamic require as partial when a static production path remains known', () => {
    const scope = resolveGameplayProductionScope([
      file('src/GameEntry.lua', 'require("Feature")\nlocal name = GetOptionalModule()\nreturn require(name)'),
      file('src/Feature.lua', 'return {}'),
    ]);

    expect(scope.reachablePaths).toEqual(['src/Feature.lua', 'src/GameEntry.lua']);
    expect(scope.findings).toContainEqual(expect.objectContaining({
      code: 'GAMEPLAY_DYNAMIC_REQUIRE_UNMODELED', severity: 'partial',
    }));
  });
});
