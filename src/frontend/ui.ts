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

function checkbox(label: string, checked: boolean, onChange: (value: boolean) => void): HTMLLabelElement {
  const wrap = el('label', 'spn-check');
  const input = el('input');
  input.type = 'checkbox';
  input.checked = checked;
  input.addEventListener('change', () => onChange(input.checked));
  wrap.appendChild(input);
  wrap.appendChild(el('span', undefined, label));
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

interface Slider {
  root: HTMLDivElement;
  /** Show a value changed elsewhere (a button, a drag) without firing onInput. */
  set(value: number): void;
}

function slider(
  label: string,
  limits: { min: number; max: number; step: number },
  value: number,
  format: (value: number) => string,
  onInput: (value: number) => void,
): Slider {
  const root = el('div', 'spn-slider');
  const head = el('div', 'spn-slider-head');
  head.appendChild(el('span', undefined, label));
  const valueSpan = el('span', 'spn-slider-value', format(value));
  head.appendChild(valueSpan);
  const input = el('input');
  input.type = 'range';
  input.min = String(limits.min);
  input.max = String(limits.max);
  input.step = String(limits.step);
  input.value = String(value);
  input.setAttribute('aria-label', label);
  input.addEventListener('input', () => {
    valueSpan.textContent = format(Number(input.value));
    onInput(Number(input.value));
  });
  root.appendChild(head);
  root.appendChild(input);
  return {
    root,
    set(next: number) {
      input.value = String(next);
      valueSpan.textContent = format(next);
    },
  };
}

function section(title: string, ...children: (HTMLElement | null)[]): HTMLDetailsElement {
  const wrap = el('details', 'spn-section');
  wrap.open = true;
  wrap.appendChild(el('summary', 'spn-section-title', title));
  for (const child of children) if (child) wrap.appendChild(child);
  return wrap;
}

/** A row of controls; a string becomes a label that names the control after it. */
function row(...children: (HTMLElement | string)[]): HTMLDivElement {
  const wrap = el('div', 'spn-row');
  let label: string | null = null;
  for (const child of children) {
    if (typeof child === 'string') {
      label = child;
      wrap.appendChild(el('span', 'spn-label', child));
      continue;
    }
    if (label && (child instanceof HTMLSelectElement || child instanceof HTMLInputElement)) {
      if (!child.hasAttribute('aria-label')) child.setAttribute('aria-label', label);
    }
    label = null;
    wrap.appendChild(child);
  }
  return wrap;
}

function note(text: string): HTMLParagraphElement {
  return el('p', 'spn-note', text);
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

const formatFixed = (digits: number, suffix = '') => (value: number) => `${value.toFixed(digits)}${suffix}`;

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
      section(
        'Global',
        checkbox('Enabled', globals.enabled, (value) => {
          globals.enabled = value;
          controller.saveNow();
          controller.reloadStage();
        }),
        checkbox('Show model as chat background', globals.backgroundMode, (value) => {
          globals.backgroundMode = value;
          controller.saveNow();
          controller.applyBackgroundMode();
        }),
        checkbox('Auto-send interaction', globals.autoSendInteraction, (value) => {
          globals.autoSendInteraction = value;
          controller.saveDebounced();
        }),
        row(
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
        controller.usingOverlay()
          ? null
          : note('Overlay permission not granted — the avatar renders in the preview box below.'),
      ),
    );

    // ── Debug ──
    const debug = section(
      'Debug',
      checkbox('Show bones and bounds', globals.showBounds, (value) => {
        globals.showBounds = value;
        controller.saveDebounced();
      }),
      row(button('Reload Spine', () => controller.reloadStage())),
    );
    debug.open = false;
    root.appendChild(debug);

    // ── Embedded preview host ──
    if (!controller.usingOverlay()) {
      const preview = section('Stage preview');
      controller.embeddedHost.classList.add('spn-embedded-host');
      preview.appendChild(controller.embeddedHost);
      root.appendChild(preview);
    }

    // ── Model library ──
    const models = controller.getModels();
    const library = el('div');
    const libraryList = el('div');
    this.libraryList = libraryList;
    if (models.length === 0) {
      library.appendChild(note('No models imported yet. Import a Spine model folder as a .zip archive.'));
    } else {
      const filter = withLabel(el('input', 'spn-input spn-library-filter'), 'Filter models');
      filter.type = 'search';
      filter.placeholder = 'Filter models…';
      filter.value = this.libraryFilter;
      filter.addEventListener('input', () => {
        this.libraryFilter = filter.value;
        this.renderLibraryList(libraryList);
      });
      const sort = withLabel(
        select(SORT_OPTIONS, globals.librarySort, (value) => {
          globals.librarySort = value as LibrarySort;
          controller.saveDebounced();
          this.renderLibraryList(libraryList);
        }),
        'Sort models',
      );
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
    const importStatus = el('span', 'spn-dim', '');
    library.appendChild(
      row(
        button('Import model (.zip)', () => {
          void this.controller.importZip((text) => {
            importStatus.textContent = text;
          });
        }),
        importStatus,
      ),
    );
    library.appendChild(
      note(
        'Zip the exported model folder: the skeleton (.skel or .json), its .atlas and the atlas page images. ' +
          "Spine 4.1 exports are supported. A model's thumbnail is taken the first time it's shown.",
      ),
    );
    root.appendChild(section('Model library', library));

    // ── Character binding ──
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
      bindingSection.appendChild(row('Character', characterSelect));
      bindingSection.appendChild(row('Model', modelSelect));
      if (isGroup) {
        bindingSection.appendChild(
          note(
            'Group chat: every member with a model is shown. The stage is split into equal columns, one per ' +
              'model, in member order; zoom, X and Y offset and Fit to canvas work within that column.',
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
      bindingSection.appendChild(row(exportButton, importButton, fileStatus));
      bindingSection.appendChild(
        row(
          button('Clear model settings for this character', () => {
            const characterId = this.selectedCharacterId;
            if (!characterId) return;
            delete settings.characterModelsSettings[characterId];
            controller.saveNow();
            if (this.isOnStage(characterId)) controller.reloadStage();
            this.render();
          }),
        ),
      );
    }
    root.appendChild(section('Character model', bindingSection));

    // ── Per-model settings (async: needs the model description) ──
    if (this.selectedCharacterId && this.selectedModelId) {
      const host = el('div');
      const status = note('Loading model details…');
      host.appendChild(status);
      root.appendChild(section('Model settings', host));
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

    // ── Classification test ──
    const testInput = el('input', 'spn-input');
    testInput.type = 'text';
    testInput.placeholder = 'Type a message to classify…';
    const testResult = el('span', 'spn-dim', '');
    const test = section(
      'Test emotion classification',
      row(
        testInput,
        button('Classify', () => {
          testResult.textContent = '…';
          void controller
            .classifyTest(testInput.value)
            .then((label) => {
              testResult.textContent = `→ ${label}`;
            })
            .catch((error) => {
              testResult.textContent = String(error);
            });
        }),
        testResult,
      ),
    );
    test.open = false;
    root.appendChild(test);

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
    const remove = (model: ModelRecord, label: string) => {
      const removeButton = withLabel(
        button(label, () => {
          void controller.deleteModel(model.id);
        }),
        `Delete ${model.name}`,
      );
      removeButton.title = `Delete ${model.name}`;
      return removeButton;
    };

    if (libraryView(settings.global.libraryView) === 'tiles') {
      const grid = el('div', 'spn-tiles');
      for (const model of shown) {
        const tile = el('div', 'spn-tile');
        const used = boundTo(model.id);
        tile.title = `${model.name}\n${modelSummary(model)}${used ? `\nUsed by ${used} character${used === 1 ? '' : 's'}` : ''}`;
        tile.appendChild(thumbnail(model, 'spn-tile-thumb'));
        tile.appendChild(el('div', 'spn-tile-name', model.name));
        tile.appendChild(el('div', 'spn-tile-meta', megabytes(model)));
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
      const text = el('div', 'spn-list-text');
      text.appendChild(el('div', 'spn-model-name', model.name));
      text.appendChild(el('div', 'spn-dim', `Spine ${model.spineVersion} · ${model.fileCount} files · ${megabytes(model)}`));
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
    const renderScale = slider('Render scale', limits.renderScale, modelSettings.renderScale, formatFixed(2, '×'), (value) => {
      modelSettings.renderScale = value;
      changed();
    });
    const zoom = slider('Zoom', limits.zoom, modelSettings.zoom, formatFixed(2, '×'), (value) => {
      modelSettings.zoom = value;
      changed();
    });
    const rotation = slider('Rotation', limits.rotation, modelSettings.rotation, formatFixed(0, '°'), (value) => {
      modelSettings.rotation = value;
      changed();
    });
    const speed = slider('Playback speed', limits.speed, modelSettings.speed, formatFixed(2, '×'), (value) => {
      modelSettings.speed = value;
      changed();
    });
    const offsetX = slider('X offset', limits.offset, modelSettings.x, formatFixed(0, '%'), (value) => {
      modelSettings.x = value;
      changed();
    });
    const offsetY = slider('Y offset', limits.offset, modelSettings.y, formatFixed(0, '%'), (value) => {
      modelSettings.y = value;
      changed();
    });
    this.syncLayout = () => {
      zoom.set(modelSettings.zoom);
      offsetX.set(modelSettings.x);
      offsetY.set(modelSettings.y);
    };

    const viewStatus = statusLine();
    const view = el('div');
    view.appendChild(
      row(
        button('Fit to canvas', () =>
          onStage(viewStatus, () => {
            if (!stage.fitToCanvas(characterId, modelId)) {
              viewStatus.say('The stage is hidden or has no size yet. Show it, then try again.');
              return;
            }
            this.syncLayout?.();
          }),
        ),
        button('Center model', () => {
          modelSettings.x = 0;
          modelSettings.y = 0;
          changed();
          viewStatus.say('');
          this.syncLayout?.();
        }),
        button('Update thumbnail', () =>
          onStage(viewStatus, () => {
            viewStatus.say(
              controller.updateThumbnail(characterId, modelId)
                ? 'Thumbnail updated.'
                : 'The stage is hidden or has no size yet. Show it, then try again.',
            );
          }),
        ),
        viewStatus.root,
      ),
    );
    view.append(renderScale.root, zoom.root, rotation.root, speed.root, offsetX.root, offsetY.root);
    view.appendChild(
      checkbox('Premultiplied alpha', modelSettings.premultipliedAlpha, (value) => {
        modelSettings.premultipliedAlpha = value;
        changed();
      }),
    );
    view.appendChild(
      note(
        `Render scale is the drawing resolution (lower is faster, higher is sharper); zoom is the model's size. ` +
          `Drag the model to move it. This model's atlas says premultiplied alpha is ${description.pma ? 'on' : 'off'}; ` +
          `if edges look dark or haloed, flip the toggle.`,
      ),
    );
    host.appendChild(section('View', view));

    // ── Animations ──
    const options = animationOptions(description);
    const animationStatus = statusLine();
    const emotionStatus = statusLine();
    const preview = (label: string, status: { say(text: string): void }, name: () => string) => {
      const play = button('▶', () => onStage(status, () => stage.playAnimation(characterId, name())));
      play.setAttribute('aria-label', `Play ${label} animation`);
      return play;
    };
    const animations = el('div');
    animations.appendChild(animationStatus.root);
    if (description.skins.length > 1) {
      animations.appendChild(
        row(
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
      row(
        'Idle (loops)',
        select(options, modelSettings.animation_idle, (value) => {
          modelSettings.animation_idle = value;
          changed();
          if (isLive()) stage.applyIdle(characterId);
        }),
      ),
    );
    animations.appendChild(
      row(
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
        'Delay before it plays (ms)',
        { min: 0, max: 10000, step: 100 },
        modelSettings.animation_starter.delay,
        formatFixed(0),
        (value) => {
          modelSettings.animation_starter.delay = value;
          changed();
        },
      ).root,
    );
    const clickMessage = el('input', 'spn-input');
    clickMessage.type = 'text';
    clickMessage.placeholder = 'Message sent when clicked (optional)';
    clickMessage.value = modelSettings.animation_click.message;
    clickMessage.addEventListener('change', () => {
      modelSettings.animation_click.message = clickMessage.value;
      changed();
    });
    animations.appendChild(
      row(
        'On click',
        select(options, modelSettings.animation_click.animation, (value) => {
          modelSettings.animation_click.animation = value;
          changed();
        }),
        preview('click', animationStatus, () => modelSettings.animation_click.animation),
      ),
    );
    animations.appendChild(row('Click message', clickMessage));
    animations.appendChild(
      row(
        'While talking',
        select(options, modelSettings.animation_talk, (value) => {
          modelSettings.animation_talk = value;
          changed();
        }),
      ),
    );
    animations.appendChild(
      slider(
        'Talk time per character (ms)',
        { min: 0, max: 100, step: 1 },
        modelSettings.talk_time_per_character,
        formatFixed(0),
        (value) => {
          modelSettings.talk_time_per_character = value;
          changed();
        },
      ).root,
    );
    animations.appendChild(
      note(
        'Chat-open, click and emotion animations play once, then the idle loop resumes. ' +
          'The talking animation plays on a layer above them.',
      ),
    );
    host.appendChild(section('Animations', animations));

    // ── Emotion mappings ──
    const classify = el('div');
    classify.appendChild(emotionStatus.root);
    for (const label of CLASSIFY_EXPRESSIONS) {
      const current = modelSettings.classify_mapping[label] ?? 'none';
      classify.appendChild(
        row(
          el('span', 'spn-emotion', label),
          withLabel(
            select(options, current, (value) => {
              modelSettings.classify_mapping[label] = value;
              changed();
            }),
            `Animation for ${label}`,
          ),
          preview(label, emotionStatus, () => modelSettings.classify_mapping[label] ?? 'none'),
        ),
      );
    }
    classify.appendChild(note('Emotions whose names match one of the model’s animations are mapped on first load.'));
    const classifySection = section('Emotion mappings', classify);
    classifySection.open = false;
    host.appendChild(classifySection);
  }
}

export const UI_CSS = `
.spn-root { padding: 10px 12px; color: var(--lumiverse-text); font-size: 13px; }
.spn-section { margin-bottom: 10px; border: 1px solid var(--lumiverse-border); border-radius: var(--lumiverse-radius); padding: 8px 10px; background: var(--lumiverse-fill-subtle); }
.spn-section-title { cursor: pointer; font-weight: 600; margin: 0 0 4px; color: var(--lumiverse-text); }
.spn-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 6px 0; }
.spn-label { color: var(--lumiverse-text-muted); min-width: 90px; }
.spn-note { color: var(--lumiverse-text-dim); font-size: 12px; margin: 6px 0; }
.spn-dim { color: var(--lumiverse-text-dim); font-size: 12px; }
.spn-btn { padding: 4px 10px; border-radius: var(--lumiverse-radius); border: 1px solid var(--lumiverse-border); background: var(--lumiverse-fill); color: var(--lumiverse-text); cursor: pointer; }
.spn-btn:hover { border-color: var(--lumiverse-border-hover); }
.spn-check { display: flex; align-items: center; gap: 8px; margin: 6px 0; cursor: pointer; }
.spn-select { max-width: 100%; min-width: 140px; padding: 3px 6px; border-radius: var(--lumiverse-radius); border: 1px solid var(--lumiverse-border); background: var(--lumiverse-fill); color: var(--lumiverse-text); }
.spn-input { flex: 1; min-width: 120px; padding: 4px 8px; border-radius: var(--lumiverse-radius); border: 1px solid var(--lumiverse-border); background: var(--lumiverse-fill); color: var(--lumiverse-text); }
.spn-slider { margin: 8px 0; }
.spn-slider input[type=range] { width: 100%; accent-color: var(--lumiverse-accent); }
.spn-slider-head { display: flex; justify-content: space-between; color: var(--lumiverse-text-muted); }
.spn-slider-value { color: var(--lumiverse-text); font-variant-numeric: tabular-nums; }
.spn-emotion { min-width: 110px; color: var(--lumiverse-text-muted); }
.spn-model-name { font-weight: 600; }
.spn-banner { border: 1px solid var(--lumiverse-accent); border-radius: var(--lumiverse-radius); padding: 8px 10px; margin-bottom: 10px; }
.spn-banner-title { font-weight: 600; margin-bottom: 4px; }
.spn-banner-line { color: var(--lumiverse-text-muted); font-size: 12px; margin: 2px 0 6px; }
.spn-segmented { display: inline-flex; }
.spn-segmented .spn-btn { border-radius: 0; }
.spn-segmented .spn-btn:first-child { border-radius: var(--lumiverse-radius) 0 0 var(--lumiverse-radius); }
.spn-segmented .spn-btn:last-child { border-radius: 0 var(--lumiverse-radius) var(--lumiverse-radius) 0; margin-left: -1px; }
.spn-btn.spn-active { background: var(--lumiverse-fill-hover, var(--lumiverse-fill)); border-color: var(--lumiverse-accent); }
.spn-btn:disabled { opacity: 0.5; cursor: default; }
.spn-library-filter { min-width: 140px; }
.spn-tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(88px, 1fr)); gap: 6px; margin: 8px 0; }
.spn-tile { position: relative; display: flex; flex-direction: column; gap: 2px; min-width: 0; padding: 4px; border: 1px solid var(--lumiverse-border); border-radius: var(--lumiverse-radius); background: var(--lumiverse-fill); }
.spn-tile-delete { position: absolute; top: 6px; right: 6px; padding: 0 6px !important; font-size: 11px; line-height: 18px; opacity: 0.55; }
.spn-tile:hover .spn-tile-delete, .spn-tile-delete:focus-visible { opacity: 1; }
.spn-tile-thumb { width: 100%; aspect-ratio: 1; object-fit: contain; border-radius: var(--lumiverse-radius); background: var(--lumiverse-fill-subtle); }
.spn-tile-name { font-weight: 600; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.spn-tile-meta { color: var(--lumiverse-text-dim); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.spn-list-row { display: flex; align-items: center; gap: 8px; margin: 6px 0; }
.spn-list-text { flex: 1; min-width: 0; }
.spn-list-text > * { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.spn-list-thumb { width: 32px; height: 32px; object-fit: contain; border-radius: var(--lumiverse-radius); background: var(--lumiverse-fill-subtle); flex: none; }
.spn-thumb-empty { display: flex; align-items: center; justify-content: center; color: var(--lumiverse-text-dim); font-weight: 600; font-size: 20px; }
.spn-list-thumb.spn-thumb-empty { font-size: 14px; }
.spn-picker { flex: 1; min-width: 180px; max-width: 360px; }
.spn-embedded-host { position: relative; width: 100%; height: 420px; overflow: hidden; border-radius: var(--lumiverse-radius); border: 1px solid var(--lumiverse-border); }
`;
