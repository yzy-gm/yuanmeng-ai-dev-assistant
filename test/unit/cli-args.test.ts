import { describe, expect, it } from 'vitest';

import { parseCliArgs } from '../../src/cli/args.js';

describe('CLI argument parser', () => {
  it('parses a UI lookup without allowing global options to become the query', () => {
    expect(parseCliArgs([
      'find-ui',
      '经验',
      '--project',
      'C:/匿名工程',
      '--fuzzy',
      '--allow-stale',
      '--json',
    ])).toEqual({
      command: 'find-ui',
      query: '经验',
      project: 'C:/匿名工程',
      launcherManifest: null,
      json: true,
      allowStale: true,
      searchMode: 'fuzzy',
    });
  });

  it('parses UI runtime screen geometry and layout audit commands', () => {
    expect(parseCliArgs(['ui-screen-snapshot', '经验', '--allow-stale'])).toMatchObject({
      command: 'ui-screen-snapshot', query: '经验', allowStale: true, searchMode: 'exact-name',
    });
    expect(parseCliArgs(['ui-tree-screen-snapshot', '/HUD', '--path'])).toMatchObject({
      command: 'ui-tree-screen-snapshot', query: '/HUD', searchMode: 'exact-path',
    });
    expect(parseCliArgs(['ui-layout-audit', '/HUD', '--path', '--include-overlaps'])).toMatchObject({
      command: 'ui-layout-audit', query: '/HUD', searchMode: 'exact-path', includePotentialSiblingOverlap: true,
    });
    expect(() => parseCliArgs(['find-ui', '经验', '--include-overlaps'])).toThrowError(
      expect.objectContaining({ code: 'USAGE_ERROR' }),
    );
  });

  it('parses deterministic P0 UI/runtime-probe commands without arbitrary Lua input', () => {
    expect(parseCliArgs(['resolve-ui', '/HUD/商品列表', '--allow-stale'])).toMatchObject({
      command: 'resolve-ui', query: '/HUD/商品列表', allowStale: true,
    });
    expect(parseCliArgs(['ui-inspect-point', '320', '240', '--include-group', '--group-id', '1000'])).toMatchObject({
      command: 'ui-inspect-point', request: { x: 320, y: 240, includeGroup: true, groupId: '1000' },
    });
    expect(parseCliArgs(['ui-runtime-widgets', 'HUD'])).toMatchObject({
      command: 'ui-runtime-widgets', query: 'HUD', allowStale: false,
    });
    expect(parseCliArgs(['runtime-probe', 'ui-screen-point', '10', '20'])).toMatchObject({
      command: 'runtime-probe', kind: 'ui-screen-point', request: { x: 10, y: 20, includeGroup: false, groupId: '0' },
    });
    expect(parseCliArgs(['runtime-probe', 'ui-runtime-tree', '/HUD'])).toMatchObject({
      command: 'runtime-probe', kind: 'ui-runtime-tree', query: '/HUD',
    });
    expect(parseCliArgs(['runtime-probe', 'scene-capability', '517'])).toMatchObject({
      command: 'runtime-probe', kind: 'scene-capability', instanceId: '517',
    });
    expect(parseCliArgs(['scene-capabilities', '517'])).toMatchObject({ command: 'scene-capabilities', instanceId: '517' });
    expect(() => parseCliArgs(['runtime-probe', 'lua', 'return UI:GetPosition(1)'])).toThrowError(
      expect.objectContaining({ code: 'USAGE_ERROR' }),
    );
  });

  it('parses diff and export command-specific options', () => {
    expect(parseCliArgs(['diff-ui', '--from', 'old', '--to', 'new'])).toMatchObject({
      command: 'diff-ui',
      from: 'old',
      to: 'new',
    });
    expect(parseCliArgs(['export', 'ui', '--format', 'csv', '--out', 'ui.csv'])).toMatchObject({
      command: 'export',
      subject: 'ui',
      format: 'csv',
      out: 'ui.csv',
    });
  });

  it('accepts launcher binding options before the subcommand', () => {
    const project = ['C:', '匿名 工程'].join('/');
    const launcherManifest = `${project}/.${'yuanmeng-inspector'}/bin/cli-launcher.json`;
    expect(parseCliArgs([
      '--launcher-manifest',
      launcherManifest,
      '--project',
      project,
      'refresh-ui',
      '--timeout',
      '8',
      '--json',
    ])).toEqual({
      command: 'refresh-ui',
      project,
      launcherManifest,
      json: true,
      timeoutSeconds: 8,
    });
  });

  it('parses independent list-ids filters and rejects the old combined status filter', () => {
    expect(parseCliArgs([
      'list-ids',
      '--kind', 'ui-control',
      '--environment', 'test',
      '--validity', 'confirmed',
      '--allow-stale',
      '--json',
    ])).toEqual({
      command: 'list-ids',
      project: null,
      launcherManifest: null,
      json: true,
      kind: 'ui-control',
      environment: 'test',
      validity: 'confirmed',
      allowStale: true,
    });
    expect(() => parseCliArgs(['list-ids', '--status', 'confirmed'])).toThrowError(
      expect.objectContaining({ code: 'USAGE_ERROR' }),
    );
  });

  it('parses where-used with legacy and exact scene registry kinds', () => {
    expect(parseCliArgs([
      'where-used',
      '41001',
      '--kind', 'ui',
      '--json',
    ])).toEqual({
      command: 'where-used',
      query: '41001',
      kind: 'ui',
      project: null,
      launcherManifest: null,
      json: true,
    });
    expect(() => parseCliArgs(['where-used', '41001', '--kind', 'camera'])).toThrowError(
      expect.objectContaining({ code: 'USAGE_ERROR' }),
    );
    for (const kind of ['scene-instance', 'element-type', 'scene-layer'] as const) {
      expect(parseCliArgs(['where-used', '84001', '--kind', kind])).toMatchObject({
        command: 'where-used',
        query: '84001',
        kind,
      });
    }
  });

  it('parses api-search with one query', () => {
    expect(parseCliArgs(['api-search', '控件名称', '--json'])).toEqual({
      command: 'api-search',
      query: '控件名称',
      limit: 200,
      project: null,
      launcherManifest: null,
      json: true,
    });
    expect(() => parseCliArgs(['api-search'])).toThrowError(expect.objectContaining({ code: 'USAGE_ERROR' }));
    expect(parseCliArgs(['api-search', '控件名称', '--limit', '7'])).toMatchObject({
      command: 'api-search', query: '控件名称', limit: 7,
    });
  });

  it('parses read-only official audit and explicit private API baseline save', () => {
    expect(parseCliArgs(['official-audit'])).toMatchObject({ command: 'official-audit', saveBaseline: false });
    expect(parseCliArgs(['official-audit', '--save-baseline', '--json'])).toMatchObject({ command: 'official-audit', saveBaseline: true, json: true });
    expect(() => parseCliArgs(['official-audit', 'src/GameEntry.lua'])).toThrowError(expect.objectContaining({ code: 'USAGE_ERROR' }));
  });

  it('parses full and targeted audit options without weakening the default scope', () => {
    expect(parseCliArgs(['audit', '--json'])).toEqual({
      command: 'audit',
      files: [],
      errorsOnly: false,
      project: null,
      launcherManifest: null,
      json: true,
    });
    expect(parseCliArgs([
      'audit',
      '--file', 'src/Client/GameClient.lua',
      '--file', 'src\\Server\\GameServer.lua',
      '--errors-only',
      '--json',
    ])).toEqual({
      command: 'audit',
      files: ['src/Client/GameClient.lua', 'src/Server/GameServer.lua'],
      errorsOnly: true,
      project: null,
      launcherManifest: null,
      json: true,
    });
    expect(() => parseCliArgs(['audit', '--file', '../GameEntry.lua'])).toThrowError(
      expect.objectContaining({ code: 'USAGE_ERROR' }),
    );
    const driveAbsolutePath = ['C:', 'project', 'src', 'GameEntry.lua'].join('\\');
    expect(() => parseCliArgs(['audit', '--file', driveAbsolutePath])).toThrowError(
      expect.objectContaining({ code: 'USAGE_ERROR' }),
    );
    expect(() => parseCliArgs(['audit', '--file', 'src/GameEntry.lua', '--file', 'src\\GameEntry.lua'])).toThrowError(
      expect.objectContaining({ code: 'USAGE_ERROR' }),
    );
    expect(() => parseCliArgs(['audit', 'extra'])).toThrowError(expect.objectContaining({ code: 'USAGE_ERROR' }));
  });

  it('parses an AI-settable map display name', () => {
    expect(parseCliArgs(['set-map-name', '星光超市', '--json'])).toEqual({
      command: 'set-map-name',
      mapDisplayName: '星光超市',
      project: null,
      launcherManifest: null,
      json: true,
    });
    expect(() => parseCliArgs(['set-map-name'])).toThrowError(expect.objectContaining({ code: 'USAGE_ERROR' }));
  });

  it('parses explicit AI gameplay review and confirmed test workflows', () => {
    expect(parseCliArgs(['gameplay-review', 'gameplay/spec.json', '--out', 'reports'])).toMatchObject({
      command: 'gameplay-review', modelPath: 'gameplay/spec.json', out: 'reports',
    });
    expect(parseCliArgs(['gameplay-test', 'gameplay/spec.json', 'gameplay/scenarios', '--out', 'reports'])).toMatchObject({
      command: 'gameplay-test', mode: 'manual', modelPath: 'gameplay/spec.json', scenarioDirectory: 'gameplay/scenarios', out: 'reports',
      focus: null, changedFiles: [],
    });
    expect(() => parseCliArgs(['gameplay-test', 'gameplay/spec.json', 'gameplay/scenarios'])).toThrowError(
      expect.objectContaining({ code: 'USAGE_ERROR' }),
    );
  });

  it('defaults gameplay tests to automatic preparation and rejects mixed modes', () => {
    expect(parseCliArgs(['gameplay-test', '--json'])).toMatchObject({
      command: 'gameplay-test', mode: 'auto', modelPath: null, scenarioDirectory: null, out: null,
      focus: null, changedFiles: [], preview: false, json: true,
    });
    expect(parseCliArgs([
      'gameplay-test', '--focus', '复核结算流程',
      '--file', 'src/GameEntry.lua', '--file', 'src/Server/Settlement.lua',
    ])).toMatchObject({
      command: 'gameplay-test', mode: 'auto', focus: '复核结算流程',
      changedFiles: ['src/GameEntry.lua', 'src/Server/Settlement.lua'], preview: false,
    });

    expect(parseCliArgs(['gameplay-test', '--preview'])).toMatchObject({
      command: 'gameplay-test', mode: 'auto', preview: true,
    });

    for (const argv of [
      ['gameplay-test', 'gameplay/spec.json'],
      ['gameplay-test', '--out', 'reports'],
      ['gameplay-test', 'gameplay/spec.json', 'gameplay/scenarios', '--out', 'reports', '--focus', '混用'],
      ['gameplay-test', 'gameplay/spec.json', 'gameplay/scenarios', '--out', 'reports', '--file', 'src/GameEntry.lua'],
      ['gameplay-test', 'gameplay/spec.json', 'gameplay/scenarios', '--out', 'reports', '--preview'],
    ]) {
      expect(() => parseCliArgs(argv)).toThrowError(expect.objectContaining({ code: 'USAGE_ERROR' }));
    }
  });

  it('parses project-local AI feedback inbox operations', () => {
    expect(parseCliArgs(['feedback', 'add', 'bug', '刷新提示错误', '--message', '保存后仍显示未绑定'])).toMatchObject({
      command: 'feedback', action: 'add', kind: 'bug', title: '刷新提示错误', message: '保存后仍显示未绑定',
    });
    expect(parseCliArgs(['feedback', 'list', 'open', 'improvement', '--json'])).toMatchObject({
      command: 'feedback', action: 'list', status: 'open', kind: 'improvement', json: true,
    });
    expect(parseCliArgs(['feedback', 'resolve', 'a'.repeat(64), '--message', '已修复'])).toMatchObject({
      command: 'feedback', action: 'resolve', feedbackId: 'a'.repeat(64), resolution: '已修复',
    });
    expect(() => parseCliArgs(['status', '--message', 'x'])).toThrowError(expect.objectContaining({ code: 'USAGE_ERROR' }));
  });

  it('parses private scene commands without changing the existing CLI envelope contract', () => {
    expect(parseCliArgs(['bind-scene', 'raw-pbin', 'C:/匿名/LayerData.pbin', '--json'])).toMatchObject({
      command: 'bind-scene', role: 'raw-pbin', sourcePath: 'C:/匿名/LayerData.pbin', json: true,
    });
    expect(parseCliArgs(['refresh-scene', 'auto-dat', '--timeout', '45'])).toMatchObject({
      command: 'refresh-scene', role: 'auto-dat', timeoutSeconds: 45,
    });
    expect(parseCliArgs(['find-scene', 'type:7000'])).toMatchObject({ command: 'find-scene', query: 'type:7000' });
    expect(parseCliArgs(['scene-plan', '100', '101', '102'])).toMatchObject({
      command: 'scene-plan', mode: 'floor-align', supportId: '100', moverIds: ['101', '102'],
    });
    expect(parseCliArgs(['scene-plan', 'axis-align', '101', '102', '--reference', '900', '--axis', 'x', '--anchor', 'center'])).toMatchObject({
      command: 'scene-plan', mode: 'placement', request: {
        kind: 'axis-align', targetIds: ['101', '102'], referenceId: '900', axis: 'x', anchor: 'center', preserveGroupRelative: true,
      },
    });
    expect(parseCliArgs(['scene-plan', 'batch-offset', '101', '--position', 'z=5,x=-2', '--rotation', 'y=90', '--no-preserve-group'])).toMatchObject({
      command: 'scene-plan', mode: 'placement', request: {
        kind: 'batch-offset', targetIds: ['101'], components: { position: { z: 5, x: -2 }, rotation: { y: 90 } }, preserveGroupRelative: false,
      },
    });
    expect(parseCliArgs(['scene-plan', 'grid', '101', '102', '--row-axis', 'y', '--column-axis', 'x', '--columns', '2', '--row-spacing', '4', '--column-spacing', '5'])).toMatchObject({
      command: 'scene-plan', mode: 'placement', request: {
        kind: 'grid', targetIds: ['101', '102'], rowAxis: 'y', columnAxis: 'x', columns: 2, rowSpacing: 4, columnSpacing: 5,
      },
    });
    expect(parseCliArgs(['scene-journal', 'list', '--limit', '20'])).toMatchObject({ command: 'scene-journal', action: 'list', limit: 20 });
    expect(parseCliArgs(['scene-journal', 'show', 'a'.repeat(64)])).toMatchObject({ command: 'scene-journal', action: 'show', journalId: 'a'.repeat(64) });
    expect(parseCliArgs(['scene-near', '101'])).toMatchObject({
      command: 'scene-near', instanceId: '101', radius: 100, limit: 50,
    });
    expect(parseCliArgs(['scene-near', '101', '--radius', '25.5', '--limit', '7'])).toMatchObject({
      command: 'scene-near', instanceId: '101', radius: 25.5, limit: 7,
    });
    expect(parseCliArgs(['scene-audit', '--json'])).toMatchObject({ command: 'scene-audit', json: true });
    expect(parseCliArgs(['scene-types', '--json'])).toMatchObject({ command: 'scene-types', json: true });
    expect(parseCliArgs(['scene-geometry', 'bounds', '513'])).toMatchObject({
      command: 'scene-geometry', request: { operation: 'bounds', targetId: '513' },
    });
    expect(parseCliArgs(['scene-geometry', 'contact', '513', '509', '--tolerance', '0.1'])).toMatchObject({
      command: 'scene-geometry', request: { operation: 'contact', targetId: '513', supportId: '509', tolerance: 0.1 },
    });
    expect(parseCliArgs(['scene-geometry', 'overlaps', '513', '600'])).toMatchObject({
      command: 'scene-geometry', request: { operation: 'overlaps', targetIds: ['513', '600'] },
    });
    expect(parseCliArgs(['scene-audit', '--detailed', '--json'])).toMatchObject({
      command: 'scene-audit', detailed: true, json: true,
    });
    expect(() => parseCliArgs(['status', '--detailed'])).toThrowError(expect.objectContaining({ code: 'USAGE_ERROR' }));
    expect(parseCliArgs(['export', 'scene', '--format', 'md', '--out', 'scene.md'])).toMatchObject({
      command: 'export', subject: 'scene', format: 'md', out: 'scene.md',
    });
    expect(parseCliArgs(['export', 'scene-ai', '--format', 'json', '--out', 'scene-ai.json'])).toMatchObject({
      command: 'export', subject: 'scene-ai', format: 'json', out: 'scene-ai.json',
    });
    expect(parseCliArgs(['property-locate', '测试立方体', 'Number'])).toMatchObject({
      command: 'property-locate', propertyName: '测试立方体', propertyType: 'Number',
    });
  });

  it.each([
    { argv: [] },
    { argv: ['unknown'] },
    { argv: ['find-ui'] },
    { argv: ['status', '--mystery'] },
    { argv: ['status', '--path'] },
    { argv: ['status', '--timeout', '5'] },
    { argv: ['refresh-ui', '--timeout', '0'] },
    { argv: ['export', 'ids', '--format', 'json', '--out', 'ids.json'] },
    { argv: ['bind-scene', 'packed', 'LayerData.pbin'] },
    { argv: ['scene-plan', '100'] },
    { argv: ['scene-plan', 'axis-align', '101', '--axis', 'x'] },
    { argv: ['scene-plan', 'batch-offset', '101'] },
    { argv: ['scene-plan', 'grid', '101', '--row-axis', 'x', '--column-axis', 'x', '--columns', '2', '--row-spacing', '1', '--column-spacing', '1'] },
    { argv: ['scene-journal', 'show', 'short'] },
    { argv: ['scene-journal', 'show', 'a'.repeat(64), '--limit', '2'] },
    { argv: ['export', 'scene-ai', '--format', 'csv', '--out', 'scene-ai.csv'] },
    { argv: ['scene-near', '100', '--radius', 'NaN'] },
    { argv: ['scene-near', '100', '--limit', '0'] },
    { argv: ['scene-audit', 'extra'] },
    { argv: ['status', '--project'] },
    { argv: ['--project', 'C:/one', '--project', 'C:/two', 'status'] },
    { argv: ['status', '--launcher-manifest', 'one.json', '--launcher-manifest', 'two.json'] },
  ])('rejects incomplete or unsupported input: $argv', ({ argv }) => {
    expect(() => parseCliArgs(argv)).toThrowError(expect.objectContaining({ code: 'USAGE_ERROR' }));
  });
});
