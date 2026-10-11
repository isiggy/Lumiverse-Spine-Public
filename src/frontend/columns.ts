/**
 * Group chat columns, shared with the sibling avatar extension. Keep this file
 * the same in the Live2D Avatars and Spine Avatars repos.
 *
 * In a group chat the stage is split into equal columns, one per member with a
 * model, in member order. A member's model can be a Live2D model or a Spine
 * model, and each extension draws on its own canvas, so both have to count the
 * columns the same way. Each extension publishes which characters it has a
 * model for on a registry on `window` (extension frontends run in the same
 * page), and lays its own models out in the columns of the chat's members that
 * have a model in any extension. With one extension installed, the registry
 * only holds its own entry and the columns are its own models.
 */

const REGISTRY_KEY = '__lumiverseAvatarColumns';
const CHANGED_EVENT = 'lumiverse-avatar-columns-changed';

interface Registry {
  version: 1;
  /** extension id -> characters it draws a model for over the app */
  extensions: Record<string, string[]>;
}

export interface Columns {
  /** How many columns the stage is split into (at least 1). */
  count: number;
  /** character id -> column, counted from the left */
  index: Map<string, number>;
}

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

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

export function sameColumns(a: Columns, b: Columns): boolean {
  if (a.count !== b.count || a.index.size !== b.index.size) return false;
  for (const [characterId, column] of a.index) {
    if (b.index.get(characterId) !== column) return false;
  }
  return true;
}

export class SharedColumns {
  private published: string[] | null = null;
  private readonly listener = (event: Event) => {
    if ((event as CustomEvent<{ extension?: string }>).detail?.extension !== this.extensionId) this.onChange();
  };

  /** `onChange` runs when another extension's characters change. */
  constructor(
    private readonly extensionId: string,
    private readonly onChange: () => void,
  ) {
    window.addEventListener(CHANGED_EVENT, this.listener);
  }

  /**
   * Say which characters this extension draws a model for over the app. Empty
   * when it draws nothing there (turned off, or drawing in its own tab).
   */
  publish(characterIds: string[]): void {
    const sorted = [...new Set(characterIds)].sort();
    if (this.published && sameList(sorted, this.published)) return;
    this.published = sorted;
    registry().extensions[this.extensionId] = sorted;
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

  destroy(): void {
    window.removeEventListener(CHANGED_EVENT, this.listener);
    const extensions = registry().extensions;
    if (!(this.extensionId in extensions)) return;
    delete extensions[this.extensionId];
    window.dispatchEvent(new CustomEvent(CHANGED_EVENT, { detail: { extension: this.extensionId } }));
  }
}
