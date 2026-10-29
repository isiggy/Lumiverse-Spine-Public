/**
 * The Spine stage: owns the WebGL canvas, the loaded skeletons and their
 * animation states, the render loop, and interaction (drag to move, click to
 * play the click animation). The canvas is drawn into a Lumiverse app overlay
 * or the settings tab's preview box, like the Live2D Avatars extension.
 *
 * Every character in the chat that has a model gets one: one in a solo chat,
 * one per member in a group chat. The stage is split into equal columns, one
 * per member with a model, left to right in member order, and each model is
 * laid out inside its column as if that column were the whole stage. A solo
 * chat's single column is the whole stage. Members with a Live2D model (from
 * the Live2D Avatars extension) get columns too; see columns.ts.
 *
 * Layout model, all read from the per-model settings every frame:
 * - the model's reference bounds (its visible parts at frame 0 of the idle
 *   animation) are scaled to fit its column at zoom 1, then multiplied by zoom;
 * - the model rotates about the center of those bounds;
 * - x / y move that center as a percent of half the column's size;
 * - render scale sets the canvas's backing resolution, not the model's size.
 *   With several models the canvas uses the highest of their render scales.
 *
 * Each model is read and drawn by the Spine runtime for its editor version
 * (runtimes.ts). Models of different versions share the canvas: each runtime
 * gets its own renderer on the same WebGL context.
 */

import * as spine from '@esotericsoftware/spine-webgl';
import type { ModelAssets, ModelBundle } from './assets';
import { type Columns, SharedColumns, sameColumns } from './columns';
import { type SpineRuntime, runtimeFor } from './runtimes';
import { squareThumbnail, THUMBNAIL_RENDER_PIXELS } from './thumbnail';
import {
  type ModelDescription,
  type ModelRecord,
  type ModelSettings,
  type SpineRuntimeVersion,
  type SpineSettings,
  SETTINGS_LIMITS,
} from '../shared/settings';

/** Host UI under the pointer that must keep its clicks even where the model is drawn. */
const INTERACTIVE_SELECTOR = [
  'input',
  'textarea',
  'select',
  'button',
  'a[href]',
  'label',
  'summary',
  '[contenteditable]:not([contenteditable="false"])',
  '[role="button"]',
  '[role="textbox"]',
  '[role="menuitem"]',
  '[role="tab"]',
  '[role="slider"]',
].join(',');

/** Crossfade between animations on the same track, in seconds. */
const DEFAULT_MIX = 0.2;
/** Slots fainter than this don't count as part of the model (bounds and clicks). */
const MIN_VISIBLE_ALPHA = 0.05;
/** Longest frame step fed to the animation, so a backgrounded tab doesn't jump. */
const MAX_DELTA = 0.1;
/**
 * Most canvas pixels drawn at once (4096²). Browsers cap the drawing buffer's
 * area anyway, and a huge buffer can exhaust GPU memory and lose the context.
 */
const MAX_CANVAS_PIXELS = 4096 * 4096;
/** How long to wait for a lost WebGL context to come back before rebuilding the stage. */
const CONTEXT_RESTORE_WAIT_MS = 3000;
/** How long a model has been on stage before its first thumbnail is taken (its idle pose has settled). */
const THUMBNAIL_DELAY_MS = 1500;

export interface StageDeps {
  getSettings(): SpineSettings;
  getModelRecord(modelId: string): ModelRecord | undefined;
  /** Returns (creating if needed) the per-character per-model settings object. */
  getModelSettings(characterId: string, modelId: string, description: ModelDescription | null): ModelSettings;
  saveSettingsDebounced(): void;
  /** Whether the stage draws over the app (rather than in the settings tab), where other avatar extensions draw too. */
  drawsOverApp(): boolean;
  /** The stage changed the model's position or zoom itself (a drag). */
  layoutChanged(): void;
  assets: ModelAssets;
  /** Send a click interaction message into the chat, from a click on this character's model. */
  sendInteraction(message: string, characterId: string): void;
  /** Store a model's library thumbnail (an image data URL). */
  saveThumbnail(modelId: string, dataUrl: string): void;
  log(message: string): void;
}

interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** One runtime's renderer on the shared canvas. */
interface Renderer {
  context: spine.ManagedWebGLRenderingContext;
  shader: spine.Shader;
  batcher: spine.PolygonBatcher;
  renderer: spine.SkeletonRenderer;
  debugShader: spine.Shader | null;
  shapes: spine.ShapeRenderer | null;
  debugRenderer: spine.SkeletonDebugRenderer | null;
}

interface Gl {
  canvas: HTMLCanvasElement;
  context: WebGLRenderingContext;
  /** Created the first time a model of that runtime's version is drawn. */
  renderers: Map<SpineRuntimeVersion, Renderer>;
  mvp: spine.Matrix4;
  maxDimension: number;
  maxTextureSize: number;
  /** Set while a lost context hasn't been restored yet. */
  restoreTimer: number | null;
}

interface LoadedEntry {
  characterId: string;
  modelId: string;
  description: ModelDescription;
  runtime: SpineRuntime;
  atlas: spine.TextureAtlas;
  skeleton: spine.Skeleton;
  state: spine.AnimationState;
  /** Visible bounds at frame 0 of the idle animation, in skeleton units. */
  bounds: Bounds;
  textures: spine.GLTexture[];
  talkTimer: number | null;
  starterTimer: number | null;
  thumbnailTimer: number | null;
}

/** A model's column on the stage, in host CSS pixels. */
interface Slot {
  x: number;
  width: number;
  height: number;
}

/** skeleton (x, y) -> host CSS pixels: sx = a*x + c*y + e, sy = b*x + d*y + f */
interface Affine {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

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

/** A bundle file by path relative to `baseDir`, falling back to a case-insensitive match. */
function bundleFile(bundle: ModelBundle, baseDir: string, file: string): Blob | undefined {
  const resolved = normalizePath(baseDir ? `${baseDir}/${file}` : file);
  const exact = bundle.files.get(resolved);
  if (exact) return exact;
  const lower = resolved.toLowerCase();
  for (const [path, blob] of bundle.files) {
    if (path.toLowerCase() === lower) return blob;
  }
  return undefined;
}

/** Stand-in texture for parsing a skeleton without a GL context. Either runtime takes it. */
class NullTexture extends spine.Texture {
  constructor(width: number, height: number) {
    super({ width, height } as unknown as HTMLImageElement);
  }
  setFilters(): void {}
  setWraps(): void {}
  dispose(): void {}
}

/**
 * Parse the atlas with stand-in textures: mesh attachments read their page's
 * size while the skeleton loads. The stage swaps in GL textures afterwards.
 */
async function readAtlas(runtime: SpineRuntime, bundle: ModelBundle): Promise<spine.TextureAtlas> {
  const text = await bundle.files.get(bundle.atlasFile)?.text();
  if (text === undefined) throw new Error(`Atlas missing from bundle: ${bundle.atlasFile}`);
  const atlas = runtime.readAtlas(text);
  for (const page of atlas.pages) page.setTexture(new NullTexture(page.width || 1, page.height || 1));
  return atlas;
}

async function readSkeletonData(
  { spine }: SpineRuntime,
  bundle: ModelBundle,
  atlas: spine.TextureAtlas,
): Promise<spine.SkeletonData> {
  const file = bundle.files.get(bundle.skeletonFile);
  if (!file) throw new Error(`Skeleton missing from bundle: ${bundle.skeletonFile}`);
  const loader = new spine.AtlasAttachmentLoader(atlas);
  if (/\.json$/i.test(bundle.skeletonFile)) {
    return new spine.SkeletonJson(loader).readSkeletonData(await file.text());
  }
  return new spine.SkeletonBinary(loader).readSkeletonData(new Uint8Array(await file.arrayBuffer()));
}

function describeSkeleton(data: spine.SkeletonData, atlas: spine.TextureAtlas, record: ModelRecord): ModelDescription {
  return {
    animations: data.animations.map((animation) => ({ name: animation.name, duration: animation.duration })),
    skins: data.skins.map((skin) => skin.name),
    pma: atlas.pages.some((page) => page.pma) || record.pma,
  };
}

/** Run `visit` with the world-space triangles of every visible region and mesh attachment. */
function forEachVisibleTriangle(
  { spine }: SpineRuntime,
  skeleton: spine.Skeleton,
  visit: (vertices: ArrayLike<number>, triangles: ArrayLike<number>) => boolean | void,
): void {
  const vertices: number[] = [];
  for (const slot of skeleton.drawOrder) {
    if (!slot.bone.active) continue;
    const attachment = slot.getAttachment();
    if (!attachment) continue;
    let triangles: ArrayLike<number>;
    if (attachment instanceof spine.RegionAttachment) {
      if (skeleton.color.a * slot.color.a * attachment.color.a < MIN_VISIBLE_ALPHA) continue;
      vertices.length = 8;
      attachment.computeWorldVertices(slot, vertices, 0, 2);
      triangles = spine.SkeletonRenderer.QUAD_TRIANGLES;
    } else if (attachment instanceof spine.MeshAttachment) {
      if (skeleton.color.a * slot.color.a * attachment.color.a < MIN_VISIBLE_ALPHA) continue;
      vertices.length = attachment.worldVerticesLength;
      attachment.computeWorldVertices(slot, 0, attachment.worldVerticesLength, vertices, 0, 2);
      triangles = attachment.triangles;
    } else {
      continue;
    }
    if (visit(vertices, triangles) === true) return;
  }
}

function visibleBounds(runtime: SpineRuntime, skeleton: spine.Skeleton): Bounds | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  forEachVisibleTriangle(runtime, skeleton, (vertices) => {
    for (let i = 0; i + 1 < vertices.length; i += 2) {
      const x = vertices[i]!;
      const y = vertices[i + 1]!;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  });
  if (!Number.isFinite(minX) || maxX - minX <= 0 || maxY - minY <= 0) return null;
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** Give an atlas page without a `size:` line its image's size, and recompute its regions' UVs. */
function setPageSize(page: spine.TextureAtlasPage, width: number, height: number): void {
  page.width = width;
  page.height = height;
  for (const region of page.regions) {
    region.u = region.x / width;
    region.v = region.y / height;
    if (region.degrees === 90) {
      region.u2 = (region.x + region.height) / width;
      region.v2 = (region.y + region.width) / height;
    } else {
      region.u2 = (region.x + region.width) / width;
      region.v2 = (region.y + region.height) / height;
    }
  }
  // Mesh attachments read the page's size from its texture while the skeleton loads.
  if (page.texture instanceof NullTexture) page.setTexture(new NullTexture(width, height));
}

/**
 * Visible bounds at frame 0 of the idle animation (or the setup pose without
 * one), with the configured skin. Measured on a scratch skeleton so the one on
 * stage keeps its pose.
 */
function measureReferenceBounds(runtime: SpineRuntime, data: spine.SkeletonData, settings: ModelSettings): Bounds {
  const { spine } = runtime;
  const skeleton = new spine.Skeleton(data);
  const skin = (settings.skin && data.findSkin(settings.skin)) || data.defaultSkin;
  if (skin) skeleton.setSkin(skin);
  skeleton.setToSetupPose();
  const idle = settings.animation_idle !== 'none' ? data.findAnimation(settings.animation_idle) : null;
  if (idle) idle.apply(skeleton, 0, 0, false, [], 1, spine.MixBlend.setup, spine.MixDirection.mixIn);
  skeleton.updateWorldTransform();
  const bounds = visibleBounds(runtime, skeleton);
  if (bounds) return bounds;
  if (data.width > 0 && data.height > 0) return { x: data.x, y: data.y, width: data.width, height: data.height };
  return { x: -50, y: 0, width: 100, height: 100 };
}

/**
 * A runtime's shader, batcher and skeleton renderer for the canvas. Every
 * runtime asks the canvas for the same WebGL context, so they share it.
 */
function createRenderer({ spine }: SpineRuntime, canvas: HTMLCanvasElement): Renderer {
  const context = new spine.ManagedWebGLRenderingContext(canvas, {
    alpha: true,
    premultipliedAlpha: true,
    antialias: true,
    preserveDrawingBuffer: false,
  });
  if (!context.gl) throw new Error('WebGL is unavailable in this browser.');
  return {
    context,
    shader: spine.Shader.newTwoColoredTextured(context),
    batcher: new spine.PolygonBatcher(context, true),
    renderer: new spine.SkeletonRenderer(context, true),
    debugShader: null,
    shapes: null,
    debugRenderer: null,
  };
}

function pointInTriangle(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
): boolean {
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
  const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
  const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
  const hasNegative = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPositive = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNegative && hasPositive);
}

export class Stage {
  private host: HTMLElement | null = null;
  private gl: Gl | null = null;
  /** Models on stage, in draw order (left to right). */
  private loaded: LoadedEntry[] = [];
  private chatId: string | null = null;
  /** Characters in the chat, in member order. */
  private characterIds: string[] = [];
  /** Columns the stage is split into: one per member with a model, here or in the Live2D extension. */
  private columns: Columns = { count: 1, index: new Map() };
  private readonly sharedColumns: SharedColumns;
  private loadToken = 0;
  private frameRequest: number | null = null;
  private lastFrameTime = 0;
  private hostWidth = 0;
  private hostHeight = 0;
  private resizeObserver: ResizeObserver | null = null;
  private previousInteraction = { characterId: '', message: '' };
  private descriptionCache = new Map<string, ModelDescription>();
  private drag: { entry: LoadedEntry; pointerId: number; offsetX: number; offsetY: number; moved: boolean } | null =
    null;
  private suppressClick = false;
  private hoverFrame: number | null = null;
  private hovering = false;

  // The canvas never takes pointer events, so it can't block the chat UI drawn
  // under it. Model interaction is detected at the document level instead.
  private listeners: Array<[EventTarget, string, EventListener, AddEventListenerOptions]> = [
    [document, 'pointerdown', (event) => this.onPointerDown(event as PointerEvent), { capture: true }],
    [document, 'pointermove', (event) => this.onPointerMove(event as PointerEvent), { capture: true }],
    [document, 'pointerup', (event) => this.onPointerUp(event as PointerEvent), { capture: true }],
    [document, 'pointercancel', () => this.endDrag(), { capture: true }],
    [document, 'click', (event) => this.onClickCapture(event as MouseEvent), { capture: true }],
    [document, 'touchstart', (event) => this.drag && event.preventDefault(), { capture: true, passive: false }],
    [document, 'touchmove', (event) => this.drag && event.preventDefault(), { capture: true, passive: false }],
  ];

  constructor(private deps: StageDeps) {
    for (const [target, type, listener, options] of this.listeners) target.addEventListener(type, listener, options);
    this.sharedColumns = new SharedColumns('spine_avatars', () => this.updateColumns());
  }

  destroy(): void {
    for (const [target, type, listener, options] of this.listeners) {
      target.removeEventListener(type, listener, options);
    }
    if (this.hoverFrame !== null) window.cancelAnimationFrame(this.hoverFrame);
    this.hoverFrame = null;
    this.setHovering(false);
    this.teardown();
    this.sharedColumns.destroy();
  }

  /** Attach the stage to a host element (overlay mount root or embedded panel). */
  setHost(host: HTMLElement | null): void {
    if (this.host === host) return;
    this.teardown();
    this.host = host;
    void this.reload();
  }

  /** Show the models of these characters (the chat's members, in order). */
  setChatContext(chatId: string | null, characterIds: string[]): void {
    const unique = [...new Set(characterIds.filter(Boolean))];
    const changed =
      chatId !== this.chatId ||
      unique.length !== this.characterIds.length ||
      unique.some((id, index) => id !== this.characterIds[index]);
    this.chatId = chatId;
    this.characterIds = unique;
    if (changed) void this.reload();
  }

  getChatContext(): { chatId: string | null; characterIds: string[] } {
    return { chatId: this.chatId, characterIds: [...this.characterIds] };
  }

  /** Whether this character's model is loaded and drawn (optionally: this particular model). */
  isOnStage(characterId: string, modelId?: string): boolean {
    const entry = this.entryFor(characterId);
    return entry !== undefined && (modelId === undefined || entry.modelId === modelId);
  }

  /** Characters whose models are on stage, left to right. */
  charactersOnStage(): string[] {
    return this.loaded.map((entry) => entry.characterId);
  }

  getDescription(characterId: string): ModelDescription | null {
    return this.entryFor(characterId)?.description ?? null;
  }

  private entryFor(characterId: string): LoadedEntry | undefined {
    return this.loaded.find((entry) => entry.characterId === characterId);
  }

  /** Characters with a model in the library, by character. */
  private boundCharacters(settings: SpineSettings): Map<string, ModelRecord> {
    const bound = new Map<string, ModelRecord>();
    if (!settings.global.enabled) return bound;
    for (const [characterId, modelId] of Object.entries(settings.characterModelMapping)) {
      const record = modelId ? this.deps.getModelRecord(modelId) : undefined;
      if (record) bound.set(characterId, record);
    }
    return bound;
  }

  /**
   * Share which characters have a model here with the other avatar extension,
   * and take the columns for the chat's members. The render loop reads them
   * every frame, so a change shows on the next one.
   */
  private updateColumns(): void {
    const own = [...this.boundCharacters(this.deps.getSettings()).keys()];
    const overApp = this.host !== null && this.deps.drawsOverApp();
    this.sharedColumns.publish(overApp ? own : []);
    const columns = this.sharedColumns.layout(this.characterIds, own, overApp);
    if (sameColumns(columns, this.columns)) return;
    this.columns = columns;
    this.sortEntries();
  }

  /** Keep the draw order left to right, whatever order the models finish loading in. */
  private sortEntries(): void {
    const column = (entry: LoadedEntry) => this.columns.index.get(entry.characterId) ?? 0;
    this.loaded.sort((a, b) => column(a) - column(b));
  }

  /** Rebuild the whole stage from current settings + chat context. */
  async reload(): Promise<void> {
    this.teardown(); // bumps loadToken, cancelling any in-flight load
    const token = this.loadToken;
    // Columns are handed out up front, so a model that loads late (or fails)
    // doesn't shift the others.
    this.updateColumns();

    const settings = this.deps.getSettings();
    if (!settings.global.enabled || !this.host) return;
    const bound = this.boundCharacters(settings);
    const cast = this.characterIds.flatMap((characterId) => {
      const record = bound.get(characterId);
      return record ? [{ characterId, record }] : [];
    });
    if (cast.length === 0) return;

    // Each model appears as soon as it's ready; one failing doesn't stop the others.
    await Promise.all(
      cast.map(async ({ characterId, record }) => {
        let bundle: ModelBundle;
        try {
          bundle = await this.deps.assets.load(record);
        } catch (error) {
          this.deps.log(`Failed to download model "${record.name}": ${String(error)}`);
          return;
        }
        if (token !== this.loadToken || !this.host) return;
        try {
          await this.loadModel(characterId, record, bundle, token);
        } catch (error) {
          if (token === this.loadToken) this.deps.log(`Failed to load model "${record.name}": ${String(error)}`);
        }
      }),
    );
  }

  private createGl(host: HTMLElement, runtime: SpineRuntime): Gl {
    const canvas = document.createElement('canvas');
    canvas.className = 'spine-avatars-canvas';
    host.appendChild(canvas);
    try {
      const first = createRenderer(runtime, canvas);
      const gl = first.context.gl;
      const maxViewport = gl.getParameter(gl.MAX_VIEWPORT_DIMS) as Int32Array | null;
      const maxRenderbuffer = gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number;
      const result: Gl = {
        canvas,
        context: gl,
        renderers: new Map([[runtime.version, first]]),
        mvp: new runtime.spine.Matrix4(),
        maxDimension: Math.max(256, Math.min(maxRenderbuffer || 4096, maxViewport?.[0] ?? 4096, 8192)),
        maxTextureSize: (gl.getParameter(gl.MAX_TEXTURE_SIZE) as number) || 4096,
        restoreTimer: null,
      };
      // spine-webgl restores shaders, buffers and textures when the context comes
      // back. A context that never comes back (the browser evicted it, or ran out
      // of GPU memory) leaves a blank stage, so rebuild it after a while.
      canvas.addEventListener('webglcontextlost', () => {
        if (this.gl !== result || result.restoreTimer !== null) return;
        result.restoreTimer = window.setTimeout(() => {
          result.restoreTimer = null;
          if (this.gl !== result) return;
          this.deps.log('WebGL context was lost and not restored; reloading the model.');
          void this.reload();
        }, CONTEXT_RESTORE_WAIT_MS);
      });
      canvas.addEventListener('webglcontextrestored', () => {
        if (result.restoreTimer !== null) window.clearTimeout(result.restoreTimer);
        result.restoreTimer = null;
        // GLTexture.restore() resets filters and wraps to defaults; re-apply the atlas's.
        if (this.gl !== result) return;
        for (const entry of this.loaded) {
          entry.atlas.pages.forEach((page, index) => {
            const texture = entry.textures[index];
            if (texture) page.setTexture(texture);
          });
        }
      });
      return result;
    } catch (error) {
      canvas.remove();
      throw error;
    }
  }

  private async loadModel(
    characterId: string,
    record: ModelRecord,
    bundle: ModelBundle,
    token: number,
  ): Promise<void> {
    const host = this.host!;
    const runtime = runtimeFor(record);
    const atlas = await readAtlas(runtime, bundle);

    // Decode every atlas page before touching GL, so a cancelled load leaves nothing behind.
    const atlasDir = dirname(bundle.atlasFile);
    const images: ImageBitmap[] = [];
    const closeImages = () => images.forEach((image) => image.close());
    const cancelled = () => token !== this.loadToken || this.host !== host;
    let data: spine.SkeletonData;
    try {
      for (const page of atlas.pages) {
        const blob = bundleFile(bundle, atlasDir, page.name);
        if (!blob) throw new Error(`Atlas page image missing: ${page.name}`);
        // Upload the stored bytes as they are: premultiplication is the
        // premultiplied-alpha setting's job, not the decoder's.
        const image = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
        images.push(image);
        if (!page.width || !page.height) setPageSize(page, image.width, image.height);
      }
      if (cancelled()) return closeImages();
      data = await readSkeletonData(runtime, bundle, atlas);
    } catch (error) {
      closeImages();
      throw error;
    }
    if (cancelled()) return closeImages();

    const description = describeSkeleton(data, atlas, record);
    this.descriptionCache.set(`${record.id}@${record.version}`, description);
    const modelSettings = this.deps.getModelSettings(characterId, record.id, description);

    // The models share one canvas: the first one ready creates it.
    let gl = this.gl;
    let renderer: Renderer;
    try {
      if (!gl) {
        gl = this.createGl(host, runtime);
        this.gl = gl;
        this.observeSize(gl.canvas);
      }
      renderer = this.rendererFor(gl, runtime);
    } catch (error) {
      closeImages();
      throw error;
    }
    const textures: spine.GLTexture[] = [];
    try {
      atlas.pages.forEach((page, index) => {
        const image = images[index]!;
        if (Math.max(image.width, image.height) > gl.maxTextureSize) {
          this.deps.log(
            `Atlas page ${page.name} is ${image.width}x${image.height}, larger than this GPU's ` +
              `${gl.maxTextureSize}px texture limit; it may draw black.`,
          );
        }
        const texture = new runtime.spine.GLTexture(renderer.context, image);
        textures.push(texture);
        page.setTexture(texture);
      });
    } catch (error) {
      // Not yet owned by an entry, so teardown can't free these.
      textures.forEach((texture) => texture.dispose());
      closeImages();
      throw error;
    }

    const skeleton = new runtime.spine.Skeleton(data);
    const stateData = new runtime.spine.AnimationStateData(data);
    stateData.defaultMix = DEFAULT_MIX;
    const entry: LoadedEntry = {
      characterId,
      modelId: record.id,
      description,
      runtime,
      atlas,
      skeleton,
      state: new runtime.spine.AnimationState(stateData),
      bounds: { x: 0, y: 0, width: 1, height: 1 },
      textures,
      talkTimer: null,
      starterTimer: null,
      thumbnailTimer: null,
    };
    // Owned by the stage from here on, so teardown frees it on any later failure.
    this.loaded.push(entry);
    this.sortEntries();
    this.applySkinTo(entry, modelSettings);
    this.startIdle(entry, modelSettings);
    entry.bounds = measureReferenceBounds(runtime, data, modelSettings);

    if (this.frameRequest === null) {
      this.lastFrameTime = performance.now();
      this.frameRequest = window.requestAnimationFrame(this.frame);
    }

    const starter = modelSettings.animation_starter;
    if (starter.animation !== 'none') {
      entry.starterTimer = window.setTimeout(() => {
        entry.starterTimer = null;
        if (this.loaded.includes(entry)) this.playAnimation(characterId, starter.animation);
      }, Math.max(0, starter.delay));
    }

    // A model's first appearance gives the library its thumbnail.
    if (!record.thumbnail) {
      entry.thumbnailTimer = window.setTimeout(() => {
        entry.thumbnailTimer = null;
        if (!this.loaded.includes(entry) || this.deps.getModelRecord(record.id)?.thumbnail) return;
        const dataUrl = this.captureThumbnail(characterId);
        if (dataUrl) this.deps.saveThumbnail(record.id, dataUrl);
      }, THUMBNAIL_DELAY_MS);
    }
  }

  /**
   * A square picture of a character's model, upright and centered, as an image
   * data URL; null when it isn't on stage. The model is drawn alone into the
   * canvas's corner, copied, and the frame drawn again, all before the browser
   * shows the canvas, so nothing flickers.
   */
  captureThumbnail(characterId: string): string | null {
    const gl = this.gl;
    const entry = this.entryFor(characterId);
    const width = this.hostWidth;
    const height = this.hostHeight;
    if (!gl || !entry || width === 0 || height === 0 || gl.context.isContextLost()) return null;
    const pixels = Math.min(THUMBNAIL_RENDER_PIXELS, gl.canvas.width, gl.canvas.height);
    if (pixels < 32) return null;
    // The square in host CSS pixels, and the model's current pose fitted into it.
    const box = (pixels * width) / gl.canvas.width;
    const bounds = visibleBounds(entry.runtime, entry.skeleton) ?? entry.bounds;
    const scale = (box * 0.96) / Math.max(bounds.width, bounds.height);
    const centerX = bounds.x + bounds.width / 2;
    const centerY = bounds.y + bounds.height / 2;
    const fitted: Affine = { a: scale, b: 0, c: 0, d: -scale, e: box / 2 - scale * centerX, f: box / 2 + scale * centerY };
    const context = gl.context;
    try {
      context.viewport(0, 0, context.drawingBufferWidth, context.drawingBufferHeight);
      context.clearColor(0, 0, 0, 0);
      context.clear(context.COLOR_BUFFER_BIT);
      this.drawEntry(gl, entry, this.settingsFor(entry), width, height, fitted);
      return squareThumbnail(gl.canvas, pixels);
    } catch (error) {
      this.deps.log(`Thumbnail failed: ${String(error)}`);
      return null;
    } finally {
      this.draw(
        gl,
        this.loaded.map((other) => ({ entry: other, settings: this.settingsFor(other) })),
        width,
        height,
      );
    }
  }

  /** Track the canvas's CSS size: the area drawn into and hit-tested. */
  private observeSize(canvas: HTMLCanvasElement): void {
    const measure = () => {
      this.hostWidth = canvas.clientWidth;
      this.hostHeight = canvas.clientHeight;
    };
    measure();
    if (this.hostWidth === 0 || this.hostHeight === 0) {
      this.deps.log(`Stage host has no size yet (${this.hostWidth}x${this.hostHeight}); waiting for it to be shown.`);
    }
    this.resizeObserver = new ResizeObserver(measure);
    this.resizeObserver.observe(canvas);
  }

  /** Look up a per-model settings object without creating or reshaping it. */
  private settingsFor(entry: LoadedEntry): ModelSettings {
    const stored = this.deps.getSettings().characterModelsSettings[entry.characterId]?.[entry.modelId];
    return stored ?? this.deps.getModelSettings(entry.characterId, entry.modelId, entry.description);
  }

  // ── Render loop ───────────────────────────────────────────────────────────

  private frame = (now: number): void => {
    this.frameRequest = null;
    const gl = this.gl;
    if (this.loaded.length === 0 || !gl) return;
    this.frameRequest = window.requestAnimationFrame(this.frame);

    const delta = Math.min(MAX_DELTA, Math.max(0, (now - this.lastFrameTime) / 1000));
    this.lastFrameTime = now;
    let renderScale = 0;
    const drawn: Array<{ entry: LoadedEntry; settings: ModelSettings }> = [];
    for (const entry of this.loaded) {
      const settings = this.settingsFor(entry);
      entry.state.update(delta * settings.speed);
      entry.state.apply(entry.skeleton);
      entry.skeleton.updateWorldTransform();
      renderScale = Math.max(renderScale, settings.renderScale);
      drawn.push({ entry, settings });
    }

    const width = this.hostWidth;
    const height = this.hostHeight;
    if (width === 0 || height === 0 || gl.context.isContextLost()) return;
    this.resizeCanvas(gl, width, height, renderScale);
    this.draw(gl, drawn, width, height);
  };

  private resizeCanvas(gl: Gl, width: number, height: number, renderScale: number): void {
    const density = (window.devicePixelRatio || 1) * renderScale;
    let pixelWidth = Math.max(1, Math.round(width * density));
    let pixelHeight = Math.max(1, Math.round(height * density));
    const shrink = Math.min(
      1,
      gl.maxDimension / Math.max(pixelWidth, pixelHeight),
      Math.sqrt(MAX_CANVAS_PIXELS / (pixelWidth * pixelHeight)),
    );
    if (shrink < 1) {
      pixelWidth = Math.max(1, Math.floor(pixelWidth * shrink));
      pixelHeight = Math.max(1, Math.floor(pixelHeight * shrink));
    }
    if (gl.canvas.width !== pixelWidth) gl.canvas.width = pixelWidth;
    if (gl.canvas.height !== pixelHeight) gl.canvas.height = pixelHeight;
  }

  private draw(
    gl: Gl,
    drawn: Array<{ entry: LoadedEntry; settings: ModelSettings }>,
    width: number,
    height: number,
  ): void {
    const context = gl.context;
    // The browser may give the canvas a smaller buffer than asked for; draw into what it has.
    context.viewport(0, 0, context.drawingBufferWidth, context.drawingBufferHeight);
    context.clearColor(0, 0, 0, 0);
    context.clear(context.COLOR_BUFFER_BIT);
    const showBounds = this.deps.getSettings().global.showBounds;
    for (const { entry, settings } of drawn) {
      this.drawEntry(gl, entry, settings, width, height);
      if (showBounds) this.drawDebug(gl, entry, gl.mvp.values);
    }
  }

  private drawEntry(
    gl: Gl,
    entry: LoadedEntry,
    settings: ModelSettings,
    width: number,
    height: number,
    t: Affine = this.transform(entry, settings, width, height),
  ): void {
    // Host CSS pixels -> clip space, folded into the skeleton transform.
    const m = gl.mvp.values;
    m.fill(0);
    m[spine.M00] = (2 * t.a) / width;
    m[spine.M01] = (2 * t.c) / width;
    m[spine.M03] = (2 * t.e) / width - 1;
    m[spine.M10] = (-2 * t.b) / height;
    m[spine.M11] = (-2 * t.d) / height;
    m[spine.M13] = 1 - (2 * t.f) / height;
    m[spine.M22] = 1;
    m[spine.M33] = 1;

    const r = this.rendererFor(gl, entry.runtime);
    r.shader.bind();
    r.shader.setUniformi(spine.Shader.SAMPLER, 0);
    r.shader.setUniform4x4f(spine.Shader.MVP_MATRIX, m);
    r.renderer.premultipliedAlpha = settings.premultipliedAlpha;
    r.batcher.begin(r.shader);
    r.renderer.draw(r.batcher, entry.skeleton);
    r.batcher.end();
    r.shader.unbind();
  }

  /** The renderer for a runtime's models, created on first use. */
  private rendererFor(gl: Gl, runtime: SpineRuntime): Renderer {
    let renderer = gl.renderers.get(runtime.version);
    if (!renderer) {
      renderer = createRenderer(runtime, gl.canvas);
      gl.renderers.set(runtime.version, renderer);
    }
    return renderer;
  }

  private drawDebug(gl: Gl, entry: LoadedEntry, mvp: Float32Array): void {
    const { spine } = entry.runtime;
    const r = this.rendererFor(gl, entry.runtime);
    if (!r.debugShader) {
      r.debugShader = spine.Shader.newColored(r.context);
      r.shapes = new spine.ShapeRenderer(r.context);
      r.debugRenderer = new spine.SkeletonDebugRenderer(r.context);
      r.debugRenderer.drawMeshTriangles = false;
    }
    const shader = r.debugShader;
    const shapes = r.shapes!;
    shader.bind();
    shader.setUniform4x4f(spine.Shader.MVP_MATRIX, mvp);
    shapes.begin(shader);
    r.debugRenderer!.draw(shapes, entry.skeleton);
    const { x, y, width, height } = entry.bounds;
    shapes.setColor(new spine.Color(1, 0.6, 0, 1));
    shapes.rect(false, x, y, width, height);
    shapes.end();
    shader.unbind();
  }

  // ── Layout ────────────────────────────────────────────────────────────────

  /** The model's column for this stage size. */
  private slotOf(entry: LoadedEntry, width: number, height: number): Slot {
    const slotWidth = width / Math.max(1, this.columns.count);
    return { x: slotWidth * (this.columns.index.get(entry.characterId) ?? 0), width: slotWidth, height };
  }

  /** The skeleton -> host-pixel transform for the current settings and stage size. */
  private transform(entry: LoadedEntry, settings: ModelSettings, stageWidth: number, stageHeight: number): Affine {
    const { x: left, width, height } = this.slotOf(entry, stageWidth, stageHeight);
    const bounds = entry.bounds;
    const fit = Math.min(width / bounds.width, height / bounds.height);
    const scale = fit * settings.zoom;
    const angle = (settings.rotation * Math.PI) / 180;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const centerX = bounds.x + bounds.width / 2;
    const centerY = bounds.y + bounds.height / 2;
    const targetX = left + width / 2 + ((width / 2) * settings.x) / 100;
    const targetY = height / 2 + ((height / 2) * settings.y) / 100;
    // Skeleton space is y-up and the screen is y-down; rotation is clockwise on screen.
    const a = scale * cos;
    const c = scale * sin;
    const b = scale * sin;
    const d = -scale * cos;
    return { a, b, c, d, e: targetX - a * centerX - c * centerY, f: targetY - b * centerX - d * centerY };
  }

  private toSkeletonPoint(entry: LoadedEntry, x: number, y: number): { x: number; y: number } {
    const t = this.transform(entry, this.settingsFor(entry), this.hostWidth, this.hostHeight);
    const det = t.a * t.d - t.b * t.c;
    if (det === 0) return { x: NaN, y: NaN };
    const u = x - t.e;
    const v = y - t.f;
    return { x: (t.d * u - t.c * v) / det, y: (-t.b * u + t.a * v) / det };
  }

  /**
   * Zoom so the whole model fits its column at its current rotation, and center it.
   * Returns false when the model isn't on stage.
   */
  fitToCanvas(characterId: string, modelId: string): boolean {
    const entry = this.entryFor(characterId);
    if (!entry || entry.modelId !== modelId) return false;
    if (this.hostWidth === 0 || this.hostHeight === 0) return false;
    const { width, height } = this.slotOf(entry, this.hostWidth, this.hostHeight);
    const settings = this.settingsFor(entry);
    const { width: boundsWidth, height: boundsHeight } = entry.bounds;
    const angle = (settings.rotation * Math.PI) / 180;
    const cos = Math.abs(Math.cos(angle));
    const sin = Math.abs(Math.sin(angle));
    const rotatedWidth = cos * boundsWidth + sin * boundsHeight;
    const rotatedHeight = sin * boundsWidth + cos * boundsHeight;
    const fitRotated = Math.min(width / rotatedWidth, height / rotatedHeight);
    const fitUpright = Math.min(width / boundsWidth, height / boundsHeight);
    const { min, max } = SETTINGS_LIMITS.zoom;
    // Round down so the fitted model never overflows the stage.
    settings.zoom = Math.min(max, Math.max(min, Math.floor((fitRotated / fitUpright) * 100) / 100));
    settings.x = 0;
    settings.y = 0;
    this.deps.saveSettingsDebounced();
    return true;
  }

  // ── Skin and animation ────────────────────────────────────────────────────

  private findAnimation(entry: LoadedEntry, name: string): spine.Animation | null {
    if (!name || name === 'none') return null;
    return entry.skeleton.data.findAnimation(name);
  }

  private applySkinTo(entry: LoadedEntry, settings: ModelSettings): void {
    const { skeleton } = entry;
    const skin = (settings.skin && skeleton.data.findSkin(settings.skin)) || skeleton.data.defaultSkin;
    if (skin) skeleton.setSkin(skin);
    skeleton.setSlotsToSetupPose();
  }

  private startIdle(entry: LoadedEntry, settings: ModelSettings): void {
    const idle = this.findAnimation(entry, settings.animation_idle);
    if (idle) entry.state.setAnimation(0, idle.name, true);
    else entry.state.setEmptyAnimation(0, DEFAULT_MIX);
  }

  /** Re-apply the skin after the setting changes. The reference bounds follow it, as on the next load. */
  applySkin(characterId: string): void {
    const entry = this.entryFor(characterId);
    if (!entry) return;
    const settings = this.settingsFor(entry);
    this.applySkinTo(entry, settings);
    entry.bounds = measureReferenceBounds(entry.runtime, entry.skeleton.data, settings);
  }

  /** Switch to the idle animation after the setting changes. The reference bounds follow it, as on the next load. */
  applyIdle(characterId: string): void {
    const entry = this.entryFor(characterId);
    if (!entry) return;
    const settings = this.settingsFor(entry);
    this.startIdle(entry, settings);
    entry.bounds = measureReferenceBounds(entry.runtime, entry.skeleton.data, settings);
  }

  /** Play an animation once on a character's base track, then go back to idling. */
  playAnimation(characterId: string, name: string): void {
    const entry = this.entryFor(characterId);
    if (!entry) return;
    const animation = this.findAnimation(entry, name);
    if (!animation) return;
    entry.state.setAnimation(0, animation.name, false);
    const idle = this.findAnimation(entry, this.settingsFor(entry).animation_idle);
    if (idle) entry.state.addAnimation(0, idle.name, true, 0);
    else entry.state.addEmptyAnimation(0, DEFAULT_MIX, 0);
  }

  /** Loop a character's talk animation on its own track for a time based on the message length. */
  playTalk(characterId: string, textLength: number): void {
    const entry = this.entryFor(characterId);
    if (!entry || textLength <= 0) return;
    const settings = this.settingsFor(entry);
    const talk = this.findAnimation(entry, settings.animation_talk);
    if (!talk) return;
    if (entry.talkTimer !== null) window.clearTimeout(entry.talkTimer);
    const current = entry.state.getCurrent(1);
    if (current?.animation?.name !== talk.name) {
      // Fade in from nothing instead of popping to full strength.
      if (!current) entry.state.setEmptyAnimation(1, 0);
      entry.state.addAnimation(1, talk.name, true, 0).mixDuration = DEFAULT_MIX;
    }
    const speed = Math.max(0.05, settings.speed);
    const duration = (textLength * settings.talk_time_per_character) / speed;
    entry.talkTimer = window.setTimeout(() => {
      entry.talkTimer = null;
      if (this.loaded.includes(entry)) entry.state.setEmptyAnimation(1, DEFAULT_MIX);
    }, duration);
  }

  // ── Descriptions ──────────────────────────────────────────────────────────

  /** Read a model's animations and skins (downloading its files if needed). */
  async describeModel(record: ModelRecord): Promise<ModelDescription> {
    const key = `${record.id}@${record.version}`;
    const cached = this.descriptionCache.get(key);
    if (cached) return cached;
    const runtime = runtimeFor(record);
    const bundle = await this.deps.assets.load(record);
    const atlas = await readAtlas(runtime, bundle);
    const data = await readSkeletonData(runtime, bundle, atlas);
    const description = describeSkeleton(data, atlas, record);
    this.descriptionCache.set(key, description);
    return description;
  }

  // ── Interaction ───────────────────────────────────────────────────────────

  /**
   * The model a pointer event at this position belongs to, or null: the
   * canvas must be the topmost layer there (no drawer or modal above it), the
   * element underneath must not be a control (input, button, link…), and the
   * point must fall on one of a model's visible drawn parts. Where models
   * overlap, the one drawn on top wins.
   */
  private modelAt(event: PointerEvent): LoadedEntry | null {
    const canvas = this.gl?.canvas;
    if (this.loaded.length === 0 || !canvas) return null;
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest(INTERACTIVE_SELECTOR)) return null;

    const previous = canvas.style.pointerEvents;
    canvas.style.pointerEvents = 'auto';
    const topmost = document.elementFromPoint(event.clientX, event.clientY);
    canvas.style.pointerEvents = previous;
    if (topmost !== canvas) return null;

    const point = this.toStagePoint(event);
    for (let i = this.loaded.length - 1; i >= 0; i--) {
      const entry = this.loaded[i]!;
      if (this.isOverModel(entry, point.x, point.y)) return entry;
    }
    return null;
  }

  private isOverModel(entry: LoadedEntry, stageX: number, stageY: number): boolean {
    const point = this.toSkeletonPoint(entry, stageX, stageY);
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return false;
    let hit = false;
    try {
      forEachVisibleTriangle(entry.runtime, entry.skeleton, (vertices, triangles) => {
        for (let i = 0; i + 2 < triangles.length; i += 3) {
          const p = triangles[i]! * 2;
          const q = triangles[i + 1]! * 2;
          const r = triangles[i + 2]! * 2;
          if (
            pointInTriangle(
              point.x,
              point.y,
              vertices[p]!,
              vertices[p + 1]!,
              vertices[q]!,
              vertices[q + 1]!,
              vertices[r]!,
              vertices[r + 1]!,
            )
          ) {
            hit = true;
            return true;
          }
        }
        return false;
      });
    } catch {
      /* model torn down mid-check */
    }
    return hit;
  }

  /** The model's center in host pixels. */
  private modelCenter(entry: LoadedEntry): { x: number; y: number } {
    const settings = this.settingsFor(entry);
    const slot = this.slotOf(entry, this.hostWidth, this.hostHeight);
    return {
      x: slot.x + slot.width / 2 + ((slot.width / 2) * settings.x) / 100,
      y: slot.height / 2 + ((slot.height / 2) * settings.y) / 100,
    };
  }

  private onPointerDown(event: PointerEvent): void {
    if (event.button !== 0) return;
    const entry = this.modelAt(event);
    if (!entry) return;
    event.preventDefault();
    event.stopPropagation();
    const point = this.toStagePoint(event);
    const center = this.modelCenter(entry);
    this.drag = {
      entry,
      pointerId: event.pointerId,
      offsetX: point.x - center.x,
      offsetY: point.y - center.y,
      moved: false,
    };
    this.suppressClick = true;
  }

  private onPointerMove(event: PointerEvent): void {
    const drag = this.drag;
    if (drag && event.pointerId === drag.pointerId) {
      event.preventDefault();
      event.stopPropagation();
      this.dragTo(drag, event);
      return;
    }
    if (this.loaded.length === 0) return;
    if (event.pointerType === 'mouse' && this.hoverFrame === null) {
      this.hoverFrame = window.requestAnimationFrame(() => {
        this.hoverFrame = null;
        this.setHovering(this.modelAt(event) !== null);
      });
    }
  }

  private dragTo(drag: NonNullable<Stage['drag']>, event: PointerEvent): void {
    const { entry } = drag;
    if (!this.loaded.includes(entry) || this.hostWidth === 0 || this.hostHeight === 0) return;
    const point = this.toStagePoint(event);
    const center = this.modelCenter(entry);
    const newX = point.x - drag.offsetX;
    const newY = point.y - drag.offsetY;
    if (!drag.moved && Math.abs(newX - center.x) < 3 && Math.abs(newY - center.y) < 3) return;
    drag.moved = true;
    // Persist as percent offsets of the model's center from its column's center.
    const settings = this.settingsFor(entry);
    const slot = this.slotOf(entry, this.hostWidth, this.hostHeight);
    const { min, max } = SETTINGS_LIMITS.offset;
    const percent = (value: number) => Math.min(max, Math.max(min, Math.round(value * 100) / 100));
    settings.x = percent(((newX - slot.x - slot.width / 2) / (slot.width / 2)) * 100);
    settings.y = percent(((newY - slot.height / 2) / (slot.height / 2)) * 100);
    this.deps.saveSettingsDebounced();
    this.deps.layoutChanged();
  }

  private onPointerUp(event: PointerEvent): void {
    const drag = this.drag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    this.endDrag();
    if (!drag.moved && this.loaded.includes(drag.entry)) this.onModelClick(drag.entry);
  }

  private endDrag(): void {
    this.drag = null;
    // The browser dispatches `click` right after `pointerup`; if the pointer was
    // released over a different element no click comes, so stop suppressing.
    window.setTimeout(() => {
      this.suppressClick = false;
    }, 0);
  }

  private onClickCapture(event: MouseEvent): void {
    if (!this.suppressClick) return;
    this.suppressClick = false;
    event.preventDefault();
    event.stopPropagation();
  }

  private setHovering(hovering: boolean): void {
    if (hovering === this.hovering) return;
    this.hovering = hovering;
    document.documentElement.classList.toggle('spine-avatars-hover', hovering);
  }

  private toStagePoint(event: PointerEvent): { x: number; y: number } {
    const rect = this.gl?.canvas.getBoundingClientRect();
    return { x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) };
  }

  private onModelClick(entry: LoadedEntry): void {
    const click = this.settingsFor(entry).animation_click;
    if (click.message) {
      if (
        this.previousInteraction.characterId === entry.characterId &&
        this.previousInteraction.message === click.message
      ) {
        this.deps.log('Same as last interaction, message not sent again.');
      } else {
        this.previousInteraction = { characterId: entry.characterId, message: click.message };
        this.deps.sendInteraction(click.message, entry.characterId);
      }
    }
    if (click.animation !== 'none') this.playAnimation(entry.characterId, click.animation);
  }

  // ── Teardown ──────────────────────────────────────────────────────────────

  private teardown(): void {
    this.loadToken++;
    // A press that started on the model won't get its pointerup handled now,
    // so don't leave the next click anywhere swallowed.
    if (this.drag) this.suppressClick = false;
    this.drag = null;
    this.setHovering(false);
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    if (this.frameRequest !== null) {
      window.cancelAnimationFrame(this.frameRequest);
      this.frameRequest = null;
    }
    const entries = this.loaded;
    this.loaded = [];
    for (const entry of entries) {
      if (entry.talkTimer !== null) window.clearTimeout(entry.talkTimer);
      if (entry.starterTimer !== null) window.clearTimeout(entry.starterTimer);
      if (entry.thumbnailTimer !== null) window.clearTimeout(entry.thumbnailTimer);
      for (const texture of entry.textures) {
        try {
          texture.dispose();
        } catch {
          /* context already lost */
        }
        (texture.getImage() as ImageBitmap | null)?.close?.();
      }
    }
    const gl = this.gl;
    this.gl = null;
    if (gl) {
      if (gl.restoreTimer !== null) window.clearTimeout(gl.restoreTimer);
      for (const renderer of gl.renderers.values()) {
        for (const disposable of [renderer.batcher, renderer.shader, renderer.debugShader, renderer.shapes]) {
          try {
            disposable?.dispose();
          } catch {
            /* context already lost */
          }
        }
      }
      // Free the GPU context now instead of whenever the canvas is collected;
      // browsers cap how many live WebGL contexts a page may hold.
      try {
        gl.context.getExtension('WEBGL_lose_context')?.loseContext();
      } catch {
        /* unsupported */
      }
      gl.canvas.remove();
    }
  }
}
