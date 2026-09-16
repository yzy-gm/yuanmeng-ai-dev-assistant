import type { ProjectDiagnostic } from './analyzer.js';

export function filterEditorDiagnostics(
  _diagnostics: readonly ProjectDiagnostic[],
): ProjectDiagnostic[] {
  // Static review is performed by the AI workflow. The extension remains a
  // navigation/search companion and must not create a second Problems source.
  void _diagnostics;
  return [];
}
