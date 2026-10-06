/** Message protocol between the frontend module and the backend runtime. */

import type { ModelRecord, SpineSettings } from './settings';

// ── Frontend → Backend ──────────────────────────────────────────────────────

export interface GetStateMsg {
  type: 'get_state';
}

export interface SaveSettingsMsg {
  type: 'save_settings';
  settings: SpineSettings;
}

export interface ImportModelZipMsg {
  type: 'import_model_zip';
  uploadId: string;
  /** Optional display-name override; defaults to the zip's model folder name */
  name?: string;
}

export interface DeleteModelMsg {
  type: 'delete_model';
  modelId: string;
}

/**
 * Model files are pulled by the browser a few chunks at a time. The host relays
 * extension messages with Bun's pub/sub, which silently drops messages once a
 * connection has ~16 MB queued, so pushing a whole large model at once loses chunks.
 */
export interface GetModelManifestMsg {
  type: 'get_model_manifest';
  reqId: string;
  modelId: string;
}

export interface GetModelChunkMsg {
  type: 'get_model_chunk';
  reqId: string;
  path: string;
  seq: number;
}

export interface InteractionMsg {
  type: 'interaction';
  chatId: string;
  message: string;
  /** Trigger a normal reply generation after appending (Auto-send interaction). */
  generate: boolean;
}

export interface ClassifyTestMsg {
  type: 'classify_test';
  text: string;
}

export type FrontendToBackend =
  | GetStateMsg
  | SaveSettingsMsg
  | ImportModelZipMsg
  | DeleteModelMsg
  | GetModelManifestMsg
  | GetModelChunkMsg
  | InteractionMsg
  | ClassifyTestMsg;

// ── Backend → Frontend ──────────────────────────────────────────────────────

export interface StateMsg {
  type: 'state';
  settings: SpineSettings;
  models: ModelRecord[];
  characters: Array<{ id: string; name: string }>;
  permissions: string[];
}

export interface SettingsSavedMsg {
  type: 'settings_saved';
}

export interface ModelImportedMsg {
  type: 'model_imported';
  model: ModelRecord;
}

export interface ModelDeletedMsg {
  type: 'model_deleted';
  modelId: string;
}

export interface ImportErrorMsg {
  type: 'import_error';
  error: string;
}

export interface ModelManifestMsg {
  type: 'model_manifest';
  reqId: string;
  modelId: string;
  version: number;
  skeletonFile: string;
  atlasFile: string;
  /** Raw bytes per chunk; file `size` / `chunkBytes` (rounded up, min 1) chunks per file */
  chunkBytes: number;
  files: Array<{ path: string; size: number }>;
}

export interface ModelChunkMsg {
  type: 'model_chunk';
  reqId: string;
  path: string;
  seq: number;
  dataB64: string;
}

export interface ModelFilesErrorMsg {
  type: 'model_files_error';
  reqId: string;
  error: string;
}

export interface ExpressionMsg {
  type: 'expression';
  chatId: string;
  characterId: string | null;
  label: string;
  source: 'llm' | 'native';
}

export interface CharacterMessageMsg {
  type: 'character_message';
  chatId: string;
  characterId: string | null;
  messageId: string;
  /** Message text length (for the talking mouth animation); 0 when unknown */
  textLength: number;
}

export interface ChatContextMsg {
  type: 'chat_context';
  chatId: string | null;
  characterId: string | null;
}

export interface ClassifyTestResultMsg {
  type: 'classify_test_result';
  label: string;
  error?: string;
}

export interface PermissionsChangedMsg {
  type: 'permissions_changed';
  permissions: string[];
}

export interface FocusTabMsg {
  type: 'focus_tab';
}

export interface ReloadModelsMsg {
  type: 'reload_models';
}

export interface ToggleEnabledMsg {
  type: 'toggle_enabled';
  enabled: boolean;
}

export type BackendToFrontend =
  | StateMsg
  | SettingsSavedMsg
  | ModelImportedMsg
  | ModelDeletedMsg
  | ImportErrorMsg
  | ModelManifestMsg
  | ModelChunkMsg
  | ModelFilesErrorMsg
  | ExpressionMsg
  | CharacterMessageMsg
  | ChatContextMsg
  | ClassifyTestResultMsg
  | PermissionsChangedMsg
  | FocusTabMsg
  | ReloadModelsMsg
  | ToggleEnabledMsg;
