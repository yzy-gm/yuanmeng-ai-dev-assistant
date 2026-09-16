import { resolve } from 'node:path';

export const SOURCE_PATH_VARIABLES = {
  officialExtensionPath: 'YMAI_OFFICIAL_EXTENSION_PATH',
  eventsDocumentationPath: 'YMAI_EVENTS_DOC_PATH',
  resourceDocumentationPath: 'YMAI_RESOURCE_DOC_PATH',
  gameInstallPath: 'YMAI_GAME_INSTALL_PATH',
  ugcDataPath: 'YMAI_UGC_DATA_PATH',
} as const;

export type SourcePathSettings = Partial<Record<keyof typeof SOURCE_PATH_VARIABLES, string>>;

// Share a closed path whitelist across VS Code Provider and both project launchers.
export function sourcePathEnvironment(settings: SourcePathSettings, projectRoot: string): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const key of Object.keys(SOURCE_PATH_VARIABLES) as Array<keyof SourcePathSettings>) {
    const path = settings[key]?.trim();
    if (!path) continue;
    if (path.includes('\0')) throw new Error(`Invalid source path: ${key}`);
    environment[SOURCE_PATH_VARIABLES[key]] = resolve(projectRoot, path);
  }
  return environment;
}
