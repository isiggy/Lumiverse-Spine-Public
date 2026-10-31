/**
 * Group chat columns and stacking, shared with the sibling avatar extension.
 * Keep this file the same in the Live2D Avatars and Spine Avatars repos.
 *
 * In a group chat the stage is split into equal columns, one per member with a
 * model, in member order. A member's model can be a Live2D model or a Spine
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
   * something else of the app is above the models there (a drawer, a modal, the
   * chat over a background model) or no model is under the point.
   */
  topmostAt(clientX: number, clientY: number): { extension: string; characterId: string } | null {
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
    for (const element of elements) {
      const extension = element.getAttribute(OWNER_ATTRIBUTE);
      if (!extension) return null;
      const characterId = hitTests[extension]?.(element, clientX, clientY) ?? null;
      if (characterId) return { extension, characterId };
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
