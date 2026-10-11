/**
 * Shared settings schema. Follows the Live2D Avatars extension's layout
 * (characterModelMapping / characterModelsSettings) so the two extensions
 * behave and feel the same.
 */

export const CLASSIFY_EXPRESSIONS = [
  'admiration',
  'amusement',
  'anger',
  'annoyance',
  'approval',
  'caring',
  'confusion',
  'curiosity',
  'desire',
  'disappointment',
  'disapproval',
  'disgust',
  'embarrassment',
  'excitement',
  'fear',
  'gratitude',
  'grief',
  'joy',
  'love',
  'nervousness',
  'optimism',
  'pride',
  'realization',
  'relief',
  'remorse',
  'sadness',
  'surprise',
  'neutral',
] as const;

/** The Spine editor version (major.minor) the bundled runtime reads. */
export const SUPPORTED_SPINE_VERSION = '4.1';

/**
 * Animation names commonly used for each emotion. On a model's first load,
 * any emotion whose candidates match one of the model's animations (by name,
 * case-insensitive) is mapped to it automatically.
 */
export const EMOTION_ANIMATION_HINTS: Record<string, string[]> = {
  admiration: ['admiration', 'delight', 'happy', 'joy', 'smile'],
  amusement: ['amusement', 'laugh', 'delight', 'happy', 'smile'],
  anger: ['anger', 'angry', 'mad'],
  annoyance: ['annoyance', 'annoyed', 'angry'],
  approval: ['approval', 'nod', 'delight', 'happy'],
  caring: ['caring', 'shy', 'smile'],
  confusion: ['confusion', 'confused', 'worry', 'worry_02'],
  curiosity: ['curiosity', 'curious', 'surprise'],
  desire: ['desire', 'shy'],
  disappointment: ['disappointment', 'disappointed', 'sad'],
  disapproval: ['disapproval', 'angry'],
  disgust: ['disgust', 'disgusted', 'angry'],
  embarrassment: ['embarrassment', 'embarrassed', 'shy', 'blush'],
  excitement: ['excitement', 'excited', 'special', 'delight', 'happy'],
  fear: ['fear', 'scared', 'afraid', 'worry'],
  gratitude: ['gratitude', 'thanks', 'delight', 'happy'],
  grief: ['grief', 'cry', 'sad'],
  joy: ['joy', 'happy', 'delight', 'smile'],
  love: ['love', 'shy', 'delight'],
  nervousness: ['nervousness', 'nervous', 'worry', 'worry_02'],
  optimism: ['optimism', 'delight', 'happy'],
  pride: ['pride', 'proud', 'special', 'delight'],
  realization: ['realization', 'surprise'],
  relief: ['relief', 'relieved', 'delight'],
  remorse: ['remorse', 'sad', 'worry'],
  sadness: ['sadness', 'sad', 'cry'],
  surprise: ['surprise', 'surprised', 'shock'],
  neutral: [],
};

export const IDLE_ANIMATION_HINTS = ['idle', 'idle_0', 'idle_1', 'idle01', 'stand', 'wait', 'loop', 'animation'];
export const TALK_ANIMATION_HINTS = ['talk', 'talk_start', 'speak', 'talking', 'mouth'];

export interface StarterAnimation {
  animation: string; // 'none' or an animation name
  delay: number; // ms before playing on chat load
}

export interface ClickAnimation {
  animation: string; // 'none' or an animation name
  message: string; // user message to send on click ('' = none)
}

export interface ModelSettings {
  /** Resolution the model is drawn at, relative to the screen's pixel density (1 = native). */
  renderScale: number;
  /** Model size; 1 = the model's bounds fit the stage at 0° rotation. */
  zoom: number;
  rotation: number; // degrees clockwise, -180..180
  /** Animation playback speed multiplier (0 = paused). */
  speed: number;
  /** Treat texture colors as premultiplied by alpha. Defaults to the atlas's `pma` flag. */
  premultipliedAlpha: boolean;
  x: number; // percent offset of the model's center from the stage center, -100..100
  y: number;
  skin: string; // skin name, '' = the skeleton's default skin
  /** Looping animation played when nothing else is. */
  animation_idle: string;
  animation_starter: StarterAnimation;
  animation_click: ClickAnimation;
  /** Animation layered on top (track 1) while the character "speaks". */
  animation_talk: string;
  talk_time_per_character: number; // ms
  /** classify label -> animation name or 'none' */
  classify_mapping: Record<string, string>;
}

export interface GlobalSettings {
  enabled: boolean;
  autoSendInteraction: boolean;
  /** Draw the model behind the chat instead of over it. */
  backgroundMode: boolean;
  /** Draw each slot's bounds and the skeleton's bones over the model. */
  showBounds: boolean;
  /**
   * How emotions are detected on new character messages:
   * - 'llm'    — classify the message with a quiet LLM generation (needs `generation`)
   * - 'native' — reuse Lumiverse's own expression detection (EXPRESSION_CHANGED)
   * - 'off'    — no automatic animation on messages
   */
  expressionSource: 'llm' | 'native' | 'off';
  /** Model library order and layout in the settings tab. */
  librarySort: LibrarySort;
  libraryView: LibraryView;
}

export type LibrarySort = 'name' | 'name_desc' | 'newest' | 'oldest' | 'largest' | 'smallest';
export type LibraryView = 'tiles' | 'list';

export interface SpineSettings {
  global: GlobalSettings;
  /** characterId -> modelId */
  characterModelMapping: Record<string, string>;
  /** characterId -> modelId -> per-model settings */
  characterModelsSettings: Record<string, Record<string, ModelSettings>>;
}

export interface ModelRecord {
  id: string;
  name: string;
  /** Path of the skeleton file (.skel or .json) inside the model folder */
  skeletonFile: string;
  /** Path of the atlas file inside the model folder */
  atlasFile: string;
  /** Spine editor version the skeleton was exported with, e.g. "4.1.20" */
  spineVersion: string;
  /** The atlas's `pma` flag: textures are stored premultiplied by alpha */
  pma: boolean;
  sizeBytes: number;
  fileCount: number;
  importedAt: string;
  /** bumped when files change; used for frontend cache invalidation */
  version: number;
  /** Small picture of the model for the library (an image data URL), taken the first time it's shown. */
  thumbnail?: string;
}

/** What the settings UI needs to know about a model's skeleton. */
export interface ModelDescription {
  animations: Array<{ name: string; duration: number }>;
  skins: string[];
  pma: boolean;
}

export const SETTINGS_LIMITS = {
  renderScale: { min: 0.25, max: 2, step: 0.05 },
  zoom: { min: 0.05, max: 5, step: 0.01 },
  rotation: { min: -180, max: 180, step: 1 },
  speed: { min: 0, max: 3, step: 0.05 },
  offset: { min: -100, max: 100, step: 1 },
} as const;

export function defaultGlobalSettings(): GlobalSettings {
  return {
    enabled: true,
    autoSendInteraction: false,
    backgroundMode: false,
    showBounds: false,
    expressionSource: 'llm',
    librarySort: 'name',
    libraryView: 'tiles',
  };
}

export function defaultSettings(): SpineSettings {
  return {
    global: defaultGlobalSettings(),
    characterModelMapping: {},
    characterModelsSettings: {},
  };
}

function findAnimation(names: string[], hints: string[]): string | null {
  const byLower = new Map(names.map((name) => [name.toLowerCase(), name]));
  for (const hint of hints) {
    const found = byLower.get(hint);
    if (found) return found;
  }
  return null;
}

export function defaultModelSettings(description: ModelDescription | null = null): ModelSettings {
  const names = description?.animations.map((animation) => animation.name) ?? [];
  const settings: ModelSettings = {
    renderScale: 1,
    zoom: 1,
    rotation: 0,
    speed: 1,
    premultipliedAlpha: description?.pma ?? true,
    x: 0,
    y: 0,
    skin: '',
    animation_idle: findAnimation(names, IDLE_ANIMATION_HINTS) ?? names[0] ?? 'none',
    animation_starter: { animation: 'none', delay: 0 },
    animation_click: { animation: 'none', message: '' },
    animation_talk: findAnimation(names, TALK_ANIMATION_HINTS) ?? 'none',
    talk_time_per_character: 30,
    classify_mapping: {},
  };
  for (const label of CLASSIFY_EXPRESSIONS) {
    settings.classify_mapping[label] = findAnimation(names, EMOTION_ANIMATION_HINTS[label] ?? []) ?? 'none';
  }
  return settings;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Merge a possibly partial/stale stored settings object over defaults, dropping
 * malformed entries and filling in every per-model field.
 */
export function normalizeSettings(raw: unknown): SpineSettings {
  const base = defaultSettings();
  if (!isPlainObject(raw)) return base;
  const value = raw as Partial<SpineSettings>;
  if (isPlainObject(value.global)) {
    base.global = { ...base.global, ...value.global };
  }
  if (isPlainObject(value.characterModelMapping)) {
    for (const [characterId, modelId] of Object.entries(value.characterModelMapping)) {
      if (typeof modelId === 'string') base.characterModelMapping[characterId] = modelId;
    }
  }
  if (isPlainObject(value.characterModelsSettings)) {
    for (const [characterId, byModel] of Object.entries(value.characterModelsSettings)) {
      if (!isPlainObject(byModel)) continue;
      const kept: Record<string, ModelSettings> = {};
      for (const [modelId, modelSettings] of Object.entries(byModel)) {
        if (isPlainObject(modelSettings)) kept[modelId] = ensureModelSettingsShape(modelSettings as unknown as ModelSettings);
      }
      base.characterModelsSettings[characterId] = kept;
    }
  }
  return base;
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

/**
 * Ensure a stored per-model settings object has every field (and sane numbers),
 * mutating it in place so live references held by the UI and the stage stay valid.
 */
export function ensureModelSettingsShape(
  settings: ModelSettings,
  description: ModelDescription | null = null,
): ModelSettings {
  const base = defaultModelSettings(description);
  const target = settings as unknown as Record<string, unknown>;
  // Missing fields, and fields of the wrong type, take the default.
  for (const [key, value] of Object.entries(base) as Array<[string, unknown]>) {
    const current = target[key];
    if (current === undefined || current === null || typeof current !== typeof value) target[key] = value;
  }
  for (const nested of ['animation_starter', 'animation_click', 'classify_mapping'] as const) {
    if (!isPlainObject(settings[nested])) target[nested] = base[nested];
    const baseNested = base[nested] as unknown as Record<string, unknown>;
    const targetNested = settings[nested] as unknown as Record<string, unknown>;
    for (const [key, value] of Object.entries(baseNested)) {
      if (targetNested[key] === undefined || typeof targetNested[key] !== typeof value) targetNested[key] = value;
    }
  }
  const limits = SETTINGS_LIMITS;
  settings.renderScale = clampNumber(settings.renderScale, limits.renderScale.min, limits.renderScale.max, 1);
  settings.zoom = clampNumber(settings.zoom, limits.zoom.min, limits.zoom.max, 1);
  settings.rotation = clampNumber(settings.rotation, limits.rotation.min, limits.rotation.max, 0);
  settings.speed = clampNumber(settings.speed, limits.speed.min, limits.speed.max, 1);
  settings.x = clampNumber(settings.x, limits.offset.min, limits.offset.max, 0);
  settings.y = clampNumber(settings.y, limits.offset.min, limits.offset.max, 0);
  settings.talk_time_per_character = clampNumber(settings.talk_time_per_character, 0, 1000, 30);
  settings.animation_starter.delay = clampNumber(settings.animation_starter.delay, 0, 60_000, 0);
  return settings;
}

/**
 * Per-model settings from an untrusted source (an imported file): only the
 * known fields, with wrong types replaced by defaults and numbers clamped.
 */
export function sanitizeModelSettings(raw: unknown, description: ModelDescription | null = null): ModelSettings {
  const base = defaultModelSettings(description) as unknown as Record<string, unknown>;
  const source = isPlainObject(raw) ? raw : {};
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(base)) {
    if (source[key] !== undefined) out[key] = structuredClone(source[key]);
  }
  for (const nested of ['animation_starter', 'animation_click', 'classify_mapping'] as const) {
    if (!isPlainObject(out[nested])) continue;
    const known = base[nested] as Record<string, unknown>;
    out[nested] = Object.fromEntries(Object.entries(out[nested]).filter(([key]) => key in known));
  }
  return ensureModelSettingsShape(out as unknown as ModelSettings, description);
}
