export interface ExtensionManifestRecord {
  id: string;
  packageJSON: unknown;
}

export interface OfficialCommandProvider {
  extensionId: string;
  version: string;
}

const REFRESH_UI_COMMAND = 'dreamhelper.GetCustomUIData';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function contributesCommand(packageJSON: unknown): boolean {
  if (!isRecord(packageJSON) || !isRecord(packageJSON.contributes) || !Array.isArray(packageJSON.contributes.commands)) {
    return false;
  }
  return packageJSON.contributes.commands.some((candidate) => (
    isRecord(candidate) && candidate.command === REFRESH_UI_COMMAND
  ));
}

export function discoverOfficialCommandProvider(
  extensions: readonly ExtensionManifestRecord[],
): OfficialCommandProvider | null {
  const matches = extensions.filter((extension) => contributesCommand(extension.packageJSON));
  if (matches.length !== 1) {
    return null;
  }
  const match = matches[0]!;
  if (!isRecord(match.packageJSON) || typeof match.packageJSON.version !== 'string' || match.packageJSON.version.length === 0) {
    return null;
  }
  return { extensionId: match.id, version: match.packageJSON.version };
}
