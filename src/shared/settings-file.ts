/**
 * Model settings files: one character's settings for one model, exported from
 * the settings tab and imported back (on this install or another one). The
 * Live2D Avatars extension writes the same format with `extension: 'live2d'`.
 */

export const SETTINGS_FILE_FORMAT = 'lumiverse-avatar-model-settings';
export const SETTINGS_FILE_VERSION = 1;
export const SETTINGS_FILE_EXTENSION = 'spine';
const EXTENSION_NAMES: Record<string, string> = { live2d: 'Live2D', spine: 'Spine' };

export interface ModelSettingsFile {
  format: typeof SETTINGS_FILE_FORMAT;
  version: number;
  /** Which extension the settings belong to. */
  extension: string;
  exportedAt: string;
  /** The character the settings were exported from. Ids differ between installs, so the name is what's shown. */
  character: { id: string; name: string };
  /** The model they apply to. Imports find it by id, then by name. */
  model: { id: string; name: string };
  /** The per-model settings object, as stored by the extension. */
  settings: Record<string, unknown>;
}

export function buildSettingsFile(
  character: { id: string; name: string },
  model: { id: string; name: string },
  settings: object,
): ModelSettingsFile {
  return {
    format: SETTINGS_FILE_FORMAT,
    version: SETTINGS_FILE_VERSION,
    extension: SETTINGS_FILE_EXTENSION,
    exportedAt: new Date().toISOString(),
    character: { id: character.id, name: character.name },
    model: { id: model.id, name: model.name },
    settings: JSON.parse(JSON.stringify(settings)),
  };
}

/** A file name like "Bay - bay.spine-settings.json", safe on every OS. */
export function settingsFileName(characterName: string, modelName: string): string {
  const clean = (text: string) =>
    text
      .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_')
      .trim()
      .slice(0, 60) || 'model';
  return `${clean(characterName)} - ${clean(modelName)}.${SETTINGS_FILE_EXTENSION}-settings.json`;
}

export function parseSettingsFile(text: string): { file: ModelSettingsFile } | { error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { error: "This file isn't valid JSON." };
  }
  const value = raw as Partial<ModelSettingsFile> | null;
  if (!value || typeof value !== 'object' || value.format !== SETTINGS_FILE_FORMAT) {
    return { error: "This isn't a model settings file exported from the Live2D or Spine Avatars extension." };
  }
  if (value.extension !== SETTINGS_FILE_EXTENSION) {
    const name = EXTENSION_NAMES[String(value.extension)] ?? String(value.extension);
    return { error: `This file holds ${name} model settings. Import it in the ${name} Avatars extension.` };
  }
  if (typeof value.version !== 'number' || value.version > SETTINGS_FILE_VERSION) {
    return { error: 'This file was made by a newer version of the extension. Update the extension, then try again.' };
  }
  if (!value.settings || typeof value.settings !== 'object' || Array.isArray(value.settings)) {
    return { error: 'This file has no model settings in it.' };
  }
  const named = (part: unknown) => {
    const object = (part && typeof part === 'object' ? part : {}) as Record<string, unknown>;
    return {
      id: typeof object.id === 'string' ? object.id : '',
      name: typeof object.name === 'string' ? object.name : '',
    };
  };
  return {
    file: {
      format: SETTINGS_FILE_FORMAT,
      version: value.version,
      extension: value.extension,
      exportedAt: typeof value.exportedAt === 'string' ? value.exportedAt : '',
      character: named(value.character),
      model: named(value.model),
      settings: value.settings as Record<string, unknown>,
    },
  };
}
