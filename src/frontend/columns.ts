/**
 * Group chat columns and stacking, shared with the sibling avatar extension.
 * Keep this file the same in the Live2D Avatars and Spine Avatars repos.
 *
 * In a group chat the stage is split into equal columns, one per member with a
 * model, in member order. A column is where its model starts out (X offset 0);
 * a drag can take the model anywhere on the stage (see stageX). A member's model can be a Live2D model or a Spine
 * model, and each extension draws on its own canvases, so both have to count
 * the columns the same way. Each extension publishes which characters it has a
 * model for on a registry on `window` (extension frontends run in the same
 * page), and lays its own models out in the columns of the chat's members that
 * have a model in any extension. With one extension installed, the registry
 * only holds its own entry and the columns are its own models.
 *
 * Models can overlap (a drag, a big zoom), so they're also stacked in one
 * order across both extensions: by each character's stacking layer (Send to
 * front / Send to back), then by extension, then by column. Over the app, both
 * extensions put their canvases in the same shared layer element, sorted by
 * that order, so a Live2D model can sit between two Spine models. A click goes
 * to the topmost model under the pointer, whichever extension draws it.
 *
 * As the chat background, the models sit under the chat. A tap still reaches
 * one where the chat draws nothing over it: the empty space between and
 * around messages (see seeThroughAt).
 */

const REGISTRY_KEY = '__lumiverseAvatarColumns';
const CHANGED_EVENT = 'lumiverse-avatar-columns-changed';
/** On every avatar canvas: the id of the extension that draws it. */
const OWNER_ATTRIBUTE = 'data-lumiverse-avatar';
/** On every avatar canvas: its place in the stacking order, counted from the bottom. */
const RANK_ATTRIBUTE = 'data-lumiverse-avatar-rank';
/** On the shared layer elements: which layer it is. */
const LAYER_ATTRIBUTE = 'data-lumiverse-avatar-layer';

/** Says which of an extension's characters has a model drawn at a viewport point on one of its canvases. */
export type HitTest = (canvas: Element, clientX: number, clientY: number) => string | null;

interface Registry {
  version: 1;
  /** extension id -> characters it draws a model for over the app */
  extensions: Record<string, string[]>;
  /**
   * extension id -> character id -> stacking layer, for characters not on the
   * default layer 0. Added after version 1 shipped, so it can be missing.
   */
  layers?: Record<string, Record<string, number>>;
  /** extension id -> its hit test. Added after version 1 shipped, so it can be missing. */
  hitTests?: Record<string, HitTest>;
}

export interface Columns {
  /** How many columns the stage is split into (at least 1). */
  count: number;
  /** character id -> column, counted from the left */
  index: Map<string, number>;
}

/** One model in the stacking order. */
export interface Stacked {
  extension: string;
  characterId: string;
  layer: number;
}

/**
 * Where an extension draws over the app: in front of it, or as the chat
 * background (in the chat view, above its wallpaper and under the messages).
 */
export type LayerKind = 'front' | 'background';

function registry(): Registry {
  const scope = window as unknown as Record<string, unknown>;
  const existing = scope[REGISTRY_KEY] as Partial<Registry> | undefined;
  if (existing?.version === 1 && existing.extensions && typeof existing.extensions === 'object') {
    return existing as Registry;
  }
  const fresh: Registry = { version: 1, extensions: {} };
  scope[REGISTRY_KEY] = fresh;
  return fresh;
}

/**
 * Where a model's center goes across the stage for its X offset: at 0 the
 * center of its column, at -100 / 100 the stage's left / right edge, in
 * proportion between. So in a group chat a model can be placed anywhere on
 * the stage, and in a solo chat (one column) it's a percent of half the stage.
 */
export function stageX(stageWidth: number, columnCenter: number, offset: number): number {
  return columnCenter + (offset / 100) * (offset < 0 ? columnCenter : stageWidth - columnCenter);
}

/** The X offset (-100..100) that puts a model's center at this stage x; the inverse of stageX. */
export function offsetForStageX(stageWidth: number, columnCenter: number, x: number): number {
  const delta = x - columnCenter;
  const room = delta < 0 ? columnCenter : stageWidth - columnCenter;
  return room > 0 ? Math.min(100, Math.max(-100, (delta / room) * 100)) : 0;
}

export function sameColumns(a: Columns, b: Columns): boolean {
  if (a.count !== b.count || a.index.size !== b.index.size) return false;
  for (const [characterId, column] of a.index) {
    if (b.index.get(characterId) !== column) return false;
  }
  return true;
}

export function sameStack(a: Stacked[], b: Stacked[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (item, index) =>
        item.extension === b[index]!.extension &&
        item.characterId === b[index]!.characterId &&
        item.layer === b[index]!.layer,
    )
  );
}

/** A character's stacking layer, if it's a usable one. */
function layerValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export class SharedColumns {
  private published: string | null = null;
  private readonly listener = (event: Event) => {
    if ((event as CustomEvent<{ extension?: string }>).detail?.extension !== this.extensionId) this.onChange();
  };

  /** `onChange` runs when another extension's characters or their layers change. */
  constructor(
    private readonly extensionId: string,
    private readonly onChange: () => void,
  ) {
    window.addEventListener(CHANGED_EVENT, this.listener);
  }

  /**
   * Say which characters this extension draws a model for over the app, and
   * their stacking layers. Empty when it draws nothing there (turned off, or
   * drawing in its own tab).
   */
  publish(characterIds: string[], layers: Record<string, number> = {}): void {
    const sorted = [...new Set(characterIds)].sort();
    const ownLayers: Record<string, number> = {};
    for (const characterId of sorted) {
      const layer = layerValue(layers[characterId]);
      if (layer !== 0) ownLayers[characterId] = layer;
    }
    const key = JSON.stringify([sorted, ownLayers]);
    if (key === this.published) return;
    this.published = key;
    const shared = registry();
    shared.extensions[this.extensionId] = sorted;
    shared.layers = { ...shared.layers, [this.extensionId]: ownLayers };
    window.dispatchEvent(new CustomEvent(CHANGED_EVENT, { detail: { extension: this.extensionId } }));
  }

  /**
   * The columns for a chat's members, in member order: one per member with a
   * model in this extension (`own`) or, when `shared`, in any other extension
   * drawing over the app.
   */
  layout(members: string[], own: Iterable<string>, shared: boolean): Columns {
    const withModel = new Set(own);
    if (shared) {
      for (const [extension, characterIds] of Object.entries(registry().extensions)) {
        if (extension === this.extensionId || !Array.isArray(characterIds)) continue;
        for (const characterId of characterIds) withModel.add(characterId);
      }
    }
    const index = new Map<string, number>();
    for (const characterId of members) {
      if (withModel.has(characterId) && !index.has(characterId)) index.set(characterId, index.size);
    }
    return { count: Math.max(1, index.size), index };
  }

  /**
   * The models in these columns from bottom to top: this extension's (`own`,
   * with their layers) and, when `shared`, the other extensions'. Higher layers
   * draw on top; on the same layer the sibling extensions keep a fixed order
   * between them, and within an extension the rightmost column is on top.
   */
  stack(columns: Columns, own: Iterable<string>, layers: Record<string, number>, shared: boolean): Stacked[] {
    const items: Stacked[] = [];
    for (const characterId of new Set(own)) {
      if (columns.index.has(characterId)) {
        items.push({ extension: this.extensionId, characterId, layer: layerValue(layers[characterId]) });
      }
    }
    if (shared) {
      const { extensions, layers: sharedLayers } = registry();
      for (const [extension, characterIds] of Object.entries(extensions)) {
        if (extension === this.extensionId || !Array.isArray(characterIds)) continue;
        for (const characterId of characterIds) {
          if (columns.index.has(characterId)) {
            items.push({ extension, characterId, layer: layerValue(sharedLayers?.[extension]?.[characterId]) });
          }
        }
      }
    }
    const column = (item: Stacked) => columns.index.get(item.characterId) ?? 0;
    return items.sort(
      (a, b) =>
        a.layer - b.layer ||
        (a.extension < b.extension ? -1 : a.extension > b.extension ? 1 : 0) ||
        column(a) - column(b),
    );
  }

  /** Answer the other extension's question of which of our models is at a point (see topmostAt). */
  setHitTest(hitTest: HitTest | null): void {
    const shared = registry();
    const hitTests = { ...shared.hitTests };
    if (hitTest) hitTests[this.extensionId] = hitTest;
    else delete hitTests[this.extensionId];
    shared.hitTests = hitTests;
  }

  /** Mark a canvas as one of this extension's avatar canvases. */
  adopt(canvas: HTMLElement): void {
    canvas.setAttribute(OWNER_ATTRIBUTE, this.extensionId);
  }

  /**
   * Put this extension's canvases in `parent` (a shared layer, or the stage's
   * own host in the settings tab) with their stacking ranks, and keep every
   * avatar canvas there in rank order: later siblings draw on top.
   */
  place(parent: HTMLElement, canvases: Array<{ canvas: HTMLElement; rank: number }>): void {
    for (const { canvas, rank } of canvases) {
      canvas.setAttribute(RANK_ATTRIBUTE, String(rank));
      if (canvas.parentElement !== parent) parent.appendChild(canvas);
    }
    const ranked = [...parent.children].filter((child) => child.hasAttribute(RANK_ATTRIBUTE));
    const rankOf = (element: Element) => Number(element.getAttribute(RANK_ATTRIBUTE)) || 0;
    const sorted = [...ranked].sort((a, b) => rankOf(a) - rankOf(b));
    if (sorted.every((element, index) => element === ranked[index])) return;
    const end = ranked[ranked.length - 1]!.nextSibling;
    for (const element of sorted) parent.insertBefore(element, end);
  }

  /**
   * The model a pointer at this viewport point is on, from any extension: the
   * topmost avatar canvas there whose model covers the point. Null when
   * something else of the app is above the models there (a drawer, a modal, a
   * message or the input over a background model) or no model is under the
   * point. `through` says the chat is above a background model there but
   * draws nothing at the point (see seeThroughAt): a tap can reach the model,
   * but a press there must stay the chat's, to scroll or select text.
   */
  topmostAt(clientX: number, clientY: number): { extension: string; characterId: string; through: boolean } | null {
    const canvases = [...document.querySelectorAll<HTMLElement>(`[${OWNER_ATTRIBUTE}]`)];
    const previous = canvases.map((canvas) => canvas.style.pointerEvents);
    for (const canvas of canvases) canvas.style.pointerEvents = 'auto';
    let elements: Element[];
    try {
      elements = document.elementsFromPoint(clientX, clientY);
    } finally {
      canvases.forEach((canvas, index) => (canvas.style.pointerEvents = previous[index]!));
    }
    const hitTests = registry().hitTests ?? {};
    const background = findLayer('background');
    const behindChat = !!background?.querySelector(`[${OWNER_ATTRIBUTE}]`);
    let through = false;
    for (const element of elements) {
      const extension = element.getAttribute(OWNER_ATTRIBUTE);
      if (!extension) {
        if (behindChat && seeThroughAt(element, clientX, clientY)) {
          through = true;
          continue;
        }
        return null;
      }
      // Past the chat, only the background models are under the point.
      if (through && element.parentElement !== background) continue;
      const characterId = hitTests[extension]?.(element, clientX, clientY) ?? null;
      if (characterId) return { extension, characterId, through };
    }
    return null;
  }

  destroy(): void {
    window.removeEventListener(CHANGED_EVENT, this.listener);
    this.setHitTest(null);
    const shared = registry();
    if (shared.layers) delete shared.layers[this.extensionId];
    if (!(this.extensionId in shared.extensions)) return;
    delete shared.extensions[this.extensionId];
    window.dispatchEvent(new CustomEvent(CHANGED_EVENT, { detail: { extension: this.extensionId } }));
  }
}

// ── The model menu ───────────────────────────────────────────────────────────

/** An entry of the app's context menu (ctx.ui.showContextMenu). */
export interface MenuItem {
  key: string;
  label: string;
  type?: 'item' | 'divider';
  disabled?: boolean;
}

/** What a model menu entry does. */
export type MenuAction = 'front' | 'back';

/**
 * The menu a right-click or long press on a model shows when it shares the
 * stage with other models (a group chat): Send to front / Send to back. Null
 * when the model is alone on the stage. The same in both extensions.
 */
export function modelMenu(stack: Stacked[], columns: Columns, extension: string, characterId: string): MenuItem[] | null {
  const rank = stack.findIndex((item) => item.extension === extension && item.characterId === characterId);
  if (rank === -1 || !columns.index.has(characterId) || stack.length < 2) return null;
  const items: Array<MenuItem & { key: MenuAction }> = [
    { key: 'front', label: 'Send to front', disabled: rank === stack.length - 1 },
    { key: 'back', label: 'Send to back', disabled: rank === 0 },
  ];
  return items;
}

/** How long a touch has to stay still on a model to open its menu. */
export const LONG_PRESS_MS = 550;

// ── Tapping through the chat ─────────────────────────────────────────────────

/** Elements that take their own clicks. */
const INTERACTIVE_SELECTOR = [
  'input',
  'textarea',
  'select',
  'button',
  'a[href]',
  'label',
  'summary',
  'img',
  'video',
  'audio',
  'canvas',
  'svg',
  'iframe',
  'object',
  'embed',
  '[contenteditable]:not([contenteditable="false"])',
  '[role="button"]',
  '[role="textbox"]',
  '[role="menuitem"]',
  '[role="tab"]',
  '[role="slider"]',
  '[role="dialog"]',
].join(',');

/** Classes the extensions put on <html> to set the cursor everywhere while it's over a model. */
const OWN_CURSORS = '.live2d-avatars-hover, .live2d-avatars-tap, .spine-avatars-hover, .spine-avatars-tap';

/** Whether a computed color is see-through enough to show what's under it. */
function clearColor(color: string): boolean {
  if (color === 'transparent') return true;
  const match = /rgba?\(([^)]*)\)/.exec(color);
  if (!match) return false;
  const parts = match[1]!.split(/[\s,/]+/).filter(Boolean);
  return parts.length >= 4 && Number.parseFloat(parts[3]!) <= 0.02;
}

/**
 * Whether an element of the app draws nothing at this viewport point, so a
 * background model under it shows through there: no background, backdrop blur
 * or text of its own at the point, it's not a control or media, and the point
 * isn't on its scrollbar. That's the chat's own layout boxes (the chat body,
 * column, message list, the empty part of a message row) where they're empty.
 * Message cards, the input bar and any panel with a background stop a tap.
 */
function seeThroughAt(element: Element, clientX: number, clientY: number): boolean {
  if (!(element instanceof HTMLElement)) return false;
  if (element === document.documentElement || element === document.body) return false;
  if (element.closest(INTERACTIVE_SELECTOR)) return false;
  const style = getComputedStyle(element);
  if (!clearColor(style.backgroundColor) || style.backgroundImage !== 'none') return false;
  if (style.backdropFilter && style.backdropFilter !== 'none') return false;
  // A pointer or text cursor of the app's own (not the one the extensions set on the whole page over a model).
  if ((style.cursor === 'pointer' || style.cursor === 'text') && !document.documentElement.matches(OWN_CURSORS)) {
    return false;
  }
  // Its scrollbars: right of (or below) the content box.
  const rect = element.getBoundingClientRect();
  if (
    clientX > rect.left + element.clientLeft + element.clientWidth ||
    clientY > rect.top + element.clientTop + element.clientHeight
  ) {
    return false;
  }
  // Text right in this element (text in a child element shows up as that child).
  const range = document.createRange();
  for (const node of element.childNodes) {
    if (node.nodeType !== Node.TEXT_NODE || !node.textContent?.trim()) continue;
    range.selectNodeContents(node);
    for (const box of range.getClientRects()) {
      if (clientX >= box.left && clientX <= box.right && clientY >= box.top && clientY <= box.bottom) return false;
    }
  }
  return true;
}

// ── Shared layers ────────────────────────────────────────────────────────────

function findLayer(kind: LayerKind): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[${LAYER_ATTRIBUTE}="${kind}"]`);
}

/**
 * The element after this one, skipping the stage hosts older versions of the
 * extensions put before the chat body themselves (so the two don't keep
 * swapping places).
 */
function nextAfterOlderHosts(element: Element): Element | null {
  let next = element.nextElementSibling;
  while (next?.matches('.live2d-avatars-overlay, .spine-avatars-overlay')) next = next.nextElementSibling;
  return next;
}

/**
 * Move a layer to where it belongs. The front layer sits over the whole app,
 * like an app overlay mount (z-index 9990). The background layer goes in the
 * open chat view just before the chat body: at z-index 1 and after the text
 * scrim in the DOM (also 1), it paints above the wallpaper and scene layers (0)
 * and the scrim, which would wash the models out in light themes, and below
 * the wallpaper transition fade (2) and the chat itself (3). With no chat open
 * it sits at the end of the app root at z-index 0: above the app's backdrop
 * and global wallpaper but under <main> (1).
 */
function placeLayer(layer: HTMLElement, kind: LayerKind): void {
  const appRoot = document.querySelector('[data-app-root]') ?? document.body;
  if (kind === 'front') {
    layer.style.zIndex = '9990';
    if (layer.parentElement !== appRoot) appRoot.appendChild(layer);
    return;
  }
  const chatBody = document.querySelector('[data-component="ChatView"] > [data-lumiverse-surface="chat-body"]');
  const target = chatBody?.parentElement ?? appRoot;
  layer.style.zIndex = chatBody ? '1' : '0';
  if (layer.parentElement === target && (!chatBody || nextAfterOlderHosts(layer) === chatBody)) return;
  target.insertBefore(layer, chatBody);
}

/** The shared layer element both extensions draw their canvases in over the app, created if needed. */
export function avatarLayer(kind: LayerKind): HTMLElement {
  let layer = findLayer(kind);
  if (!layer) {
    layer = document.createElement('div');
    layer.setAttribute(LAYER_ATTRIBUTE, kind);
    layer.style.cssText = 'position: fixed; inset: 0; pointer-events: none;';
  }
  placeLayer(layer, kind);
  return layer;
}

/** Put the shared layers back in place, after the app replaced the chat view (another chat or page opened). */
export function placeAvatarLayers(): void {
  for (const kind of ['front', 'background'] as const) {
    const layer = findLayer(kind);
    if (layer) placeLayer(layer, kind);
  }
}

/** Remove shared layers nothing draws in any more. */
export function releaseAvatarLayers(): void {
  for (const kind of ['front', 'background'] as const) {
    const layer = findLayer(kind);
    if (layer && layer.childElementCount === 0) layer.remove();
  }
}
