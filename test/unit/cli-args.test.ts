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
    expect(parseCliArgs([
      '--launcher-manifest',
      'C:/匿名 工程/.yuanmeng-inspector/bin/cli-launcher.json',
      '--project',
      'C:/匿名 工程',
      'refresh-ui',
      '--timeout',
      '8',
      '--json',
    ])).toEqual({
      command: 'refresh-ui',
      project: 'C:/匿名 工程',
      launcherManifest: 'C:/匿名 工程/.yuanmeng-inspector/bin/cli-launcher.json',
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

  it('parses where-used with only id, signal or ui kinds', () => {
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
  });

  it('parses api-search with one query', () => {
    expect(parseCliArgs(['api-search', '控件名称', '--json'])).toEqual({
      command: 'api-search',
      query: '控件名称',
      project: null,
      launcherManifest: null,
      json: true,
    });
    expect(() => parseCliArgs(['api-search'])).toThrowError(expect.objectContaining({ code: 'USAGE_ERROR' }));
  });

  it('parses audit without command-specific options', () => {
    expect(parseCliArgs(['audit', '--json'])).toEqual({
      command: 'audit',
      project: null,
      launcherManifest: null,
      json: true,
    });
    expect(() => parseCliArgs(['audit', 'extra'])).toThrowError(expect.objectContaining({ code: 'USAGE_ERROR' }));
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
    { argv: ['status', '--project'] },
    { argv: ['--project', 'C:/one', '--project', 'C:/two', 'status'] },
    { argv: ['status', '--launcher-manifest', 'one.json', '--launcher-manifest', 'two.json'] },
  ])('rejects incomplete or unsupported input: $argv', ({ argv }) => {
    expect(() => parseCliArgs(argv)).toThrowError(expect.objectContaining({ code: 'USAGE_ERROR' }));
  });
});
