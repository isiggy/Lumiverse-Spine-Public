/**
 * Spine Avatars — backend runtime.
 *
 * Owns persistent state (settings + imported model files), unpacks model ZIPs,
 * streams model files to the frontend, classifies message emotions with a
 * quiet LLM generation, and relays chat lifecycle context to the stage.
 */

declare const spindle: import('lumiverse-spindle-types').SpindleAPI;

import { TextureAtlas } from '@esotericsoftware/spine-core';
import { unzipSync } from 'fflate';
import type { ChatMessageDTO } from 'lumiverse-spindle-types';
import type {
  BackendToFrontend,
  FrontendToBackend,
  GetModelChunkMsg,
  GetModelManifestMsg,
  ImportModelZipMsg,
  InteractionMsg,
  SaveSettingsMsg,
  SaveThumbnailMsg,
} from './shared/protocol';
import {
  CLASSIFY_EXPRESSIONS,
  SUPPORTED_SPINE_VERSIONS,
  spineRuntimeFor,
  type ModelRecord,
  type SpineSettings,
  normalizeSettings,
} from './shared/settings';

const SETTINGS_FILE = 'settings.json';
const REGISTRY_FILE = 'models.json';
const MODELS_DIR = 'models';

const MAX_UNPACKED_BYTES = 512 * 1024 * 1024;
const MAX_FILE_COUNT = 3000;
/** Raw bytes per chunk; base64 expansion keeps this well under the 4 MB message cap. */
const CHUNK_BYTES = 1024 * 1024;

// ── Storage helpers ─────────────────────────────────────────────────────────

async function loadSettings(userId?: string): Promise<SpineSettings> {
  const raw = await spindle.userStorage.getJson<unknown>(SETTINGS_FILE, {
    fallback: null,
    ...(userId ? { userId } : {}),
  });
  return normalizeSettings(raw);
}

async function saveSettings(settings: SpineSettings, userId?: string): Promise<void> {
  await spindle.userStorage.setJson(SETTINGS_FILE, settings, {
    indent: 2,
    ...(userId ? { userId } : {}),
  });
}

async function loadRegistry(userId?: string): Promise<ModelRecord[]> {
  const raw = await spindle.userStorage.getJson<ModelRecord[]>(REGISTRY_FILE, {
    fallback: [],
    ...(userId ? { userId } : {}),
  });
  return Array.isArray(raw) ? raw : [];
}

async function saveRegistry(models: ModelRecord[], userId?: string): Promise<void> {
  await spindle.userStorage.setJson(REGISTRY_FILE, models, {
    indent: 2,
    ...(userId ? { userId } : {}),
  });
}

function send(payload: BackendToFrontend, userId?: string): void {
  spindle.sendToFrontend(payload, userId);
}

// ── ZIP import ──────────────────────────────────────────────────────────────

function sanitizeZipPath(path: string): string | null {
  const normalized = path.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized || normalized.endsWith('/')) return null;
  const parts = normalized.split('/');
  if (parts.some((part) => part === '..' || part === '' || part === '.')) return null;
  if (parts.some((part) => part === '__MACOSX' || part === '.DS_Store' || part.startsWith('._'))) return null;
  return parts.join('/');
}

/** Strip a single shared top-level directory, if every file lives under one. */
function stripCommonRoot(paths: string[]): (path: string) => string {
  const roots = new Set(paths.map((path) => path.split('/')[0]));
  const first = [...roots][0];
  if (roots.size === 1 && first !== undefined && paths.every((path) => path.includes('/'))) {
    const prefix = first + '/';
    return (path) => path.slice(prefix.length);
  }
  return (path) => path;
}

const SKELETON_BINARY = /\.skel(\.bytes)?$/i;
const SKELETON_JSON = /\.json$/i;
const ATLAS = /\.atlas(\.txt)?$/i;
/** Skeleton JSON files above this size aren't sniffed for a `skeleton.spine` header. */
const MAX_SNIFF_JSON_BYTES = 64 * 1024 * 1024;

function dirname(path: string): string {
  const index = path.lastIndexOf('/');
  return index === -1 ? '' : path.slice(0, index);
}

function normalizePath(path: string): string {
  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return parts.join('/');
}

function stem(path: string): string {
  return path
    .split('/')
    .pop()!
    .replace(SKELETON_BINARY, '')
    .replace(ATLAS, '')
    .replace(SKELETON_JSON, '')
    .toLowerCase();
}

/** Spine's binary varint (always "optimize positive"). */
function readVarint(data: Uint8Array, offset: { pos: number }): number {
  let result = 0;
  for (let shift = 0; shift < 35; shift += 7) {
    const byte = data[offset.pos++];
    if (byte === undefined) throw new Error('truncated');
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return result >>> 0;
  }
  throw new Error('bad varint');
}

function readSpineString(data: Uint8Array, offset: { pos: number }): string | null {
  const byteCount = readVarint(data, offset);
  if (byteCount === 0) return null;
  const length = byteCount - 1;
  if (length > 256 || offset.pos + length > data.length) throw new Error('bad string');
  const text = new TextDecoder().decode(data.subarray(offset.pos, offset.pos + length));
  offset.pos += length;
  return text;
}

/** e.g. 4.1.20, 3.8.99, 4.2.0-beta. Only plain characters, so a misread header can't pass. */
const VERSION_PATTERN = /^\d+\.\d+[\w.-]{0,16}$/;

/** Read the editor version from a binary skeleton's header (4.x and 3.x layouts). */
function binarySkeletonVersion(data: Uint8Array): string | null {
  // 4.x: 64-bit hash, then the version string.
  try {
    const version = readSpineString(data, { pos: 8 });
    if (version && VERSION_PATTERN.test(version)) return version;
  } catch {
    /* try the 3.x layout */
  }
  // 3.x: hash string, then the version string.
  try {
    const offset = { pos: 0 };
    readSpineString(data, offset);
    const version = readSpineString(data, offset);
    if (version && VERSION_PATTERN.test(version)) return version;
  } catch {
    /* not a Spine binary */
  }
  return null;
}

function jsonSkeletonVersion(data: Uint8Array): string | null {
  if (data.length > MAX_SNIFF_JSON_BYTES) return null;
  try {
    const json = JSON.parse(new TextDecoder().decode(data));
    const version = json?.skeleton?.spine;
    return typeof version === 'string' && VERSION_PATTERN.test(version) ? version : null;
  } catch {
    return null;
  }
}

interface SkeletonChoice {
  skeleton: string;
  atlas: string;
  version: string;
  pma: boolean;
}

/**
 * Pick the skeleton to use and the atlas that goes with it. Only skeletons a
 * bundled runtime can play are considered. The atlas is, in order of preference: the
 * one with the same name in the same folder, the same name anywhere, any in
 * the same folder, then any at all.
 */
function findSkeleton(files: Array<{ path: string; data: Uint8Array }>): SkeletonChoice | { error: string } {
  const atlases = files.filter((file) => ATLAS.test(file.path));
  const skeletons: Array<{ path: string; version: string | null }> = [];
  for (const file of files) {
    if (SKELETON_BINARY.test(file.path)) skeletons.push({ path: file.path, version: binarySkeletonVersion(file.data) });
    else if (SKELETON_JSON.test(file.path)) {
      const version = jsonSkeletonVersion(file.data);
      if (version) skeletons.push({ path: file.path, version });
    }
  }
  if (skeletons.length === 0) {
    return { error: 'No Spine skeleton (*.skel or skeleton *.json) found in the archive.' };
  }
  if (atlases.length === 0) return { error: 'No Spine atlas (*.atlas) found in the archive.' };

  const playable = skeletons.filter(
    (skeleton) => skeleton.version !== null && spineRuntimeFor(skeleton.version) !== null,
  );
  if (playable.length === 0) {
    const versioned = skeletons.find((skeleton) => skeleton.version !== null);
    if (!versioned) {
      return { error: `Couldn't read the Spine version of ${skeletons[0]!.path}; is it a Spine skeleton?` };
    }
    return {
      error:
        `${versioned.path} was exported from Spine ${versioned.version}. ` +
        `This extension plays Spine ${SUPPORTED_SPINE_VERSIONS.map((version) => `${version}.x`).join(' and ')} skeletons only.`,
    };
  }

  const depth = (path: string) => path.split('/').length;
  const ranked = playable
    .map((skeleton) => {
      const folder = dirname(skeleton.path);
      const name = stem(skeleton.path);
      const candidates = [
        atlases.find((atlas) => dirname(atlas.path) === folder && stem(atlas.path) === name),
        atlases.find((atlas) => stem(atlas.path) === name),
        atlases.find((atlas) => dirname(atlas.path) === folder),
        atlases[0],
      ];
      const rank = candidates.findIndex((atlas) => atlas !== undefined);
      return { skeleton, atlas: candidates[rank]!, score: rank * 1000 + depth(skeleton.path) };
    })
    .sort((a, b) => a.score - b.score || a.skeleton.path.localeCompare(b.skeleton.path));
  const best = ranked[0]!;

  // Parse the atlas the same way the runtime will, to check its page images are here.
  let atlas: TextureAtlas;
  try {
    atlas = new TextureAtlas(new TextDecoder().decode(best.atlas.data));
  } catch (error) {
    return { error: `Couldn't read the atlas ${best.atlas.path}: ${String(error)}` };
  }
  if (atlas.pages.length === 0) return { error: `The atlas ${best.atlas.path} has no pages.` };
  const atlasDir = dirname(best.atlas.path);
  const lowerPaths = new Set(files.map((file) => file.path.toLowerCase()));
  const missing = atlas.pages
    .map((page) => normalizePath(atlasDir ? `${atlasDir}/${page.name}` : page.name))
    .filter((page) => !lowerPaths.has(page.toLowerCase()));
  if (missing.length > 0) {
    return { error: `The atlas references images that aren't in the archive: ${missing.join(', ')}` };
  }
  return {
    skeleton: best.skeleton.path,
    atlas: best.atlas.path,
    version: best.skeleton.version!,
    pma: atlas.pages.some((page) => page.pma),
  };
}

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 48) || 'model'
  );
}

async function handleImportZip(msg: ImportModelZipMsg, userId: string): Promise<void> {
  const upload = await spindle.uploads.get(msg.uploadId, userId);
  if (!upload) {
    send({ type: 'import_error', error: 'Upload not found or expired. Try again.' }, userId);
    return;
  }
  try {
    let entries: Record<string, Uint8Array>;
    try {
      entries = unzipSync(upload.data);
    } catch {
      send({ type: 'import_error', error: 'Could not read the ZIP archive.' }, userId);
      return;
    }

    const cleaned: Array<{ path: string; data: Uint8Array }> = [];
    for (const [rawPath, data] of Object.entries(entries)) {
      const path = sanitizeZipPath(rawPath);
      if (!path || data.length === 0) continue;
      cleaned.push({ path, data });
    }
    if (cleaned.length === 0) {
      send({ type: 'import_error', error: 'The ZIP archive is empty.' }, userId);
      return;
    }
    if (cleaned.length > MAX_FILE_COUNT) {
      send({ type: 'import_error', error: `Too many files in archive (max ${MAX_FILE_COUNT}).` }, userId);
      return;
    }
    const totalBytes = cleaned.reduce((sum, file) => sum + file.data.length, 0);
    if (totalBytes > MAX_UNPACKED_BYTES) {
      send({ type: 'import_error', error: 'Unpacked model exceeds the 512 MB limit.' }, userId);
      return;
    }

    const strip = stripCommonRoot(cleaned.map((file) => file.path));
    const files = cleaned
      .map((file) => ({ path: strip(file.path), data: file.data }))
      .filter((file) => file.path.length > 0);

    const choice = findSkeleton(files);
    if ('error' in choice) {
      send({ type: 'import_error', error: choice.error }, userId);
      return;
    }

    const registry = await loadRegistry(userId);
    const baseName = msg.name?.trim() || upload.fileName.replace(/\.zip$/i, '') || stem(choice.skeleton);
    let id = slugify(baseName);
    let suffix = 2;
    while (registry.some((model) => model.id === id)) {
      id = `${slugify(baseName)}_${suffix++}`;
    }

    // Clear anything a failed import or delete left behind under this id.
    for (const stale of await spindle.userStorage.list(`${MODELS_DIR}/${id}/`, userId)) {
      await spindle.userStorage.delete(stale, userId).catch(() => {});
    }
    for (const file of files) {
      await spindle.userStorage.writeBinary(`${MODELS_DIR}/${id}/${file.path}`, file.data, userId);
    }

    const record: ModelRecord = {
      id,
      name: baseName,
      skeletonFile: choice.skeleton,
      atlasFile: choice.atlas,
      spineVersion: choice.version,
      pma: choice.pma,
      sizeBytes: totalBytes,
      fileCount: files.length,
      importedAt: new Date().toISOString(),
      // Unique per import, so a model re-imported under a reused id never
      // matches files or descriptions cached for the old one.
      version: Date.now(),
    };
    registry.push(record);
    await saveRegistry(registry, userId);

    spindle.log.info(
      `spine: imported model "${record.name}" (Spine ${record.spineVersion}, ${files.length} files, ${totalBytes} bytes)`,
    );
    send({ type: 'model_imported', model: record }, userId);
    spindle.toast.success(`Spine model "${record.name}" imported.`, userId ? { userId } : undefined);
  } finally {
    await spindle.uploads.delete(msg.uploadId, userId).catch(() => {});
  }
}

async function handleDeleteModel(modelId: string, userId: string): Promise<void> {
  const registry = await loadRegistry(userId);
  const record = registry.find((model) => model.id === modelId);
  if (!record) return;

  const prefix = `${MODELS_DIR}/${modelId}/`;
  for (const key of [...fileCache.keys()]) {
    if (key.startsWith(`${userId}:${prefix}`)) fileCache.delete(key);
  }
  const files = await spindle.userStorage.list(prefix, userId);
  for (const file of files) {
    await spindle.userStorage.delete(file, userId).catch(() => {});
  }
  await saveRegistry(
    registry.filter((model) => model.id !== modelId),
    userId,
  );

  // Drop dangling character bindings and the model's per-character settings
  const settings = await loadSettings(userId);
  let changed = false;
  for (const [characterId, boundModel] of Object.entries(settings.characterModelMapping)) {
    if (boundModel === modelId) {
      delete settings.characterModelMapping[characterId];
      changed = true;
    }
  }
  for (const byModel of Object.values(settings.characterModelsSettings)) {
    if (byModel && modelId in byModel) {
      delete byModel[modelId];
      changed = true;
    }
  }
  if (changed) await saveSettings(settings, userId);

  send({ type: 'model_deleted', modelId }, userId);
}

/** Thumbnails are small webp/png pictures; anything bigger than this isn't one. */
const MAX_THUMBNAIL_CHARS = 512 * 1024;

async function handleSaveThumbnail(msg: SaveThumbnailMsg, userId: string): Promise<void> {
  if (
    typeof msg.dataUrl !== 'string' ||
    msg.dataUrl.length > MAX_THUMBNAIL_CHARS ||
    !/^data:image\/(webp|png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(msg.dataUrl)
  ) {
    return;
  }
  const registry = await loadRegistry(userId);
  const record = registry.find((model) => model.id === msg.modelId);
  if (!record) return;
  record.thumbnail = msg.dataUrl;
  await saveRegistry(registry, userId);
  send({ type: 'model_updated', model: record }, userId);
}

// ── Model file streaming ────────────────────────────────────────────────────

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
}

interface TransferSession {
  prefix: string;
  files: Set<string>;
  lastUsed: number;
}

const TRANSFER_IDLE_MS = 10 * 60 * 1000;
const FILE_CACHE_IDLE_MS = 60 * 1000;
const FILE_CACHE_MAX_ENTRIES = 3;

/** Open transfers, keyed by user + browser-chosen request id. */
const transfers = new Map<string, TransferSession>();
/** Whole files kept briefly so consecutive chunk requests don't re-read them. */
const fileCache = new Map<string, { bytes: Promise<Uint8Array>; lastUsed: number }>();

function sweepTransferState(now: number): void {
  for (const [key, session] of transfers) {
    if (now - session.lastUsed > TRANSFER_IDLE_MS) transfers.delete(key);
  }
  for (const [key, entry] of fileCache) {
    if (now - entry.lastUsed > FILE_CACHE_IDLE_MS) fileCache.delete(key);
  }
}

function readCachedFile(userId: string, path: string): Promise<Uint8Array> {
  const key = `${userId}:${path}`;
  const now = Date.now();
  let entry = fileCache.get(key);
  if (!entry) {
    while (fileCache.size >= FILE_CACHE_MAX_ENTRIES) {
      const oldest = [...fileCache.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
      if (!oldest) break;
      fileCache.delete(oldest[0]);
    }
    const bytes = spindle.userStorage.readBinary(path, userId);
    bytes.catch(() => fileCache.delete(key));
    entry = { bytes, lastUsed: now };
    fileCache.set(key, entry);
  }
  entry.lastUsed = now;
  return entry.bytes;
}

async function handleGetModelManifest(msg: GetModelManifestMsg, userId: string): Promise<void> {
  sweepTransferState(Date.now());
  const registry = await loadRegistry(userId);
  const record = registry.find((model) => model.id === msg.modelId);
  if (!record) {
    send({ type: 'model_files_error', reqId: msg.reqId, error: `Unknown model: ${msg.modelId}` }, userId);
    return;
  }

  const prefix = `${MODELS_DIR}/${record.id}/`;
  const listed = await spindle.userStorage.list(prefix, userId);
  const relative = listed
    .map((path) => (path.startsWith(prefix) ? path.slice(prefix.length) : path))
    .filter((path) => path.length > 0);

  const files: Array<{ path: string; size: number }> = [];
  for (const path of relative) {
    const stat = await spindle.userStorage.stat(prefix + path, userId);
    if (stat.isFile) files.push({ path, size: stat.sizeBytes });
  }

  transfers.set(`${userId}:${msg.reqId}`, {
    prefix,
    files: new Set(files.map((file) => file.path)),
    lastUsed: Date.now(),
  });

  send(
    {
      type: 'model_manifest',
      reqId: msg.reqId,
      modelId: record.id,
      version: record.version,
      skeletonFile: record.skeletonFile,
      atlasFile: record.atlasFile,
      chunkBytes: CHUNK_BYTES,
      files,
    },
    userId,
  );
}

async function handleGetModelChunk(msg: GetModelChunkMsg, userId: string): Promise<void> {
  const session = transfers.get(`${userId}:${msg.reqId}`);
  if (!session || !session.files.has(msg.path)) {
    send({ type: 'model_files_error', reqId: msg.reqId, error: 'Transfer expired or unknown file; reload the model.' }, userId);
    return;
  }
  session.lastUsed = Date.now();
  const bytes = await readCachedFile(userId, session.prefix + msg.path);
  const seq = Math.max(0, Math.floor(msg.seq));
  const slice = bytes.subarray(seq * CHUNK_BYTES, Math.min((seq + 1) * CHUNK_BYTES, bytes.length));
  send({ type: 'model_chunk', reqId: msg.reqId, path: msg.path, seq, dataB64: toBase64(slice) }, userId);
}

// ── Emotion classification ──────────────────────────────────────────────────

function trimToEndSentence(text: string): string {
  const punctuation = new Set(['.', '!', '?', '*', '"', ')', '}', '`', ']', '$', '\n']);
  for (let i = text.length - 1; i >= 0; i--) {
    const char = text[i]!;
    if (punctuation.has(char)) {
      return text.substring(0, i + 1).trimEnd();
    }
  }
  return text.trimEnd();
}

function trimToStartSentence(text: string): string {
  const punctuation = new Set(['.', '!', '?', '*', '"', ')', '}', '`', ']', '$', '\n']);
  for (let i = 0; i < text.length; i++) {
    if (punctuation.has(text[i]!)) {
      return text.substring(i + 1).trimStart();
    }
  }
  return text;
}

/** Same sampling as the SillyTavern extension: strip markup, keep ends of long messages. */
function sampleClassifyText(text: string): string {
  let result = text.replace(/[\*\"]/g, '');
  const SAMPLE_THRESHOLD = 300;
  const HALF = SAMPLE_THRESHOLD / 2;
  if (text.length < SAMPLE_THRESHOLD) {
    result = trimToEndSentence(result);
  } else {
    result = trimToEndSentence(result.slice(0, HALF)) + ' ' + trimToStartSentence(result.slice(-HALF));
  }
  return result.trim();
}

/**
 * The dominant emotion of a message, or an error when it can't be classified.
 * Emotions are auto-mapped to animations here, so no fallback label is
 * returned: a guess would play an animation on every message.
 */
async function classifyExpression(text: string): Promise<{ label: string } | { error: string }> {
  if (!text.trim()) return { error: 'Nothing to classify.' };
  if (!spindle.permissions.has('generation')) return { error: 'Needs the "generation" permission.' };
  const labels = CLASSIFY_EXPRESSIONS.join(', ');
  try {
    const result = (await spindle.generate.quiet({
      type: 'quiet',
      messages: [
        {
          role: 'system',
          content:
            'You classify the dominant emotion of a roleplay message. ' +
            `Respond with exactly one word from this list and nothing else: ${labels}.`,
        },
        { role: 'user', content: sampleClassifyText(text) },
      ],
      parameters: { max_tokens: 16, temperature: 0 },
    })) as { content?: string } | null;
    const response = (result?.content ?? '').toLowerCase();
    // Prefer an exact word match; fall back to the first label mentioned anywhere.
    const words = response.split(/[^a-z]+/).filter(Boolean);
    for (const word of words) {
      if ((CLASSIFY_EXPRESSIONS as readonly string[]).includes(word)) return { label: word };
    }
    for (const label of CLASSIFY_EXPRESSIONS) {
      if (response.includes(label)) return { label };
    }
    return { error: `The model answered "${response.trim().slice(0, 40)}", which isn't an emotion label.` };
  } catch (error) {
    spindle.log.warn(`spine: classification failed: ${String(error)}`);
    return { error: `Classification failed: ${String(error)}` };
  }
}

// ── Chat lifecycle ──────────────────────────────────────────────────────────

interface ChatCast {
  /** The chat's own character (a group chat's first member). */
  characterId: string | null;
  /** Everyone in the chat, in member order. */
  characterIds: string[];
}

/** Group chats list their members in `metadata.character_ids`. */
function castFromChat(chat: { character_id?: string | null; metadata?: Record<string, unknown> | null }): ChatCast {
  const metadata = chat.metadata ?? {};
  const members =
    metadata.group === true && Array.isArray(metadata.character_ids)
      ? metadata.character_ids.filter((id): id is string => typeof id === 'string' && id.length > 0)
      : [];
  const characterId = chat.character_id ?? members[0] ?? null;
  return { characterId, characterIds: members.length > 0 ? [...new Set(members)] : characterId ? [characterId] : [] };
}

async function resolveChatCast(chatId: string, userId?: string): Promise<ChatCast | null> {
  if (!spindle.permissions.has('chats')) return null;
  try {
    const chat = await spindle.chats.get(chatId, userId);
    return chat ? castFromChat(chat) : null;
  } catch {
    return null;
  }
}

async function sendChatContext(chatId: string | null, userId?: string): Promise<void> {
  const cast = chatId ? await resolveChatCast(chatId, userId) : null;
  send(
    { type: 'chat_context', chatId, characterId: cast?.characterId ?? null, characterIds: cast?.characterIds ?? null },
    userId,
  );
}

/**
 * A character's message arrived: make that character's model talk and, with
 * LLM emotion detection, play the matching animation. In a group chat the
 * message says which member wrote it.
 */
async function handleCharacterMessage(
  chatId: string,
  message: { id: string; content?: string; extra?: Record<string, unknown> | null },
  userId?: string,
): Promise<void> {
  const settings = await loadSettings(userId);
  if (!settings.global.enabled) return;

  // Replies carry their author as `character_id`; greetings as `greeting_character_id`.
  const author = [message.extra?.character_id, message.extra?.greeting_character_id].find(
    (id): id is string => typeof id === 'string' && id.length > 0,
  );
  const characterId = author ?? (await resolveChatCast(chatId, userId))?.characterId ?? null;
  const text = message.content ?? '';

  send({ type: 'character_message', chatId, characterId, messageId: message.id, textLength: text.length }, userId);

  if (settings.global.expressionSource !== 'llm') return;
  if (!text) return;

  const result = await classifyExpression(text);
  if (!('label' in result)) return;
  send({ type: 'expression', chatId, characterId, label: result.label, source: 'llm' }, userId);
}

async function handleInteraction(msg: InteractionMsg, userId?: string): Promise<void> {
  if (!spindle.permissions.has('chat_mutation')) {
    spindle.toast.warning(
      'Grant the "Chat mutation" permission to send Spine interaction messages.',
      userId ? { userId } : undefined,
    );
    return;
  }
  try {
    await spindle.chat.appendMessage(
      msg.chatId,
      { role: 'user', content: msg.message },
      msg.generate
        ? {
            triggerGeneration: true,
            // Lumiverse only uses the target in group chats, to pick who replies.
            ...(msg.characterId ? { generation: { target_character_id: msg.characterId } } : {}),
          }
        : undefined,
    );
  } catch (error) {
    spindle.log.warn(`spine: interaction failed: ${String(error)}`);
    spindle.toast.error(`Spine interaction failed: ${String(error)}`, userId ? { userId } : undefined);
  }
}

// ── State snapshot ──────────────────────────────────────────────────────────

async function sendState(userId: string): Promise<void> {
  const settings = await loadSettings(userId);
  const models = await loadRegistry(userId);

  let characters: Array<{ id: string; name: string }> = [];
  if (spindle.permissions.has('characters')) {
    try {
      const { data } = await spindle.characters.list({ limit: 200, userId });
      characters = data.map((character) => ({ id: character.id, name: character.name }));
    } catch {
      characters = [];
    }
  }

  const permissions = await spindle.permissions.getGranted();
  send({ type: 'state', settings, models, characters, permissions }, userId);
}

// ── Message router ──────────────────────────────────────────────────────────

spindle.onFrontendMessage(async (payload, userId) => {
  const msg = payload as FrontendToBackend;
  try {
    switch (msg.type) {
      case 'get_state':
        await sendState(userId);
        break;
      case 'save_settings':
        await saveSettings(normalizeSettings((msg as SaveSettingsMsg).settings), userId);
        send({ type: 'settings_saved' }, userId);
        break;
      case 'import_model_zip':
        await handleImportZip(msg, userId);
        break;
      case 'delete_model':
        await handleDeleteModel(msg.modelId, userId);
        break;
      case 'save_thumbnail':
        await handleSaveThumbnail(msg, userId);
        break;
      case 'get_model_manifest':
        await handleGetModelManifest(msg, userId);
        break;
      case 'get_model_chunk':
        await handleGetModelChunk(msg, userId);
        break;
      case 'interaction':
        await handleInteraction(msg, userId);
        break;
      case 'get_chat_context':
        await sendChatContext(msg.chatId, userId);
        break;
      case 'classify_test': {
        const result = await classifyExpression(msg.text);
        send(
          'label' in result
            ? { type: 'classify_test_result', label: result.label }
            : { type: 'classify_test_result', label: '', error: result.error },
          userId,
        );
        break;
      }
    }
  } catch (error) {
    spindle.log.error(`spine: error handling ${msg?.type ?? 'message'}: ${String(error)}`);
    if (msg?.type === 'import_model_zip') {
      send({ type: 'import_error', error: String(error) }, userId);
    } else if (msg?.type === 'get_model_manifest' || msg?.type === 'get_model_chunk') {
      send({ type: 'model_files_error', reqId: msg.reqId, error: String(error) }, userId);
    }
  }
});

// ── Event subscriptions ─────────────────────────────────────────────────────

// Lumiverse creates a reply's message once it has finished streaming, and a
// regenerated reply as a new swipe. (The documented CHARACTER_MESSAGE_RENDERED
// event is never emitted by the host.)
spindle.on('MESSAGE_SENT', (payload, userId) => {
  const event = payload as { chatId?: string; message?: ChatMessageDTO };
  if (!event?.chatId || !event.message || event.message.is_user) return;
  void handleCharacterMessage(event.chatId, event.message, userId);
});

spindle.on('MESSAGE_SWIPED', (payload, userId) => {
  const event = payload as { chatId?: string; message?: ChatMessageDTO; action?: string };
  if (!event?.chatId || !event.message || event.message.is_user || event.action !== 'added') return;
  void handleCharacterMessage(event.chatId, event.message, userId);
});

// Reuse Lumiverse's native expression detection when the user prefers it.
spindle.on('EXPRESSION_CHANGED', (payload, userId) => {
  const event = payload as { chatId: string; characterId: string; label: string };
  if (!event?.chatId || !event?.label) return;
  void (async () => {
    const settings = await loadSettings(userId);
    if (!settings.global.enabled || settings.global.expressionSource !== 'native') return;
    send(
      {
        type: 'expression',
        chatId: event.chatId,
        characterId: event.characterId ?? null,
        label: event.label,
        source: 'native',
      },
      userId,
    );
  })();
});

spindle.on('CHAT_SWITCHED', (payload, userId) => {
  const event = payload as { chatId: string | null };
  void sendChatContext(event?.chatId ?? null, userId);
});

// Members joining or leaving a group chat change its metadata.
spindle.on('CHAT_CHANGED', (payload, userId) => {
  const event = payload as {
    chatId?: string;
    chat?: { id?: string; character_id?: string; metadata?: Record<string, unknown> };
    changedFields?: string[];
  };
  const chatId = event?.chat?.id ?? event?.chatId;
  if (!chatId) return;
  const fields = event.changedFields;
  if (fields && !fields.some((field) => /^metadata(\.(group|character_ids)\b|$)/.test(field))) return;
  void (async () => {
    const cast = event.chat?.metadata ? castFromChat(event.chat) : await resolveChatCast(chatId, userId);
    if (cast) send({ type: 'chat_members', chatId, characterIds: cast.characterIds }, userId);
  })();
});

spindle.permissions.onChanged(({ allGranted }) => {
  send({ type: 'permissions_changed', permissions: allGranted });
});

// ── Command palette ─────────────────────────────────────────────────────────

spindle.commands.register([
  {
    id: 'spine-open-settings',
    label: 'Spine: Open Settings',
    description: 'Open the Spine Avatars settings tab',
    keywords: ['spine', 'avatar', 'model', 'settings'],
  },
  {
    id: 'spine-reload',
    label: 'Spine: Reload Models',
    description: 'Reload the Spine model on the stage',
    keywords: ['spine', 'reload', 'reset'],
  },
  {
    id: 'spine-toggle',
    label: 'Spine: Toggle Enabled',
    description: 'Enable or disable the Spine avatar stage',
    keywords: ['spine', 'toggle', 'enable', 'disable'],
  },
]);

spindle.commands.onInvoked((commandId) => {
  void (async () => {
    switch (commandId) {
      case 'spine-open-settings':
        send({ type: 'focus_tab' });
        break;
      case 'spine-reload':
        send({ type: 'reload_models' });
        break;
      case 'spine-toggle': {
        const settings = await loadSettings();
        settings.global.enabled = !settings.global.enabled;
        await saveSettings(settings);
        send({ type: 'toggle_enabled', enabled: settings.global.enabled });
        spindle.toast.info(`Spine ${settings.global.enabled ? 'enabled' : 'disabled'}.`);
        break;
      }
    }
  })();
});

spindle.log.info('spine: backend ready');
