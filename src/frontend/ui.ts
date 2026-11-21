/**
 * Settings UI rendered into the extension's drawer tab. Same layout as the
 * Live2D Avatars extension: global toggles, model library, character↔model
 * binding, then the bound model's view controls, animations and emotion
 * mappings.
 */

import type { SpindleSelectHandle, SpindleSelectOptionLeading, SpindleSelectOptions } from 'lumiverse-spindle-types';
import type { Stage } from './stage';
import {
  CLASSIFY_EXPRESSIONS,
  SETTINGS_LIMITS,
  SUPPORTED_SPINE_VERSIONS,
  defaultModelSettings,
  type LibrarySort,
  type LibraryView,
  type ModelDescription,
  type ModelRecord,
  type ModelSettings,
  type SpineSettings,
} from '../shared/settings';

export interface UIController {
  getSettings(): SpineSettings;
  getModels(): ModelRecord[];
  getCharacters(): Array<{ id: string; name: string }>;
  getPermissions(): string[];
  getActiveCharacterId(): string | null;
  stage: Stage;
  saveDebounced(): void;
  saveNow(): void;
  reloadStage(): void;
  /** Show or hide the reload button in the chat's menu bar to match the settings. */
  syncChatBarButton(): void;
  importZip(status: (text: string) => void): Promise<void>;
  deleteModel(modelId: string): Promise<void>;
  classifyTest(text: string): Promise<string>;
  describeModel(modelId: string): Promise<ModelDescription>;
  /** Bytes received so far while a model's files are being downloaded from the backend. */
  getDownloadProgress(modelId: string): { receivedBytes: number; totalBytes: number } | null;
  getOrCreateModelSettings(characterId: string, modelId: string, description: ModelDescription | null): ModelSettings;
  requestPermissions(perms: string[]): Promise<void>;
  /** Host element used when the stage runs embedded in the tab (no overlay permission). */
  embeddedHost: HTMLElement;
  usingOverlay(): boolean;
  /** Re-apply the chat-background stacking after the setting changes. */
  applyBackgroundMode(): void;
  /** Mount Lumiverse's own searchable dropdown; undefined when the host doesn't offer it. */
  mountSelect?(target: HTMLElement, options: SpindleSelectOptions): SpindleSelectHandle;
  /** Save a character's settings for its model to a file. */
  exportModelSettings(characterId: string, characterName: string): void;
  /** Load a settings file onto a character; resolves to a status line ('' when cancelled). */
  importModelSettings(characterId: string, characterName: string): Promise<string>;
  /** Retake the library thumbnail of a character's model on stage; false when it isn't shown. */
  updateThumbnail(characterId: string, modelId: string): boolean;
  /** Ask before something that can't be undone; resolves to whether the user agreed. */
  confirm(options: { title: string; message: string; confirmLabel: string }): Promise<boolean>;
}

const REQUIRED_PERMS: Array<{ id: string; why: string }> = [
  { id: 'app_manipulation', why: 'show the avatar over the app (otherwise it renders inside this tab)' },
  { id: 'generation', why: 'classify message emotions with the LLM' },
  { id: 'chat_mutation', why: 'send click interaction messages' },
  { id: 'chats', why: 'know which characters are in the active chat (needed for group chats)' },
  { id: 'characters', why: 'list your characters by name when assigning models' },
];

// ── tiny DOM helpers ────────────────────────────────────────────────────────

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label: string, onClick: () => void): HTMLButtonElement {
  const node = el('button', 'spn-btn', label);
  node.type = 'button';
  node.addEventListener('click', onClick);
  return node;
}

/** A small square button (▶, ✕, ↺) that names its action for screen readers and on hover. */
function iconButton(icon: string, label: string, onClick: () => void): HTMLButtonElement {
  const node = button(icon, onClick);
  node.classList.add('spn-icon-btn');
  node.title = label;
  node.setAttribute('aria-label', label);
  return node;
}

/** A checkbox, with an optional line under its label that says what it does. */
function checkbox(
  label: string,
  checked: boolean,
  onChange: (value: boolean) => void,
  hint?: string,
): HTMLLabelElement {
  const wrap = el('label', 'spn-check');
  const input = el('input');
  input.type = 'checkbox';
  input.checked = checked;
  input.addEventListener('change', () => onChange(input.checked));
  wrap.appendChild(input);
  const text = el('span', 'spn-check-text');
  text.appendChild(el('span', undefined, label));
  if (hint) text.appendChild(el('span', 'spn-hint', hint));
  wrap.appendChild(text);
  return wrap;
}

function select(
  options: Array<{ value: string; label: string }>,
  value: string,
  onChange: (value: string) => void,
): HTMLSelectElement {
  const node = el('select', 'spn-select');
  for (const option of options) {
    const opt = el('option', undefined, option.label);
    opt.value = option.value;
    node.appendChild(opt);
  }
  node.value = value;
  if (node.value !== value) node.selectedIndex = 0;
  node.addEventListener('change', () => onChange(node.value));
  return node;
}

interface SliderOptions {
  min: number;
  max: number;
  step: number;
  /** Shown after the value: '%', '°', '×', 'ms'. */
  unit?: string;
  /** The default value; a reset button shows whenever the value differs from it. */
  reset?: number;
}

/**
 * A labelled slider whose value can also be typed in, with a reset button
 * once it's moved off its default. The range input carries the label as its
 * aria-label.
 */
function slider(
  label: string,
  options: SliderOptions,
  value: number,
  onInput: (value: number) => void,
): HTMLDivElement & { setValue(value: number): void } {
  const decimals = (String(options.step).split('.')[1] ?? '').length;
  const clamp = (next: number) =>
    Number(Math.min(options.max, Math.max(options.min, next)).toFixed(decimals));
  const range = el('input', 'spn-range');
  range.type = 'range';
  range.min = String(options.min);
  range.max = String(options.max);
  range.step = String(options.step);
  range.setAttribute('aria-label', label);
  const number = el('input', 'spn-number');
  number.type = 'number';
  number.min = String(options.min);
  number.max = String(options.max);
  number.step = String(options.step);
  number.setAttribute('aria-label', `${label} value`);
  const reset =
    options.reset === undefined
      ? null
      : iconButton('↺', `Reset to ${options.reset}${options.unit ?? ''}`, () => {
          show(options.reset!);
          onInput(options.reset!);
        });
  const show = (next: number) => {
    range.value = String(next);
    number.value = next.toFixed(decimals);
    const fill = ((next - options.min) / (options.max - options.min)) * 100;
    range.style.setProperty('--spn-fill', `${Math.min(100, Math.max(0, fill))}%`);
    if (reset) reset.hidden = next === options.reset;
  };
  range.addEventListener('input', () => {
    const next = clamp(Number(range.value));
    show(next);
    onInput(next);
  });
  number.addEventListener('change', () => {
    const typed = Number(number.value);
    const next = number.value.trim() === '' || !Number.isFinite(typed) ? Number(range.value) : clamp(typed);
    show(next);
    onInput(next);
  });
  const head = el('div', 'spn-slider-head');
  head.appendChild(el('span', 'spn-slider-label', label));
  const valueBox = el('span', 'spn-slider-value');
  valueBox.appendChild(number);
  if (options.unit) valueBox.appendChild(el('span', 'spn-unit', options.unit));
  if (reset) valueBox.appendChild(reset);
  head.appendChild(valueBox);
  const wrap = Object.assign(el('div', 'spn-slider'), {
    /** Show a value set from code, without calling onInput. */
    setValue(next: number) {
      show(next);
    },
  });
  wrap.append(head, range);
  show(value);
  return wrap;
}

// Which sections are open is remembered in this browser, by title, so a
// re-render (or a reload) doesn't open everything again.
const SECTION_STATE_KEY = 'spine-avatars:open-sections';

function loadSectionState(): Record<string, boolean> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(SECTION_STATE_KEY) ?? '{}');
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

const sectionState = loadSectionState();

/** A collapsible section, open unless `open: false`; the user's choice is remembered. */
function section(
  title: string,
  children: (HTMLElement | null)[] = [],
  options: { open?: boolean; className?: string } = {},
): HTMLDetailsElement {
  const wrap = el('details', 'spn-section');
  if (options.className) wrap.classList.add(options.className);
  const defaultOpen = options.open ?? true;
  wrap.open = sectionState[title] ?? defaultOpen;
  wrap.addEventListener('toggle', () => {
    if (wrap.open === (sectionState[title] ?? defaultOpen)) return;
    sectionState[title] = wrap.open;
    try {
      localStorage.setItem(SECTION_STATE_KEY, JSON.stringify(sectionState));
    } catch {
      /* storage unavailable: it's only remembered until the tab reloads */
    }
  });
  wrap.appendChild(el('summary', 'spn-section-title', title));
  for (const child of children) if (child) wrap.appendChild(child);
  return wrap;
}

/** A row of buttons and status text. */
function row(...children: (HTMLElement | string)[]): HTMLDivElement {
  const wrap = el('div', 'spn-row');
  for (const child of children) {
    wrap.appendChild(typeof child === 'string' ? el('span', 'spn-label', child) : child);
  }
  return wrap;
}

/** A label and its control(s), lined up with the other fields; selects and inputs fill the space. */
function field(label: string, ...controls: HTMLElement[]): HTMLDivElement {
  const wrap = el('div', 'spn-field');
  wrap.appendChild(el('span', 'spn-label', label));
  const box = el('div', 'spn-field-control');
  for (const control of controls) {
    if ((control instanceof HTMLSelectElement || control instanceof HTMLInputElement) && !control.hasAttribute('aria-label')) {
      control.setAttribute('aria-label', label);
    }
    box.appendChild(control);
  }
  wrap.appendChild(box);
  return wrap;
}

function note(text: string): HTMLParagraphElement {
  return el('p', 'spn-note', text);
}

/** An explanation that the Show help text setting hides. */
function help(text: string): HTMLParagraphElement {
  return el('p', 'spn-note spn-help', text);
}


// ── model library helpers ───────────────────────────────────────────────────

const SORT_OPTIONS: Array<{ value: LibrarySort; label: string }> = [
  { value: 'name', label: 'Name (A–Z)' },
  { value: 'name_desc', label: 'Name (Z–A)' },
  { value: 'newest', label: 'Newest first' },
  { value: 'oldest', label: 'Oldest first' },
  { value: 'largest', label: 'Largest first' },
  { value: 'smallest', label: 'Smallest first' },
];

/** Dropdowns show their search field once they have more options than this. */
const SEARCH_THRESHOLD = 6;

const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function sortModels(models: ModelRecord[], sort: LibrarySort): ModelRecord[] {
  const time = (model: ModelRecord) => Date.parse(model.importedAt) || 0;
  const compare: Record<LibrarySort, (a: ModelRecord, b: ModelRecord) => number> = {
    name: (a, b) => byName.compare(a.name, b.name),
    name_desc: (a, b) => byName.compare(b.name, a.name),
    newest: (a, b) => time(b) - time(a),
    oldest: (a, b) => time(a) - time(b),
    largest: (a, b) => b.sizeBytes - a.sizeBytes,
    smallest: (a, b) => a.sizeBytes - b.sizeBytes,
  };
  const order = compare[sort] ?? compare.name;
  return [...models].sort((a, b) => order(a, b) || byName.compare(a.name, b.name));
}

function libraryView(view: LibraryView | undefined): LibraryView {
  return view === 'list' ? 'list' : 'tiles';
}

function megabytes(model: ModelRecord): string {
  return `${(model.sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}

function modelSummary(model: ModelRecord): string {
  return `Spine ${model.spineVersion} · ${megabytes(model)}`;
}

function initial(name: string): string {
  return (name.trim()[0] ?? '?').toUpperCase();
}

/** The model's thumbnail, or its initial on a plain square until it has one. */
function thumbnail(model: ModelRecord, className: string): HTMLElement {
  if (model.thumbnail) {
    const image = el('img', className);
    image.src = model.thumbnail;
    image.alt = '';
    return image;
  }
  return el('div', `${className} spn-thumb-empty`, initial(model.name));
}

function modelLeading(model: ModelRecord): SpindleSelectOptionLeading {
  return model.thumbnail
    ? { type: 'image', src: model.thumbnail, rounded: false, fallback: { text: initial(model.name) } }
    : { type: 'initial', text: initial(model.name) };
}

interface PickerOption {
  value: string;
  label: string;
  sublabel?: string;
  leading?: SpindleSelectOptionLeading;
}

function withLabel<T extends HTMLElement>(node: T, label: string): T {
  node.setAttribute('aria-label', label);
  return node;
}

/** A line that explains why a button didn't do anything; empty otherwise. */
function statusLine(): { root: HTMLSpanElement; say(text: string): void } {
  const root = el('span', 'spn-dim', '');
  root.setAttribute('role', 'status');
  return {
    root,
    say(text: string) {
      root.textContent = text;
    },
  };
}

function animationOptions(description: ModelDescription): Array<{ value: string; label: string }> {
  return [
    { value: 'none', label: 'None' },
    ...description.animations.map((animation) => ({
      value: animation.name,
      label: `${animation.name} (${animation.duration.toFixed(2)}s)`,
    })),
  ];
}

// ── main UI class ───────────────────────────────────────────────────────────

export class SettingsUI {
  private root: HTMLElement | null = null;
  private selectedCharacterId: string | null = null;
  private selectedModelId: string | null = null;
  /** The active chat's character at the last render, to notice chat switches. */
  private lastActiveCharacterId: string | null = null;
  /** Bumped on every render, so late async results can tell they're stale. */
  private renderGeneration = 0;
  /** Refreshes the layout sliders from the stored settings (after a drag on the stage). */
  private syncLayout: (() => void) | null = null;
  /** Model library filter text (not saved). */
  private libraryFilter = '';
  private libraryList: HTMLElement | null = null;
  /** Result of the last settings file import, shown until another character is picked. */
  private fileStatusText = '';
  /** Host dropdowns mounted by the last render, destroyed on the next one. */
  private mounted: SpindleSelectHandle[] = [];
  /** Host dropdowns to mount once the render has put their placeholders in the tab. */
  private pendingMounts: Array<() => void> = [];

  constructor(private controller: UIController) {}

  mount(root: HTMLElement): void {
    this.root = root;
    this.render();
  }

  /** The stage moved the model (drag); show the new position on the sliders. */
  layoutChanged(): void {
    this.syncLayout?.();
  }

  /** Re-render from current state (cheap enough for a settings panel). */
  render(): void {
    const root = this.root;
    if (!root) return;
    for (const handle of this.mounted.splice(0)) {
      try {
        handle.destroy();
      } catch {
        /* already gone */
      }
    }
    this.pendingMounts = [];
    root.replaceChildren();
    root.classList.add('spn-root');
    root.classList.toggle('spn-hide-help', !this.controller.getSettings().global.showHelp);
    this.controller.syncChatBarButton();
    this.syncLayout = null;
    const generation = ++this.renderGeneration;

    const controller = this.controller;
    const settings = controller.getSettings();
    const globals = settings.global;

    // ── Permissions banner ──
    const granted = new Set(controller.getPermissions());
    const missing = REQUIRED_PERMS.filter((perm) => !granted.has(perm.id));
    if (missing.length > 0) {
      const banner = el('div', 'spn-banner');
      banner.appendChild(el('div', 'spn-banner-title', 'Some features need permissions'));
      for (const perm of missing) {
        banner.appendChild(el('div', 'spn-banner-line', `• ${perm.id} — ${perm.why}`));
      }
      banner.appendChild(
        button('Grant permissions', () => {
          void controller.requestPermissions(missing.map((perm) => perm.id));
        }),
      );
      root.appendChild(banner);
    }

    // ── Global settings ──
    root.appendChild(
      section('Global', [
        checkbox('Enabled', globals.enabled, (value) => {
          globals.enabled = value;
          controller.saveNow();
          controller.reloadStage();
          controller.syncChatBarButton();
        }),
        checkbox(
          'Show model as chat background',
          globals.backgroundMode,
          (value) => {
            globals.backgroundMode = value;
            controller.saveNow();
            controller.applyBackgroundMode();
          },
          'Draw the model behind the chat messages instead of over them.',
        ),
        checkbox(
          'Reply to click messages',
          globals.autoSendInteraction,
          (value) => {
            globals.autoSendInteraction = value;
            controller.saveDebounced();
          },
          'When a click posts its message, the character answers it right away.',
        ),
        field(
          'Emotion detection',
          select(
            [
              { value: 'llm', label: 'LLM classification' },
              { value: 'native', label: "Lumiverse's expression detection" },
              { value: 'off', label: 'Off' },
            ],
            globals.expressionSource,
            (value) => {
              globals.expressionSource = value as typeof globals.expressionSource;
              controller.saveNow();
            },
          ),
        ),
        help('Each new character message plays the animation mapped to its emotion (Model settings → Emotion mappings).'),
        controller.usingOverlay()
          ? null
          : note('Overlay permission not granted — the avatar renders in the preview box below.'),
        checkbox(
          'Show help text',
          globals.showHelp,
          (value) => {
            globals.showHelp = value;
            controller.saveDebounced();
            root.classList.toggle('spn-hide-help', !value);
          },
          'The explanations under the settings, like this one.',
        ),
      ]),
    );

    // ── Debug ──
    root.appendChild(
      section('Debug', [
        checkbox('Show bones and bounds', globals.showBounds, (value) => {
          globals.showBounds = value;
          controller.saveDebounced();
        }),
        checkbox(
          'Reload button in the chat menu bar',
          globals.showReloadButton,
          (value) => {
            globals.showReloadButton = value;
            controller.saveDebounced();
            controller.syncChatBarButton();
          },
          'Adds a button that reloads the Spine models next to the chat’s other icons, above the message input.',
        ),
        row(button('Reload Spine', () => controller.reloadStage())),
      ]),
    );

    // ── Embedded preview host ──
    if (!controller.usingOverlay()) {
      controller.embeddedHost.classList.add('spn-embedded-host');
      root.appendChild(section('Stage preview', [controller.embeddedHost]));
    }

    // ── Character binding ──
    const models = controller.getModels();
    const known = controller.getCharacters();
    const activeCharacterId = controller.getActiveCharacterId();
    // The chat's characters come first, marked, in member order.
    const inChat = controller.stage.getChatContext().characterIds;
    if (activeCharacterId && !inChat.includes(activeCharacterId)) inChat.unshift(activeCharacterId);
    const isGroup = inChat.length > 1;
    const characters = [
      ...inChat.map((id, index) => {
        const name = known.find((character) => character.id === id)?.name;
        const fallback = isGroup ? `Group member ${index + 1}` : 'Current chat character';
        return { id, name: `${name ?? fallback} (in this chat)` };
      }),
      ...known.filter((character) => !inChat.includes(character.id)),
    ];
    // Follow the chat: when it switches, move the selection along unless the
    // user had picked some other character.
    if (activeCharacterId !== this.lastActiveCharacterId) {
      if (activeCharacterId && (!this.selectedCharacterId || this.selectedCharacterId === this.lastActiveCharacterId)) {
        this.selectedCharacterId = activeCharacterId;
      }
      this.lastActiveCharacterId = activeCharacterId;
    }
    if (!characters.some((character) => character.id === this.selectedCharacterId)) {
      this.selectedCharacterId = activeCharacterId ?? characters[0]?.id ?? null;
    }

    const bindingSection = el('div');
    if (characters.length === 0) {
      this.selectedModelId = null;
      bindingSection.appendChild(
        note('Open a chat (or grant the "characters" permission) to assign a model to a character.'),
      );
    } else {
      const characterSelect = this.picker(
        characters.map((character) => ({
          value: character.id,
          label: character.name,
          leading: {
            type: 'image',
            src: `/api/v1/characters/${encodeURIComponent(character.id)}/avatar?size=sm`,
            fallback: { text: initial(character.name) },
          },
        })),
        this.selectedCharacterId ?? characters[0]!.id,
        (value) => {
          this.selectedCharacterId = value;
          this.fileStatusText = '';
          this.render();
        },
        { label: 'Character', placeholder: 'Choose a character', searchPlaceholder: 'Search characters…' },
      );
      const boundModelId = this.selectedCharacterId
        ? settings.characterModelMapping[this.selectedCharacterId] ?? 'none'
        : 'none';
      this.selectedModelId = boundModelId === 'none' ? null : boundModelId;
      const modelSelect = this.picker(
        sortModels(models, globals.librarySort).map((model) => ({
          value: model.id,
          label: model.name,
          sublabel: modelSummary(model),
          leading: modelLeading(model),
        })),
        boundModelId,
        (value) => {
          const characterId = this.selectedCharacterId;
          if (!characterId) return;
          if (value === 'none') delete settings.characterModelMapping[characterId];
          else settings.characterModelMapping[characterId] = value;
          controller.saveNow();
          if (this.isOnStage(characterId)) controller.reloadStage();
          this.render();
        },
        { label: 'Model', placeholder: 'No model', searchPlaceholder: 'Search models…', noneLabel: 'No model' },
      );
      bindingSection.appendChild(field('Character', characterSelect));
      bindingSection.appendChild(field('Model', modelSelect));
      if (models.length === 0) {
        bindingSection.appendChild(note('Your library is empty: import a model in Model library below first.'));
      }
      if (isGroup) {
        bindingSection.appendChild(
          help(
            'Group chat: every member with a model is shown, starting side by side in equal columns in member order ' +
              '(Spine and, with the Live2D Avatars extension, Live2D models). Drag a model anywhere on the screen. ' +
              'Zoom 1 fits the model in its column and Fit to canvas puts it back there; X offset 0 is the middle of its ' +
              'column, -100 and 100 the left and right edges of the screen. Right-click a model (or touch and hold it) ' +
              'to send it to the front or back where models overlap.',
          ),
        );
      }
      const characterName = () =>
        characters.find((character) => character.id === this.selectedCharacterId)?.name.replace(/ \(in this chat\)$/, '') ??
        'Character';
      const fileStatus = el('span', 'spn-dim', this.fileStatusText);
      fileStatus.setAttribute('role', 'status');
      const exportButton = button('Export settings', () => {
        if (this.selectedCharacterId) controller.exportModelSettings(this.selectedCharacterId, characterName());
      });
      exportButton.disabled = boundModelId === 'none';
      exportButton.title = 'Save this character’s model and animation settings to a file';
      const importButton = button('Import settings', () => {
        const characterId = this.selectedCharacterId;
        if (!characterId) return;
        fileStatus.textContent = '';
        void controller
          .importModelSettings(characterId, characterName())
          .catch((error) => `Import failed: ${String(error)}`)
          .then((status) => {
            if (this.selectedCharacterId !== characterId) return;
            this.fileStatusText = status;
            this.render();
          });
      });
      importButton.title = 'Load model and animation settings for this character from a file';
      const resetButton = button('Reset settings', () => {
        const characterId = this.selectedCharacterId;
        if (!characterId) return;
        void controller
          .confirm({
            title: 'Reset model settings',
            message:
              `Reset ${characterName()}’s settings for every model to the defaults? Position, zoom, ` +
              'skin, animations and emotion mappings are all cleared. The model stays assigned.',
            confirmLabel: 'Reset',
          })
          .then((confirmed) => {
            if (!confirmed) return;
            delete settings.characterModelsSettings[characterId];
            controller.saveNow();
            if (this.isOnStage(characterId)) controller.reloadStage();
            this.render();
          });
      });
      resetButton.classList.add('spn-btn-danger');
      resetButton.title = 'Clear this character’s model settings back to the defaults';
      bindingSection.appendChild(row(exportButton, importButton, resetButton, fileStatus));
    }
    root.appendChild(section('Character model', [bindingSection]));

    // ── Per-model settings (async: needs the model description) ──
    if (this.selectedCharacterId && this.selectedModelId) {
      const host = el('div');
      const status = note('Loading model details…');
      host.appendChild(status);
      root.appendChild(section('Model settings', [host]));
      const characterId = this.selectedCharacterId;
      const modelId = this.selectedModelId;
      const showProgress = () => {
        const progress = controller.getDownloadProgress(modelId);
        if (!progress || progress.totalBytes === 0) return;
        const mb = (bytes: number) => (bytes / (1024 * 1024)).toFixed(1);
        const percent = Math.floor((progress.receivedBytes / progress.totalBytes) * 100);
        status.textContent =
          `Downloading model files… ${percent}% ` +
          `(${mb(progress.receivedBytes)} / ${mb(progress.totalBytes)} MB)`;
      };
      const progressTimer = window.setInterval(() => {
        if (!status.isConnected) window.clearInterval(progressTimer);
        else showProgress();
      }, 500);
      void controller
        .describeModel(modelId)
        .then((description) => {
          if (generation !== this.renderGeneration) return;
          host.replaceChildren();
          this.renderModelSettings(host, characterId, modelId, description);
        })
        .catch((error) => {
          if (generation !== this.renderGeneration) return;
          host.replaceChildren();
          host.appendChild(note(`Could not load model details: ${String(error)}`));
        })
        .finally(() => window.clearInterval(progressTimer));
    }

    // ── Model library ──
    const library = el('div');
    const libraryList = el('div');
    this.libraryList = libraryList;
    const importStatus = el('span', 'spn-dim', '');
    importStatus.setAttribute('role', 'status');
    const importButton = button('Import model (.zip)', () => {
      void this.controller.importZip((text) => {
        importStatus.textContent = text;
      });
    });
    importButton.classList.add('spn-btn-primary');
    importButton.title = 'Zip the exported model folder: the skeleton (.skel or .json), its .atlas and the atlas page images';
    library.appendChild(row(importButton, importStatus));
    if (models.length === 0) {
      library.appendChild(
        note(
          'No models yet. Zip an exported Spine model folder (the skeleton .skel or .json, its .atlas and the ' +
            `atlas page images) and import it. Spine ${SUPPORTED_SPINE_VERSIONS.join(' and ')} exports are supported.`,
        ),
      );
    } else {
      const filter = el('input', 'spn-input spn-library-filter');
      filter.type = 'search';
      filter.placeholder = 'Filter models…';
      filter.setAttribute('aria-label', 'Filter models');
      filter.value = this.libraryFilter;
      filter.addEventListener('input', () => {
        this.libraryFilter = filter.value;
        this.renderLibraryList(libraryList);
      });
      const sort = select(SORT_OPTIONS, globals.librarySort, (value) => {
        globals.librarySort = value as LibrarySort;
        controller.saveDebounced();
        this.renderLibraryList(libraryList);
      });
      sort.title = 'Sort models';
      sort.setAttribute('aria-label', 'Sort models');
      const views = el('div', 'spn-segmented');
      views.setAttribute('role', 'group');
      views.setAttribute('aria-label', 'Library view');
      const viewButtons = (['tiles', 'list'] as const).map((view) => {
        const viewButton = button(view === 'tiles' ? 'Tiles' : 'List', () => {
          globals.libraryView = view;
          controller.saveDebounced();
          for (const other of viewButtons) {
            other.classList.toggle('spn-active', other === viewButton);
            other.setAttribute('aria-pressed', String(other === viewButton));
          }
          this.renderLibraryList(libraryList);
        });
        const active = libraryView(globals.libraryView) === view;
        viewButton.classList.toggle('spn-active', active);
        viewButton.setAttribute('aria-pressed', String(active));
        views.appendChild(viewButton);
        return viewButton;
      });
      library.appendChild(row(filter, sort, views));
    }
    library.appendChild(libraryList);
    this.renderLibraryList(libraryList);
    if (models.length > 0) {
      library.appendChild(
        help(
          `Spine ${SUPPORTED_SPINE_VERSIONS.join(' and ')} exports are supported. A model’s thumbnail is taken ` +
            'the first time it’s shown; the highlighted one is the selected character’s.',
        ),
      );
    }
    root.appendChild(section('Model library', [library]));

    // ── Classification test ──
    const testInput = el('input', 'spn-input') as HTMLInputElement;
    testInput.type = 'text';
    testInput.placeholder = 'Type a message to classify…';
    testInput.setAttribute('aria-label', 'Message to classify');
    const testResult = el('span', 'spn-dim', '');
    testResult.setAttribute('role', 'status');
    const classifyButton = button('Classify', () => {
      if (!testInput.value.trim()) {
        testResult.textContent = 'Type a message first.';
        return;
      }
      testResult.textContent = 'Classifying…';
      classifyButton.disabled = true;
      void controller
        .classifyTest(testInput.value)
        .then((label) => {
          testResult.textContent = `Emotion: ${label}`;
        })
        .catch((error) => {
          testResult.textContent = String(error);
        })
        .finally(() => {
          classifyButton.disabled = false;
        });
    });
    testInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') classifyButton.click();
    });
    root.appendChild(
      section(
        'Test emotion classification',
        [row(testInput, classifyButton), testResult],
        { open: false },
      ),
    );


    for (const mount of this.pendingMounts.splice(0)) mount();
  }

  /** Redraw the model library (after a thumbnail changes) without rebuilding the rest of the tab. */
  refreshLibrary(): void {
    if (this.libraryList) this.renderLibraryList(this.libraryList);
  }

  /** The library's models, filtered and sorted, as tiles or a list. */
  private renderLibraryList(host: HTMLElement): void {
    const controller = this.controller;
    const settings = controller.getSettings();
    const models = controller.getModels();
    host.replaceChildren();
    if (models.length === 0) return;
    const needle = this.libraryFilter.trim().toLowerCase();
    const shown = sortModels(
      needle ? models.filter((model) => model.name.toLowerCase().includes(needle)) : models,
      settings.global.librarySort,
    );
    if (shown.length === 0) {
      host.appendChild(note(`No models match “${this.libraryFilter.trim()}”.`));
      return;
    }
    const boundTo = (modelId: string) =>
      Object.values(settings.characterModelMapping).filter((bound) => bound === modelId).length;
    const usedBy = (count: number) => (count ? `used by ${count}` : 'unused');
    const current = this.selectedCharacterId ? settings.characterModelMapping[this.selectedCharacterId] : undefined;
    const remove = (model: ModelRecord, label: string) => {
      const removeButton = withLabel(
        button(label, () => {
          void controller.deleteModel(model.id);
        }),
        `Delete ${model.name}`,
      );
      removeButton.classList.add('spn-btn-danger');
      removeButton.title = `Delete ${model.name}`;
      return removeButton;
    };

    if (libraryView(settings.global.libraryView) === 'tiles') {
      const grid = el('div', 'spn-tiles');
      for (const model of shown) {
        const tile = el('div', 'spn-tile');
        tile.dataset.modelId = model.id;
        tile.classList.toggle('spn-current', model.id === current);
        const used = boundTo(model.id);
        tile.title = `${model.name}\n${modelSummary(model)}${used ? `\nUsed by ${used} character${used === 1 ? '' : 's'}` : ''}`;
        tile.appendChild(thumbnail(model, 'spn-tile-thumb'));
        tile.appendChild(el('div', 'spn-tile-name', model.name));
        tile.appendChild(el('div', 'spn-tile-meta', `${megabytes(model)} · ${usedBy(used)}`));
        const removeButton = remove(model, '✕');
        removeButton.classList.add('spn-tile-delete');
        tile.appendChild(removeButton);
        grid.appendChild(tile);
      }
      host.appendChild(grid);
      return;
    }
    for (const model of shown) {
      const line = el('div', 'spn-list-row');
      line.dataset.modelId = model.id;
      line.classList.toggle('spn-current', model.id === current);
      const text = el('div', 'spn-list-text');
      text.appendChild(el('div', 'spn-model-name', model.name));
      text.appendChild(
        el('div', 'spn-dim', `Spine ${model.spineVersion} · ${model.fileCount} files · ${megabytes(model)} · ${usedBy(boundTo(model.id))}`),
      );
      line.append(thumbnail(model, 'spn-list-thumb'), text, remove(model, 'Delete'));
      host.appendChild(line);
    }
  }

  /**
   * A dropdown with a search field. Uses Lumiverse's own dropdown, mounted once
   * the render has placed it in the tab, and a plain select where that's unavailable.
   * A `noneLabel` adds a first option whose value is 'none'.
   */
  private picker(
    options: PickerOption[],
    value: string,
    onChange: (value: string) => void,
    config: { label: string; placeholder: string; searchPlaceholder: string; noneLabel?: string },
  ): HTMLElement {
    const fallback = () =>
      select(
        [...(config.noneLabel ? [{ value: 'none', label: config.noneLabel }] : []), ...options],
        value,
        onChange,
      );
    const mount = this.controller.mountSelect;
    if (!mount) return fallback();
    const host = el('div', 'spn-picker');
    this.pendingMounts.push(() => {
      try {
        this.mounted.push(
          mount(host, {
            options,
            value: value === 'none' ? '' : value,
            clearable: config.noneLabel !== undefined,
            clearLabel: config.noneLabel,
            placeholder: config.placeholder,
            searchPlaceholder: config.searchPlaceholder,
            noResultsMessage: 'No matches',
            searchThreshold: SEARCH_THRESHOLD,
            maxHeight: 360,
            ariaLabel: config.label,
            onChange: (next) => onChange(next === '' ? 'none' : next),
          }),
        );
      } catch (error) {
        console.debug('[spine] host dropdown unavailable:', error);
        host.replaceChildren(withLabel(fallback(), config.label));
      }
    });
    return host;
  }

  /** Whether this character is in the chat on stage (its binding changes show there). */
  private isOnStage(characterId: string): boolean {
    return this.controller.stage.getChatContext().characterIds.includes(characterId);
  }

  private renderModelSettings(
    host: HTMLElement,
    characterId: string,
    modelId: string,
    description: ModelDescription,
  ): void {
    const controller = this.controller;
    const stage = controller.stage;
    const modelSettings = controller.getOrCreateModelSettings(characterId, modelId, description);
    const defaults = defaultModelSettings(description);
    const isLive = () => stage.isOnStage(characterId, modelId);
    /** Why buttons that act on the stage can't, or null when the model is on stage. */
    const notLiveReason = (): string | null => {
      if (isLive()) return null;
      if (!controller.getSettings().global.enabled) return 'Spine is turned off (Global → Enabled).';
      if (!this.isOnStage(characterId)) {
        return 'Open a chat with this character to see the model on stage.';
      }
      return "The model isn't on stage yet. If it doesn't appear, use Debug → Reload Spine.";
    };
    /** Run `action` on the live model, or explain on `status` why it can't. */
    const onStage = (status: { say(text: string): void }, action: () => void) => {
      const reason = notLiveReason();
      status.say(reason ?? '');
      if (!reason) action();
    };
    const changed = () => controller.saveDebounced();
    const limits = SETTINGS_LIMITS;

    // ── View ──
    const renderScale = slider('Render scale', { ...limits.renderScale, unit: '×', reset: defaults.renderScale }, modelSettings.renderScale, (value) => {
      modelSettings.renderScale = value;
      changed();
    });
    const zoom = slider('Zoom', { ...limits.zoom, unit: '×', reset: defaults.zoom }, modelSettings.zoom, (value) => {
      modelSettings.zoom = value;
      changed();
    });
    const rotation = slider('Rotation', { ...limits.rotation, unit: '°', reset: defaults.rotation }, modelSettings.rotation, (value) => {
      modelSettings.rotation = value;
      changed();
    });
    const speed = slider('Playback speed', { ...limits.speed, unit: '×', reset: defaults.speed }, modelSettings.speed, (value) => {
      modelSettings.speed = value;
      changed();
    });
    const offsetX = slider('X offset', { ...limits.offset, unit: '%', reset: 0 }, modelSettings.x, (value) => {
      modelSettings.x = value;
      changed();
    });
    const offsetY = slider('Y offset', { ...limits.offset, unit: '%', reset: 0 }, modelSettings.y, (value) => {
      modelSettings.y = value;
      changed();
    });
    this.syncLayout = () => {
      zoom.setValue(modelSettings.zoom);
      offsetX.setValue(modelSettings.x);
      offsetY.setValue(modelSettings.y);
    };

    const viewStatus = statusLine();
    const view = el('div');
    const fitButton = button('Fit to canvas', () =>
      onStage(viewStatus, () => {
        if (!stage.fitToCanvas(characterId, modelId)) {
          viewStatus.say('The stage is hidden or has no size yet. Show it, then try again.');
          return;
        }
        this.syncLayout?.();
      }),
    );
    fitButton.title = 'Make the model as large as fits, at its current rotation, and center it';
    const centerButton = button('Center model', () => {
      modelSettings.x = 0;
      modelSettings.y = 0;
      changed();
      viewStatus.say('');
      this.syncLayout?.();
    });
    centerButton.title = 'Set X and Y offset back to 0';
    const thumbButton = button('Update thumbnail', () =>
      onStage(viewStatus, () => {
        viewStatus.say(
          controller.updateThumbnail(characterId, modelId)
            ? 'Thumbnail updated.'
            : 'The stage is hidden or has no size yet. Show it, then try again.',
        );
      }),
    );
    thumbButton.title = 'Take the library thumbnail again from the model as it is now';
    view.appendChild(row(fitButton, centerButton, thumbButton));
    if (stage.getChatContext().characterIds.length > 1 && this.isOnStage(characterId)) {
      // Where models overlap in a group chat, Spine or Live2D.
      const restack = (toFront: boolean) =>
        onStage(viewStatus, () => {
          if (!stage.restack(characterId, toFront)) viewStatus.say(toFront ? 'Already in front.' : 'Already at the back.');
        });
      const front = button('Send to front', () => restack(true));
      front.title = 'Draw this model over the other models in the chat where they overlap';
      const back = button('Send to back', () => restack(false));
      back.title = 'Draw this model under the other models in the chat where they overlap';
      view.appendChild(row(front, back));
    }
    view.appendChild(viewStatus.root);
    view.append(zoom, offsetX, offsetY, rotation, speed, renderScale);
    view.appendChild(
      checkbox(
        'Premultiplied alpha',
        modelSettings.premultipliedAlpha,
        (value) => {
          modelSettings.premultipliedAlpha = value;
          changed();
        },
        `This model’s atlas says ${description.pma ? 'on' : 'off'}. If edges look dark or haloed, flip it.`,
      ),
    );
    view.appendChild(
      help('Drag the model on the stage to move it. Render scale is the drawing resolution (lower is faster, higher is sharper); zoom is the model’s size.'),
    );
    host.appendChild(section('View', [view]));

    // ── Animations ──
    const options = animationOptions(description);
    const animationStatus = statusLine();
    const emotionStatus = statusLine();
    const preview = (label: string, status: { say(text: string): void }, name: () => string) =>
      iconButton('▶', `Play ${label} animation`, () => onStage(status, () => stage.playAnimation(characterId, name())));
    const animations = el('div');
    animations.appendChild(animationStatus.root);
    if (description.skins.length > 1) {
      animations.appendChild(
        field(
          'Skin',
          select(
            description.skins.map((skin) => ({ value: skin === 'default' ? '' : skin, label: skin })),
            modelSettings.skin,
            (value) => {
              modelSettings.skin = value;
              changed();
              if (isLive()) stage.applySkin(characterId);
            },
          ),
        ),
      );
    }
    animations.appendChild(
      field(
        'Idle (loops)',
        select(options, modelSettings.animation_idle, (value) => {
          modelSettings.animation_idle = value;
          changed();
          if (isLive()) stage.applyIdle(characterId);
        }),
      ),
    );
    animations.appendChild(
      field(
        'On chat open',
        select(options, modelSettings.animation_starter.animation, (value) => {
          modelSettings.animation_starter.animation = value;
          changed();
        }),
        preview('chat open', animationStatus, () => modelSettings.animation_starter.animation),
      ),
    );
    animations.appendChild(
      slider(
        'Delay before it plays',
        { min: 0, max: 10000, step: 100, unit: 'ms', reset: 0 },
        modelSettings.animation_starter.delay,
        (value) => {
          modelSettings.animation_starter.delay = value;
          changed();
        },
      ),
    );
    animations.appendChild(
      field(
        'On click',
        select(options, modelSettings.animation_click.animation, (value) => {
          modelSettings.animation_click.animation = value;
          changed();
        }),
        preview('click', animationStatus, () => modelSettings.animation_click.animation),
      ),
    );
    const clickMessage = el('input', 'spn-input');
    clickMessage.type = 'text';
    clickMessage.placeholder = 'Optional';
    clickMessage.value = modelSettings.animation_click.message;
    clickMessage.addEventListener('change', () => {
      modelSettings.animation_click.message = clickMessage.value;
      changed();
    });
    animations.appendChild(field('Click message', clickMessage));
    animations.appendChild(
      field(
        'While talking',
        select(options, modelSettings.animation_talk, (value) => {
          modelSettings.animation_talk = value;
          changed();
        }),
      ),
    );
    animations.appendChild(
      slider(
        'Talk time per character',
        { min: 0, max: 100, step: 1, unit: 'ms', reset: defaults.talk_time_per_character },
        modelSettings.talk_time_per_character,
        (value) => {
          modelSettings.talk_time_per_character = value;
          changed();
        },
      ),
    );
    animations.appendChild(
      help(
        'Chat-open, click and emotion animations play once, then the idle loop resumes. ' +
          'The talking animation plays on a layer above them. The click message, if any, is posted to the chat.',
      ),
    );
    host.appendChild(section('Animations', [animations]));

    // ── Emotion mappings ──
    const classify = el('div');
    classify.appendChild(emotionStatus.root);
    const grid = el('div', 'spn-mapping-grid');
    grid.setAttribute('role', 'table');
    grid.setAttribute('aria-label', 'Emotion mappings');
    const head = el('div', 'spn-mapping-head');
    head.setAttribute('role', 'row');
    for (const title of ['Emotion', 'Animation', '']) {
      const cell = el('span', undefined, title);
      cell.setAttribute('role', 'columnheader');
      head.appendChild(cell);
    }
    grid.appendChild(head);
    for (const label of CLASSIFY_EXPRESSIONS) {
      const line = el('div', 'spn-mapping-row');
      line.setAttribute('role', 'row');
      const mark = () => line.classList.toggle('spn-unset', (modelSettings.classify_mapping[label] ?? 'none') === 'none');
      const choice = withLabel(
        select(options, modelSettings.classify_mapping[label] ?? 'none', (value) => {
          modelSettings.classify_mapping[label] = value;
          changed();
          mark();
        }),
        `Animation for ${label}`,
      );
      line.append(
        el('span', 'spn-emotion', label),
        choice,
        preview(label, emotionStatus, () => modelSettings.classify_mapping[label] ?? 'none'),
      );
      mark();
      grid.appendChild(line);
    }
    classify.appendChild(grid);
    classify.appendChild(
      help(
        'A new character message plays the animation mapped to its emotion. Dimmed rows play nothing. ' +
          'Emotions whose names match one of the model’s animations are mapped on first load.',
      ),
    );
    host.appendChild(section('Emotion mappings', [classify], { open: false }));
  }
}

export const UI_CSS = `
.spn-root { padding: 10px 12px; color: var(--lumiverse-text); font-size: 13px; container-type: inline-size; }
.spn-section { margin-bottom: 10px; border: 1px solid var(--lumiverse-border); border-radius: var(--lumiverse-radius); padding: 0 10px; background: var(--lumiverse-fill-subtle); }
.spn-section[open] { padding-bottom: 8px; }
.spn-section .spn-section { margin: 8px 0 0; background: transparent; }
.spn-section-title { display: flex; align-items: center; gap: 6px; cursor: pointer; font-weight: 600; padding: 8px 0; color: var(--lumiverse-text); list-style: none; user-select: none; }
.spn-section-title::-webkit-details-marker { display: none; }
.spn-section-title::before { content: ''; flex: none; width: 6px; height: 6px; margin: 0 3px 0 1px; border-right: 1.5px solid var(--lumiverse-text-dim); border-bottom: 1.5px solid var(--lumiverse-text-dim); transform: rotate(-45deg); transition: transform var(--lumiverse-transition-fast, 0.15s); }
.spn-section[open] > .spn-section-title::before { transform: rotate(45deg); }
.spn-section-title:hover::before { border-color: var(--lumiverse-text); }
.spn-row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 8px; margin: 6px 0; }
.spn-field { display: grid; grid-template-columns: minmax(72px, 34%) minmax(0, 1fr); align-items: center; gap: 8px; margin: 6px 0; }
.spn-field-control { display: flex; align-items: center; gap: 6px; min-width: 0; }
.spn-field-control > .spn-select, .spn-field-control > .spn-input, .spn-field-control > .spn-picker { flex: 1; min-width: 0; max-width: none; width: 100%; }
.spn-label { color: var(--lumiverse-text-muted); }
.spn-note { color: var(--lumiverse-text-dim); font-size: 12px; line-height: 1.45; margin: 6px 0; }
.spn-dim { color: var(--lumiverse-text-dim); font-size: 12px; }
.spn-dim:empty { display: none; }
.spn-btn { padding: 4px 10px; border-radius: var(--lumiverse-radius); border: 1px solid var(--lumiverse-border); background: var(--lumiverse-fill); color: var(--lumiverse-text); cursor: pointer; font: inherit; line-height: 1.4; }
.spn-btn:hover:not(:disabled) { border-color: var(--lumiverse-border-hover); background: var(--lumiverse-fill-hover, var(--lumiverse-fill)); }
.spn-btn:focus-visible, .spn-select:focus-visible, .spn-input:focus-visible, .spn-number:focus-visible, .spn-section-title:focus-visible { outline: 2px solid var(--lumiverse-primary, var(--lumiverse-accent)); outline-offset: 1px; }
.spn-btn-primary { border-color: var(--lumiverse-primary, var(--lumiverse-accent)); }
.spn-btn-danger:hover:not(:disabled) { border-color: var(--lumiverse-danger, #e5484d); color: var(--lumiverse-danger, #e5484d); }
.spn-icon-btn { flex: none; width: 28px; height: 28px; padding: 0; display: inline-flex; align-items: center; justify-content: center; font-size: 11px; }
.spn-icon-btn[hidden] { display: none; }
.spn-check { display: flex; align-items: flex-start; gap: 8px; margin: 8px 0; cursor: pointer; }
.spn-check input { margin: 2px 0 0; flex: none; accent-color: var(--lumiverse-primary, var(--lumiverse-accent)); }
.spn-check-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.spn-hint { color: var(--lumiverse-text-dim); font-size: 12px; line-height: 1.4; }
.spn-hide-help .spn-help, .spn-hide-help .spn-hint { display: none; }
.spn-select { max-width: 100%; min-width: 0; padding: 4px 6px; border-radius: var(--lumiverse-radius); border: 1px solid var(--lumiverse-border); background: var(--lumiverse-fill); color: var(--lumiverse-text); font: inherit; text-overflow: ellipsis; }
.spn-input { flex: 1; min-width: 120px; padding: 4px 8px; border-radius: var(--lumiverse-radius); border: 1px solid var(--lumiverse-border); background: var(--lumiverse-fill); color: var(--lumiverse-text); font: inherit; }
.spn-slider { margin: 6px 0 2px; }
.spn-slider-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; color: var(--lumiverse-text-muted); min-height: 28px; }
.spn-slider-value { display: inline-flex; align-items: center; gap: 4px; color: var(--lumiverse-text); }
.spn-number { width: 64px; padding: 2px 6px; border-radius: var(--lumiverse-radius); border: 1px solid transparent; background: transparent; color: var(--lumiverse-text); font: inherit; font-variant-numeric: tabular-nums; text-align: right; -moz-appearance: textfield; }
.spn-number::-webkit-inner-spin-button, .spn-number::-webkit-outer-spin-button { -webkit-appearance: none; margin: 0; }
.spn-number:hover, .spn-number:focus { border-color: var(--lumiverse-border); background: var(--lumiverse-fill); }
.spn-unit { color: var(--lumiverse-text-dim); min-width: 1ch; }
.spn-slider-value .spn-icon-btn { width: 24px; height: 24px; font-size: 13px; }
.spn-range { display: block; width: 100%; margin: 0; }
@media (pointer: fine) { .spn-root input.spn-range { min-height: 24px; } }
.spn-root input.spn-range::-webkit-slider-runnable-track { background: linear-gradient(to right, var(--lumiverse-primary, var(--lumiverse-accent)) var(--spn-fill, 0%), var(--lumiverse-border) var(--spn-fill, 0%)); }
.spn-root input.spn-range::-moz-range-track { background: var(--lumiverse-border); }
.spn-root input.spn-range::-moz-range-progress { height: 4px; border-radius: 2px; background: var(--lumiverse-primary, var(--lumiverse-accent)); }
@media (pointer: fine) { .spn-root input.spn-range::-webkit-slider-thumb { width: 16px; height: 16px; margin-top: -6px; } .spn-root input.spn-range::-moz-range-thumb { width: 16px; height: 16px; } }
.spn-emotion { color: var(--lumiverse-text-muted); }
.spn-input.spn-area-name { flex: 1 1 100px; min-width: 80px; }
.spn-model-name { font-weight: 600; }
.spn-anim { border-top: 1px solid var(--lumiverse-border); padding-top: 4px; margin-top: 8px; }
.spn-anim:first-of-type { border-top: none; margin-top: 0; }
.spn-anim-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 30px; }
.spn-anim-title { font-weight: 600; color: var(--lumiverse-text-muted); margin-top: 6px; }
.spn-anim-head .spn-anim-title { margin: 0; }
.spn-mapping-grid { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 4px 6px; align-items: center; margin: 6px 0; }
.spn-mapping-head, .spn-mapping-row { display: contents; }
.spn-mapping-head > span { color: var(--lumiverse-text-dim); font-size: 11px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.spn-mapping-row > .spn-select { width: 100%; font-size: 12px; }
.spn-mapping-row.spn-unset > .spn-emotion, .spn-mapping-row.spn-unset > .spn-select { opacity: 0.55; }
.spn-mapping { border: 1px solid var(--lumiverse-border); border-radius: var(--lumiverse-radius); padding: 6px 8px; margin: 6px 0; display: flex; flex-direction: column; gap: 6px; }
.spn-mapping-top { display: flex; align-items: center; gap: 6px; }
.spn-mapping-name { flex: 1; min-width: 0; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.spn-mapping-choices { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 6px; }
.spn-mapping-choices > .spn-select { width: 100%; }
.spn-mapping > .spn-input { min-width: 0; }
.spn-banner { border: 1px solid var(--lumiverse-primary, var(--lumiverse-accent)); border-radius: var(--lumiverse-radius); padding: 8px 10px; margin-bottom: 10px; }
.spn-banner-title { font-weight: 600; margin-bottom: 4px; }
.spn-banner-line { color: var(--lumiverse-text-muted); font-size: 12px; margin: 2px 0 6px; }
.spn-segmented { display: inline-flex; }
.spn-segmented .spn-btn { border-radius: 0; }
.spn-segmented .spn-btn:first-child { border-radius: var(--lumiverse-radius) 0 0 var(--lumiverse-radius); }
.spn-segmented .spn-btn:last-child { border-radius: 0 var(--lumiverse-radius) var(--lumiverse-radius) 0; margin-left: -1px; }
.spn-btn.spn-active { background: var(--lumiverse-fill-hover, var(--lumiverse-fill)); border-color: var(--lumiverse-primary, var(--lumiverse-accent)); position: relative; }
.spn-btn:disabled { opacity: 0.5; cursor: default; }
.spn-library-filter { min-width: 120px; }
.spn-tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(96px, 1fr)); gap: 6px; margin: 8px 0; }
.spn-tile { position: relative; display: flex; flex-direction: column; gap: 2px; min-width: 0; padding: 4px; border: 1px solid var(--lumiverse-border); border-radius: var(--lumiverse-radius); background: var(--lumiverse-fill); }
.spn-tile.spn-current, .spn-list-row.spn-current { border-color: var(--lumiverse-primary, var(--lumiverse-accent)); box-shadow: 0 0 0 1px var(--lumiverse-primary, var(--lumiverse-accent)); }
.spn-tile-delete { position: absolute; top: 6px; right: 6px; padding: 0 6px !important; font-size: 11px; line-height: 18px; opacity: 0.55; }
.spn-tile:hover .spn-tile-delete, .spn-tile-delete:focus-visible { opacity: 1; }
.spn-tile-meta { color: var(--lumiverse-text-dim); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.spn-tile-thumb { width: 100%; aspect-ratio: 1; object-fit: contain; border-radius: var(--lumiverse-radius); background: var(--lumiverse-fill-subtle); }
.spn-tile-name { font-weight: 600; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.spn-list-row { display: flex; align-items: center; gap: 8px; margin: 4px 0; padding: 4px; border: 1px solid transparent; border-radius: var(--lumiverse-radius); }
.spn-list-text { flex: 1; min-width: 0; }
.spn-list-text > * { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.spn-list-thumb { width: 32px; height: 32px; object-fit: contain; border-radius: var(--lumiverse-radius); background: var(--lumiverse-fill-subtle); flex: none; }
.spn-thumb-empty { display: flex; align-items: center; justify-content: center; color: var(--lumiverse-text-dim); font-weight: 600; font-size: 20px; }
.spn-list-thumb.spn-thumb-empty { font-size: 14px; }
.spn-picker { flex: 1; min-width: 160px; max-width: 360px; }
.spn-embedded-host { position: relative; width: 100%; height: 420px; overflow: hidden; border-radius: var(--lumiverse-radius); border: 1px solid var(--lumiverse-border); }
@container (max-width: 300px) {
  .spn-field { grid-template-columns: minmax(0, 1fr); gap: 4px; }
  .spn-mapping-grid { grid-template-columns: minmax(0, 1fr) auto; }
  .spn-mapping-head > span:first-child { display: none; }
  .spn-mapping-row > .spn-emotion { grid-column: 1 / -1; margin-top: 4px; }
}
`;
