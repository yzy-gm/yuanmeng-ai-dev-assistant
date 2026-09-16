import { describe, expect, it } from 'vitest';

import { filterEditorDiagnostics } from '../../src/core/diagnostics/editor-policy.js';
import type { ProjectDiagnostic } from '../../src/core/diagnostics/analyzer.js';

function diagnostic(code: ProjectDiagnostic['code']): ProjectDiagnostic {
  return {
    code,
    severity: 'error',
    message: code,
    nextAction: 'test',
    path: 'src/GameClient.lua',
    range: null,
    evidence: 'STATIC_LOCAL',
    runtimeVerified: false,
  };
}

describe('editor diagnostic policy', () => {
  it('does not publish any private diagnostics into the editor Problems panel', () => {
    const result = filterEditorDiagnostics([
      diagnostic('UNKNOWN_OFFICIAL_API'),
      diagnostic('API_ARGUMENT_COUNT'),
      diagnostic('API_LITERAL_TYPE'),
      diagnostic('OFFICIAL_API_UNAVAILABLE'),
      diagnostic('UNREGISTERED_ID_REFERENCE'),
      diagnostic('DUPLICATE_UI_NAME'),
    ]);

    expect(result).toEqual([]);
  });
});
