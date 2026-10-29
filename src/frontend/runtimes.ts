/**
 * The Spine runtimes the stage draws with. Each Spine editor version has its
 * own skeleton format, so a model is read and drawn by the runtime for its
 * version: spine-webgl 4.1 from npm, or spine-ts 3.8 from vendor/.
 *
 * For everything the stage uses, 3.8 has the same classes under the same names
 * (its WebGL ones under `spine.webgl`), so its namespace is flattened and typed
 * as 4.1's. Where the two differ, this module makes 3.8 behave like 4.1:
 * - atlases: 3.8's parser can't read a 4.x atlas (the `pma:` line breaks it),
 *   so every atlas is parsed by 4.1's and copied into 3.8's classes;
 * - atlas pages get 4.1's setTexture() (3.8 regions keep their own texture);
 * - RegionAttachment.computeWorldVertices takes the slot, as in 4.1, not the bone;
 * - blending: 3.8 blends alpha like color, see patchBlending38().
 */

import * as spine41 from '@esotericsoftware/spine-webgl';
import spine38Namespace from '../../vendor/spine-webgl-3.8.js';
import { type ModelRecord, type SpineRuntimeVersion, spineRuntimeFor } from '../shared/settings';

export type Spine = typeof spine41;

export interface SpineRuntime {
  version: SpineRuntimeVersion;
  spine: Spine;
  /** Parse an atlas. Its pages have no texture yet. */
  readAtlas(text: string): spine41.TextureAtlas;
}

// The canvas is transparent and composited over the app. Additive slots (glows)
// must not add alpha, or they'd darken the page behind them instead of
// brightening it: keep the destination's alpha by using ZERO for the source's.
(spine41.PolygonBatcher as unknown as { blendModesGL: Array<{ srcAlpha: number }> }).blendModesGL[
  spine41.BlendMode.Additive
]!.srcAlpha = 0; // GL_ZERO

const runtime41: SpineRuntime = {
  version: '4.1',
  spine: spine41,
  readAtlas: (text) => new spine41.TextureAtlas(text),
};

// The 3.8 runtime is untyped.
const ns38 = spine38Namespace as any;
const spine38 = { ...ns38, ...ns38.webgl } as Spine;

/**
 * 3.8 blends with glBlendFunc, so alpha gets the color's factors: a
 * non-premultiplied slot writes alpha², and additive slots add alpha. Use 4.1's
 * factors for alpha instead: ONE for the source (ZERO for additive, as above),
 * and the color's destination factor.
 */
function patchBlending38(): void {
  const batcher = ns38.webgl.PolygonBatcher.prototype;
  const blend = (gl: WebGLRenderingContext, src: number, dst: number) =>
    gl.blendFuncSeparate(src, dst, dst === gl.ONE ? gl.ZERO : gl.ONE, dst);
  const begin = batcher.begin;
  batcher.begin = function (this: any, shader: unknown) {
    begin.call(this, shader);
    blend(this.context.gl, this.srcBlend, this.dstBlend);
  };
  const setBlendMode = batcher.setBlendMode;
  batcher.setBlendMode = function (this: any, src: number, dst: number) {
    setBlendMode.call(this, src, dst);
    if (this.isDrawing) blend(this.context.gl, src, dst);
  };
}

function patchClasses38(): void {
  ns38.TextureAtlasPage.prototype.setTexture = function (this: any, texture: any) {
    this.texture = texture;
    texture.setFilters(this.minFilter, this.magFilter);
    texture.setWraps(this.uWrap, this.vWrap);
    for (const region of this.regions) region.texture = texture;
  };
  const computeWorldVertices = ns38.RegionAttachment.prototype.computeWorldVertices;
  ns38.RegionAttachment.prototype.computeWorldVertices = function (this: any, slotOrBone: any, ...rest: unknown[]) {
    const bone = slotOrBone instanceof ns38.Slot ? slotOrBone.bone : slotOrBone;
    return computeWorldVertices.call(this, bone, ...rest);
  };
}

patchBlending38();
patchClasses38();

/** A 4.1-parsed atlas as 3.8 atlas objects, with the fields 3.8's parser would set (plus `pma` and `regions`). */
function convertAtlas38(source: spine41.TextureAtlas): spine41.TextureAtlas {
  const atlas = new ns38.TextureAtlas('', () => null);
  for (const sourcePage of source.pages) {
    const page = new ns38.TextureAtlasPage();
    Object.assign(page, {
      name: sourcePage.name,
      minFilter: sourcePage.minFilter,
      magFilter: sourcePage.magFilter,
      uWrap: sourcePage.uWrap,
      vWrap: sourcePage.vWrap,
      width: sourcePage.width,
      height: sourcePage.height,
      pma: sourcePage.pma,
      regions: [],
      texture: null,
    });
    atlas.pages.push(page);
    for (const sourceRegion of sourcePage.regions) {
      const region = new ns38.TextureAtlasRegion();
      Object.assign(region, {
        name: sourceRegion.name,
        page,
        x: sourceRegion.x,
        y: sourceRegion.y,
        width: sourceRegion.width,
        height: sourceRegion.height,
        u: sourceRegion.u,
        v: sourceRegion.v,
        u2: sourceRegion.u2,
        v2: sourceRegion.v2,
        degrees: sourceRegion.degrees,
        rotate: sourceRegion.degrees === 90,
        offsetX: sourceRegion.offsetX,
        offsetY: sourceRegion.offsetY,
        originalWidth: sourceRegion.originalWidth,
        originalHeight: sourceRegion.originalHeight,
        index: sourceRegion.index,
        texture: null,
      });
      page.regions.push(region);
      atlas.regions.push(region);
    }
  }
  return atlas;
}

const runtime38: SpineRuntime = {
  version: '3.8',
  spine: spine38,
  readAtlas: (text) => convertAtlas38(new spine41.TextureAtlas(text)),
};

const RUNTIMES: Record<SpineRuntimeVersion, SpineRuntime> = { '4.1': runtime41, '3.8': runtime38 };

/** The runtime that plays a model's skeleton. */
export function runtimeFor(record: ModelRecord): SpineRuntime {
  const version = spineRuntimeFor(record.spineVersion);
  if (!version) throw new Error(`Spine ${record.spineVersion} skeletons aren't supported.`);
  return RUNTIMES[version];
}
