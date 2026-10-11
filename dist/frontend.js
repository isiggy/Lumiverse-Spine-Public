/*! Includes the Spine Runtimes, Copyright (c) 2013-2019 Esoteric Software LLC, under the Spine Runtimes License Agreement in LICENSE-spine-runtimes. */

// src/frontend/assets.ts
var CACHE_NAME = "spine_avatars_v1";
var WINDOW = 4;
var MANIFEST_RETRY_MS = 15000;
var CHUNK_RETRY_MS = 20000;
var MAX_ATTEMPTS = 4;
var STALL_MS = 90000;
function base64ToBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0;i < binary.length; i++)
    bytes[i] = binary.charCodeAt(i);
  return bytes;
}
function cacheUrl(modelId, version, path) {
  return `${window.location.origin}/__spine_avatars__/${encodeURIComponent(modelId)}/${version}/${path.split("/").map(encodeURIComponent).join("/")}`;
}
async function openCache() {
  try {
    return await caches.open(CACHE_NAME);
  } catch {
    return null;
  }
}
var chunkKey = (path, seq) => `${seq}:${path}`;

class ModelAssets {
  sendToBackend;
  transfers = new Map;
  memory = new Map;
  progressByModel = new Map;
  nextReq = 1;
  constructor(sendToBackend) {
    this.sendToBackend = sendToBackend;
  }
  handleMessage(msg) {
    switch (msg.type) {
      case "model_manifest": {
        const transfer = this.transfers.get(msg.reqId);
        if (transfer && !transfer.manifest)
          this.onManifest(transfer, msg);
        return true;
      }
      case "model_chunk": {
        const transfer = this.transfers.get(msg.reqId);
        if (transfer)
          this.onChunk(transfer, msg);
        return true;
      }
      case "model_files_error": {
        const transfer = this.transfers.get(msg.reqId);
        if (transfer)
          this.fail(transfer, new Error(msg.error));
        return true;
      }
      default:
        return false;
    }
  }
  progress(modelId) {
    return this.progressByModel.get(modelId) ?? null;
  }
  load(record) {
    const key = `${record.id}@${record.version}`;
    let bundle = this.memory.get(key);
    if (!bundle) {
      bundle = this.loadUncached(record).catch((error) => {
        this.memory.delete(key);
        throw error;
      });
      this.memory.set(key, bundle);
    }
    return bundle;
  }
  invalidate(modelId) {
    for (const key of [...this.memory.keys()]) {
      if (key.startsWith(`${modelId}@`))
        this.memory.delete(key);
    }
    (async () => {
      const cache = await openCache();
      if (!cache)
        return;
      const prefix = `${window.location.origin}/__spine_avatars__/${encodeURIComponent(modelId)}/`;
      for (const request of await cache.keys()) {
        if (request.url.startsWith(prefix))
          await cache.delete(request);
      }
    })();
  }
  async loadUncached(record) {
    const fromCache = await this.loadFromCache(record);
    if (fromCache)
      return fromCache;
    return await this.transferFromBackend(record);
  }
  async loadFromCache(record) {
    const cache = await openCache();
    if (!cache)
      return null;
    try {
      const manifestRes = await cache.match(cacheUrl(record.id, record.version, "__manifest__"));
      if (!manifestRes)
        return null;
      const manifest = await manifestRes.json();
      const files = new Map;
      for (const path of manifest.files) {
        const res = await cache.match(cacheUrl(record.id, record.version, path));
        if (!res)
          return null;
        files.set(path, await res.blob());
      }
      return {
        modelId: record.id,
        version: manifest.version,
        skeletonFile: manifest.skeletonFile,
        atlasFile: manifest.atlasFile,
        files
      };
    } catch {
      return null;
    }
  }
  transferFromBackend(record) {
    return new Promise((resolve, reject) => {
      const now = Date.now();
      const transfer = {
        reqId: `req_${this.nextReq++}_${now}`,
        record,
        resolve,
        reject,
        manifest: null,
        manifestRequestedAt: now,
        manifestAttempts: 1,
        queue: [],
        outstanding: new Map,
        parts: new Map,
        receivedBytes: 0,
        totalBytes: 0,
        lastProgress: now,
        watchdog: window.setInterval(() => this.checkTransfer(transfer), 2000)
      };
      this.transfers.set(transfer.reqId, transfer);
      this.sendToBackend({ type: "get_model_manifest", reqId: transfer.reqId, modelId: record.id });
    });
  }
  onManifest(transfer, manifest) {
    transfer.manifest = manifest;
    transfer.lastProgress = Date.now();
    for (const file of manifest.files) {
      const chunks = Math.max(1, Math.ceil(file.size / manifest.chunkBytes));
      transfer.parts.set(file.path, new Array(chunks));
      transfer.totalBytes += file.size;
      for (let seq = 0;seq < chunks; seq++)
        transfer.queue.push({ path: file.path, seq });
    }
    this.reportProgress(transfer);
    this.pump(transfer);
  }
  pump(transfer) {
    while (transfer.outstanding.size < WINDOW && transfer.queue.length > 0) {
      const next = transfer.queue.shift();
      this.requestChunk(transfer, { ...next, sentAt: 0, attempts: 0 });
    }
    if (transfer.queue.length === 0 && transfer.outstanding.size === 0)
      this.finish(transfer);
  }
  requestChunk(transfer, request) {
    request.sentAt = Date.now();
    request.attempts++;
    transfer.outstanding.set(chunkKey(request.path, request.seq), request);
    this.sendToBackend({ type: "get_model_chunk", reqId: transfer.reqId, path: request.path, seq: request.seq });
  }
  onChunk(transfer, msg) {
    const key = chunkKey(msg.path, msg.seq);
    if (!transfer.outstanding.has(key))
      return;
    transfer.outstanding.delete(key);
    const bytes = base64ToBytes(msg.dataB64);
    transfer.parts.get(msg.path)[msg.seq] = bytes;
    transfer.receivedBytes += bytes.length;
    transfer.lastProgress = Date.now();
    this.reportProgress(transfer);
    this.pump(transfer);
  }
  checkTransfer(transfer) {
    const now = Date.now();
    if (now - transfer.lastProgress > STALL_MS) {
      this.fail(transfer, new Error("Model download stalled: no data from the backend for 90 seconds."));
      return;
    }
    if (!transfer.manifest) {
      if (now - transfer.manifestRequestedAt > MANIFEST_RETRY_MS) {
        if (transfer.manifestAttempts >= MAX_ATTEMPTS) {
          this.fail(transfer, new Error("The backend did not answer the model file list request."));
          return;
        }
        transfer.manifestAttempts++;
        transfer.manifestRequestedAt = now;
        this.sendToBackend({ type: "get_model_manifest", reqId: transfer.reqId, modelId: transfer.record.id });
      }
      return;
    }
    for (const request of transfer.outstanding.values()) {
      if (now - request.sentAt <= CHUNK_RETRY_MS)
        continue;
      if (request.attempts >= MAX_ATTEMPTS) {
        this.fail(transfer, new Error(`Chunk ${request.seq} of ${request.path} never arrived.`));
        return;
      }
      this.requestChunk(transfer, request);
    }
  }
  reportProgress(transfer) {
    this.progressByModel.set(transfer.record.id, {
      receivedBytes: transfer.receivedBytes,
      totalBytes: transfer.totalBytes
    });
  }
  endTransfer(transfer) {
    if (!this.transfers.delete(transfer.reqId))
      return false;
    window.clearInterval(transfer.watchdog);
    this.progressByModel.delete(transfer.record.id);
    return true;
  }
  fail(transfer, error) {
    if (this.endTransfer(transfer))
      transfer.reject(error);
  }
  async finish(transfer) {
    if (!this.endTransfer(transfer))
      return;
    const manifest = transfer.manifest;
    try {
      const files = new Map;
      for (const file of manifest.files) {
        const parts = transfer.parts.get(file.path);
        const received = parts.reduce((sum, part) => sum + (part?.length ?? 0), 0);
        if (received !== file.size) {
          throw new Error(`Incomplete transfer for ${file.path} (${received}/${file.size} bytes).`);
        }
        files.set(file.path, new Blob(parts));
      }
      const bundle = {
        modelId: manifest.modelId,
        version: manifest.version,
        skeletonFile: manifest.skeletonFile,
        atlasFile: manifest.atlasFile,
        files
      };
      await this.storeInCache(bundle);
      transfer.resolve(bundle);
    } catch (error) {
      transfer.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }
  async storeInCache(bundle) {
    const cache = await openCache();
    if (!cache)
      return;
    const stalePrefix = `${window.location.origin}/__spine_avatars__/${encodeURIComponent(bundle.modelId)}/`;
    const currentPrefix = `${stalePrefix}${bundle.version}/`;
    for (const request of await cache.keys()) {
      if (request.url.startsWith(stalePrefix) && !request.url.startsWith(currentPrefix)) {
        await cache.delete(request);
      }
    }
    const manifest = {
      version: bundle.version,
      skeletonFile: bundle.skeletonFile,
      atlasFile: bundle.atlasFile,
      files: [...bundle.files.keys()]
    };
    try {
      for (const [path, blob] of bundle.files) {
        await cache.put(cacheUrl(bundle.modelId, bundle.version, path), new Response(blob));
      }
      await cache.put(cacheUrl(bundle.modelId, bundle.version, "__manifest__"), new Response(JSON.stringify(manifest), { headers: { "Content-Type": "application/json" } }));
    } catch {}
  }
}

// node_modules/@esotericsoftware/spine-core/dist/Utils.js
class StringSet {
  entries = {};
  size = 0;
  add(value) {
    let contains = this.entries[value];
    this.entries[value] = true;
    if (!contains) {
      this.size++;
      return true;
    }
    return false;
  }
  addAll(values) {
    let oldSize = this.size;
    for (var i = 0, n = values.length;i < n; i++)
      this.add(values[i]);
    return oldSize != this.size;
  }
  contains(value) {
    return this.entries[value];
  }
  clear() {
    this.entries = {};
    this.size = 0;
  }
}

class Color {
  r;
  g;
  b;
  a;
  static WHITE = new Color(1, 1, 1, 1);
  static RED = new Color(1, 0, 0, 1);
  static GREEN = new Color(0, 1, 0, 1);
  static BLUE = new Color(0, 0, 1, 1);
  static MAGENTA = new Color(1, 0, 1, 1);
  constructor(r = 0, g = 0, b = 0, a = 0) {
    this.r = r;
    this.g = g;
    this.b = b;
    this.a = a;
  }
  set(r, g, b, a) {
    this.r = r;
    this.g = g;
    this.b = b;
    this.a = a;
    return this.clamp();
  }
  setFromColor(c) {
    this.r = c.r;
    this.g = c.g;
    this.b = c.b;
    this.a = c.a;
    return this;
  }
  setFromString(hex) {
    hex = hex.charAt(0) == "#" ? hex.substr(1) : hex;
    this.r = parseInt(hex.substr(0, 2), 16) / 255;
    this.g = parseInt(hex.substr(2, 2), 16) / 255;
    this.b = parseInt(hex.substr(4, 2), 16) / 255;
    this.a = hex.length != 8 ? 1 : parseInt(hex.substr(6, 2), 16) / 255;
    return this;
  }
  add(r, g, b, a) {
    this.r += r;
    this.g += g;
    this.b += b;
    this.a += a;
    return this.clamp();
  }
  clamp() {
    if (this.r < 0)
      this.r = 0;
    else if (this.r > 1)
      this.r = 1;
    if (this.g < 0)
      this.g = 0;
    else if (this.g > 1)
      this.g = 1;
    if (this.b < 0)
      this.b = 0;
    else if (this.b > 1)
      this.b = 1;
    if (this.a < 0)
      this.a = 0;
    else if (this.a > 1)
      this.a = 1;
    return this;
  }
  static rgba8888ToColor(color, value) {
    color.r = ((value & 4278190080) >>> 24) / 255;
    color.g = ((value & 16711680) >>> 16) / 255;
    color.b = ((value & 65280) >>> 8) / 255;
    color.a = (value & 255) / 255;
  }
  static rgb888ToColor(color, value) {
    color.r = ((value & 16711680) >>> 16) / 255;
    color.g = ((value & 65280) >>> 8) / 255;
    color.b = (value & 255) / 255;
  }
  static fromString(hex) {
    return new Color().setFromString(hex);
  }
}

class MathUtils {
  static PI = 3.1415927;
  static PI2 = MathUtils.PI * 2;
  static radiansToDegrees = 180 / MathUtils.PI;
  static radDeg = MathUtils.radiansToDegrees;
  static degreesToRadians = MathUtils.PI / 180;
  static degRad = MathUtils.degreesToRadians;
  static clamp(value, min, max) {
    if (value < min)
      return min;
    if (value > max)
      return max;
    return value;
  }
  static cosDeg(degrees) {
    return Math.cos(degrees * MathUtils.degRad);
  }
  static sinDeg(degrees) {
    return Math.sin(degrees * MathUtils.degRad);
  }
  static signum(value) {
    return value > 0 ? 1 : value < 0 ? -1 : 0;
  }
  static toInt(x) {
    return x > 0 ? Math.floor(x) : Math.ceil(x);
  }
  static cbrt(x) {
    let y = Math.pow(Math.abs(x), 1 / 3);
    return x < 0 ? -y : y;
  }
  static randomTriangular(min, max) {
    return MathUtils.randomTriangularWith(min, max, (min + max) * 0.5);
  }
  static randomTriangularWith(min, max, mode) {
    let u = Math.random();
    let d = max - min;
    if (u <= (mode - min) / d)
      return min + Math.sqrt(u * d * (mode - min));
    return max - Math.sqrt((1 - u) * d * (max - mode));
  }
  static isPowerOfTwo(value) {
    return value && (value & value - 1) === 0;
  }
}
class Utils {
  static SUPPORTS_TYPED_ARRAYS = typeof Float32Array !== "undefined";
  static arrayCopy(source, sourceStart, dest, destStart, numElements) {
    for (let i = sourceStart, j = destStart;i < sourceStart + numElements; i++, j++) {
      dest[j] = source[i];
    }
  }
  static arrayFill(array, fromIndex, toIndex, value) {
    for (let i = fromIndex;i < toIndex; i++)
      array[i] = value;
  }
  static setArraySize(array, size, value = 0) {
    let oldSize = array.length;
    if (oldSize == size)
      return array;
    array.length = size;
    if (oldSize < size) {
      for (let i = oldSize;i < size; i++)
        array[i] = value;
    }
    return array;
  }
  static ensureArrayCapacity(array, size, value = 0) {
    if (array.length >= size)
      return array;
    return Utils.setArraySize(array, size, value);
  }
  static newArray(size, defaultValue) {
    let array = new Array(size);
    for (let i = 0;i < size; i++)
      array[i] = defaultValue;
    return array;
  }
  static newFloatArray(size) {
    if (Utils.SUPPORTS_TYPED_ARRAYS)
      return new Float32Array(size);
    else {
      let array = new Array(size);
      for (let i = 0;i < array.length; i++)
        array[i] = 0;
      return array;
    }
  }
  static newShortArray(size) {
    if (Utils.SUPPORTS_TYPED_ARRAYS)
      return new Int16Array(size);
    else {
      let array = new Array(size);
      for (let i = 0;i < array.length; i++)
        array[i] = 0;
      return array;
    }
  }
  static toFloatArray(array) {
    return Utils.SUPPORTS_TYPED_ARRAYS ? new Float32Array(array) : array;
  }
  static toSinglePrecision(value) {
    return Utils.SUPPORTS_TYPED_ARRAYS ? Math.fround(value) : value;
  }
  static webkit602BugfixHelper(alpha, blend) {}
  static contains(array, element, identity = true) {
    for (var i = 0;i < array.length; i++)
      if (array[i] == element)
        return true;
    return false;
  }
  static enumValue(type, name) {
    return type[name[0].toUpperCase() + name.slice(1)];
  }
}
class Pool {
  items = new Array;
  instantiator;
  constructor(instantiator) {
    this.instantiator = instantiator;
  }
  obtain() {
    return this.items.length > 0 ? this.items.pop() : this.instantiator();
  }
  free(item) {
    if (item.reset)
      item.reset();
    this.items.push(item);
  }
  freeAll(items) {
    for (let i = 0;i < items.length; i++)
      this.free(items[i]);
  }
  clear() {
    this.items.length = 0;
  }
}

class Vector2 {
  x;
  y;
  constructor(x = 0, y = 0) {
    this.x = x;
    this.y = y;
  }
  set(x, y) {
    this.x = x;
    this.y = y;
    return this;
  }
  length() {
    let x = this.x;
    let y = this.y;
    return Math.sqrt(x * x + y * y);
  }
  normalize() {
    let len = this.length();
    if (len != 0) {
      this.x /= len;
      this.y /= len;
    }
    return this;
  }
}

// node_modules/@esotericsoftware/spine-core/dist/attachments/Attachment.js
class Attachment {
  name;
  constructor(name) {
    if (!name)
      throw new Error("name cannot be null.");
    this.name = name;
  }
}

class VertexAttachment extends Attachment {
  static nextID = 0;
  id = VertexAttachment.nextID++;
  bones = null;
  vertices = [];
  worldVerticesLength = 0;
  timelineAttachment = this;
  constructor(name) {
    super(name);
  }
  computeWorldVertices(slot, start, count, worldVertices, offset, stride) {
    count = offset + (count >> 1) * stride;
    let skeleton = slot.bone.skeleton;
    let deformArray = slot.deform;
    let vertices = this.vertices;
    let bones = this.bones;
    if (!bones) {
      if (deformArray.length > 0)
        vertices = deformArray;
      let bone = slot.bone;
      let x = bone.worldX;
      let y = bone.worldY;
      let { a, b, c, d } = bone;
      for (let v = start, w = offset;w < count; v += 2, w += stride) {
        let vx = vertices[v], vy = vertices[v + 1];
        worldVertices[w] = vx * a + vy * b + x;
        worldVertices[w + 1] = vx * c + vy * d + y;
      }
      return;
    }
    let v = 0, skip = 0;
    for (let i = 0;i < start; i += 2) {
      let n = bones[v];
      v += n + 1;
      skip += n;
    }
    let skeletonBones = skeleton.bones;
    if (deformArray.length == 0) {
      for (let w = offset, b = skip * 3;w < count; w += stride) {
        let wx = 0, wy = 0;
        let n = bones[v++];
        n += v;
        for (;v < n; v++, b += 3) {
          let bone = skeletonBones[bones[v]];
          let vx = vertices[b], vy = vertices[b + 1], weight = vertices[b + 2];
          wx += (vx * bone.a + vy * bone.b + bone.worldX) * weight;
          wy += (vx * bone.c + vy * bone.d + bone.worldY) * weight;
        }
        worldVertices[w] = wx;
        worldVertices[w + 1] = wy;
      }
    } else {
      let deform = deformArray;
      for (let w = offset, b = skip * 3, f = skip << 1;w < count; w += stride) {
        let wx = 0, wy = 0;
        let n = bones[v++];
        n += v;
        for (;v < n; v++, b += 3, f += 2) {
          let bone = skeletonBones[bones[v]];
          let vx = vertices[b] + deform[f], vy = vertices[b + 1] + deform[f + 1], weight = vertices[b + 2];
          wx += (vx * bone.a + vy * bone.b + bone.worldX) * weight;
          wy += (vx * bone.c + vy * bone.d + bone.worldY) * weight;
        }
        worldVertices[w] = wx;
        worldVertices[w + 1] = wy;
      }
    }
  }
  copyTo(attachment) {
    if (this.bones) {
      attachment.bones = new Array(this.bones.length);
      Utils.arrayCopy(this.bones, 0, attachment.bones, 0, this.bones.length);
    } else
      attachment.bones = null;
    if (this.vertices) {
      attachment.vertices = Utils.newFloatArray(this.vertices.length);
      Utils.arrayCopy(this.vertices, 0, attachment.vertices, 0, this.vertices.length);
    }
    attachment.worldVerticesLength = this.worldVerticesLength;
    attachment.timelineAttachment = this.timelineAttachment;
  }
}

// node_modules/@esotericsoftware/spine-core/dist/attachments/Sequence.js
class Sequence {
  static _nextID = 0;
  id = Sequence.nextID();
  regions;
  start = 0;
  digits = 0;
  setupIndex = 0;
  constructor(count) {
    this.regions = new Array(count);
  }
  copy() {
    let copy = new Sequence(this.regions.length);
    Utils.arrayCopy(this.regions, 0, copy.regions, 0, this.regions.length);
    copy.start = this.start;
    copy.digits = this.digits;
    copy.setupIndex = this.setupIndex;
    return copy;
  }
  apply(slot, attachment) {
    let index = slot.sequenceIndex;
    if (index == -1)
      index = this.setupIndex;
    if (index >= this.regions.length)
      index = this.regions.length - 1;
    let region = this.regions[index];
    if (attachment.region != region) {
      attachment.region = region;
      attachment.updateRegion();
    }
  }
  getPath(basePath, index) {
    let result = basePath;
    let frame = (this.start + index).toString();
    for (let i = this.digits - frame.length;i > 0; i--)
      result += "0";
    result += frame;
    return result;
  }
  static nextID() {
    return Sequence._nextID++;
  }
}
var SequenceMode;
(function(SequenceMode) {
  SequenceMode[SequenceMode["hold"] = 0] = "hold";
  SequenceMode[SequenceMode["once"] = 1] = "once";
  SequenceMode[SequenceMode["loop"] = 2] = "loop";
  SequenceMode[SequenceMode["pingpong"] = 3] = "pingpong";
  SequenceMode[SequenceMode["onceReverse"] = 4] = "onceReverse";
  SequenceMode[SequenceMode["loopReverse"] = 5] = "loopReverse";
  SequenceMode[SequenceMode["pingpongReverse"] = 6] = "pingpongReverse";
})(SequenceMode || (SequenceMode = {}));
var SequenceModeValues = [
  SequenceMode.hold,
  SequenceMode.once,
  SequenceMode.loop,
  SequenceMode.pingpong,
  SequenceMode.onceReverse,
  SequenceMode.loopReverse,
  SequenceMode.pingpongReverse
];

// node_modules/@esotericsoftware/spine-core/dist/Animation.js
class Animation {
  name;
  timelines = [];
  timelineIds = new StringSet;
  duration;
  constructor(name, timelines, duration) {
    if (!name)
      throw new Error("name cannot be null.");
    this.name = name;
    this.setTimelines(timelines);
    this.duration = duration;
  }
  setTimelines(timelines) {
    if (!timelines)
      throw new Error("timelines cannot be null.");
    this.timelines = timelines;
    this.timelineIds.clear();
    for (var i = 0;i < timelines.length; i++)
      this.timelineIds.addAll(timelines[i].getPropertyIds());
  }
  hasTimeline(ids) {
    for (let i = 0;i < ids.length; i++)
      if (this.timelineIds.contains(ids[i]))
        return true;
    return false;
  }
  apply(skeleton, lastTime, time, loop, events, alpha, blend, direction) {
    if (!skeleton)
      throw new Error("skeleton cannot be null.");
    if (loop && this.duration != 0) {
      time %= this.duration;
      if (lastTime > 0)
        lastTime %= this.duration;
    }
    let timelines = this.timelines;
    for (let i = 0, n = timelines.length;i < n; i++)
      timelines[i].apply(skeleton, lastTime, time, events, alpha, blend, direction);
  }
}
var MixBlend;
(function(MixBlend) {
  MixBlend[MixBlend["setup"] = 0] = "setup";
  MixBlend[MixBlend["first"] = 1] = "first";
  MixBlend[MixBlend["replace"] = 2] = "replace";
  MixBlend[MixBlend["add"] = 3] = "add";
})(MixBlend || (MixBlend = {}));
var MixDirection;
(function(MixDirection) {
  MixDirection[MixDirection["mixIn"] = 0] = "mixIn";
  MixDirection[MixDirection["mixOut"] = 1] = "mixOut";
})(MixDirection || (MixDirection = {}));
var Property = {
  rotate: 0,
  x: 1,
  y: 2,
  scaleX: 3,
  scaleY: 4,
  shearX: 5,
  shearY: 6,
  rgb: 7,
  alpha: 8,
  rgb2: 9,
  attachment: 10,
  deform: 11,
  event: 12,
  drawOrder: 13,
  ikConstraint: 14,
  transformConstraint: 15,
  pathConstraintPosition: 16,
  pathConstraintSpacing: 17,
  pathConstraintMix: 18,
  sequence: 19
};

class Timeline {
  propertyIds;
  frames;
  constructor(frameCount, propertyIds) {
    this.propertyIds = propertyIds;
    this.frames = Utils.newFloatArray(frameCount * this.getFrameEntries());
  }
  getPropertyIds() {
    return this.propertyIds;
  }
  getFrameEntries() {
    return 1;
  }
  getFrameCount() {
    return this.frames.length / this.getFrameEntries();
  }
  getDuration() {
    return this.frames[this.frames.length - this.getFrameEntries()];
  }
  static search1(frames, time) {
    let n = frames.length;
    for (let i = 1;i < n; i++)
      if (frames[i] > time)
        return i - 1;
    return n - 1;
  }
  static search(frames, time, step) {
    let n = frames.length;
    for (let i = step;i < n; i += step)
      if (frames[i] > time)
        return i - step;
    return n - step;
  }
}

class CurveTimeline extends Timeline {
  curves;
  constructor(frameCount, bezierCount, propertyIds) {
    super(frameCount, propertyIds);
    this.curves = Utils.newFloatArray(frameCount + bezierCount * 18);
    this.curves[frameCount - 1] = 1;
  }
  setLinear(frame) {
    this.curves[frame] = 0;
  }
  setStepped(frame) {
    this.curves[frame] = 1;
  }
  shrink(bezierCount) {
    let size = this.getFrameCount() + bezierCount * 18;
    if (this.curves.length > size) {
      let newCurves = Utils.newFloatArray(size);
      Utils.arrayCopy(this.curves, 0, newCurves, 0, size);
      this.curves = newCurves;
    }
  }
  setBezier(bezier, frame, value, time1, value1, cx1, cy1, cx2, cy2, time2, value2) {
    let curves = this.curves;
    let i = this.getFrameCount() + bezier * 18;
    if (value == 0)
      curves[frame] = 2 + i;
    let tmpx = (time1 - cx1 * 2 + cx2) * 0.03, tmpy = (value1 - cy1 * 2 + cy2) * 0.03;
    let dddx = ((cx1 - cx2) * 3 - time1 + time2) * 0.006, dddy = ((cy1 - cy2) * 3 - value1 + value2) * 0.006;
    let ddx = tmpx * 2 + dddx, ddy = tmpy * 2 + dddy;
    let dx = (cx1 - time1) * 0.3 + tmpx + dddx * 0.16666667, dy = (cy1 - value1) * 0.3 + tmpy + dddy * 0.16666667;
    let x = time1 + dx, y = value1 + dy;
    for (let n = i + 18;i < n; i += 2) {
      curves[i] = x;
      curves[i + 1] = y;
      dx += ddx;
      dy += ddy;
      ddx += dddx;
      ddy += dddy;
      x += dx;
      y += dy;
    }
  }
  getBezierValue(time, frameIndex, valueOffset, i) {
    let curves = this.curves;
    if (curves[i] > time) {
      let x = this.frames[frameIndex], y = this.frames[frameIndex + valueOffset];
      return y + (time - x) / (curves[i] - x) * (curves[i + 1] - y);
    }
    let n = i + 18;
    for (i += 2;i < n; i += 2) {
      if (curves[i] >= time) {
        let x = curves[i - 2], y = curves[i - 1];
        return y + (time - x) / (curves[i] - x) * (curves[i + 1] - y);
      }
    }
    frameIndex += this.getFrameEntries();
    let x = curves[n - 2], y = curves[n - 1];
    return y + (time - x) / (this.frames[frameIndex] - x) * (this.frames[frameIndex + valueOffset] - y);
  }
}

class CurveTimeline1 extends CurveTimeline {
  constructor(frameCount, bezierCount, propertyId) {
    super(frameCount, bezierCount, [propertyId]);
  }
  getFrameEntries() {
    return 2;
  }
  setFrame(frame, time, value) {
    frame <<= 1;
    this.frames[frame] = time;
    this.frames[frame + 1] = value;
  }
  getCurveValue(time) {
    let frames = this.frames;
    let i = frames.length - 2;
    for (let ii = 2;ii <= i; ii += 2) {
      if (frames[ii] > time) {
        i = ii - 2;
        break;
      }
    }
    let curveType = this.curves[i >> 1];
    switch (curveType) {
      case 0:
        let before = frames[i], value = frames[i + 1];
        return value + (time - before) / (frames[i + 2] - before) * (frames[i + 2 + 1] - value);
      case 1:
        return frames[i + 1];
    }
    return this.getBezierValue(time, i, 1, curveType - 2);
  }
}

class CurveTimeline2 extends CurveTimeline {
  constructor(frameCount, bezierCount, propertyId1, propertyId2) {
    super(frameCount, bezierCount, [propertyId1, propertyId2]);
  }
  getFrameEntries() {
    return 3;
  }
  setFrame(frame, time, value1, value2) {
    frame *= 3;
    this.frames[frame] = time;
    this.frames[frame + 1] = value1;
    this.frames[frame + 2] = value2;
  }
}

class RotateTimeline extends CurveTimeline1 {
  boneIndex = 0;
  constructor(frameCount, bezierCount, boneIndex) {
    super(frameCount, bezierCount, Property.rotate + "|" + boneIndex);
    this.boneIndex = boneIndex;
  }
  apply(skeleton, lastTime, time, events, alpha, blend, direction) {
    let bone = skeleton.bones[this.boneIndex];
    if (!bone.active)
      return;
    let frames = this.frames;
    if (time < frames[0]) {
      switch (blend) {
        case MixBlend.setup:
          bone.rotation = bone.data.rotation;
          return;
        case MixBlend.first:
          bone.rotation += (bone.data.rotation - bone.rotation) * alpha;
      }
      return;
    }
    let r = this.getCurveValue(time);
    switch (blend) {
      case MixBlend.setup:
        bone.rotation = bone.data.rotation + r * alpha;
        break;
      case MixBlend.first:
      case MixBlend.replace:
        r += bone.data.rotation - bone.rotation;
      case MixBlend.add:
        bone.rotation += r * alpha;
    }
  }
}

class TranslateTimeline extends CurveTimeline2 {
  boneIndex = 0;
  constructor(frameCount, bezierCount, boneIndex) {
    super(frameCount, bezierCount, Property.x + "|" + boneIndex, Property.y + "|" + boneIndex);
    this.boneIndex = boneIndex;
  }
  apply(skeleton, lastTime, time, events, alpha, blend, direction) {
    let bone = skeleton.bones[this.boneIndex];
    if (!bone.active)
      return;
    let frames = this.frames;
    if (time < frames[0]) {
      switch (blend) {
        case MixBlend.setup:
          bone.x = bone.data.x;
          bone.y = bone.data.y;
          return;
        case MixBlend.first:
          bone.x += (bone.data.x - bone.x) * alpha;
          bone.y += (bone.data.y - bone.y) * alpha;
      }
      return;
    }
    let x = 0, y = 0;
    let i = Timeline.search(frames, time, 3);
    let curveType = this.curves[i / 3];
    switch (curveType) {
      case 0:
        let before = frames[i];
        x = frames[i + 1];
        y = frames[i + 2];
        let t = (time - before) / (frames[i + 3] - before);
        x += (frames[i + 3 + 1] - x) * t;
        y += (frames[i + 3 + 2] - y) * t;
        break;
      case 1:
        x = frames[i + 1];
        y = frames[i + 2];
        break;
      default:
        x = this.getBezierValue(time, i, 1, curveType - 2);
        y = this.getBezierValue(time, i, 2, curveType + 18 - 2);
    }
    switch (blend) {
      case MixBlend.setup:
        bone.x = bone.data.x + x * alpha;
        bone.y = bone.data.y + y * alpha;
        break;
      case MixBlend.first:
      case MixBlend.replace:
        bone.x += (bone.data.x + x - bone.x) * alpha;
        bone.y += (bone.data.y + y - bone.y) * alpha;
        break;
      case MixBlend.add:
        bone.x += x * alpha;
        bone.y += y * alpha;
    }
  }
}

class TranslateXTimeline extends CurveTimeline1 {
  boneIndex = 0;
  constructor(frameCount, bezierCount, boneIndex) {
    super(frameCount, bezierCount, Property.x + "|" + boneIndex);
    this.boneIndex = boneIndex;
  }
  apply(skeleton, lastTime, time, events, alpha, blend, direction) {
    let bone = skeleton.bones[this.boneIndex];
    if (!bone.active)
      return;
    let frames = this.frames;
    if (time < frames[0]) {
      switch (blend) {
        case MixBlend.setup:
          bone.x = bone.data.x;
          return;
        case MixBlend.first:
          bone.x += (bone.data.x - bone.x) * alpha;
      }
      return;
    }
    let x = this.getCurveValue(time);
    switch (blend) {
      case MixBlend.setup:
        bone.x = bone.data.x + x * alpha;
        break;
      case MixBlend.first:
      case MixBlend.replace:
        bone.x += (bone.data.x + x - bone.x) * alpha;
        break;
      case MixBlend.add:
        bone.x += x * alpha;
    }
  }
}

class TranslateYTimeline extends CurveTimeline1 {
  boneIndex = 0;
  constructor(frameCount, bezierCount, boneIndex) {
    super(frameCount, bezierCount, Property.y + "|" + boneIndex);
    this.boneIndex = boneIndex;
  }
  apply(skeleton, lastTime, time, events, alpha, blend, direction) {
    let bone = skeleton.bones[this.boneIndex];
    if (!bone.active)
      return;
    let frames = this.frames;
    if (time < frames[0]) {
      switch (blend) {
        case MixBlend.setup:
          bone.y = bone.data.y;
          return;
        case MixBlend.first:
          bone.y += (bone.data.y - bone.y) * alpha;
      }
      return;
    }
    let y = this.getCurveValue(time);
    switch (blend) {
      case MixBlend.setup:
        bone.y = bone.data.y + y * alpha;
        break;
      case MixBlend.first:
      case MixBlend.replace:
        bone.y += (bone.data.y + y - bone.y) * alpha;
        break;
      case MixBlend.add:
        bone.y += y * alpha;
    }
  }
}

class ScaleTimeline extends CurveTimeline2 {
  boneIndex = 0;
  constructor(frameCount, bezierCount, boneIndex) {
    super(frameCount, bezierCount, Property.scaleX + "|" + boneIndex, Property.scaleY + "|" + boneIndex);
    this.boneIndex = boneIndex;
  }
  apply(skeleton, lastTime, time, events, alpha, blend, direction) {
    let bone = skeleton.bones[this.boneIndex];
    if (!bone.active)
      return;
    let frames = this.frames;
    if (time < frames[0]) {
      switch (blend) {
        case MixBlend.setup:
          bone.scaleX = bone.data.scaleX;
          bone.scaleY = bone.data.scaleY;
          return;
        case MixBlend.first:
          bone.scaleX += (bone.data.scaleX - bone.scaleX) * alpha;
          bone.scaleY += (bone.data.scaleY - bone.scaleY) * alpha;
      }
      return;
    }
    let x, y;
    let i = Timeline.search(frames, time, 3);
    let curveType = this.curves[i / 3];
    switch (curveType) {
      case 0:
        let before = frames[i];
        x = frames[i + 1];
        y = frames[i + 2];
        let t = (time - before) / (frames[i + 3] - before);
        x += (frames[i + 3 + 1] - x) * t;
        y += (frames[i + 3 + 2] - y) * t;
        break;
      case 1:
        x = frames[i + 1];
        y = frames[i + 2];
        break;
      default:
        x = this.getBezierValue(time, i, 1, curveType - 2);
        y = this.getBezierValue(time, i, 2, curveType + 18 - 2);
    }
    x *= bone.data.scaleX;
    y *= bone.data.scaleY;
    if (alpha == 1) {
      if (blend == MixBlend.add) {
        bone.scaleX += x - bone.data.scaleX;
        bone.scaleY += y - bone.data.scaleY;
      } else {
        bone.scaleX = x;
        bone.scaleY = y;
      }
    } else {
      let bx = 0, by = 0;
      if (direction == MixDirection.mixOut) {
        switch (blend) {
          case MixBlend.setup:
            bx = bone.data.scaleX;
            by = bone.data.scaleY;
            bone.scaleX = bx + (Math.abs(x) * MathUtils.signum(bx) - bx) * alpha;
            bone.scaleY = by + (Math.abs(y) * MathUtils.signum(by) - by) * alpha;
            break;
          case MixBlend.first:
          case MixBlend.replace:
            bx = bone.scaleX;
            by = bone.scaleY;
            bone.scaleX = bx + (Math.abs(x) * MathUtils.signum(bx) - bx) * alpha;
            bone.scaleY = by + (Math.abs(y) * MathUtils.signum(by) - by) * alpha;
            break;
          case MixBlend.add:
            bone.scaleX += (x - bone.data.scaleX) * alpha;
            bone.scaleY += (y - bone.data.scaleY) * alpha;
        }
      } else {
        switch (blend) {
          case MixBlend.setup:
            bx = Math.abs(bone.data.scaleX) * MathUtils.signum(x);
            by = Math.abs(bone.data.scaleY) * MathUtils.signum(y);
            bone.scaleX = bx + (x - bx) * alpha;
            bone.scaleY = by + (y - by) * alpha;
            break;
          case MixBlend.first:
          case MixBlend.replace:
            bx = Math.abs(bone.scaleX) * MathUtils.signum(x);
            by = Math.abs(bone.scaleY) * MathUtils.signum(y);
            bone.scaleX = bx + (x - bx) * alpha;
            bone.scaleY = by + (y - by) * alpha;
            break;
          case MixBlend.add:
            bone.scaleX += (x - bone.data.scaleX) * alpha;
            bone.scaleY += (y - bone.data.scaleY) * alpha;
        }
      }
    }
  }
}

class ScaleXTimeline extends CurveTimeline1 {
  boneIndex = 0;
  constructor(frameCount, bezierCount, boneIndex) {
    super(frameCount, bezierCount, Property.scaleX + "|" + boneIndex);
    this.boneIndex = boneIndex;
  }
  apply(skeleton, lastTime, time, events, alpha, blend, direction) {
    let bone = skeleton.bones[this.boneIndex];
    if (!bone.active)
      return;
    let frames = this.frames;
    if (time < frames[0]) {
      switch (blend) {
        case MixBlend.setup:
          bone.scaleX = bone.data.scaleX;
          return;
        case MixBlend.first:
          bone.scaleX += (bone.data.scaleX - bone.scaleX) * alpha;
      }
      return;
    }
    let x = this.getCurveValue(time) * bone.data.scaleX;
    if (alpha == 1) {
      if (blend == MixBlend.add)
        bone.scaleX += x - bone.data.scaleX;
      else
        bone.scaleX = x;
    } else {
      let bx = 0;
      if (direction == MixDirection.mixOut) {
        switch (blend) {
          case MixBlend.setup:
            bx = bone.data.scaleX;
            bone.scaleX = bx + (Math.abs(x) * MathUtils.signum(bx) - bx) * alpha;
            break;
          case MixBlend.first:
          case MixBlend.replace:
            bx = bone.scaleX;
            bone.scaleX = bx + (Math.abs(x) * MathUtils.signum(bx) - bx) * alpha;
            break;
          case MixBlend.add:
            bone.scaleX += (x - bone.data.scaleX) * alpha;
        }
      } else {
        switch (blend) {
          case MixBlend.setup:
            bx = Math.abs(bone.data.scaleX) * MathUtils.signum(x);
            bone.scaleX = bx + (x - bx) * alpha;
            break;
          case MixBlend.first:
          case MixBlend.replace:
            bx = Math.abs(bone.scaleX) * MathUtils.signum(x);
            bone.scaleX = bx + (x - bx) * alpha;
            break;
          case MixBlend.add:
            bone.scaleX += (x - bone.data.scaleX) * alpha;
        }
      }
    }
  }
}

class ScaleYTimeline extends CurveTimeline1 {
  boneIndex = 0;
  constructor(frameCount, bezierCount, boneIndex) {
    super(frameCount, bezierCount, Property.scaleY + "|" + boneIndex);
    this.boneIndex = boneIndex;
  }
  apply(skeleton, lastTime, time, events, alpha, blend, direction) {
    let bone = skeleton.bones[this.boneIndex];
    if (!bone.active)
      return;
    let frames = this.frames;
    if (time < frames[0]) {
      switch (blend) {
        case MixBlend.setup:
          bone.scaleY = bone.data.scaleY;
          return;
        case MixBlend.first:
          bone.scaleY += (bone.data.scaleY - bone.scaleY) * alpha;
      }
      return;
    }
    let y = this.getCurveValue(time) * bone.data.scaleY;
    if (alpha == 1) {
      if (blend == MixBlend.add)
        bone.scaleY += y - bone.data.scaleY;
      else
        bone.scaleY = y;
    } else {
      let by = 0;
      if (direction == MixDirection.mixOut) {
        switch (blend) {
          case MixBlend.setup:
            by = bone.data.scaleY;
            bone.scaleY = by + (Math.abs(y) * MathUtils.signum(by) - by) * alpha;
            break;
          case MixBlend.first:
          case MixBlend.replace:
            by = bone.scaleY;
            bone.scaleY = by + (Math.abs(y) * MathUtils.signum(by) - by) * alpha;
            break;
          case MixBlend.add:
            bone.scaleY += (y - bone.data.scaleY) * alpha;
        }
      } else {
        switch (blend) {
          case MixBlend.setup:
            by = Math.abs(bone.data.scaleY) * MathUtils.signum(y);
            bone.scaleY = by + (y - by) * alpha;
            break;
          case MixBlend.first:
          case MixBlend.replace:
            by = Math.abs(bone.scaleY) * MathUtils.signum(y);
            bone.scaleY = by + (y - by) * alpha;
            break;
          case MixBlend.add:
            bone.scaleY += (y - bone.data.scaleY) * alpha;
        }
      }
    }
  }
}

class ShearTimeline extends CurveTimeline2 {
  boneIndex = 0;
  constructor(frameCount, bezierCount, boneIndex) {
    super(frameCount, bezierCount, Property.shearX + "|" + boneIndex, Property.shearY + "|" + boneIndex);
    this.boneIndex = boneIndex;
  }
  apply(skeleton, lastTime, time, events, alpha, blend, direction) {
    let bone = skeleton.bones[this.boneIndex];
    if (!bone.active)
      return;
    let frames = this.frames;
    if (time < frames[0]) {
      switch (blend) {
        case MixBlend.setup:
          bone.shearX = bone.data.shearX;
          bone.shearY = bone.data.shearY;
          return;
        case MixBlend.first:
          bone.shearX += (bone.data.shearX - bone.shearX) * alpha;
          bone.shearY += (bone.data.shearY - bone.shearY) * alpha;
      }
      return;
    }
    let x = 0, y = 0;
    let i = Timeline.search(frames, time, 3);
    let curveType = this.curves[i / 3];
    switch (curveType) {
      case 0:
        let before = frames[i];
        x = frames[i + 1];
        y = frames[i + 2];
        let t = (time - before) / (frames[i + 3] - before);
        x += (frames[i + 3 + 1] - x) * t;
        y += (frames[i + 3 + 2] - y) * t;
        break;
      case 1:
        x = frames[i + 1];
        y = frames[i + 2];
        break;
      default:
        x = this.getBezierValue(time, i, 1, curveType - 2);
        y = this.getBezierValue(time, i, 2, curveType + 18 - 2);
    }
    switch (blend) {
      case MixBlend.setup:
        bone.shearX = bone.data.shearX + x * alpha;
        bone.shearY = bone.data.shearY + y * alpha;
        break;
      case MixBlend.first:
      case MixBlend.replace:
        bone.shearX += (bone.data.shearX + x - bone.shearX) * alpha;
        bone.shearY += (bone.data.shearY + y - bone.shearY) * alpha;
        break;
      case MixBlend.add:
        bone.shearX += x * alpha;
        bone.shearY += y * alpha;
    }
  }
}

class ShearXTimeline extends CurveTimeline1 {
  boneIndex = 0;
  constructor(frameCount, bezierCount, boneIndex) {
    super(frameCount, bezierCount, Property.shearX + "|" + boneIndex);
    this.boneIndex = boneIndex;
  }
  apply(skeleton, lastTime, time, events, alpha, blend, direction) {
    let bone = skeleton.bones[this.boneIndex];
    if (!bone.active)
      return;
    let frames = this.frames;
    if (time < frames[0]) {
      switch (blend) {
        case MixBlend.setup:
          bone.shearX = bone.data.shearX;
          return;
        case MixBlend.first:
          bone.shearX += (bone.data.shearX - bone.shearX) * alpha;
      }
      return;
    }
    let x = this.getCurveValue(time);
    switch (blend) {
      case MixBlend.setup:
        bone.shearX = bone.data.shearX + x * alpha;
        break;
      case MixBlend.first:
      case MixBlend.replace:
        bone.shearX += (bone.data.shearX + x - bone.shearX) * alpha;
        break;
      case MixBlend.add:
        bone.shearX += x * alpha;
    }
  }
}

class ShearYTimeline extends CurveTimeline1 {
  boneIndex = 0;
  constructor(frameCount, bezierCount, boneIndex) {
    super(frameCount, bezierCount, Property.shearY + "|" + boneIndex);
    this.boneIndex = boneIndex;
  }
  apply(skeleton, lastTime, time, events, alpha, blend, direction) {
    let bone = skeleton.bones[this.boneIndex];
    if (!bone.active)
      return;
    let frames = this.frames;
    if (time < frames[0]) {
      switch (blend) {
        case MixBlend.setup:
          bone.shearY = bone.data.shearY;
          return;
        case MixBlend.first:
          bone.shearY += (bone.data.shearY - bone.shearY) * alpha;
      }
      return;
    }
    let y = this.getCurveValue(time);
    switch (blend) {
      case MixBlend.setup:
        bone.shearY = bone.data.shearY + y * alpha;
        break;
      case MixBlend.first:
      case MixBlend.replace:
        bone.shearY += (bone.data.shearY + y - bone.shearY) * alpha;
        break;
      case MixBlend.add:
        bone.shearY += y * alpha;
    }
  }
}

class RGBATimeline extends CurveTimeline {
  slotIndex = 0;
  constructor(frameCount, bezierCount, slotIndex) {
    super(frameCount, bezierCount, [
      Property.rgb + "|" + slotIndex,
      Property.alpha + "|" + slotIndex
    ]);
    this.slotIndex = slotIndex;
  }
  getFrameEntries() {
    return 5;
  }
  setFrame(frame, time, r, g, b, a) {
    frame *= 5;
    this.frames[frame] = time;
    this.frames[frame + 1] = r;
    this.frames[frame + 2] = g;
    this.frames[frame + 3] = b;
    this.frames[frame + 4] = a;
  }
  apply(skeleton, lastTime, time, events, alpha, blend, direction) {
    let slot = skeleton.slots[this.slotIndex];
    if (!slot.bone.active)
      return;
    let frames = this.frames;
    let color = slot.color;
    if (time < frames[0]) {
      let setup = slot.data.color;
      switch (blend) {
        case MixBlend.setup:
          color.setFromColor(setup);
          return;
        case MixBlend.first:
          color.add((setup.r - color.r) * alpha, (setup.g - color.g) * alpha, (setup.b - color.b) * alpha, (setup.a - color.a) * alpha);
      }
      return;
    }
    let r = 0, g = 0, b = 0, a = 0;
    let i = Timeline.search(frames, time, 5);
    let curveType = this.curves[i / 5];
    switch (curveType) {
      case 0:
        let before = frames[i];
        r = frames[i + 1];
        g = frames[i + 2];
        b = frames[i + 3];
        a = frames[i + 4];
        let t = (time - before) / (frames[i + 5] - before);
        r += (frames[i + 5 + 1] - r) * t;
        g += (frames[i + 5 + 2] - g) * t;
        b += (frames[i + 5 + 3] - b) * t;
        a += (frames[i + 5 + 4] - a) * t;
        break;
      case 1:
        r = frames[i + 1];
        g = frames[i + 2];
        b = frames[i + 3];
        a = frames[i + 4];
        break;
      default:
        r = this.getBezierValue(time, i, 1, curveType - 2);
        g = this.getBezierValue(time, i, 2, curveType + 18 - 2);
        b = this.getBezierValue(time, i, 3, curveType + 18 * 2 - 2);
        a = this.getBezierValue(time, i, 4, curveType + 18 * 3 - 2);
    }
    if (alpha == 1)
      color.set(r, g, b, a);
    else {
      if (blend == MixBlend.setup)
        color.setFromColor(slot.data.color);
      color.add((r - color.r) * alpha, (g - color.g) * alpha, (b - color.b) * alpha, (a - color.a) * alpha);
    }
  }
}

class RGBTimeline extends CurveTimeline {
  slotIndex = 0;
  constructor(frameCount, bezierCount, slotIndex) {
    super(frameCount, bezierCount, [
      Property.rgb + "|" + slotIndex
    ]);
    this.slotIndex = slotIndex;
  }
  getFrameEntries() {
    return 4;
  }
  setFrame(frame, time, r, g, b) {
    frame <<= 2;
    this.frames[frame] = time;
    this.frames[frame + 1] = r;
    this.frames[frame + 2] = g;
    this.frames[frame + 3] = b;
  }
  apply(skeleton, lastTime, time, events, alpha, blend, direction) {
    let slot = skeleton.slots[this.slotIndex];
    if (!slot.bone.active)
      return;
    let frames = this.frames;
    let color = slot.color;
    if (time < frames[0]) {
      let setup = slot.data.color;
      switch (blend) {
        case MixBlend.setup:
          color.r = setup.r;
          color.g = setup.g;
          color.b = setup.b;
          return;
        case MixBlend.first:
          color.r += (setup.r - color.r) * alpha;
          color.g += (setup.g - color.g) * alpha;
          color.b += (setup.b - color.b) * alpha;
      }
      return;
    }
    let r = 0, g = 0, b = 0;
    let i = Timeline.search(frames, time, 4);
    let curveType = this.curves[i >> 2];
    switch (curveType) {
      case 0:
        let before = frames[i];
        r = frames[i + 1];
        g = frames[i + 2];
        b = frames[i + 3];
        let t = (time - before) / (frames[i + 4] - before);
        r += (frames[i + 4 + 1] - r) * t;
        g += (frames[i + 4 + 2] - g) * t;
        b += (frames[i + 4 + 3] - b) * t;
        break;
      case 1:
        r = frames[i + 1];
        g = frames[i + 2];
        b = frames[i + 3];
        break;
      default:
        r = this.getBezierValue(time, i, 1, curveType - 2);
        g = this.getBezierValue(time, i, 2, curveType + 18 - 2);
        b = this.getBezierValue(time, i, 3, curveType + 18 * 2 - 2);
    }
    if (alpha == 1) {
      color.r = r;
      color.g = g;
      color.b = b;
    } else {
      if (blend == MixBlend.setup) {
        let setup = slot.data.color;
        color.r = setup.r;
        color.g = setup.g;
        color.b = setup.b;
      }
      color.r += (r - color.r) * alpha;
      color.g += (g - color.g) * alpha;
      color.b += (b - color.b) * alpha;
    }
  }
}

class AlphaTimeline extends CurveTimeline1 {
  slotIndex = 0;
  constructor(frameCount, bezierCount, slotIndex) {
    super(frameCount, bezierCount, Property.alpha + "|" + slotIndex);
    this.slotIndex = slotIndex;
  }
  apply(skeleton, lastTime, time, events, alpha, blend, direction) {
    let slot = skeleton.slots[this.slotIndex];
    if (!slot.bone.active)
      return;
    let color = slot.color;
    if (time < this.frames[0]) {
      let setup = slot.data.color;
      switch (blend) {
        case MixBlend.setup:
          color.a = setup.a;
          return;
        case MixBlend.first:
          color.a += (setup.a - color.a) * alpha;
      }
      return;
    }
    let a = this.getCurveValue(time);
    if (alpha == 1)
      color.a = a;
    else {
      if (blend == MixBlend.setup)
        color.a = slot.data.color.a;
      color.a += (a - color.a) * alpha;
    }
  }
}

class RGBA2Timeline extends CurveTimeline {
  slotIndex = 0;
  constructor(frameCount, bezierCount, slotIndex) {
    super(frameCount, bezierCount, [
      Property.rgb + "|" + slotIndex,
      Property.alpha + "|" + slotIndex,
      Property.rgb2 + "|" + slotIndex
    ]);
    this.slotIndex = slotIndex;
  }
  getFrameEntries() {
    return 8;
  }
  setFrame(frame, time, r, g, b, a, r2, g2, b2) {
    frame <<= 3;
    this.frames[frame] = time;
    this.frames[frame + 1] = r;
    this.frames[frame + 2] = g;
    this.frames[frame + 3] = b;
    this.frames[frame + 4] = a;
    this.frames[frame + 5] = r2;
    this.frames[frame + 6] = g2;
    this.frames[frame + 7] = b2;
  }
  apply(skeleton, lastTime, time, events, alpha, blend, direction) {
    let slot = skeleton.slots[this.slotIndex];
    if (!slot.bone.active)
      return;
    let frames = this.frames;
    let { color: light, darkColor: dark } = slot;
    if (time < frames[0]) {
      let setupLight = slot.data.color, setupDark = slot.data.darkColor;
      switch (blend) {
        case MixBlend.setup:
          light.setFromColor(setupLight);
          dark.r = setupDark.r;
          dark.g = setupDark.g;
          dark.b = setupDark.b;
          return;
        case MixBlend.first:
          light.add((setupLight.r - light.r) * alpha, (setupLight.g - light.g) * alpha, (setupLight.b - light.b) * alpha, (setupLight.a - light.a) * alpha);
          dark.r += (setupDark.r - dark.r) * alpha;
          dark.g += (setupDark.g - dark.g) * alpha;
          dark.b += (setupDark.b - dark.b) * alpha;
      }
      return;
    }
    let r = 0, g = 0, b = 0, a = 0, r2 = 0, g2 = 0, b2 = 0;
    let i = Timeline.search(frames, time, 8);
    let curveType = this.curves[i >> 3];
    switch (curveType) {
      case 0:
        let before = frames[i];
        r = frames[i + 1];
        g = frames[i + 2];
        b = frames[i + 3];
        a = frames[i + 4];
        r2 = frames[i + 5];
        g2 = frames[i + 6];
        b2 = frames[i + 7];
        let t = (time - before) / (frames[i + 8] - before);
        r += (frames[i + 8 + 1] - r) * t;
        g += (frames[i + 8 + 2] - g) * t;
        b += (frames[i + 8 + 3] - b) * t;
        a += (frames[i + 8 + 4] - a) * t;
        r2 += (frames[i + 8 + 5] - r2) * t;
        g2 += (frames[i + 8 + 6] - g2) * t;
        b2 += (frames[i + 8 + 7] - b2) * t;
        break;
      case 1:
        r = frames[i + 1];
        g = frames[i + 2];
        b = frames[i + 3];
        a = frames[i + 4];
        r2 = frames[i + 5];
        g2 = frames[i + 6];
        b2 = frames[i + 7];
        break;
      default:
        r = this.getBezierValue(time, i, 1, curveType - 2);
        g = this.getBezierValue(time, i, 2, curveType + 18 - 2);
        b = this.getBezierValue(time, i, 3, curveType + 18 * 2 - 2);
        a = this.getBezierValue(time, i, 4, curveType + 18 * 3 - 2);
        r2 = this.getBezierValue(time, i, 5, curveType + 18 * 4 - 2);
        g2 = this.getBezierValue(time, i, 6, curveType + 18 * 5 - 2);
        b2 = this.getBezierValue(time, i, 7, curveType + 18 * 6 - 2);
    }
    if (alpha == 1) {
      light.set(r, g, b, a);
      dark.r = r2;
      dark.g = g2;
      dark.b = b2;
    } else {
      if (blend == MixBlend.setup) {
        light.setFromColor(slot.data.color);
        let setupDark = slot.data.darkColor;
        dark.r = setupDark.r;
        dark.g = setupDark.g;
        dark.b = setupDark.b;
      }
      light.add((r - light.r) * alpha, (g - light.g) * alpha, (b - light.b) * alpha, (a - light.a) * alpha);
      dark.r += (r2 - dark.r) * alpha;
      dark.g += (g2 - dark.g) * alpha;
      dark.b += (b2 - dark.b) * alpha;
    }
  }
}

class RGB2Timeline extends CurveTimeline {
  slotIndex = 0;
  constructor(frameCount, bezierCount, slotIndex) {
    super(frameCount, bezierCount, [
      Property.rgb + "|" + slotIndex,
      Property.rgb2 + "|" + slotIndex
    ]);
    this.slotIndex = slotIndex;
  }
  getFrameEntries() {
    return 7;
  }
  setFrame(frame, time, r, g, b, r2, g2, b2) {
    frame *= 7;
    this.frames[frame] = time;
    this.frames[frame + 1] = r;
    this.frames[frame + 2] = g;
    this.frames[frame + 3] = b;
    this.frames[frame + 4] = r2;
    this.frames[frame + 5] = g2;
    this.frames[frame + 6] = b2;
  }
  apply(skeleton, lastTime, time, events, alpha, blend, direction) {
    let slot = skeleton.slots[this.slotIndex];
    if (!slot.bone.active)
      return;
    let frames = this.frames;
    let { color: light, darkColor: dark } = slot;
    if (time < frames[0]) {
      let setupLight = slot.data.color, setupDark = slot.data.darkColor;
      switch (blend) {
        case MixBlend.setup:
          light.r = setupLight.r;
          light.g = setupLight.g;
          light.b = setupLight.b;
          dark.r = setupDark.r;
          dark.g = setupDark.g;
          dark.b = setupDark.b;
          return;
        case MixBlend.first:
          light.r += (setupLight.r - light.r) * alpha;
          light.g += (setupLight.g - light.g) * alpha;
          light.b += (setupLight.b - light.b) * alpha;
          dark.r += (setupDark.r - dark.r) * alpha;
          dark.g += (setupDark.g - dark.g) * alpha;
          dark.b += (setupDark.b - dark.b) * alpha;
      }
      return;
    }
    let r = 0, g = 0, b = 0, a = 0, r2 = 0, g2 = 0, b2 = 0;
    let i = Timeline.search(frames, time, 7);
    let curveType = this.curves[i / 7];
    switch (curveType) {
      case 0:
        let before = frames[i];
        r = frames[i + 1];
        g = frames[i + 2];
        b = frames[i + 3];
        r2 = frames[i + 4];
        g2 = frames[i + 5];
        b2 = frames[i + 6];
        let t = (time - before) / (frames[i + 7] - before);
        r += (frames[i + 7 + 1] - r) * t;
        g += (frames[i + 7 + 2] - g) * t;
        b += (frames[i + 7 + 3] - b) * t;
        r2 += (frames[i + 7 + 4] - r2) * t;
        g2 += (frames[i + 7 + 5] - g2) * t;
        b2 += (frames[i + 7 + 6] - b2) * t;
        break;
      case 1:
        r = frames[i + 1];
        g = frames[i + 2];
        b = frames[i + 3];
        r2 = frames[i + 4];
        g2 = frames[i + 5];
        b2 = frames[i + 6];
        break;
      default:
        r = this.getBezierValue(time, i, 1, curveType - 2);
        g = this.getBezierValue(time, i, 2, curveType + 18 - 2);
        b = this.getBezierValue(time, i, 3, curveType + 18 * 2 - 2);
        r2 = this.getBezierValue(time, i, 4, curveType + 18 * 3 - 2);
        g2 = this.getBezierValue(time, i, 5, curveType + 18 * 4 - 2);
        b2 = this.getBezierValue(time, i, 6, curveType + 18 * 5 - 2);
    }
    if (alpha == 1) {
      light.r = r;
      light.g = g;
      light.b = b;
      dark.r = r2;
      dark.g = g2;
      dark.b = b2;
    } else {
      if (blend == MixBlend.setup) {
        let setupLight = slot.data.color, setupDark = slot.data.darkColor;
        light.r = setupLight.r;
        light.g = setupLight.g;
        light.b = setupLight.b;
        dark.r = setupDark.r;
        dark.g = setupDark.g;
        dark.b = setupDark.b;
      }
      light.r += (r - light.r) * alpha;
      light.g += (g - light.g) * alpha;
      light.b += (b - light.b) * alpha;
      dark.r += (r2 - dark.r) * alpha;
      dark.g += (g2 - dark.g) * alpha;
      dark.b += (b2 - dark.b) * alpha;
    }
  }
}

class AttachmentTimeline extends Timeline {
  slotIndex = 0;
  attachmentNames;
  constructor(frameCount, slotIndex) {
    super(frameCount, [
      Property.attachment + "|" + slotIndex
    ]);
    this.slotIndex = slotIndex;
    this.attachmentNames = new Array(frameCount);
  }
  getFrameCount() {
    return this.frames.length;
  }
  setFrame(frame, time, attachmentName) {
    this.frames[frame] = time;
    this.attachmentNames[frame] = attachmentName;
  }
  apply(skeleton, lastTime, time, events, alpha, blend, direction) {
    let slot = skeleton.slots[this.slotIndex];
    if (!slot.bone.active)
      return;
    if (direction == MixDirection.mixOut) {
      if (blend == MixBlend.setup)
        this.setAttachment(skeleton, slot, slot.data.attachmentName);
      return;
    }
    if (time < this.frames[0]) {
      if (blend == MixBlend.setup || blend == MixBlend.first)
        this.setAttachment(skeleton, slot, slot.data.attachmentName);
      return;
    }
    this.setAttachment(skeleton, slot, this.attachmentNames[Timeline.search1(this.frames, time)]);
  }
  setAttachment(skeleton, slot, attachmentName) {
    slot.setAttachment(!attachmentName ? null : skeleton.getAttachment(this.slotIndex, attachmentName));
  }
}

class DeformTimeline extends CurveTimeline {
  slotIndex = 0;
  attachment;
  vertices;
  constructor(frameCount, bezierCount, slotIndex, attachment) {
    super(frameCount, bezierCount, [
      Property.deform + "|" + slotIndex + "|" + attachment.id
    ]);
    this.slotIndex = slotIndex;
    this.attachment = attachment;
    this.vertices = new Array(frameCount);
  }
  getFrameCount() {
    return this.frames.length;
  }
  setFrame(frame, time, vertices) {
    this.frames[frame] = time;
    this.vertices[frame] = vertices;
  }
  setBezier(bezier, frame, value, time1, value1, cx1, cy1, cx2, cy2, time2, value2) {
    let curves = this.curves;
    let i = this.getFrameCount() + bezier * 18;
    if (value == 0)
      curves[frame] = 2 + i;
    let tmpx = (time1 - cx1 * 2 + cx2) * 0.03, tmpy = cy2 * 0.03 - cy1 * 0.06;
    let dddx = ((cx1 - cx2) * 3 - time1 + time2) * 0.006, dddy = (cy1 - cy2 + 0.33333333) * 0.018;
    let ddx = tmpx * 2 + dddx, ddy = tmpy * 2 + dddy;
    let dx = (cx1 - time1) * 0.3 + tmpx + dddx * 0.16666667, dy = cy1 * 0.3 + tmpy + dddy * 0.16666667;
    let x = time1 + dx, y = dy;
    for (let n = i + 18;i < n; i += 2) {
      curves[i] = x;
      curves[i + 1] = y;
      dx += ddx;
      dy += ddy;
      ddx += dddx;
      ddy += dddy;
      x += dx;
      y += dy;
    }
  }
  getCurvePercent(time, frame) {
    let curves = this.curves;
    let i = curves[frame];
    switch (i) {
      case 0:
        let x = this.frames[frame];
        return (time - x) / (this.frames[frame + this.getFrameEntries()] - x);
      case 1:
        return 0;
    }
    i -= 2;
    if (curves[i] > time) {
      let x = this.frames[frame];
      return curves[i + 1] * (time - x) / (curves[i] - x);
    }
    let n = i + 18;
    for (i += 2;i < n; i += 2) {
      if (curves[i] >= time) {
        let x = curves[i - 2], y = curves[i - 1];
        return y + (time - x) / (curves[i] - x) * (curves[i + 1] - y);
      }
    }
    let x = curves[n - 2], y = curves[n - 1];
    return y + (1 - y) * (time - x) / (this.frames[frame + this.getFrameEntries()] - x);
  }
  apply(skeleton, lastTime, time, firedEvents, alpha, blend, direction) {
    let slot = skeleton.slots[this.slotIndex];
    if (!slot.bone.active)
      return;
    let slotAttachment = slot.getAttachment();
    if (!slotAttachment)
      return;
    if (!(slotAttachment instanceof VertexAttachment) || slotAttachment.timelineAttachment != this.attachment)
      return;
    let deform = slot.deform;
    if (deform.length == 0)
      blend = MixBlend.setup;
    let vertices = this.vertices;
    let vertexCount = vertices[0].length;
    let frames = this.frames;
    if (time < frames[0]) {
      switch (blend) {
        case MixBlend.setup:
          deform.length = 0;
          return;
        case MixBlend.first:
          if (alpha == 1) {
            deform.length = 0;
            return;
          }
          deform.length = vertexCount;
          let vertexAttachment = slotAttachment;
          if (!vertexAttachment.bones) {
            let setupVertices = vertexAttachment.vertices;
            for (var i = 0;i < vertexCount; i++)
              deform[i] += (setupVertices[i] - deform[i]) * alpha;
          } else {
            alpha = 1 - alpha;
            for (var i = 0;i < vertexCount; i++)
              deform[i] *= alpha;
          }
      }
      return;
    }
    deform.length = vertexCount;
    if (time >= frames[frames.length - 1]) {
      let lastVertices = vertices[frames.length - 1];
      if (alpha == 1) {
        if (blend == MixBlend.add) {
          let vertexAttachment = slotAttachment;
          if (!vertexAttachment.bones) {
            let setupVertices = vertexAttachment.vertices;
            for (let i = 0;i < vertexCount; i++)
              deform[i] += lastVertices[i] - setupVertices[i];
          } else {
            for (let i = 0;i < vertexCount; i++)
              deform[i] += lastVertices[i];
          }
        } else
          Utils.arrayCopy(lastVertices, 0, deform, 0, vertexCount);
      } else {
        switch (blend) {
          case MixBlend.setup: {
            let vertexAttachment = slotAttachment;
            if (!vertexAttachment.bones) {
              let setupVertices = vertexAttachment.vertices;
              for (let i = 0;i < vertexCount; i++) {
                let setup = setupVertices[i];
                deform[i] = setup + (lastVertices[i] - setup) * alpha;
              }
            } else {
              for (let i = 0;i < vertexCount; i++)
                deform[i] = lastVertices[i] * alpha;
            }
            break;
          }
          case MixBlend.first:
          case MixBlend.replace:
            for (let i = 0;i < vertexCount; i++)
              deform[i] += (lastVertices[i] - deform[i]) * alpha;
            break;
          case MixBlend.add:
            let vertexAttachment = slotAttachment;
            if (!vertexAttachment.bones) {
              let setupVertices = vertexAttachment.vertices;
              for (let i = 0;i < vertexCount; i++)
                deform[i] += (lastVertices[i] - setupVertices[i]) * alpha;
            } else {
              for (let i = 0;i < vertexCount; i++)
                deform[i] += lastVertices[i] * alpha;
            }
        }
      }
      return;
    }
    let frame = Timeline.search1(frames, time);
    let percent = this.getCurvePercent(time, frame);
    let prevVertices = vertices[frame];
    let nextVertices = vertices[frame + 1];
    if (alpha == 1) {
      if (blend == MixBlend.add) {
        let vertexAttachment = slotAttachment;
        if (!vertexAttachment.bones) {
          let setupVertices = vertexAttachment.vertices;
          for (let i = 0;i < vertexCount; i++) {
            let prev = prevVertices[i];
            deform[i] += prev + (nextVertices[i] - prev) * percent - setupVertices[i];
          }
        } else {
          for (let i = 0;i < vertexCount; i++) {
            let prev = prevVertices[i];
            deform[i] += prev + (nextVertices[i] - prev) * percent;
          }
        }
      } else {
        for (let i = 0;i < vertexCount; i++) {
          let prev = prevVertices[i];
          deform[i] = prev + (nextVertices[i] - prev) * percent;
        }
      }
    } else {
      switch (blend) {
        case MixBlend.setup: {
          let vertexAttachment = slotAttachment;
          if (!vertexAttachment.bones) {
            let setupVertices = vertexAttachment.vertices;
            for (let i = 0;i < vertexCount; i++) {
              let prev = prevVertices[i], setup = setupVertices[i];
              deform[i] = setup + (prev + (nextVertices[i] - prev) * percent - setup) * alpha;
            }
          } else {
            for (let i = 0;i < vertexCount; i++) {
              let prev = prevVertices[i];
              deform[i] = (prev + (nextVertices[i] - prev) * percent) * alpha;
            }
          }
          break;
        }
        case MixBlend.first:
        case MixBlend.replace:
          for (let i = 0;i < vertexCount; i++) {
            let prev = prevVertices[i];
            deform[i] += (prev + (nextVertices[i] - prev) * percent - deform[i]) * alpha;
          }
          break;
        case MixBlend.add:
          let vertexAttachment = slotAttachment;
          if (!vertexAttachment.bones) {
            let setupVertices = vertexAttachment.vertices;
            for (let i = 0;i < vertexCount; i++) {
              let prev = prevVertices[i];
              deform[i] += (prev + (nextVertices[i] - prev) * percent - setupVertices[i]) * alpha;
            }
          } else {
            for (let i = 0;i < vertexCount; i++) {
              let prev = prevVertices[i];
              deform[i] += (prev + (nextVertices[i] - prev) * percent) * alpha;
            }
          }
      }
    }
  }
}

class EventTimeline extends Timeline {
  static propertyIds = ["" + Property.event];
  events;
  constructor(frameCount) {
    super(frameCount, EventTimeline.propertyIds);
    this.events = new Array(frameCount);
  }
  getFrameCount() {
    return this.frames.length;
  }
  setFrame(frame, event) {
    this.frames[frame] = event.time;
    this.events[frame] = event;
  }
  apply(skeleton, lastTime, time, firedEvents, alpha, blend, direction) {
    if (!firedEvents)
      return;
    let frames = this.frames;
    let frameCount = this.frames.length;
    if (lastTime > time) {
      this.apply(skeleton, lastTime, Number.MAX_VALUE, firedEvents, alpha, blend, direction);
      lastTime = -1;
    } else if (lastTime >= frames[frameCount - 1])
      return;
    if (time < frames[0])
      return;
    let i = 0;
    if (lastTime < frames[0])
      i = 0;
    else {
      i = Timeline.search1(frames, lastTime) + 1;
      let frameTime = frames[i];
      while (i > 0) {
        if (frames[i - 1] != frameTime)
          break;
        i--;
      }
    }
    for (;i < frameCount && time >= frames[i]; i++)
      firedEvents.push(this.events[i]);
  }
}

class DrawOrderTimeline extends Timeline {
  static propertyIds = ["" + Property.drawOrder];
  drawOrders;
  constructor(frameCount) {
    super(frameCount, DrawOrderTimeline.propertyIds);
    this.drawOrders = new Array(frameCount);
  }
  getFrameCount() {
    return this.frames.length;
  }
  setFrame(frame, time, drawOrder) {
    this.frames[frame] = time;
    this.drawOrders[frame] = drawOrder;
  }
  apply(skeleton, lastTime, time, firedEvents, alpha, blend, direction) {
    if (direction == MixDirection.mixOut) {
      if (blend == MixBlend.setup)
        Utils.arrayCopy(skeleton.slots, 0, skeleton.drawOrder, 0, skeleton.slots.length);
      return;
    }
    if (time < this.frames[0]) {
      if (blend == MixBlend.setup || blend == MixBlend.first)
        Utils.arrayCopy(skeleton.slots, 0, skeleton.drawOrder, 0, skeleton.slots.length);
      return;
    }
    let idx = Timeline.search1(this.frames, time);
    let drawOrderToSetupIndex = this.drawOrders[idx];
    if (!drawOrderToSetupIndex)
      Utils.arrayCopy(skeleton.slots, 0, skeleton.drawOrder, 0, skeleton.slots.length);
    else {
      let drawOrder = skeleton.drawOrder;
      let slots = skeleton.slots;
      for (let i = 0, n = drawOrderToSetupIndex.length;i < n; i++)
        drawOrder[i] = slots[drawOrderToSetupIndex[i]];
    }
  }
}

class IkConstraintTimeline extends CurveTimeline {
  ikConstraintIndex = 0;
  constructor(frameCount, bezierCount, ikConstraintIndex) {
    super(frameCount, bezierCount, [
      Property.ikConstraint + "|" + ikConstraintIndex
    ]);
    this.ikConstraintIndex = ikConstraintIndex;
  }
  getFrameEntries() {
    return 6;
  }
  setFrame(frame, time, mix, softness, bendDirection, compress, stretch) {
    frame *= 6;
    this.frames[frame] = time;
    this.frames[frame + 1] = mix;
    this.frames[frame + 2] = softness;
    this.frames[frame + 3] = bendDirection;
    this.frames[frame + 4] = compress ? 1 : 0;
    this.frames[frame + 5] = stretch ? 1 : 0;
  }
  apply(skeleton, lastTime, time, firedEvents, alpha, blend, direction) {
    let constraint = skeleton.ikConstraints[this.ikConstraintIndex];
    if (!constraint.active)
      return;
    let frames = this.frames;
    if (time < frames[0]) {
      switch (blend) {
        case MixBlend.setup:
          constraint.mix = constraint.data.mix;
          constraint.softness = constraint.data.softness;
          constraint.bendDirection = constraint.data.bendDirection;
          constraint.compress = constraint.data.compress;
          constraint.stretch = constraint.data.stretch;
          return;
        case MixBlend.first:
          constraint.mix += (constraint.data.mix - constraint.mix) * alpha;
          constraint.softness += (constraint.data.softness - constraint.softness) * alpha;
          constraint.bendDirection = constraint.data.bendDirection;
          constraint.compress = constraint.data.compress;
          constraint.stretch = constraint.data.stretch;
      }
      return;
    }
    let mix = 0, softness = 0;
    let i = Timeline.search(frames, time, 6);
    let curveType = this.curves[i / 6];
    switch (curveType) {
      case 0:
        let before = frames[i];
        mix = frames[i + 1];
        softness = frames[i + 2];
        let t = (time - before) / (frames[i + 6] - before);
        mix += (frames[i + 6 + 1] - mix) * t;
        softness += (frames[i + 6 + 2] - softness) * t;
        break;
      case 1:
        mix = frames[i + 1];
        softness = frames[i + 2];
        break;
      default:
        mix = this.getBezierValue(time, i, 1, curveType - 2);
        softness = this.getBezierValue(time, i, 2, curveType + 18 - 2);
    }
    if (blend == MixBlend.setup) {
      constraint.mix = constraint.data.mix + (mix - constraint.data.mix) * alpha;
      constraint.softness = constraint.data.softness + (softness - constraint.data.softness) * alpha;
      if (direction == MixDirection.mixOut) {
        constraint.bendDirection = constraint.data.bendDirection;
        constraint.compress = constraint.data.compress;
        constraint.stretch = constraint.data.stretch;
      } else {
        constraint.bendDirection = frames[i + 3];
        constraint.compress = frames[i + 4] != 0;
        constraint.stretch = frames[i + 5] != 0;
      }
    } else {
      constraint.mix += (mix - constraint.mix) * alpha;
      constraint.softness += (softness - constraint.softness) * alpha;
      if (direction == MixDirection.mixIn) {
        constraint.bendDirection = frames[i + 3];
        constraint.compress = frames[i + 4] != 0;
        constraint.stretch = frames[i + 5] != 0;
      }
    }
  }
}

class TransformConstraintTimeline extends CurveTimeline {
  transformConstraintIndex = 0;
  constructor(frameCount, bezierCount, transformConstraintIndex) {
    super(frameCount, bezierCount, [
      Property.transformConstraint + "|" + transformConstraintIndex
    ]);
    this.transformConstraintIndex = transformConstraintIndex;
  }
  getFrameEntries() {
    return 7;
  }
  setFrame(frame, time, mixRotate, mixX, mixY, mixScaleX, mixScaleY, mixShearY) {
    let frames = this.frames;
    frame *= 7;
    frames[frame] = time;
    frames[frame + 1] = mixRotate;
    frames[frame + 2] = mixX;
    frames[frame + 3] = mixY;
    frames[frame + 4] = mixScaleX;
    frames[frame + 5] = mixScaleY;
    frames[frame + 6] = mixShearY;
  }
  apply(skeleton, lastTime, time, firedEvents, alpha, blend, direction) {
    let constraint = skeleton.transformConstraints[this.transformConstraintIndex];
    if (!constraint.active)
      return;
    let frames = this.frames;
    if (time < frames[0]) {
      let data = constraint.data;
      switch (blend) {
        case MixBlend.setup:
          constraint.mixRotate = data.mixRotate;
          constraint.mixX = data.mixX;
          constraint.mixY = data.mixY;
          constraint.mixScaleX = data.mixScaleX;
          constraint.mixScaleY = data.mixScaleY;
          constraint.mixShearY = data.mixShearY;
          return;
        case MixBlend.first:
          constraint.mixRotate += (data.mixRotate - constraint.mixRotate) * alpha;
          constraint.mixX += (data.mixX - constraint.mixX) * alpha;
          constraint.mixY += (data.mixY - constraint.mixY) * alpha;
          constraint.mixScaleX += (data.mixScaleX - constraint.mixScaleX) * alpha;
          constraint.mixScaleY += (data.mixScaleY - constraint.mixScaleY) * alpha;
          constraint.mixShearY += (data.mixShearY - constraint.mixShearY) * alpha;
      }
      return;
    }
    let rotate, x, y, scaleX, scaleY, shearY;
    let i = Timeline.search(frames, time, 7);
    let curveType = this.curves[i / 7];
    switch (curveType) {
      case 0:
        let before = frames[i];
        rotate = frames[i + 1];
        x = frames[i + 2];
        y = frames[i + 3];
        scaleX = frames[i + 4];
        scaleY = frames[i + 5];
        shearY = frames[i + 6];
        let t = (time - before) / (frames[i + 7] - before);
        rotate += (frames[i + 7 + 1] - rotate) * t;
        x += (frames[i + 7 + 2] - x) * t;
        y += (frames[i + 7 + 3] - y) * t;
        scaleX += (frames[i + 7 + 4] - scaleX) * t;
        scaleY += (frames[i + 7 + 5] - scaleY) * t;
        shearY += (frames[i + 7 + 6] - shearY) * t;
        break;
      case 1:
        rotate = frames[i + 1];
        x = frames[i + 2];
        y = frames[i + 3];
        scaleX = frames[i + 4];
        scaleY = frames[i + 5];
        shearY = frames[i + 6];
        break;
      default:
        rotate = this.getBezierValue(time, i, 1, curveType - 2);
        x = this.getBezierValue(time, i, 2, curveType + 18 - 2);
        y = this.getBezierValue(time, i, 3, curveType + 18 * 2 - 2);
        scaleX = this.getBezierValue(time, i, 4, curveType + 18 * 3 - 2);
        scaleY = this.getBezierValue(time, i, 5, curveType + 18 * 4 - 2);
        shearY = this.getBezierValue(time, i, 6, curveType + 18 * 5 - 2);
    }
    if (blend == MixBlend.setup) {
      let data = constraint.data;
      constraint.mixRotate = data.mixRotate + (rotate - data.mixRotate) * alpha;
      constraint.mixX = data.mixX + (x - data.mixX) * alpha;
      constraint.mixY = data.mixY + (y - data.mixY) * alpha;
      constraint.mixScaleX = data.mixScaleX + (scaleX - data.mixScaleX) * alpha;
      constraint.mixScaleY = data.mixScaleY + (scaleY - data.mixScaleY) * alpha;
      constraint.mixShearY = data.mixShearY + (shearY - data.mixShearY) * alpha;
    } else {
      constraint.mixRotate += (rotate - constraint.mixRotate) * alpha;
      constraint.mixX += (x - constraint.mixX) * alpha;
      constraint.mixY += (y - constraint.mixY) * alpha;
      constraint.mixScaleX += (scaleX - constraint.mixScaleX) * alpha;
      constraint.mixScaleY += (scaleY - constraint.mixScaleY) * alpha;
      constraint.mixShearY += (shearY - constraint.mixShearY) * alpha;
    }
  }
}

class PathConstraintPositionTimeline extends CurveTimeline1 {
  pathConstraintIndex = 0;
  constructor(frameCount, bezierCount, pathConstraintIndex) {
    super(frameCount, bezierCount, Property.pathConstraintPosition + "|" + pathConstraintIndex);
    this.pathConstraintIndex = pathConstraintIndex;
  }
  apply(skeleton, lastTime, time, firedEvents, alpha, blend, direction) {
    let constraint = skeleton.pathConstraints[this.pathConstraintIndex];
    if (!constraint.active)
      return;
    let frames = this.frames;
    if (time < frames[0]) {
      switch (blend) {
        case MixBlend.setup:
          constraint.position = constraint.data.position;
          return;
        case MixBlend.first:
          constraint.position += (constraint.data.position - constraint.position) * alpha;
      }
      return;
    }
    let position = this.getCurveValue(time);
    if (blend == MixBlend.setup)
      constraint.position = constraint.data.position + (position - constraint.data.position) * alpha;
    else
      constraint.position += (position - constraint.position) * alpha;
  }
}

class PathConstraintSpacingTimeline extends CurveTimeline1 {
  pathConstraintIndex = 0;
  constructor(frameCount, bezierCount, pathConstraintIndex) {
    super(frameCount, bezierCount, Property.pathConstraintSpacing + "|" + pathConstraintIndex);
    this.pathConstraintIndex = pathConstraintIndex;
  }
  apply(skeleton, lastTime, time, firedEvents, alpha, blend, direction) {
    let constraint = skeleton.pathConstraints[this.pathConstraintIndex];
    if (!constraint.active)
      return;
    let frames = this.frames;
    if (time < frames[0]) {
      switch (blend) {
        case MixBlend.setup:
          constraint.spacing = constraint.data.spacing;
          return;
        case MixBlend.first:
          constraint.spacing += (constraint.data.spacing - constraint.spacing) * alpha;
      }
      return;
    }
    let spacing = this.getCurveValue(time);
    if (blend == MixBlend.setup)
      constraint.spacing = constraint.data.spacing + (spacing - constraint.data.spacing) * alpha;
    else
      constraint.spacing += (spacing - constraint.spacing) * alpha;
  }
}

class PathConstraintMixTimeline extends CurveTimeline {
  pathConstraintIndex = 0;
  constructor(frameCount, bezierCount, pathConstraintIndex) {
    super(frameCount, bezierCount, [
      Property.pathConstraintMix + "|" + pathConstraintIndex
    ]);
    this.pathConstraintIndex = pathConstraintIndex;
  }
  getFrameEntries() {
    return 4;
  }
  setFrame(frame, time, mixRotate, mixX, mixY) {
    let frames = this.frames;
    frame <<= 2;
    frames[frame] = time;
    frames[frame + 1] = mixRotate;
    frames[frame + 2] = mixX;
    frames[frame + 3] = mixY;
  }
  apply(skeleton, lastTime, time, firedEvents, alpha, blend, direction) {
    let constraint = skeleton.pathConstraints[this.pathConstraintIndex];
    if (!constraint.active)
      return;
    let frames = this.frames;
    if (time < frames[0]) {
      switch (blend) {
        case MixBlend.setup:
          constraint.mixRotate = constraint.data.mixRotate;
          constraint.mixX = constraint.data.mixX;
          constraint.mixY = constraint.data.mixY;
          return;
        case MixBlend.first:
          constraint.mixRotate += (constraint.data.mixRotate - constraint.mixRotate) * alpha;
          constraint.mixX += (constraint.data.mixX - constraint.mixX) * alpha;
          constraint.mixY += (constraint.data.mixY - constraint.mixY) * alpha;
      }
      return;
    }
    let rotate, x, y;
    let i = Timeline.search(frames, time, 4);
    let curveType = this.curves[i >> 2];
    switch (curveType) {
      case 0:
        let before = frames[i];
        rotate = frames[i + 1];
        x = frames[i + 2];
        y = frames[i + 3];
        let t = (time - before) / (frames[i + 4] - before);
        rotate += (frames[i + 4 + 1] - rotate) * t;
        x += (frames[i + 4 + 2] - x) * t;
        y += (frames[i + 4 + 3] - y) * t;
        break;
      case 1:
        rotate = frames[i + 1];
        x = frames[i + 2];
        y = frames[i + 3];
        break;
      default:
        rotate = this.getBezierValue(time, i, 1, curveType - 2);
        x = this.getBezierValue(time, i, 2, curveType + 18 - 2);
        y = this.getBezierValue(time, i, 3, curveType + 18 * 2 - 2);
    }
    if (blend == MixBlend.setup) {
      let data = constraint.data;
      constraint.mixRotate = data.mixRotate + (rotate - data.mixRotate) * alpha;
      constraint.mixX = data.mixX + (x - data.mixX) * alpha;
      constraint.mixY = data.mixY + (y - data.mixY) * alpha;
    } else {
      constraint.mixRotate += (rotate - constraint.mixRotate) * alpha;
      constraint.mixX += (x - constraint.mixX) * alpha;
      constraint.mixY += (y - constraint.mixY) * alpha;
    }
  }
}

class SequenceTimeline extends Timeline {
  static ENTRIES = 3;
  static MODE = 1;
  static DELAY = 2;
  slotIndex;
  attachment;
  constructor(frameCount, slotIndex, attachment) {
    super(frameCount, [
      Property.sequence + "|" + slotIndex + "|" + attachment.sequence.id
    ]);
    this.slotIndex = slotIndex;
    this.attachment = attachment;
  }
  getFrameEntries() {
    return SequenceTimeline.ENTRIES;
  }
  getSlotIndex() {
    return this.slotIndex;
  }
  getAttachment() {
    return this.attachment;
  }
  setFrame(frame, time, mode, index, delay) {
    let frames = this.frames;
    frame *= SequenceTimeline.ENTRIES;
    frames[frame] = time;
    frames[frame + SequenceTimeline.MODE] = mode | index << 4;
    frames[frame + SequenceTimeline.DELAY] = delay;
  }
  apply(skeleton, lastTime, time, events, alpha, blend, direction) {
    let slot = skeleton.slots[this.slotIndex];
    if (!slot.bone.active)
      return;
    let slotAttachment = slot.attachment;
    let attachment = this.attachment;
    if (slotAttachment != attachment) {
      if (!(slotAttachment instanceof VertexAttachment) || slotAttachment.timelineAttachment != attachment)
        return;
    }
    let frames = this.frames;
    if (time < frames[0]) {
      if (blend == MixBlend.setup || blend == MixBlend.first)
        slot.sequenceIndex = -1;
      return;
    }
    let i = Timeline.search(frames, time, SequenceTimeline.ENTRIES);
    let before = frames[i];
    let modeAndIndex = frames[i + SequenceTimeline.MODE];
    let delay = frames[i + SequenceTimeline.DELAY];
    if (!this.attachment.sequence)
      return;
    let index = modeAndIndex >> 4, count = this.attachment.sequence.regions.length;
    let mode = SequenceModeValues[modeAndIndex & 15];
    if (mode != SequenceMode.hold) {
      index += (time - before) / delay + 0.00001 | 0;
      switch (mode) {
        case SequenceMode.once:
          index = Math.min(count - 1, index);
          break;
        case SequenceMode.loop:
          index %= count;
          break;
        case SequenceMode.pingpong: {
          let n = (count << 1) - 2;
          index = n == 0 ? 0 : index % n;
          if (index >= count)
            index = n - index;
          break;
        }
        case SequenceMode.onceReverse:
          index = Math.max(count - 1 - index, 0);
          break;
        case SequenceMode.loopReverse:
          index = count - 1 - index % count;
          break;
        case SequenceMode.pingpongReverse: {
          let n = (count << 1) - 2;
          index = n == 0 ? 0 : (index + count - 1) % n;
          if (index >= count)
            index = n - index;
        }
      }
    }
    slot.sequenceIndex = index;
  }
}
// node_modules/@esotericsoftware/spine-core/dist/AnimationState.js
class AnimationState {
  static _emptyAnimation = new Animation("<empty>", [], 0);
  static emptyAnimation() {
    return AnimationState._emptyAnimation;
  }
  data;
  tracks = new Array;
  timeScale = 1;
  unkeyedState = 0;
  events = new Array;
  listeners = new Array;
  queue = new EventQueue(this);
  propertyIDs = new StringSet;
  animationsChanged = false;
  trackEntryPool = new Pool(() => new TrackEntry);
  constructor(data) {
    this.data = data;
  }
  update(delta) {
    delta *= this.timeScale;
    let tracks = this.tracks;
    for (let i = 0, n = tracks.length;i < n; i++) {
      let current = tracks[i];
      if (!current)
        continue;
      current.animationLast = current.nextAnimationLast;
      current.trackLast = current.nextTrackLast;
      let currentDelta = delta * current.timeScale;
      if (current.delay > 0) {
        current.delay -= currentDelta;
        if (current.delay > 0)
          continue;
        currentDelta = -current.delay;
        current.delay = 0;
      }
      let next = current.next;
      if (next) {
        let nextTime = current.trackLast - next.delay;
        if (nextTime >= 0) {
          next.delay = 0;
          next.trackTime += current.timeScale == 0 ? 0 : (nextTime / current.timeScale + delta) * next.timeScale;
          current.trackTime += currentDelta;
          this.setCurrent(i, next, true);
          while (next.mixingFrom) {
            next.mixTime += delta;
            next = next.mixingFrom;
          }
          continue;
        }
      } else if (current.trackLast >= current.trackEnd && !current.mixingFrom) {
        tracks[i] = null;
        this.queue.end(current);
        this.clearNext(current);
        continue;
      }
      if (current.mixingFrom && this.updateMixingFrom(current, delta)) {
        let from = current.mixingFrom;
        current.mixingFrom = null;
        if (from)
          from.mixingTo = null;
        while (from) {
          this.queue.end(from);
          from = from.mixingFrom;
        }
      }
      current.trackTime += currentDelta;
    }
    this.queue.drain();
  }
  updateMixingFrom(to, delta) {
    let from = to.mixingFrom;
    if (!from)
      return true;
    let finished = this.updateMixingFrom(from, delta);
    from.animationLast = from.nextAnimationLast;
    from.trackLast = from.nextTrackLast;
    if (to.mixTime > 0 && to.mixTime >= to.mixDuration) {
      if (from.totalAlpha == 0 || to.mixDuration == 0) {
        to.mixingFrom = from.mixingFrom;
        if (from.mixingFrom)
          from.mixingFrom.mixingTo = to;
        to.interruptAlpha = from.interruptAlpha;
        this.queue.end(from);
      }
      return finished;
    }
    from.trackTime += delta * from.timeScale;
    to.mixTime += delta;
    return false;
  }
  apply(skeleton) {
    if (!skeleton)
      throw new Error("skeleton cannot be null.");
    if (this.animationsChanged)
      this._animationsChanged();
    let events = this.events;
    let tracks = this.tracks;
    let applied = false;
    for (let i = 0, n = tracks.length;i < n; i++) {
      let current = tracks[i];
      if (!current || current.delay > 0)
        continue;
      applied = true;
      let blend = i == 0 ? MixBlend.first : current.mixBlend;
      let mix = current.alpha;
      if (current.mixingFrom)
        mix *= this.applyMixingFrom(current, skeleton, blend);
      else if (current.trackTime >= current.trackEnd && !current.next)
        mix = 0;
      let animationLast = current.animationLast, animationTime = current.getAnimationTime(), applyTime = animationTime;
      let applyEvents = events;
      if (current.reverse) {
        applyTime = current.animation.duration - applyTime;
        applyEvents = null;
      }
      let timelines = current.animation.timelines;
      let timelineCount = timelines.length;
      if (i == 0 && mix == 1 || blend == MixBlend.add) {
        for (let ii = 0;ii < timelineCount; ii++) {
          Utils.webkit602BugfixHelper(mix, blend);
          var timeline = timelines[ii];
          if (timeline instanceof AttachmentTimeline)
            this.applyAttachmentTimeline(timeline, skeleton, applyTime, blend, true);
          else
            timeline.apply(skeleton, animationLast, applyTime, applyEvents, mix, blend, MixDirection.mixIn);
        }
      } else {
        let timelineMode = current.timelineMode;
        let shortestRotation = current.shortestRotation;
        let firstFrame = !shortestRotation && current.timelinesRotation.length != timelineCount << 1;
        if (firstFrame)
          current.timelinesRotation.length = timelineCount << 1;
        for (let ii = 0;ii < timelineCount; ii++) {
          let timeline = timelines[ii];
          let timelineBlend = timelineMode[ii] == SUBSEQUENT ? blend : MixBlend.setup;
          if (!shortestRotation && timeline instanceof RotateTimeline) {
            this.applyRotateTimeline(timeline, skeleton, applyTime, mix, timelineBlend, current.timelinesRotation, ii << 1, firstFrame);
          } else if (timeline instanceof AttachmentTimeline) {
            this.applyAttachmentTimeline(timeline, skeleton, applyTime, blend, true);
          } else {
            Utils.webkit602BugfixHelper(mix, blend);
            timeline.apply(skeleton, animationLast, applyTime, applyEvents, mix, timelineBlend, MixDirection.mixIn);
          }
        }
      }
      this.queueEvents(current, animationTime);
      events.length = 0;
      current.nextAnimationLast = animationTime;
      current.nextTrackLast = current.trackTime;
    }
    var setupState = this.unkeyedState + SETUP;
    var slots = skeleton.slots;
    for (var i = 0, n = skeleton.slots.length;i < n; i++) {
      var slot = slots[i];
      if (slot.attachmentState == setupState) {
        var attachmentName = slot.data.attachmentName;
        slot.setAttachment(!attachmentName ? null : skeleton.getAttachment(slot.data.index, attachmentName));
      }
    }
    this.unkeyedState += 2;
    this.queue.drain();
    return applied;
  }
  applyMixingFrom(to, skeleton, blend) {
    let from = to.mixingFrom;
    if (from.mixingFrom)
      this.applyMixingFrom(from, skeleton, blend);
    let mix = 0;
    if (to.mixDuration == 0) {
      mix = 1;
      if (blend == MixBlend.first)
        blend = MixBlend.setup;
    } else {
      mix = to.mixTime / to.mixDuration;
      if (mix > 1)
        mix = 1;
      if (blend != MixBlend.first)
        blend = from.mixBlend;
    }
    let attachments = mix < from.attachmentThreshold, drawOrder = mix < from.drawOrderThreshold;
    let timelines = from.animation.timelines;
    let timelineCount = timelines.length;
    let alphaHold = from.alpha * to.interruptAlpha, alphaMix = alphaHold * (1 - mix);
    let animationLast = from.animationLast, animationTime = from.getAnimationTime(), applyTime = animationTime;
    let events = null;
    if (from.reverse)
      applyTime = from.animation.duration - applyTime;
    else if (mix < from.eventThreshold)
      events = this.events;
    if (blend == MixBlend.add) {
      for (let i = 0;i < timelineCount; i++)
        timelines[i].apply(skeleton, animationLast, applyTime, events, alphaMix, blend, MixDirection.mixOut);
    } else {
      let timelineMode = from.timelineMode;
      let timelineHoldMix = from.timelineHoldMix;
      let shortestRotation = from.shortestRotation;
      let firstFrame = !shortestRotation && from.timelinesRotation.length != timelineCount << 1;
      if (firstFrame)
        from.timelinesRotation.length = timelineCount << 1;
      from.totalAlpha = 0;
      for (let i = 0;i < timelineCount; i++) {
        let timeline = timelines[i];
        let direction = MixDirection.mixOut;
        let timelineBlend;
        let alpha = 0;
        switch (timelineMode[i]) {
          case SUBSEQUENT:
            if (!drawOrder && timeline instanceof DrawOrderTimeline)
              continue;
            timelineBlend = blend;
            alpha = alphaMix;
            break;
          case FIRST:
            timelineBlend = MixBlend.setup;
            alpha = alphaMix;
            break;
          case HOLD_SUBSEQUENT:
            timelineBlend = blend;
            alpha = alphaHold;
            break;
          case HOLD_FIRST:
            timelineBlend = MixBlend.setup;
            alpha = alphaHold;
            break;
          default:
            timelineBlend = MixBlend.setup;
            let holdMix = timelineHoldMix[i];
            alpha = alphaHold * Math.max(0, 1 - holdMix.mixTime / holdMix.mixDuration);
            break;
        }
        from.totalAlpha += alpha;
        if (!shortestRotation && timeline instanceof RotateTimeline)
          this.applyRotateTimeline(timeline, skeleton, applyTime, alpha, timelineBlend, from.timelinesRotation, i << 1, firstFrame);
        else if (timeline instanceof AttachmentTimeline)
          this.applyAttachmentTimeline(timeline, skeleton, applyTime, timelineBlend, attachments);
        else {
          Utils.webkit602BugfixHelper(alpha, blend);
          if (drawOrder && timeline instanceof DrawOrderTimeline && timelineBlend == MixBlend.setup)
            direction = MixDirection.mixIn;
          timeline.apply(skeleton, animationLast, applyTime, events, alpha, timelineBlend, direction);
        }
      }
    }
    if (to.mixDuration > 0)
      this.queueEvents(from, animationTime);
    this.events.length = 0;
    from.nextAnimationLast = animationTime;
    from.nextTrackLast = from.trackTime;
    return mix;
  }
  applyAttachmentTimeline(timeline, skeleton, time, blend, attachments) {
    var slot = skeleton.slots[timeline.slotIndex];
    if (!slot.bone.active)
      return;
    if (time < timeline.frames[0]) {
      if (blend == MixBlend.setup || blend == MixBlend.first)
        this.setAttachment(skeleton, slot, slot.data.attachmentName, attachments);
    } else
      this.setAttachment(skeleton, slot, timeline.attachmentNames[Timeline.search1(timeline.frames, time)], attachments);
    if (slot.attachmentState <= this.unkeyedState)
      slot.attachmentState = this.unkeyedState + SETUP;
  }
  setAttachment(skeleton, slot, attachmentName, attachments) {
    slot.setAttachment(!attachmentName ? null : skeleton.getAttachment(slot.data.index, attachmentName));
    if (attachments)
      slot.attachmentState = this.unkeyedState + CURRENT;
  }
  applyRotateTimeline(timeline, skeleton, time, alpha, blend, timelinesRotation, i, firstFrame) {
    if (firstFrame)
      timelinesRotation[i] = 0;
    if (alpha == 1) {
      timeline.apply(skeleton, 0, time, null, 1, blend, MixDirection.mixIn);
      return;
    }
    let bone = skeleton.bones[timeline.boneIndex];
    if (!bone.active)
      return;
    let frames = timeline.frames;
    let r1 = 0, r2 = 0;
    if (time < frames[0]) {
      switch (blend) {
        case MixBlend.setup:
          bone.rotation = bone.data.rotation;
        default:
          return;
        case MixBlend.first:
          r1 = bone.rotation;
          r2 = bone.data.rotation;
      }
    } else {
      r1 = blend == MixBlend.setup ? bone.data.rotation : bone.rotation;
      r2 = bone.data.rotation + timeline.getCurveValue(time);
    }
    let total = 0, diff = r2 - r1;
    diff -= (16384 - (16384.499999999996 - diff / 360 | 0)) * 360;
    if (diff == 0) {
      total = timelinesRotation[i];
    } else {
      let lastTotal = 0, lastDiff = 0;
      if (firstFrame) {
        lastTotal = 0;
        lastDiff = diff;
      } else {
        lastTotal = timelinesRotation[i];
        lastDiff = timelinesRotation[i + 1];
      }
      let current = diff > 0, dir = lastTotal >= 0;
      if (MathUtils.signum(lastDiff) != MathUtils.signum(diff) && Math.abs(lastDiff) <= 90) {
        if (Math.abs(lastTotal) > 180)
          lastTotal += 360 * MathUtils.signum(lastTotal);
        dir = current;
      }
      total = diff + lastTotal - lastTotal % 360;
      if (dir != current)
        total += 360 * MathUtils.signum(lastTotal);
      timelinesRotation[i] = total;
    }
    timelinesRotation[i + 1] = diff;
    bone.rotation = r1 + total * alpha;
  }
  queueEvents(entry, animationTime) {
    let { animationStart, animationEnd } = entry;
    let duration = animationEnd - animationStart;
    let trackLastWrapped = entry.trackLast % duration;
    let events = this.events;
    let i = 0, n = events.length;
    for (;i < n; i++) {
      let event = events[i];
      if (event.time < trackLastWrapped)
        break;
      if (event.time > animationEnd)
        continue;
      this.queue.event(entry, event);
    }
    let complete = false;
    if (entry.loop)
      complete = duration == 0 || trackLastWrapped > entry.trackTime % duration;
    else
      complete = animationTime >= animationEnd && entry.animationLast < animationEnd;
    if (complete)
      this.queue.complete(entry);
    for (;i < n; i++) {
      let event = events[i];
      if (event.time < animationStart)
        continue;
      this.queue.event(entry, event);
    }
  }
  clearTracks() {
    let oldDrainDisabled = this.queue.drainDisabled;
    this.queue.drainDisabled = true;
    for (let i = 0, n = this.tracks.length;i < n; i++)
      this.clearTrack(i);
    this.tracks.length = 0;
    this.queue.drainDisabled = oldDrainDisabled;
    this.queue.drain();
  }
  clearTrack(trackIndex) {
    if (trackIndex >= this.tracks.length)
      return;
    let current = this.tracks[trackIndex];
    if (!current)
      return;
    this.queue.end(current);
    this.clearNext(current);
    let entry = current;
    while (true) {
      let from = entry.mixingFrom;
      if (!from)
        break;
      this.queue.end(from);
      entry.mixingFrom = null;
      entry.mixingTo = null;
      entry = from;
    }
    this.tracks[current.trackIndex] = null;
    this.queue.drain();
  }
  setCurrent(index, current, interrupt) {
    let from = this.expandToIndex(index);
    this.tracks[index] = current;
    current.previous = null;
    if (from) {
      if (interrupt)
        this.queue.interrupt(from);
      current.mixingFrom = from;
      from.mixingTo = current;
      current.mixTime = 0;
      if (from.mixingFrom && from.mixDuration > 0)
        current.interruptAlpha *= Math.min(1, from.mixTime / from.mixDuration);
      from.timelinesRotation.length = 0;
    }
    this.queue.start(current);
  }
  setAnimation(trackIndex, animationName, loop = false) {
    let animation = this.data.skeletonData.findAnimation(animationName);
    if (!animation)
      throw new Error("Animation not found: " + animationName);
    return this.setAnimationWith(trackIndex, animation, loop);
  }
  setAnimationWith(trackIndex, animation, loop = false) {
    if (!animation)
      throw new Error("animation cannot be null.");
    let interrupt = true;
    let current = this.expandToIndex(trackIndex);
    if (current) {
      if (current.nextTrackLast == -1) {
        this.tracks[trackIndex] = current.mixingFrom;
        this.queue.interrupt(current);
        this.queue.end(current);
        this.clearNext(current);
        current = current.mixingFrom;
        interrupt = false;
      } else
        this.clearNext(current);
    }
    let entry = this.trackEntry(trackIndex, animation, loop, current);
    this.setCurrent(trackIndex, entry, interrupt);
    this.queue.drain();
    return entry;
  }
  addAnimation(trackIndex, animationName, loop = false, delay = 0) {
    let animation = this.data.skeletonData.findAnimation(animationName);
    if (!animation)
      throw new Error("Animation not found: " + animationName);
    return this.addAnimationWith(trackIndex, animation, loop, delay);
  }
  addAnimationWith(trackIndex, animation, loop = false, delay = 0) {
    if (!animation)
      throw new Error("animation cannot be null.");
    let last = this.expandToIndex(trackIndex);
    if (last) {
      while (last.next)
        last = last.next;
    }
    let entry = this.trackEntry(trackIndex, animation, loop, last);
    if (!last) {
      this.setCurrent(trackIndex, entry, true);
      this.queue.drain();
    } else {
      last.next = entry;
      entry.previous = last;
      if (delay <= 0)
        delay += last.getTrackComplete() - entry.mixDuration;
    }
    entry.delay = delay;
    return entry;
  }
  setEmptyAnimation(trackIndex, mixDuration = 0) {
    let entry = this.setAnimationWith(trackIndex, AnimationState.emptyAnimation(), false);
    entry.mixDuration = mixDuration;
    entry.trackEnd = mixDuration;
    return entry;
  }
  addEmptyAnimation(trackIndex, mixDuration = 0, delay = 0) {
    let entry = this.addAnimationWith(trackIndex, AnimationState.emptyAnimation(), false, delay);
    if (delay <= 0)
      entry.delay += entry.mixDuration - mixDuration;
    entry.mixDuration = mixDuration;
    entry.trackEnd = mixDuration;
    return entry;
  }
  setEmptyAnimations(mixDuration = 0) {
    let oldDrainDisabled = this.queue.drainDisabled;
    this.queue.drainDisabled = true;
    for (let i = 0, n = this.tracks.length;i < n; i++) {
      let current = this.tracks[i];
      if (current)
        this.setEmptyAnimation(current.trackIndex, mixDuration);
    }
    this.queue.drainDisabled = oldDrainDisabled;
    this.queue.drain();
  }
  expandToIndex(index) {
    if (index < this.tracks.length)
      return this.tracks[index];
    Utils.ensureArrayCapacity(this.tracks, index + 1, null);
    this.tracks.length = index + 1;
    return null;
  }
  trackEntry(trackIndex, animation, loop, last) {
    let entry = this.trackEntryPool.obtain();
    entry.reset();
    entry.trackIndex = trackIndex;
    entry.animation = animation;
    entry.loop = loop;
    entry.holdPrevious = false;
    entry.reverse = false;
    entry.shortestRotation = false;
    entry.eventThreshold = 0;
    entry.attachmentThreshold = 0;
    entry.drawOrderThreshold = 0;
    entry.animationStart = 0;
    entry.animationEnd = animation.duration;
    entry.animationLast = -1;
    entry.nextAnimationLast = -1;
    entry.delay = 0;
    entry.trackTime = 0;
    entry.trackLast = -1;
    entry.nextTrackLast = -1;
    entry.trackEnd = Number.MAX_VALUE;
    entry.timeScale = 1;
    entry.alpha = 1;
    entry.mixTime = 0;
    entry.mixDuration = !last ? 0 : this.data.getMix(last.animation, animation);
    entry.interruptAlpha = 1;
    entry.totalAlpha = 0;
    entry.mixBlend = MixBlend.replace;
    return entry;
  }
  clearNext(entry) {
    let next = entry.next;
    while (next) {
      this.queue.dispose(next);
      next = next.next;
    }
    entry.next = null;
  }
  _animationsChanged() {
    this.animationsChanged = false;
    this.propertyIDs.clear();
    let tracks = this.tracks;
    for (let i = 0, n = tracks.length;i < n; i++) {
      let entry = tracks[i];
      if (!entry)
        continue;
      while (entry.mixingFrom)
        entry = entry.mixingFrom;
      do {
        if (!entry.mixingTo || entry.mixBlend != MixBlend.add)
          this.computeHold(entry);
        entry = entry.mixingTo;
      } while (entry);
    }
  }
  computeHold(entry) {
    let to = entry.mixingTo;
    let timelines = entry.animation.timelines;
    let timelinesCount = entry.animation.timelines.length;
    let timelineMode = entry.timelineMode;
    timelineMode.length = timelinesCount;
    let timelineHoldMix = entry.timelineHoldMix;
    timelineHoldMix.length = 0;
    let propertyIDs = this.propertyIDs;
    if (to && to.holdPrevious) {
      for (let i = 0;i < timelinesCount; i++)
        timelineMode[i] = propertyIDs.addAll(timelines[i].getPropertyIds()) ? HOLD_FIRST : HOLD_SUBSEQUENT;
      return;
    }
    outer:
      for (let i = 0;i < timelinesCount; i++) {
        let timeline = timelines[i];
        let ids = timeline.getPropertyIds();
        if (!propertyIDs.addAll(ids))
          timelineMode[i] = SUBSEQUENT;
        else if (!to || timeline instanceof AttachmentTimeline || timeline instanceof DrawOrderTimeline || timeline instanceof EventTimeline || !to.animation.hasTimeline(ids)) {
          timelineMode[i] = FIRST;
        } else {
          for (let next = to.mixingTo;next; next = next.mixingTo) {
            if (next.animation.hasTimeline(ids))
              continue;
            if (entry.mixDuration > 0) {
              timelineMode[i] = HOLD_MIX;
              timelineHoldMix[i] = next;
              continue outer;
            }
            break;
          }
          timelineMode[i] = HOLD_FIRST;
        }
      }
  }
  getCurrent(trackIndex) {
    if (trackIndex >= this.tracks.length)
      return null;
    return this.tracks[trackIndex];
  }
  addListener(listener) {
    if (!listener)
      throw new Error("listener cannot be null.");
    this.listeners.push(listener);
  }
  removeListener(listener) {
    let index = this.listeners.indexOf(listener);
    if (index >= 0)
      this.listeners.splice(index, 1);
  }
  clearListeners() {
    this.listeners.length = 0;
  }
  clearListenerNotifications() {
    this.queue.clear();
  }
}

class TrackEntry {
  animation = null;
  previous = null;
  next = null;
  mixingFrom = null;
  mixingTo = null;
  listener = null;
  trackIndex = 0;
  loop = false;
  holdPrevious = false;
  reverse = false;
  shortestRotation = false;
  eventThreshold = 0;
  attachmentThreshold = 0;
  drawOrderThreshold = 0;
  animationStart = 0;
  animationEnd = 0;
  animationLast = 0;
  nextAnimationLast = 0;
  delay = 0;
  trackTime = 0;
  trackLast = 0;
  nextTrackLast = 0;
  trackEnd = 0;
  timeScale = 0;
  alpha = 0;
  mixTime = 0;
  mixDuration = 0;
  interruptAlpha = 0;
  totalAlpha = 0;
  mixBlend = MixBlend.replace;
  timelineMode = new Array;
  timelineHoldMix = new Array;
  timelinesRotation = new Array;
  reset() {
    this.next = null;
    this.previous = null;
    this.mixingFrom = null;
    this.mixingTo = null;
    this.animation = null;
    this.listener = null;
    this.timelineMode.length = 0;
    this.timelineHoldMix.length = 0;
    this.timelinesRotation.length = 0;
  }
  getAnimationTime() {
    if (this.loop) {
      let duration = this.animationEnd - this.animationStart;
      if (duration == 0)
        return this.animationStart;
      return this.trackTime % duration + this.animationStart;
    }
    return Math.min(this.trackTime + this.animationStart, this.animationEnd);
  }
  setAnimationLast(animationLast) {
    this.animationLast = animationLast;
    this.nextAnimationLast = animationLast;
  }
  isComplete() {
    return this.trackTime >= this.animationEnd - this.animationStart;
  }
  resetRotationDirections() {
    this.timelinesRotation.length = 0;
  }
  getTrackComplete() {
    let duration = this.animationEnd - this.animationStart;
    if (duration != 0) {
      if (this.loop)
        return duration * (1 + (this.trackTime / duration | 0));
      if (this.trackTime < duration)
        return duration;
    }
    return this.trackTime;
  }
}

class EventQueue {
  objects = [];
  drainDisabled = false;
  animState;
  constructor(animState) {
    this.animState = animState;
  }
  start(entry) {
    this.objects.push(EventType.start);
    this.objects.push(entry);
    this.animState.animationsChanged = true;
  }
  interrupt(entry) {
    this.objects.push(EventType.interrupt);
    this.objects.push(entry);
  }
  end(entry) {
    this.objects.push(EventType.end);
    this.objects.push(entry);
    this.animState.animationsChanged = true;
  }
  dispose(entry) {
    this.objects.push(EventType.dispose);
    this.objects.push(entry);
  }
  complete(entry) {
    this.objects.push(EventType.complete);
    this.objects.push(entry);
  }
  event(entry, event) {
    this.objects.push(EventType.event);
    this.objects.push(entry);
    this.objects.push(event);
  }
  drain() {
    if (this.drainDisabled)
      return;
    this.drainDisabled = true;
    let objects = this.objects;
    let listeners = this.animState.listeners;
    for (let i = 0;i < objects.length; i += 2) {
      let type = objects[i];
      let entry = objects[i + 1];
      switch (type) {
        case EventType.start:
          if (entry.listener && entry.listener.start)
            entry.listener.start(entry);
          for (let ii = 0;ii < listeners.length; ii++) {
            let listener = listeners[ii];
            if (listener.start)
              listener.start(entry);
          }
          break;
        case EventType.interrupt:
          if (entry.listener && entry.listener.interrupt)
            entry.listener.interrupt(entry);
          for (let ii = 0;ii < listeners.length; ii++) {
            let listener = listeners[ii];
            if (listener.interrupt)
              listener.interrupt(entry);
          }
          break;
        case EventType.end:
          if (entry.listener && entry.listener.end)
            entry.listener.end(entry);
          for (let ii = 0;ii < listeners.length; ii++) {
            let listener = listeners[ii];
            if (listener.end)
              listener.end(entry);
          }
        case EventType.dispose:
          if (entry.listener && entry.listener.dispose)
            entry.listener.dispose(entry);
          for (let ii = 0;ii < listeners.length; ii++) {
            let listener = listeners[ii];
            if (listener.dispose)
              listener.dispose(entry);
          }
          this.animState.trackEntryPool.free(entry);
          break;
        case EventType.complete:
          if (entry.listener && entry.listener.complete)
            entry.listener.complete(entry);
          for (let ii = 0;ii < listeners.length; ii++) {
            let listener = listeners[ii];
            if (listener.complete)
              listener.complete(entry);
          }
          break;
        case EventType.event:
          let event = objects[i++ + 2];
          if (entry.listener && entry.listener.event)
            entry.listener.event(entry, event);
          for (let ii = 0;ii < listeners.length; ii++) {
            let listener = listeners[ii];
            if (listener.event)
              listener.event(entry, event);
          }
          break;
      }
    }
    this.clear();
    this.drainDisabled = false;
  }
  clear() {
    this.objects.length = 0;
  }
}
var EventType;
(function(EventType) {
  EventType[EventType["start"] = 0] = "start";
  EventType[EventType["interrupt"] = 1] = "interrupt";
  EventType[EventType["end"] = 2] = "end";
  EventType[EventType["dispose"] = 3] = "dispose";
  EventType[EventType["complete"] = 4] = "complete";
  EventType[EventType["event"] = 5] = "event";
})(EventType || (EventType = {}));
var SUBSEQUENT = 0;
var FIRST = 1;
var HOLD_SUBSEQUENT = 2;
var HOLD_FIRST = 3;
var HOLD_MIX = 4;
var SETUP = 1;
var CURRENT = 2;
// node_modules/@esotericsoftware/spine-core/dist/AnimationStateData.js
class AnimationStateData {
  skeletonData;
  animationToMixTime = {};
  defaultMix = 0;
  constructor(skeletonData) {
    if (!skeletonData)
      throw new Error("skeletonData cannot be null.");
    this.skeletonData = skeletonData;
  }
  setMix(fromName, toName, duration) {
    let from = this.skeletonData.findAnimation(fromName);
    if (!from)
      throw new Error("Animation not found: " + fromName);
    let to = this.skeletonData.findAnimation(toName);
    if (!to)
      throw new Error("Animation not found: " + toName);
    this.setMixWith(from, to, duration);
  }
  setMixWith(from, to, duration) {
    if (!from)
      throw new Error("from cannot be null.");
    if (!to)
      throw new Error("to cannot be null.");
    let key = from.name + "." + to.name;
    this.animationToMixTime[key] = duration;
  }
  getMix(from, to) {
    let key = from.name + "." + to.name;
    let value = this.animationToMixTime[key];
    return value === undefined ? this.defaultMix : value;
  }
}
// node_modules/@esotericsoftware/spine-core/dist/attachments/BoundingBoxAttachment.js
class BoundingBoxAttachment extends VertexAttachment {
  color = new Color(1, 1, 1, 1);
  constructor(name) {
    super(name);
  }
  copy() {
    let copy = new BoundingBoxAttachment(this.name);
    this.copyTo(copy);
    copy.color.setFromColor(this.color);
    return copy;
  }
}

// node_modules/@esotericsoftware/spine-core/dist/attachments/ClippingAttachment.js
class ClippingAttachment extends VertexAttachment {
  endSlot = null;
  color = new Color(0.2275, 0.2275, 0.8078, 1);
  constructor(name) {
    super(name);
  }
  copy() {
    let copy = new ClippingAttachment(this.name);
    this.copyTo(copy);
    copy.endSlot = this.endSlot;
    copy.color.setFromColor(this.color);
    return copy;
  }
}

// node_modules/@esotericsoftware/spine-core/dist/Texture.js
class Texture {
  _image;
  constructor(image) {
    this._image = image;
  }
  getImage() {
    return this._image;
  }
}
var TextureFilter;
(function(TextureFilter) {
  TextureFilter[TextureFilter["Nearest"] = 9728] = "Nearest";
  TextureFilter[TextureFilter["Linear"] = 9729] = "Linear";
  TextureFilter[TextureFilter["MipMap"] = 9987] = "MipMap";
  TextureFilter[TextureFilter["MipMapNearestNearest"] = 9984] = "MipMapNearestNearest";
  TextureFilter[TextureFilter["MipMapLinearNearest"] = 9985] = "MipMapLinearNearest";
  TextureFilter[TextureFilter["MipMapNearestLinear"] = 9986] = "MipMapNearestLinear";
  TextureFilter[TextureFilter["MipMapLinearLinear"] = 9987] = "MipMapLinearLinear";
})(TextureFilter || (TextureFilter = {}));
var TextureWrap;
(function(TextureWrap) {
  TextureWrap[TextureWrap["MirroredRepeat"] = 33648] = "MirroredRepeat";
  TextureWrap[TextureWrap["ClampToEdge"] = 33071] = "ClampToEdge";
  TextureWrap[TextureWrap["Repeat"] = 10497] = "Repeat";
})(TextureWrap || (TextureWrap = {}));

class TextureRegion {
  texture;
  u = 0;
  v = 0;
  u2 = 0;
  v2 = 0;
  width = 0;
  height = 0;
  degrees = 0;
  offsetX = 0;
  offsetY = 0;
  originalWidth = 0;
  originalHeight = 0;
}

// node_modules/@esotericsoftware/spine-core/dist/TextureAtlas.js
class TextureAtlas {
  pages = new Array;
  regions = new Array;
  constructor(atlasText) {
    let reader = new TextureAtlasReader(atlasText);
    let entry = new Array(4);
    let pageFields = {};
    pageFields["size"] = (page) => {
      page.width = parseInt(entry[1]);
      page.height = parseInt(entry[2]);
    };
    pageFields["format"] = () => {};
    pageFields["filter"] = (page) => {
      page.minFilter = Utils.enumValue(TextureFilter, entry[1]);
      page.magFilter = Utils.enumValue(TextureFilter, entry[2]);
    };
    pageFields["repeat"] = (page) => {
      if (entry[1].indexOf("x") != -1)
        page.uWrap = TextureWrap.Repeat;
      if (entry[1].indexOf("y") != -1)
        page.vWrap = TextureWrap.Repeat;
    };
    pageFields["pma"] = (page) => {
      page.pma = entry[1] == "true";
    };
    var regionFields = {};
    regionFields["xy"] = (region) => {
      region.x = parseInt(entry[1]);
      region.y = parseInt(entry[2]);
    };
    regionFields["size"] = (region) => {
      region.width = parseInt(entry[1]);
      region.height = parseInt(entry[2]);
    };
    regionFields["bounds"] = (region) => {
      region.x = parseInt(entry[1]);
      region.y = parseInt(entry[2]);
      region.width = parseInt(entry[3]);
      region.height = parseInt(entry[4]);
    };
    regionFields["offset"] = (region) => {
      region.offsetX = parseInt(entry[1]);
      region.offsetY = parseInt(entry[2]);
    };
    regionFields["orig"] = (region) => {
      region.originalWidth = parseInt(entry[1]);
      region.originalHeight = parseInt(entry[2]);
    };
    regionFields["offsets"] = (region) => {
      region.offsetX = parseInt(entry[1]);
      region.offsetY = parseInt(entry[2]);
      region.originalWidth = parseInt(entry[3]);
      region.originalHeight = parseInt(entry[4]);
    };
    regionFields["rotate"] = (region) => {
      let value = entry[1];
      if (value == "true")
        region.degrees = 90;
      else if (value != "false")
        region.degrees = parseInt(value);
    };
    regionFields["index"] = (region) => {
      region.index = parseInt(entry[1]);
    };
    let line = reader.readLine();
    while (line && line.trim().length == 0)
      line = reader.readLine();
    while (true) {
      if (!line || line.trim().length == 0)
        break;
      if (reader.readEntry(entry, line) == 0)
        break;
      line = reader.readLine();
    }
    let page = null;
    let names = null;
    let values = null;
    while (true) {
      if (line === null)
        break;
      if (line.trim().length == 0) {
        page = null;
        line = reader.readLine();
      } else if (!page) {
        page = new TextureAtlasPage(line.trim());
        while (true) {
          if (reader.readEntry(entry, line = reader.readLine()) == 0)
            break;
          let field = pageFields[entry[0]];
          if (field)
            field(page);
        }
        this.pages.push(page);
      } else {
        let region = new TextureAtlasRegion(page, line);
        while (true) {
          let count = reader.readEntry(entry, line = reader.readLine());
          if (count == 0)
            break;
          let field = regionFields[entry[0]];
          if (field)
            field(region);
          else {
            if (!names)
              names = [];
            if (!values)
              values = [];
            names.push(entry[0]);
            let entryValues = [];
            for (let i = 0;i < count; i++)
              entryValues.push(parseInt(entry[i + 1]));
            values.push(entryValues);
          }
        }
        if (region.originalWidth == 0 && region.originalHeight == 0) {
          region.originalWidth = region.width;
          region.originalHeight = region.height;
        }
        if (names && names.length > 0 && values && values.length > 0) {
          region.names = names;
          region.values = values;
          names = null;
          values = null;
        }
        region.u = region.x / page.width;
        region.v = region.y / page.height;
        if (region.degrees == 90) {
          region.u2 = (region.x + region.height) / page.width;
          region.v2 = (region.y + region.width) / page.height;
        } else {
          region.u2 = (region.x + region.width) / page.width;
          region.v2 = (region.y + region.height) / page.height;
        }
        this.regions.push(region);
      }
    }
  }
  findRegion(name) {
    for (let i = 0;i < this.regions.length; i++) {
      if (this.regions[i].name == name) {
        return this.regions[i];
      }
    }
    return null;
  }
  setTextures(assetManager, pathPrefix = "") {
    for (let page of this.pages)
      page.setTexture(assetManager.get(pathPrefix + page.name));
  }
  dispose() {
    for (let i = 0;i < this.pages.length; i++) {
      this.pages[i].texture?.dispose();
    }
  }
}

class TextureAtlasReader {
  lines;
  index = 0;
  constructor(text) {
    this.lines = text.split(/\r\n|\r|\n/);
  }
  readLine() {
    if (this.index >= this.lines.length)
      return null;
    return this.lines[this.index++];
  }
  readEntry(entry, line) {
    if (!line)
      return 0;
    line = line.trim();
    if (line.length == 0)
      return 0;
    let colon = line.indexOf(":");
    if (colon == -1)
      return 0;
    entry[0] = line.substr(0, colon).trim();
    for (let i = 1, lastMatch = colon + 1;; i++) {
      let comma = line.indexOf(",", lastMatch);
      if (comma == -1) {
        entry[i] = line.substr(lastMatch).trim();
        return i;
      }
      entry[i] = line.substr(lastMatch, comma - lastMatch).trim();
      lastMatch = comma + 1;
      if (i == 4)
        return 4;
    }
  }
}

class TextureAtlasPage {
  name;
  minFilter = TextureFilter.Nearest;
  magFilter = TextureFilter.Nearest;
  uWrap = TextureWrap.ClampToEdge;
  vWrap = TextureWrap.ClampToEdge;
  texture = null;
  width = 0;
  height = 0;
  pma = false;
  regions = new Array;
  constructor(name) {
    this.name = name;
  }
  setTexture(texture) {
    this.texture = texture;
    texture.setFilters(this.minFilter, this.magFilter);
    texture.setWraps(this.uWrap, this.vWrap);
    for (let region of this.regions)
      region.texture = texture;
  }
}

class TextureAtlasRegion extends TextureRegion {
  page;
  name;
  x = 0;
  y = 0;
  offsetX = 0;
  offsetY = 0;
  originalWidth = 0;
  originalHeight = 0;
  index = 0;
  degrees = 0;
  names = null;
  values = null;
  constructor(page, name) {
    super();
    this.page = page;
    this.name = name;
    page.regions.push(this);
  }
}

// node_modules/@esotericsoftware/spine-core/dist/attachments/MeshAttachment.js
class MeshAttachment extends VertexAttachment {
  region = null;
  path;
  regionUVs = [];
  uvs = [];
  triangles = [];
  color = new Color(1, 1, 1, 1);
  width = 0;
  height = 0;
  hullLength = 0;
  edges = [];
  parentMesh = null;
  sequence = null;
  tempColor = new Color(0, 0, 0, 0);
  constructor(name, path) {
    super(name);
    this.path = path;
  }
  updateRegion() {
    if (!this.region)
      throw new Error("Region not set.");
    let regionUVs = this.regionUVs;
    if (!this.uvs || this.uvs.length != regionUVs.length)
      this.uvs = Utils.newFloatArray(regionUVs.length);
    let uvs = this.uvs;
    let n = this.uvs.length;
    let u = this.region.u, v = this.region.v, width = 0, height = 0;
    if (this.region instanceof TextureAtlasRegion) {
      let region = this.region, image = region.page.texture.getImage();
      let { width: textureWidth, height: textureHeight } = image;
      switch (region.degrees) {
        case 90:
          u -= (region.originalHeight - region.offsetY - region.height) / textureWidth;
          v -= (region.originalWidth - region.offsetX - region.width) / textureHeight;
          width = region.originalHeight / textureWidth;
          height = region.originalWidth / textureHeight;
          for (let i = 0;i < n; i += 2) {
            uvs[i] = u + regionUVs[i + 1] * width;
            uvs[i + 1] = v + (1 - regionUVs[i]) * height;
          }
          return;
        case 180:
          u -= (region.originalWidth - region.offsetX - region.width) / textureWidth;
          v -= region.offsetY / textureHeight;
          width = region.originalWidth / textureWidth;
          height = region.originalHeight / textureHeight;
          for (let i = 0;i < n; i += 2) {
            uvs[i] = u + (1 - regionUVs[i]) * width;
            uvs[i + 1] = v + (1 - regionUVs[i + 1]) * height;
          }
          return;
        case 270:
          u -= region.offsetY / textureWidth;
          v -= region.offsetX / textureHeight;
          width = region.originalHeight / textureWidth;
          height = region.originalWidth / textureHeight;
          for (let i = 0;i < n; i += 2) {
            uvs[i] = u + (1 - regionUVs[i + 1]) * width;
            uvs[i + 1] = v + regionUVs[i] * height;
          }
          return;
      }
      u -= region.offsetX / textureWidth;
      v -= (region.originalHeight - region.offsetY - region.height) / textureHeight;
      width = region.originalWidth / textureWidth;
      height = region.originalHeight / textureHeight;
    } else if (!this.region) {
      u = v = 0;
      width = height = 1;
    } else {
      width = this.region.u2 - u;
      height = this.region.v2 - v;
    }
    for (let i = 0;i < n; i += 2) {
      uvs[i] = u + regionUVs[i] * width;
      uvs[i + 1] = v + regionUVs[i + 1] * height;
    }
  }
  getParentMesh() {
    return this.parentMesh;
  }
  setParentMesh(parentMesh) {
    this.parentMesh = parentMesh;
    if (parentMesh) {
      this.bones = parentMesh.bones;
      this.vertices = parentMesh.vertices;
      this.worldVerticesLength = parentMesh.worldVerticesLength;
      this.regionUVs = parentMesh.regionUVs;
      this.triangles = parentMesh.triangles;
      this.hullLength = parentMesh.hullLength;
      this.worldVerticesLength = parentMesh.worldVerticesLength;
    }
  }
  copy() {
    if (this.parentMesh)
      return this.newLinkedMesh();
    let copy = new MeshAttachment(this.name, this.path);
    copy.region = this.region;
    copy.color.setFromColor(this.color);
    this.copyTo(copy);
    copy.regionUVs = new Array(this.regionUVs.length);
    Utils.arrayCopy(this.regionUVs, 0, copy.regionUVs, 0, this.regionUVs.length);
    copy.uvs = new Array(this.uvs.length);
    Utils.arrayCopy(this.uvs, 0, copy.uvs, 0, this.uvs.length);
    copy.triangles = new Array(this.triangles.length);
    Utils.arrayCopy(this.triangles, 0, copy.triangles, 0, this.triangles.length);
    copy.hullLength = this.hullLength;
    copy.sequence = this.sequence != null ? this.sequence.copy() : null;
    if (this.edges) {
      copy.edges = new Array(this.edges.length);
      Utils.arrayCopy(this.edges, 0, copy.edges, 0, this.edges.length);
    }
    copy.width = this.width;
    copy.height = this.height;
    return copy;
  }
  computeWorldVertices(slot, start, count, worldVertices, offset, stride) {
    if (this.sequence != null)
      this.sequence.apply(slot, this);
    super.computeWorldVertices(slot, start, count, worldVertices, offset, stride);
  }
  newLinkedMesh() {
    let copy = new MeshAttachment(this.name, this.path);
    copy.region = this.region;
    copy.color.setFromColor(this.color);
    copy.timelineAttachment = this.timelineAttachment;
    copy.setParentMesh(this.parentMesh ? this.parentMesh : this);
    if (copy.region != null)
      copy.updateRegion();
    return copy;
  }
}

// node_modules/@esotericsoftware/spine-core/dist/attachments/PathAttachment.js
class PathAttachment extends VertexAttachment {
  lengths = [];
  closed = false;
  constantSpeed = false;
  color = new Color(1, 1, 1, 1);
  constructor(name) {
    super(name);
  }
  copy() {
    let copy = new PathAttachment(this.name);
    this.copyTo(copy);
    copy.lengths = new Array(this.lengths.length);
    Utils.arrayCopy(this.lengths, 0, copy.lengths, 0, this.lengths.length);
    copy.closed = closed;
    copy.constantSpeed = this.constantSpeed;
    copy.color.setFromColor(this.color);
    return copy;
  }
}

// node_modules/@esotericsoftware/spine-core/dist/attachments/PointAttachment.js
class PointAttachment extends VertexAttachment {
  x = 0;
  y = 0;
  rotation = 0;
  color = new Color(0.38, 0.94, 0, 1);
  constructor(name) {
    super(name);
  }
  computeWorldPosition(bone, point) {
    point.x = this.x * bone.a + this.y * bone.b + bone.worldX;
    point.y = this.x * bone.c + this.y * bone.d + bone.worldY;
    return point;
  }
  computeWorldRotation(bone) {
    let cos = MathUtils.cosDeg(this.rotation), sin = MathUtils.sinDeg(this.rotation);
    let x = cos * bone.a + sin * bone.b;
    let y = cos * bone.c + sin * bone.d;
    return Math.atan2(y, x) * MathUtils.radDeg;
  }
  copy() {
    let copy = new PointAttachment(this.name);
    copy.x = this.x;
    copy.y = this.y;
    copy.rotation = this.rotation;
    copy.color.setFromColor(this.color);
    return copy;
  }
}

// node_modules/@esotericsoftware/spine-core/dist/attachments/RegionAttachment.js
class RegionAttachment extends Attachment {
  x = 0;
  y = 0;
  scaleX = 1;
  scaleY = 1;
  rotation = 0;
  width = 0;
  height = 0;
  color = new Color(1, 1, 1, 1);
  path;
  region = null;
  sequence = null;
  offset = Utils.newFloatArray(8);
  uvs = Utils.newFloatArray(8);
  tempColor = new Color(1, 1, 1, 1);
  constructor(name, path) {
    super(name);
    this.path = path;
  }
  updateRegion() {
    if (!this.region)
      throw new Error("Region not set.");
    let region = this.region;
    let uvs = this.uvs;
    if (region == null) {
      uvs[0] = 0;
      uvs[1] = 0;
      uvs[2] = 0;
      uvs[3] = 1;
      uvs[4] = 1;
      uvs[5] = 1;
      uvs[6] = 1;
      uvs[7] = 0;
      return;
    }
    let regionScaleX = this.width / this.region.originalWidth * this.scaleX;
    let regionScaleY = this.height / this.region.originalHeight * this.scaleY;
    let localX = -this.width / 2 * this.scaleX + this.region.offsetX * regionScaleX;
    let localY = -this.height / 2 * this.scaleY + this.region.offsetY * regionScaleY;
    let localX2 = localX + this.region.width * regionScaleX;
    let localY2 = localY + this.region.height * regionScaleY;
    let radians = this.rotation * Math.PI / 180;
    let cos = Math.cos(radians);
    let sin = Math.sin(radians);
    let x = this.x, y = this.y;
    let localXCos = localX * cos + x;
    let localXSin = localX * sin;
    let localYCos = localY * cos + y;
    let localYSin = localY * sin;
    let localX2Cos = localX2 * cos + x;
    let localX2Sin = localX2 * sin;
    let localY2Cos = localY2 * cos + y;
    let localY2Sin = localY2 * sin;
    let offset = this.offset;
    offset[0] = localXCos - localYSin;
    offset[1] = localYCos + localXSin;
    offset[2] = localXCos - localY2Sin;
    offset[3] = localY2Cos + localXSin;
    offset[4] = localX2Cos - localY2Sin;
    offset[5] = localY2Cos + localX2Sin;
    offset[6] = localX2Cos - localYSin;
    offset[7] = localYCos + localX2Sin;
    if (region.degrees == 90) {
      uvs[0] = region.u2;
      uvs[1] = region.v2;
      uvs[2] = region.u;
      uvs[3] = region.v2;
      uvs[4] = region.u;
      uvs[5] = region.v;
      uvs[6] = region.u2;
      uvs[7] = region.v;
    } else {
      uvs[0] = region.u;
      uvs[1] = region.v2;
      uvs[2] = region.u;
      uvs[3] = region.v;
      uvs[4] = region.u2;
      uvs[5] = region.v;
      uvs[6] = region.u2;
      uvs[7] = region.v2;
    }
  }
  computeWorldVertices(slot, worldVertices, offset, stride) {
    if (this.sequence != null)
      this.sequence.apply(slot, this);
    let bone = slot.bone;
    let vertexOffset = this.offset;
    let { worldX: x, worldY: y } = bone;
    let { a, b, c, d } = bone;
    let offsetX = 0, offsetY = 0;
    offsetX = vertexOffset[0];
    offsetY = vertexOffset[1];
    worldVertices[offset] = offsetX * a + offsetY * b + x;
    worldVertices[offset + 1] = offsetX * c + offsetY * d + y;
    offset += stride;
    offsetX = vertexOffset[2];
    offsetY = vertexOffset[3];
    worldVertices[offset] = offsetX * a + offsetY * b + x;
    worldVertices[offset + 1] = offsetX * c + offsetY * d + y;
    offset += stride;
    offsetX = vertexOffset[4];
    offsetY = vertexOffset[5];
    worldVertices[offset] = offsetX * a + offsetY * b + x;
    worldVertices[offset + 1] = offsetX * c + offsetY * d + y;
    offset += stride;
    offsetX = vertexOffset[6];
    offsetY = vertexOffset[7];
    worldVertices[offset] = offsetX * a + offsetY * b + x;
    worldVertices[offset + 1] = offsetX * c + offsetY * d + y;
  }
  copy() {
    let copy = new RegionAttachment(this.name, this.path);
    copy.region = this.region;
    copy.x = this.x;
    copy.y = this.y;
    copy.scaleX = this.scaleX;
    copy.scaleY = this.scaleY;
    copy.rotation = this.rotation;
    copy.width = this.width;
    copy.height = this.height;
    Utils.arrayCopy(this.uvs, 0, copy.uvs, 0, 8);
    Utils.arrayCopy(this.offset, 0, copy.offset, 0, 8);
    copy.color.setFromColor(this.color);
    copy.sequence = this.sequence != null ? this.sequence.copy() : null;
    return copy;
  }
  static X1 = 0;
  static Y1 = 1;
  static C1R = 2;
  static C1G = 3;
  static C1B = 4;
  static C1A = 5;
  static U1 = 6;
  static V1 = 7;
  static X2 = 8;
  static Y2 = 9;
  static C2R = 10;
  static C2G = 11;
  static C2B = 12;
  static C2A = 13;
  static U2 = 14;
  static V2 = 15;
  static X3 = 16;
  static Y3 = 17;
  static C3R = 18;
  static C3G = 19;
  static C3B = 20;
  static C3A = 21;
  static U3 = 22;
  static V3 = 23;
  static X4 = 24;
  static Y4 = 25;
  static C4R = 26;
  static C4G = 27;
  static C4B = 28;
  static C4A = 29;
  static U4 = 30;
  static V4 = 31;
}

// node_modules/@esotericsoftware/spine-core/dist/AtlasAttachmentLoader.js
class AtlasAttachmentLoader {
  atlas;
  constructor(atlas) {
    this.atlas = atlas;
  }
  loadSequence(name, basePath, sequence) {
    let regions = sequence.regions;
    for (let i = 0, n = regions.length;i < n; i++) {
      let path = sequence.getPath(basePath, i);
      let region = this.atlas.findRegion(path);
      if (region == null)
        throw new Error("Region not found in atlas: " + path + " (sequence: " + name + ")");
      regions[i] = region;
    }
  }
  newRegionAttachment(skin, name, path, sequence) {
    let attachment = new RegionAttachment(name, path);
    if (sequence != null) {
      this.loadSequence(name, path, sequence);
    } else {
      let region = this.atlas.findRegion(path);
      if (!region)
        throw new Error("Region not found in atlas: " + path + " (region attachment: " + name + ")");
      attachment.region = region;
    }
    return attachment;
  }
  newMeshAttachment(skin, name, path, sequence) {
    let attachment = new MeshAttachment(name, path);
    if (sequence != null) {
      this.loadSequence(name, path, sequence);
    } else {
      let region = this.atlas.findRegion(path);
      if (!region)
        throw new Error("Region not found in atlas: " + path + " (mesh attachment: " + name + ")");
      attachment.region = region;
    }
    return attachment;
  }
  newBoundingBoxAttachment(skin, name) {
    return new BoundingBoxAttachment(name);
  }
  newPathAttachment(skin, name) {
    return new PathAttachment(name);
  }
  newPointAttachment(skin, name) {
    return new PointAttachment(name);
  }
  newClippingAttachment(skin, name) {
    return new ClippingAttachment(name);
  }
}
// node_modules/@esotericsoftware/spine-core/dist/BoneData.js
class BoneData {
  index = 0;
  name;
  parent = null;
  length = 0;
  x = 0;
  y = 0;
  rotation = 0;
  scaleX = 1;
  scaleY = 1;
  shearX = 0;
  shearY = 0;
  transformMode = TransformMode.Normal;
  skinRequired = false;
  color = new Color;
  constructor(index, name, parent) {
    if (index < 0)
      throw new Error("index must be >= 0.");
    if (!name)
      throw new Error("name cannot be null.");
    this.index = index;
    this.name = name;
    this.parent = parent;
  }
}
var TransformMode;
(function(TransformMode) {
  TransformMode[TransformMode["Normal"] = 0] = "Normal";
  TransformMode[TransformMode["OnlyTranslation"] = 1] = "OnlyTranslation";
  TransformMode[TransformMode["NoRotationOrReflection"] = 2] = "NoRotationOrReflection";
  TransformMode[TransformMode["NoScale"] = 3] = "NoScale";
  TransformMode[TransformMode["NoScaleOrReflection"] = 4] = "NoScaleOrReflection";
})(TransformMode || (TransformMode = {}));

// node_modules/@esotericsoftware/spine-core/dist/Bone.js
class Bone {
  data;
  skeleton;
  parent = null;
  children = new Array;
  x = 0;
  y = 0;
  rotation = 0;
  scaleX = 0;
  scaleY = 0;
  shearX = 0;
  shearY = 0;
  ax = 0;
  ay = 0;
  arotation = 0;
  ascaleX = 0;
  ascaleY = 0;
  ashearX = 0;
  ashearY = 0;
  a = 0;
  b = 0;
  c = 0;
  d = 0;
  worldY = 0;
  worldX = 0;
  sorted = false;
  active = false;
  constructor(data, skeleton, parent) {
    if (!data)
      throw new Error("data cannot be null.");
    if (!skeleton)
      throw new Error("skeleton cannot be null.");
    this.data = data;
    this.skeleton = skeleton;
    this.parent = parent;
    this.setToSetupPose();
  }
  isActive() {
    return this.active;
  }
  update() {
    this.updateWorldTransformWith(this.ax, this.ay, this.arotation, this.ascaleX, this.ascaleY, this.ashearX, this.ashearY);
  }
  updateWorldTransform() {
    this.updateWorldTransformWith(this.x, this.y, this.rotation, this.scaleX, this.scaleY, this.shearX, this.shearY);
  }
  updateWorldTransformWith(x, y, rotation, scaleX, scaleY, shearX, shearY) {
    this.ax = x;
    this.ay = y;
    this.arotation = rotation;
    this.ascaleX = scaleX;
    this.ascaleY = scaleY;
    this.ashearX = shearX;
    this.ashearY = shearY;
    let parent = this.parent;
    if (!parent) {
      let skeleton = this.skeleton;
      let rotationY = rotation + 90 + shearY;
      let sx = skeleton.scaleX;
      let sy = skeleton.scaleY;
      this.a = MathUtils.cosDeg(rotation + shearX) * scaleX * sx;
      this.b = MathUtils.cosDeg(rotationY) * scaleY * sx;
      this.c = MathUtils.sinDeg(rotation + shearX) * scaleX * sy;
      this.d = MathUtils.sinDeg(rotationY) * scaleY * sy;
      this.worldX = x * sx + skeleton.x;
      this.worldY = y * sy + skeleton.y;
      return;
    }
    let { a: pa, b: pb, c: pc, d: pd } = parent;
    this.worldX = pa * x + pb * y + parent.worldX;
    this.worldY = pc * x + pd * y + parent.worldY;
    switch (this.data.transformMode) {
      case TransformMode.Normal: {
        let rotationY = rotation + 90 + shearY;
        let la = MathUtils.cosDeg(rotation + shearX) * scaleX;
        let lb = MathUtils.cosDeg(rotationY) * scaleY;
        let lc = MathUtils.sinDeg(rotation + shearX) * scaleX;
        let ld = MathUtils.sinDeg(rotationY) * scaleY;
        this.a = pa * la + pb * lc;
        this.b = pa * lb + pb * ld;
        this.c = pc * la + pd * lc;
        this.d = pc * lb + pd * ld;
        return;
      }
      case TransformMode.OnlyTranslation: {
        let rotationY = rotation + 90 + shearY;
        this.a = MathUtils.cosDeg(rotation + shearX) * scaleX;
        this.b = MathUtils.cosDeg(rotationY) * scaleY;
        this.c = MathUtils.sinDeg(rotation + shearX) * scaleX;
        this.d = MathUtils.sinDeg(rotationY) * scaleY;
        break;
      }
      case TransformMode.NoRotationOrReflection: {
        let s = pa * pa + pc * pc;
        let prx = 0;
        if (s > 0.0001) {
          s = Math.abs(pa * pd - pb * pc) / s;
          pa /= this.skeleton.scaleX;
          pc /= this.skeleton.scaleY;
          pb = pc * s;
          pd = pa * s;
          prx = Math.atan2(pc, pa) * MathUtils.radDeg;
        } else {
          pa = 0;
          pc = 0;
          prx = 90 - Math.atan2(pd, pb) * MathUtils.radDeg;
        }
        let rx = rotation + shearX - prx;
        let ry = rotation + shearY - prx + 90;
        let la = MathUtils.cosDeg(rx) * scaleX;
        let lb = MathUtils.cosDeg(ry) * scaleY;
        let lc = MathUtils.sinDeg(rx) * scaleX;
        let ld = MathUtils.sinDeg(ry) * scaleY;
        this.a = pa * la - pb * lc;
        this.b = pa * lb - pb * ld;
        this.c = pc * la + pd * lc;
        this.d = pc * lb + pd * ld;
        break;
      }
      case TransformMode.NoScale:
      case TransformMode.NoScaleOrReflection: {
        let cos = MathUtils.cosDeg(rotation);
        let sin = MathUtils.sinDeg(rotation);
        let za = (pa * cos + pb * sin) / this.skeleton.scaleX;
        let zc = (pc * cos + pd * sin) / this.skeleton.scaleY;
        let s = Math.sqrt(za * za + zc * zc);
        if (s > 0.00001)
          s = 1 / s;
        za *= s;
        zc *= s;
        s = Math.sqrt(za * za + zc * zc);
        if (this.data.transformMode == TransformMode.NoScale && pa * pd - pb * pc < 0 != (this.skeleton.scaleX < 0 != this.skeleton.scaleY < 0))
          s = -s;
        let r = Math.PI / 2 + Math.atan2(zc, za);
        let zb = Math.cos(r) * s;
        let zd = Math.sin(r) * s;
        let la = MathUtils.cosDeg(shearX) * scaleX;
        let lb = MathUtils.cosDeg(90 + shearY) * scaleY;
        let lc = MathUtils.sinDeg(shearX) * scaleX;
        let ld = MathUtils.sinDeg(90 + shearY) * scaleY;
        this.a = za * la + zb * lc;
        this.b = za * lb + zb * ld;
        this.c = zc * la + zd * lc;
        this.d = zc * lb + zd * ld;
        break;
      }
    }
    this.a *= this.skeleton.scaleX;
    this.b *= this.skeleton.scaleX;
    this.c *= this.skeleton.scaleY;
    this.d *= this.skeleton.scaleY;
  }
  setToSetupPose() {
    let data = this.data;
    this.x = data.x;
    this.y = data.y;
    this.rotation = data.rotation;
    this.scaleX = data.scaleX;
    this.scaleY = data.scaleY;
    this.shearX = data.shearX;
    this.shearY = data.shearY;
  }
  getWorldRotationX() {
    return Math.atan2(this.c, this.a) * MathUtils.radDeg;
  }
  getWorldRotationY() {
    return Math.atan2(this.d, this.b) * MathUtils.radDeg;
  }
  getWorldScaleX() {
    return Math.sqrt(this.a * this.a + this.c * this.c);
  }
  getWorldScaleY() {
    return Math.sqrt(this.b * this.b + this.d * this.d);
  }
  updateAppliedTransform() {
    let parent = this.parent;
    if (!parent) {
      this.ax = this.worldX - this.skeleton.x;
      this.ay = this.worldY - this.skeleton.y;
      this.arotation = Math.atan2(this.c, this.a) * MathUtils.radDeg;
      this.ascaleX = Math.sqrt(this.a * this.a + this.c * this.c);
      this.ascaleY = Math.sqrt(this.b * this.b + this.d * this.d);
      this.ashearX = 0;
      this.ashearY = Math.atan2(this.a * this.b + this.c * this.d, this.a * this.d - this.b * this.c) * MathUtils.radDeg;
      return;
    }
    let { a: pa, b: pb, c: pc, d: pd } = parent;
    let pid = 1 / (pa * pd - pb * pc);
    let dx = this.worldX - parent.worldX, dy = this.worldY - parent.worldY;
    this.ax = dx * pd * pid - dy * pb * pid;
    this.ay = dy * pa * pid - dx * pc * pid;
    let ia = pid * pd;
    let id = pid * pa;
    let ib = pid * pb;
    let ic = pid * pc;
    let ra = ia * this.a - ib * this.c;
    let rb = ia * this.b - ib * this.d;
    let rc = id * this.c - ic * this.a;
    let rd = id * this.d - ic * this.b;
    this.ashearX = 0;
    this.ascaleX = Math.sqrt(ra * ra + rc * rc);
    if (this.ascaleX > 0.0001) {
      let det = ra * rd - rb * rc;
      this.ascaleY = det / this.ascaleX;
      this.ashearY = Math.atan2(ra * rb + rc * rd, det) * MathUtils.radDeg;
      this.arotation = Math.atan2(rc, ra) * MathUtils.radDeg;
    } else {
      this.ascaleX = 0;
      this.ascaleY = Math.sqrt(rb * rb + rd * rd);
      this.ashearY = 0;
      this.arotation = 90 - Math.atan2(rd, rb) * MathUtils.radDeg;
    }
  }
  worldToLocal(world) {
    let invDet = 1 / (this.a * this.d - this.b * this.c);
    let x = world.x - this.worldX, y = world.y - this.worldY;
    world.x = x * this.d * invDet - y * this.b * invDet;
    world.y = y * this.a * invDet - x * this.c * invDet;
    return world;
  }
  localToWorld(local) {
    let { x, y } = local;
    local.x = x * this.a + y * this.b + this.worldX;
    local.y = x * this.c + y * this.d + this.worldY;
    return local;
  }
  worldToLocalRotation(worldRotation) {
    let sin = MathUtils.sinDeg(worldRotation), cos = MathUtils.cosDeg(worldRotation);
    return Math.atan2(this.a * sin - this.c * cos, this.d * cos - this.b * sin) * MathUtils.radDeg + this.rotation - this.shearX;
  }
  localToWorldRotation(localRotation) {
    localRotation -= this.rotation - this.shearX;
    let sin = MathUtils.sinDeg(localRotation), cos = MathUtils.cosDeg(localRotation);
    return Math.atan2(cos * this.c + sin * this.d, cos * this.a + sin * this.b) * MathUtils.radDeg;
  }
  rotateWorld(degrees) {
    let a = this.a, b = this.b, c = this.c, d = this.d;
    let cos = MathUtils.cosDeg(degrees), sin = MathUtils.sinDeg(degrees);
    this.a = cos * a - sin * c;
    this.b = cos * b - sin * d;
    this.c = sin * a + cos * c;
    this.d = sin * b + cos * d;
  }
}
// node_modules/@esotericsoftware/spine-core/dist/ConstraintData.js
class ConstraintData {
  name;
  order;
  skinRequired;
  constructor(name, order, skinRequired) {
    this.name = name;
    this.order = order;
    this.skinRequired = skinRequired;
  }
}
// node_modules/@esotericsoftware/spine-core/dist/Event.js
class Event {
  data;
  intValue = 0;
  floatValue = 0;
  stringValue = null;
  time = 0;
  volume = 0;
  balance = 0;
  constructor(time, data) {
    if (!data)
      throw new Error("data cannot be null.");
    this.time = time;
    this.data = data;
  }
}
// node_modules/@esotericsoftware/spine-core/dist/EventData.js
class EventData {
  name;
  intValue = 0;
  floatValue = 0;
  stringValue = null;
  audioPath = null;
  volume = 0;
  balance = 0;
  constructor(name) {
    this.name = name;
  }
}
// node_modules/@esotericsoftware/spine-core/dist/IkConstraint.js
class IkConstraint {
  data;
  bones;
  target;
  bendDirection = 0;
  compress = false;
  stretch = false;
  mix = 1;
  softness = 0;
  active = false;
  constructor(data, skeleton) {
    if (!data)
      throw new Error("data cannot be null.");
    if (!skeleton)
      throw new Error("skeleton cannot be null.");
    this.data = data;
    this.mix = data.mix;
    this.softness = data.softness;
    this.bendDirection = data.bendDirection;
    this.compress = data.compress;
    this.stretch = data.stretch;
    this.bones = new Array;
    for (let i = 0;i < data.bones.length; i++) {
      let bone = skeleton.findBone(data.bones[i].name);
      if (!bone)
        throw new Error(`Couldn't find bone ${data.bones[i].name}`);
      this.bones.push(bone);
    }
    let target = skeleton.findBone(data.target.name);
    if (!target)
      throw new Error(`Couldn't find bone ${data.target.name}`);
    this.target = target;
  }
  isActive() {
    return this.active;
  }
  update() {
    if (this.mix == 0)
      return;
    let target = this.target;
    let bones = this.bones;
    switch (bones.length) {
      case 1:
        this.apply1(bones[0], target.worldX, target.worldY, this.compress, this.stretch, this.data.uniform, this.mix);
        break;
      case 2:
        this.apply2(bones[0], bones[1], target.worldX, target.worldY, this.bendDirection, this.stretch, this.data.uniform, this.softness, this.mix);
        break;
    }
  }
  apply1(bone, targetX, targetY, compress, stretch, uniform, alpha) {
    let p = bone.parent;
    if (!p)
      throw new Error("IK bone must have parent.");
    let { a: pa, b: pb, c: pc, d: pd } = p;
    let rotationIK = -bone.ashearX - bone.arotation, tx = 0, ty = 0;
    switch (bone.data.transformMode) {
      case TransformMode.OnlyTranslation:
        tx = (targetX - bone.worldX) * MathUtils.signum(bone.skeleton.scaleX);
        ty = (targetY - bone.worldY) * MathUtils.signum(bone.skeleton.scaleY);
        break;
      case TransformMode.NoRotationOrReflection:
        let s = Math.abs(pa * pd - pb * pc) / Math.max(0.0001, pa * pa + pc * pc);
        let sa = pa / bone.skeleton.scaleX;
        let sc = pc / bone.skeleton.scaleY;
        pb = -sc * s * bone.skeleton.scaleX;
        pd = sa * s * bone.skeleton.scaleY;
        rotationIK += Math.atan2(sc, sa) * MathUtils.radDeg;
      default:
        let x = targetX - p.worldX, y = targetY - p.worldY;
        let d = pa * pd - pb * pc;
        if (Math.abs(d) <= 0.0001) {
          tx = 0;
          ty = 0;
        } else {
          tx = (x * pd - y * pb) / d - bone.ax;
          ty = (y * pa - x * pc) / d - bone.ay;
        }
    }
    rotationIK += Math.atan2(ty, tx) * MathUtils.radDeg;
    if (bone.ascaleX < 0)
      rotationIK += 180;
    if (rotationIK > 180)
      rotationIK -= 360;
    else if (rotationIK < -180)
      rotationIK += 360;
    let { ascaleX: sx, ascaleY: sy } = bone;
    if (compress || stretch) {
      switch (bone.data.transformMode) {
        case TransformMode.NoScale:
        case TransformMode.NoScaleOrReflection:
          tx = targetX - bone.worldX;
          ty = targetY - bone.worldY;
      }
      let b = bone.data.length * sx, dd = Math.sqrt(tx * tx + ty * ty);
      if (compress && dd < b || stretch && dd > b && b > 0.0001) {
        let s = (dd / b - 1) * alpha + 1;
        sx *= s;
        if (uniform)
          sy *= s;
      }
    }
    bone.updateWorldTransformWith(bone.ax, bone.ay, bone.arotation + rotationIK * alpha, sx, sy, bone.ashearX, bone.ashearY);
  }
  apply2(parent, child, targetX, targetY, bendDir, stretch, uniform, softness, alpha) {
    let { ax: px, ay: py, ascaleX: psx, ascaleY: psy } = parent, sx = psx, sy = psy, csx = child.ascaleX;
    let os1 = 0, os2 = 0, s2 = 0;
    if (psx < 0) {
      psx = -psx;
      os1 = 180;
      s2 = -1;
    } else {
      os1 = 0;
      s2 = 1;
    }
    if (psy < 0) {
      psy = -psy;
      s2 = -s2;
    }
    if (csx < 0) {
      csx = -csx;
      os2 = 180;
    } else
      os2 = 0;
    let cx = child.ax, cy = 0, cwx = 0, cwy = 0, { a, b, c, d } = parent;
    let u = Math.abs(psx - psy) <= 0.0001;
    if (!u || stretch) {
      cy = 0;
      cwx = a * cx + parent.worldX;
      cwy = c * cx + parent.worldY;
    } else {
      cy = child.ay;
      cwx = a * cx + b * cy + parent.worldX;
      cwy = c * cx + d * cy + parent.worldY;
    }
    let pp = parent.parent;
    if (!pp)
      throw new Error("IK parent must itself have a parent.");
    a = pp.a;
    b = pp.b;
    c = pp.c;
    d = pp.d;
    let id = a * d - b * c, x = cwx - pp.worldX, y = cwy - pp.worldY;
    id = Math.abs(id) <= 0.0001 ? 0 : 1 / id;
    let dx = (x * d - y * b) * id - px, dy = (y * a - x * c) * id - py;
    let l1 = Math.sqrt(dx * dx + dy * dy), l2 = child.data.length * csx, a1, a2;
    if (l1 < 0.0001) {
      this.apply1(parent, targetX, targetY, false, stretch, false, alpha);
      child.updateWorldTransformWith(cx, cy, 0, child.ascaleX, child.ascaleY, child.ashearX, child.ashearY);
      return;
    }
    x = targetX - pp.worldX;
    y = targetY - pp.worldY;
    let tx = (x * d - y * b) * id - px, ty = (y * a - x * c) * id - py;
    let dd = tx * tx + ty * ty;
    if (softness != 0) {
      softness *= psx * (csx + 1) * 0.5;
      let td = Math.sqrt(dd), sd = td - l1 - l2 * psx + softness;
      if (sd > 0) {
        let p = Math.min(1, sd / (softness * 2)) - 1;
        p = (sd - softness * (1 - p * p)) / td;
        tx -= p * tx;
        ty -= p * ty;
        dd = tx * tx + ty * ty;
      }
    }
    outer:
      if (u) {
        l2 *= psx;
        let cos = (dd - l1 * l1 - l2 * l2) / (2 * l1 * l2);
        if (cos < -1) {
          cos = -1;
          a2 = Math.PI * bendDir;
        } else if (cos > 1) {
          cos = 1;
          a2 = 0;
          if (stretch) {
            a = (Math.sqrt(dd) / (l1 + l2) - 1) * alpha + 1;
            sx *= a;
            if (uniform)
              sy *= a;
          }
        } else
          a2 = Math.acos(cos) * bendDir;
        a = l1 + l2 * cos;
        b = l2 * Math.sin(a2);
        a1 = Math.atan2(ty * a - tx * b, tx * a + ty * b);
      } else {
        a = psx * l2;
        b = psy * l2;
        let aa = a * a, bb = b * b, ta = Math.atan2(ty, tx);
        c = bb * l1 * l1 + aa * dd - aa * bb;
        let c1 = -2 * bb * l1, c2 = bb - aa;
        d = c1 * c1 - 4 * c2 * c;
        if (d >= 0) {
          let q = Math.sqrt(d);
          if (c1 < 0)
            q = -q;
          q = -(c1 + q) * 0.5;
          let r0 = q / c2, r1 = c / q;
          let r = Math.abs(r0) < Math.abs(r1) ? r0 : r1;
          if (r * r <= dd) {
            y = Math.sqrt(dd - r * r) * bendDir;
            a1 = ta - Math.atan2(y, r);
            a2 = Math.atan2(y / psy, (r - l1) / psx);
            break outer;
          }
        }
        let minAngle = MathUtils.PI, minX = l1 - a, minDist = minX * minX, minY = 0;
        let maxAngle = 0, maxX = l1 + a, maxDist = maxX * maxX, maxY = 0;
        c = -a * l1 / (aa - bb);
        if (c >= -1 && c <= 1) {
          c = Math.acos(c);
          x = a * Math.cos(c) + l1;
          y = b * Math.sin(c);
          d = x * x + y * y;
          if (d < minDist) {
            minAngle = c;
            minDist = d;
            minX = x;
            minY = y;
          }
          if (d > maxDist) {
            maxAngle = c;
            maxDist = d;
            maxX = x;
            maxY = y;
          }
        }
        if (dd <= (minDist + maxDist) * 0.5) {
          a1 = ta - Math.atan2(minY * bendDir, minX);
          a2 = minAngle * bendDir;
        } else {
          a1 = ta - Math.atan2(maxY * bendDir, maxX);
          a2 = maxAngle * bendDir;
        }
      }
    let os = Math.atan2(cy, cx) * s2;
    let rotation = parent.arotation;
    a1 = (a1 - os) * MathUtils.radDeg + os1 - rotation;
    if (a1 > 180)
      a1 -= 360;
    else if (a1 < -180)
      a1 += 360;
    parent.updateWorldTransformWith(px, py, rotation + a1 * alpha, sx, sy, 0, 0);
    rotation = child.arotation;
    a2 = ((a2 + os) * MathUtils.radDeg - child.ashearX) * s2 + os2 - rotation;
    if (a2 > 180)
      a2 -= 360;
    else if (a2 < -180)
      a2 += 360;
    child.updateWorldTransformWith(cx, cy, rotation + a2 * alpha, child.ascaleX, child.ascaleY, child.ashearX, child.ashearY);
  }
}
// node_modules/@esotericsoftware/spine-core/dist/IkConstraintData.js
class IkConstraintData extends ConstraintData {
  bones = new Array;
  _target = null;
  set target(boneData) {
    this._target = boneData;
  }
  get target() {
    if (!this._target)
      throw new Error("BoneData not set.");
    else
      return this._target;
  }
  bendDirection = 1;
  compress = false;
  stretch = false;
  uniform = false;
  mix = 1;
  softness = 0;
  constructor(name) {
    super(name, 0, false);
  }
}
// node_modules/@esotericsoftware/spine-core/dist/PathConstraintData.js
class PathConstraintData extends ConstraintData {
  bones = new Array;
  _target = null;
  set target(slotData) {
    this._target = slotData;
  }
  get target() {
    if (!this._target)
      throw new Error("SlotData not set.");
    else
      return this._target;
  }
  positionMode = PositionMode.Fixed;
  spacingMode = SpacingMode.Fixed;
  rotateMode = RotateMode.Chain;
  offsetRotation = 0;
  position = 0;
  spacing = 0;
  mixRotate = 0;
  mixX = 0;
  mixY = 0;
  constructor(name) {
    super(name, 0, false);
  }
}
var PositionMode;
(function(PositionMode) {
  PositionMode[PositionMode["Fixed"] = 0] = "Fixed";
  PositionMode[PositionMode["Percent"] = 1] = "Percent";
})(PositionMode || (PositionMode = {}));
var SpacingMode;
(function(SpacingMode) {
  SpacingMode[SpacingMode["Length"] = 0] = "Length";
  SpacingMode[SpacingMode["Fixed"] = 1] = "Fixed";
  SpacingMode[SpacingMode["Percent"] = 2] = "Percent";
  SpacingMode[SpacingMode["Proportional"] = 3] = "Proportional";
})(SpacingMode || (SpacingMode = {}));
var RotateMode;
(function(RotateMode) {
  RotateMode[RotateMode["Tangent"] = 0] = "Tangent";
  RotateMode[RotateMode["Chain"] = 1] = "Chain";
  RotateMode[RotateMode["ChainScale"] = 2] = "ChainScale";
})(RotateMode || (RotateMode = {}));

// node_modules/@esotericsoftware/spine-core/dist/PathConstraint.js
class PathConstraint {
  static NONE = -1;
  static BEFORE = -2;
  static AFTER = -3;
  static epsilon = 0.00001;
  data;
  bones;
  target;
  position = 0;
  spacing = 0;
  mixRotate = 0;
  mixX = 0;
  mixY = 0;
  spaces = new Array;
  positions = new Array;
  world = new Array;
  curves = new Array;
  lengths = new Array;
  segments = new Array;
  active = false;
  constructor(data, skeleton) {
    if (!data)
      throw new Error("data cannot be null.");
    if (!skeleton)
      throw new Error("skeleton cannot be null.");
    this.data = data;
    this.bones = new Array;
    for (let i = 0, n = data.bones.length;i < n; i++) {
      let bone = skeleton.findBone(data.bones[i].name);
      if (!bone)
        throw new Error(`Couldn't find bone ${data.bones[i].name}.`);
      this.bones.push(bone);
    }
    let target = skeleton.findSlot(data.target.name);
    if (!target)
      throw new Error(`Couldn't find target bone ${data.target.name}`);
    this.target = target;
    this.position = data.position;
    this.spacing = data.spacing;
    this.mixRotate = data.mixRotate;
    this.mixX = data.mixX;
    this.mixY = data.mixY;
  }
  isActive() {
    return this.active;
  }
  update() {
    let attachment = this.target.getAttachment();
    if (!(attachment instanceof PathAttachment))
      return;
    let mixRotate = this.mixRotate, mixX = this.mixX, mixY = this.mixY;
    if (mixRotate == 0 && mixX == 0 && mixY == 0)
      return;
    let data = this.data;
    let tangents = data.rotateMode == RotateMode.Tangent, scale = data.rotateMode == RotateMode.ChainScale;
    let bones = this.bones;
    let boneCount = bones.length, spacesCount = tangents ? boneCount : boneCount + 1;
    let spaces = Utils.setArraySize(this.spaces, spacesCount), lengths = scale ? this.lengths = Utils.setArraySize(this.lengths, boneCount) : [];
    let spacing = this.spacing;
    switch (data.spacingMode) {
      case SpacingMode.Percent:
        if (scale) {
          for (let i = 0, n = spacesCount - 1;i < n; i++) {
            let bone = bones[i];
            let setupLength = bone.data.length;
            if (setupLength < PathConstraint.epsilon)
              lengths[i] = 0;
            else {
              let x = setupLength * bone.a, y = setupLength * bone.c;
              lengths[i] = Math.sqrt(x * x + y * y);
            }
          }
        }
        Utils.arrayFill(spaces, 1, spacesCount, spacing);
        break;
      case SpacingMode.Proportional:
        let sum = 0;
        for (let i = 0, n = spacesCount - 1;i < n; ) {
          let bone = bones[i];
          let setupLength = bone.data.length;
          if (setupLength < PathConstraint.epsilon) {
            if (scale)
              lengths[i] = 0;
            spaces[++i] = spacing;
          } else {
            let x = setupLength * bone.a, y = setupLength * bone.c;
            let length = Math.sqrt(x * x + y * y);
            if (scale)
              lengths[i] = length;
            spaces[++i] = length;
            sum += length;
          }
        }
        if (sum > 0) {
          sum = spacesCount / sum * spacing;
          for (let i = 1;i < spacesCount; i++)
            spaces[i] *= sum;
        }
        break;
      default:
        let lengthSpacing = data.spacingMode == SpacingMode.Length;
        for (let i = 0, n = spacesCount - 1;i < n; ) {
          let bone = bones[i];
          let setupLength = bone.data.length;
          if (setupLength < PathConstraint.epsilon) {
            if (scale)
              lengths[i] = 0;
            spaces[++i] = spacing;
          } else {
            let x = setupLength * bone.a, y = setupLength * bone.c;
            let length = Math.sqrt(x * x + y * y);
            if (scale)
              lengths[i] = length;
            spaces[++i] = (lengthSpacing ? setupLength + spacing : spacing) * length / setupLength;
          }
        }
    }
    let positions = this.computeWorldPositions(attachment, spacesCount, tangents);
    let boneX = positions[0], boneY = positions[1], offsetRotation = data.offsetRotation;
    let tip = false;
    if (offsetRotation == 0)
      tip = data.rotateMode == RotateMode.Chain;
    else {
      tip = false;
      let p = this.target.bone;
      offsetRotation *= p.a * p.d - p.b * p.c > 0 ? MathUtils.degRad : -MathUtils.degRad;
    }
    for (let i = 0, p = 3;i < boneCount; i++, p += 3) {
      let bone = bones[i];
      bone.worldX += (boneX - bone.worldX) * mixX;
      bone.worldY += (boneY - bone.worldY) * mixY;
      let x = positions[p], y = positions[p + 1], dx = x - boneX, dy = y - boneY;
      if (scale) {
        let length = lengths[i];
        if (length != 0) {
          let s = (Math.sqrt(dx * dx + dy * dy) / length - 1) * mixRotate + 1;
          bone.a *= s;
          bone.c *= s;
        }
      }
      boneX = x;
      boneY = y;
      if (mixRotate > 0) {
        let { a, b, c, d } = bone, r = 0, cos = 0, sin = 0;
        if (tangents)
          r = positions[p - 1];
        else if (spaces[i + 1] == 0)
          r = positions[p + 2];
        else
          r = Math.atan2(dy, dx);
        r -= Math.atan2(c, a);
        if (tip) {
          cos = Math.cos(r);
          sin = Math.sin(r);
          let length = bone.data.length;
          boneX += (length * (cos * a - sin * c) - dx) * mixRotate;
          boneY += (length * (sin * a + cos * c) - dy) * mixRotate;
        } else {
          r += offsetRotation;
        }
        if (r > MathUtils.PI)
          r -= MathUtils.PI2;
        else if (r < -MathUtils.PI)
          r += MathUtils.PI2;
        r *= mixRotate;
        cos = Math.cos(r);
        sin = Math.sin(r);
        bone.a = cos * a - sin * c;
        bone.b = cos * b - sin * d;
        bone.c = sin * a + cos * c;
        bone.d = sin * b + cos * d;
      }
      bone.updateAppliedTransform();
    }
  }
  computeWorldPositions(path, spacesCount, tangents) {
    let target = this.target;
    let position = this.position;
    let spaces = this.spaces, out = Utils.setArraySize(this.positions, spacesCount * 3 + 2), world = this.world;
    let closed2 = path.closed;
    let verticesLength = path.worldVerticesLength, curveCount = verticesLength / 6, prevCurve = PathConstraint.NONE;
    if (!path.constantSpeed) {
      let lengths = path.lengths;
      curveCount -= closed2 ? 1 : 2;
      let pathLength = lengths[curveCount];
      if (this.data.positionMode == PositionMode.Percent)
        position *= pathLength;
      let multiplier;
      switch (this.data.spacingMode) {
        case SpacingMode.Percent:
          multiplier = pathLength;
          break;
        case SpacingMode.Proportional:
          multiplier = pathLength / spacesCount;
          break;
        default:
          multiplier = 1;
      }
      world = Utils.setArraySize(this.world, 8);
      for (let i = 0, o = 0, curve = 0;i < spacesCount; i++, o += 3) {
        let space = spaces[i] * multiplier;
        position += space;
        let p = position;
        if (closed2) {
          p %= pathLength;
          if (p < 0)
            p += pathLength;
          curve = 0;
        } else if (p < 0) {
          if (prevCurve != PathConstraint.BEFORE) {
            prevCurve = PathConstraint.BEFORE;
            path.computeWorldVertices(target, 2, 4, world, 0, 2);
          }
          this.addBeforePosition(p, world, 0, out, o);
          continue;
        } else if (p > pathLength) {
          if (prevCurve != PathConstraint.AFTER) {
            prevCurve = PathConstraint.AFTER;
            path.computeWorldVertices(target, verticesLength - 6, 4, world, 0, 2);
          }
          this.addAfterPosition(p - pathLength, world, 0, out, o);
          continue;
        }
        for (;; curve++) {
          let length = lengths[curve];
          if (p > length)
            continue;
          if (curve == 0)
            p /= length;
          else {
            let prev = lengths[curve - 1];
            p = (p - prev) / (length - prev);
          }
          break;
        }
        if (curve != prevCurve) {
          prevCurve = curve;
          if (closed2 && curve == curveCount) {
            path.computeWorldVertices(target, verticesLength - 4, 4, world, 0, 2);
            path.computeWorldVertices(target, 0, 4, world, 4, 2);
          } else
            path.computeWorldVertices(target, curve * 6 + 2, 8, world, 0, 2);
        }
        this.addCurvePosition(p, world[0], world[1], world[2], world[3], world[4], world[5], world[6], world[7], out, o, tangents || i > 0 && space == 0);
      }
      return out;
    }
    if (closed2) {
      verticesLength += 2;
      world = Utils.setArraySize(this.world, verticesLength);
      path.computeWorldVertices(target, 2, verticesLength - 4, world, 0, 2);
      path.computeWorldVertices(target, 0, 2, world, verticesLength - 4, 2);
      world[verticesLength - 2] = world[0];
      world[verticesLength - 1] = world[1];
    } else {
      curveCount--;
      verticesLength -= 4;
      world = Utils.setArraySize(this.world, verticesLength);
      path.computeWorldVertices(target, 2, verticesLength, world, 0, 2);
    }
    let curves = Utils.setArraySize(this.curves, curveCount);
    let pathLength = 0;
    let x1 = world[0], y1 = world[1], cx1 = 0, cy1 = 0, cx2 = 0, cy2 = 0, x2 = 0, y2 = 0;
    let tmpx = 0, tmpy = 0, dddfx = 0, dddfy = 0, ddfx = 0, ddfy = 0, dfx = 0, dfy = 0;
    for (let i = 0, w = 2;i < curveCount; i++, w += 6) {
      cx1 = world[w];
      cy1 = world[w + 1];
      cx2 = world[w + 2];
      cy2 = world[w + 3];
      x2 = world[w + 4];
      y2 = world[w + 5];
      tmpx = (x1 - cx1 * 2 + cx2) * 0.1875;
      tmpy = (y1 - cy1 * 2 + cy2) * 0.1875;
      dddfx = ((cx1 - cx2) * 3 - x1 + x2) * 0.09375;
      dddfy = ((cy1 - cy2) * 3 - y1 + y2) * 0.09375;
      ddfx = tmpx * 2 + dddfx;
      ddfy = tmpy * 2 + dddfy;
      dfx = (cx1 - x1) * 0.75 + tmpx + dddfx * 0.16666667;
      dfy = (cy1 - y1) * 0.75 + tmpy + dddfy * 0.16666667;
      pathLength += Math.sqrt(dfx * dfx + dfy * dfy);
      dfx += ddfx;
      dfy += ddfy;
      ddfx += dddfx;
      ddfy += dddfy;
      pathLength += Math.sqrt(dfx * dfx + dfy * dfy);
      dfx += ddfx;
      dfy += ddfy;
      pathLength += Math.sqrt(dfx * dfx + dfy * dfy);
      dfx += ddfx + dddfx;
      dfy += ddfy + dddfy;
      pathLength += Math.sqrt(dfx * dfx + dfy * dfy);
      curves[i] = pathLength;
      x1 = x2;
      y1 = y2;
    }
    if (this.data.positionMode == PositionMode.Percent)
      position *= pathLength;
    let multiplier;
    switch (this.data.spacingMode) {
      case SpacingMode.Percent:
        multiplier = pathLength;
        break;
      case SpacingMode.Proportional:
        multiplier = pathLength / spacesCount;
        break;
      default:
        multiplier = 1;
    }
    let segments = this.segments;
    let curveLength = 0;
    for (let i = 0, o = 0, curve = 0, segment = 0;i < spacesCount; i++, o += 3) {
      let space = spaces[i] * multiplier;
      position += space;
      let p = position;
      if (closed2) {
        p %= pathLength;
        if (p < 0)
          p += pathLength;
        curve = 0;
      } else if (p < 0) {
        this.addBeforePosition(p, world, 0, out, o);
        continue;
      } else if (p > pathLength) {
        this.addAfterPosition(p - pathLength, world, verticesLength - 4, out, o);
        continue;
      }
      for (;; curve++) {
        let length = curves[curve];
        if (p > length)
          continue;
        if (curve == 0)
          p /= length;
        else {
          let prev = curves[curve - 1];
          p = (p - prev) / (length - prev);
        }
        break;
      }
      if (curve != prevCurve) {
        prevCurve = curve;
        let ii = curve * 6;
        x1 = world[ii];
        y1 = world[ii + 1];
        cx1 = world[ii + 2];
        cy1 = world[ii + 3];
        cx2 = world[ii + 4];
        cy2 = world[ii + 5];
        x2 = world[ii + 6];
        y2 = world[ii + 7];
        tmpx = (x1 - cx1 * 2 + cx2) * 0.03;
        tmpy = (y1 - cy1 * 2 + cy2) * 0.03;
        dddfx = ((cx1 - cx2) * 3 - x1 + x2) * 0.006;
        dddfy = ((cy1 - cy2) * 3 - y1 + y2) * 0.006;
        ddfx = tmpx * 2 + dddfx;
        ddfy = tmpy * 2 + dddfy;
        dfx = (cx1 - x1) * 0.3 + tmpx + dddfx * 0.16666667;
        dfy = (cy1 - y1) * 0.3 + tmpy + dddfy * 0.16666667;
        curveLength = Math.sqrt(dfx * dfx + dfy * dfy);
        segments[0] = curveLength;
        for (ii = 1;ii < 8; ii++) {
          dfx += ddfx;
          dfy += ddfy;
          ddfx += dddfx;
          ddfy += dddfy;
          curveLength += Math.sqrt(dfx * dfx + dfy * dfy);
          segments[ii] = curveLength;
        }
        dfx += ddfx;
        dfy += ddfy;
        curveLength += Math.sqrt(dfx * dfx + dfy * dfy);
        segments[8] = curveLength;
        dfx += ddfx + dddfx;
        dfy += ddfy + dddfy;
        curveLength += Math.sqrt(dfx * dfx + dfy * dfy);
        segments[9] = curveLength;
        segment = 0;
      }
      p *= curveLength;
      for (;; segment++) {
        let length = segments[segment];
        if (p > length)
          continue;
        if (segment == 0)
          p /= length;
        else {
          let prev = segments[segment - 1];
          p = segment + (p - prev) / (length - prev);
        }
        break;
      }
      this.addCurvePosition(p * 0.1, x1, y1, cx1, cy1, cx2, cy2, x2, y2, out, o, tangents || i > 0 && space == 0);
    }
    return out;
  }
  addBeforePosition(p, temp, i, out, o) {
    let x1 = temp[i], y1 = temp[i + 1], dx = temp[i + 2] - x1, dy = temp[i + 3] - y1, r = Math.atan2(dy, dx);
    out[o] = x1 + p * Math.cos(r);
    out[o + 1] = y1 + p * Math.sin(r);
    out[o + 2] = r;
  }
  addAfterPosition(p, temp, i, out, o) {
    let x1 = temp[i + 2], y1 = temp[i + 3], dx = x1 - temp[i], dy = y1 - temp[i + 1], r = Math.atan2(dy, dx);
    out[o] = x1 + p * Math.cos(r);
    out[o + 1] = y1 + p * Math.sin(r);
    out[o + 2] = r;
  }
  addCurvePosition(p, x1, y1, cx1, cy1, cx2, cy2, x2, y2, out, o, tangents) {
    if (p == 0 || isNaN(p)) {
      out[o] = x1;
      out[o + 1] = y1;
      out[o + 2] = Math.atan2(cy1 - y1, cx1 - x1);
      return;
    }
    let tt = p * p, ttt = tt * p, u = 1 - p, uu = u * u, uuu = uu * u;
    let ut = u * p, ut3 = ut * 3, uut3 = u * ut3, utt3 = ut3 * p;
    let x = x1 * uuu + cx1 * uut3 + cx2 * utt3 + x2 * ttt, y = y1 * uuu + cy1 * uut3 + cy2 * utt3 + y2 * ttt;
    out[o] = x;
    out[o + 1] = y;
    if (tangents) {
      if (p < 0.001)
        out[o + 2] = Math.atan2(cy1 - y1, cx1 - x1);
      else
        out[o + 2] = Math.atan2(y - (y1 * uu + cy1 * ut * 2 + cy2 * tt), x - (x1 * uu + cx1 * ut * 2 + cx2 * tt));
    }
  }
}
// node_modules/@esotericsoftware/spine-core/dist/Slot.js
class Slot {
  data;
  bone;
  color;
  darkColor = null;
  attachment = null;
  attachmentState = 0;
  sequenceIndex = -1;
  deform = new Array;
  constructor(data, bone) {
    if (!data)
      throw new Error("data cannot be null.");
    if (!bone)
      throw new Error("bone cannot be null.");
    this.data = data;
    this.bone = bone;
    this.color = new Color;
    this.darkColor = !data.darkColor ? null : new Color;
    this.setToSetupPose();
  }
  getSkeleton() {
    return this.bone.skeleton;
  }
  getAttachment() {
    return this.attachment;
  }
  setAttachment(attachment) {
    if (this.attachment == attachment)
      return;
    if (!(attachment instanceof VertexAttachment) || !(this.attachment instanceof VertexAttachment) || attachment.timelineAttachment != this.attachment.timelineAttachment) {
      this.deform.length = 0;
    }
    this.attachment = attachment;
    this.sequenceIndex = -1;
  }
  setToSetupPose() {
    this.color.setFromColor(this.data.color);
    if (this.darkColor)
      this.darkColor.setFromColor(this.data.darkColor);
    if (!this.data.attachmentName)
      this.attachment = null;
    else {
      this.attachment = null;
      this.setAttachment(this.bone.skeleton.getAttachment(this.data.index, this.data.attachmentName));
    }
  }
}

// node_modules/@esotericsoftware/spine-core/dist/TransformConstraint.js
class TransformConstraint {
  data;
  bones;
  target;
  mixRotate = 0;
  mixX = 0;
  mixY = 0;
  mixScaleX = 0;
  mixScaleY = 0;
  mixShearY = 0;
  temp = new Vector2;
  active = false;
  constructor(data, skeleton) {
    if (!data)
      throw new Error("data cannot be null.");
    if (!skeleton)
      throw new Error("skeleton cannot be null.");
    this.data = data;
    this.mixRotate = data.mixRotate;
    this.mixX = data.mixX;
    this.mixY = data.mixY;
    this.mixScaleX = data.mixScaleX;
    this.mixScaleY = data.mixScaleY;
    this.mixShearY = data.mixShearY;
    this.bones = new Array;
    for (let i = 0;i < data.bones.length; i++) {
      let bone = skeleton.findBone(data.bones[i].name);
      if (!bone)
        throw new Error(`Couldn't find bone ${data.bones[i].name}.`);
      this.bones.push(bone);
    }
    let target = skeleton.findBone(data.target.name);
    if (!target)
      throw new Error(`Couldn't find target bone ${data.target.name}.`);
    this.target = target;
  }
  isActive() {
    return this.active;
  }
  update() {
    if (this.mixRotate == 0 && this.mixX == 0 && this.mixY == 0 && this.mixScaleX == 0 && this.mixScaleY == 0 && this.mixShearY == 0)
      return;
    if (this.data.local) {
      if (this.data.relative)
        this.applyRelativeLocal();
      else
        this.applyAbsoluteLocal();
    } else {
      if (this.data.relative)
        this.applyRelativeWorld();
      else
        this.applyAbsoluteWorld();
    }
  }
  applyAbsoluteWorld() {
    let mixRotate = this.mixRotate, mixX = this.mixX, mixY = this.mixY, mixScaleX = this.mixScaleX, mixScaleY = this.mixScaleY, mixShearY = this.mixShearY;
    let translate = mixX != 0 || mixY != 0;
    let target = this.target;
    let { a: ta, b: tb, c: tc, d: td } = target;
    let degRadReflect = ta * td - tb * tc > 0 ? MathUtils.degRad : -MathUtils.degRad;
    let offsetRotation = this.data.offsetRotation * degRadReflect;
    let offsetShearY = this.data.offsetShearY * degRadReflect;
    let bones = this.bones;
    for (let i = 0, n = bones.length;i < n; i++) {
      let bone = bones[i];
      if (mixRotate != 0) {
        let { a, b, c, d } = bone;
        let r = Math.atan2(tc, ta) - Math.atan2(c, a) + offsetRotation;
        if (r > MathUtils.PI)
          r -= MathUtils.PI2;
        else if (r < -MathUtils.PI)
          r += MathUtils.PI2;
        r *= mixRotate;
        let cos = Math.cos(r), sin = Math.sin(r);
        bone.a = cos * a - sin * c;
        bone.b = cos * b - sin * d;
        bone.c = sin * a + cos * c;
        bone.d = sin * b + cos * d;
      }
      if (translate) {
        let temp = this.temp;
        target.localToWorld(temp.set(this.data.offsetX, this.data.offsetY));
        bone.worldX += (temp.x - bone.worldX) * mixX;
        bone.worldY += (temp.y - bone.worldY) * mixY;
      }
      if (mixScaleX != 0) {
        let s = Math.sqrt(bone.a * bone.a + bone.c * bone.c);
        if (s != 0)
          s = (s + (Math.sqrt(ta * ta + tc * tc) - s + this.data.offsetScaleX) * mixScaleX) / s;
        bone.a *= s;
        bone.c *= s;
      }
      if (mixScaleY != 0) {
        let s = Math.sqrt(bone.b * bone.b + bone.d * bone.d);
        if (s != 0)
          s = (s + (Math.sqrt(tb * tb + td * td) - s + this.data.offsetScaleY) * mixScaleY) / s;
        bone.b *= s;
        bone.d *= s;
      }
      if (mixShearY > 0) {
        let { b, d } = bone;
        let by = Math.atan2(d, b);
        let r = Math.atan2(td, tb) - Math.atan2(tc, ta) - (by - Math.atan2(bone.c, bone.a));
        if (r > MathUtils.PI)
          r -= MathUtils.PI2;
        else if (r < -MathUtils.PI)
          r += MathUtils.PI2;
        r = by + (r + offsetShearY) * mixShearY;
        let s = Math.sqrt(b * b + d * d);
        bone.b = Math.cos(r) * s;
        bone.d = Math.sin(r) * s;
      }
      bone.updateAppliedTransform();
    }
  }
  applyRelativeWorld() {
    let mixRotate = this.mixRotate, mixX = this.mixX, mixY = this.mixY, mixScaleX = this.mixScaleX, mixScaleY = this.mixScaleY, mixShearY = this.mixShearY;
    let translate = mixX != 0 || mixY != 0;
    let target = this.target;
    let { a: ta, b: tb, c: tc, d: td } = target;
    let degRadReflect = ta * td - tb * tc > 0 ? MathUtils.degRad : -MathUtils.degRad;
    let offsetRotation = this.data.offsetRotation * degRadReflect, offsetShearY = this.data.offsetShearY * degRadReflect;
    let bones = this.bones;
    for (let i = 0, n = bones.length;i < n; i++) {
      let bone = bones[i];
      if (mixRotate != 0) {
        let { a, b, c, d } = bone;
        let r = Math.atan2(tc, ta) + offsetRotation;
        if (r > MathUtils.PI)
          r -= MathUtils.PI2;
        else if (r < -MathUtils.PI)
          r += MathUtils.PI2;
        r *= mixRotate;
        let cos = Math.cos(r), sin = Math.sin(r);
        bone.a = cos * a - sin * c;
        bone.b = cos * b - sin * d;
        bone.c = sin * a + cos * c;
        bone.d = sin * b + cos * d;
      }
      if (translate) {
        let temp = this.temp;
        target.localToWorld(temp.set(this.data.offsetX, this.data.offsetY));
        bone.worldX += temp.x * mixX;
        bone.worldY += temp.y * mixY;
      }
      if (mixScaleX != 0) {
        let s = (Math.sqrt(ta * ta + tc * tc) - 1 + this.data.offsetScaleX) * mixScaleX + 1;
        bone.a *= s;
        bone.c *= s;
      }
      if (mixScaleY != 0) {
        let s = (Math.sqrt(tb * tb + td * td) - 1 + this.data.offsetScaleY) * mixScaleY + 1;
        bone.b *= s;
        bone.d *= s;
      }
      if (mixShearY > 0) {
        let r = Math.atan2(td, tb) - Math.atan2(tc, ta);
        if (r > MathUtils.PI)
          r -= MathUtils.PI2;
        else if (r < -MathUtils.PI)
          r += MathUtils.PI2;
        let { b, d } = bone;
        r = Math.atan2(d, b) + (r - MathUtils.PI / 2 + offsetShearY) * mixShearY;
        let s = Math.sqrt(b * b + d * d);
        bone.b = Math.cos(r) * s;
        bone.d = Math.sin(r) * s;
      }
      bone.updateAppliedTransform();
    }
  }
  applyAbsoluteLocal() {
    let mixRotate = this.mixRotate, mixX = this.mixX, mixY = this.mixY, mixScaleX = this.mixScaleX, mixScaleY = this.mixScaleY, mixShearY = this.mixShearY;
    let target = this.target;
    let bones = this.bones;
    for (let i = 0, n = bones.length;i < n; i++) {
      let bone = bones[i];
      let rotation = bone.arotation;
      if (mixRotate != 0) {
        let r = target.arotation - rotation + this.data.offsetRotation;
        r -= (16384 - (16384.499999999996 - r / 360 | 0)) * 360;
        rotation += r * mixRotate;
      }
      let { ax: x, ay: y } = bone;
      x += (target.ax - x + this.data.offsetX) * mixX;
      y += (target.ay - y + this.data.offsetY) * mixY;
      let { ascaleX: scaleX, ascaleY: scaleY } = bone;
      if (mixScaleX != 0 && scaleX != 0)
        scaleX = (scaleX + (target.ascaleX - scaleX + this.data.offsetScaleX) * mixScaleX) / scaleX;
      if (mixScaleY != 0 && scaleY != 0)
        scaleY = (scaleY + (target.ascaleY - scaleY + this.data.offsetScaleY) * mixScaleY) / scaleY;
      let shearY = bone.ashearY;
      if (mixShearY != 0) {
        let r = target.ashearY - shearY + this.data.offsetShearY;
        r -= (16384 - (16384.499999999996 - r / 360 | 0)) * 360;
        shearY += r * mixShearY;
      }
      bone.updateWorldTransformWith(x, y, rotation, scaleX, scaleY, bone.ashearX, shearY);
    }
  }
  applyRelativeLocal() {
    let mixRotate = this.mixRotate, mixX = this.mixX, mixY = this.mixY, mixScaleX = this.mixScaleX, mixScaleY = this.mixScaleY, mixShearY = this.mixShearY;
    let target = this.target;
    let bones = this.bones;
    for (let i = 0, n = bones.length;i < n; i++) {
      let bone = bones[i];
      let rotation = bone.arotation + (target.arotation + this.data.offsetRotation) * mixRotate;
      let x = bone.ax + (target.ax + this.data.offsetX) * mixX;
      let y = bone.ay + (target.ay + this.data.offsetY) * mixY;
      let scaleX = bone.ascaleX * ((target.ascaleX - 1 + this.data.offsetScaleX) * mixScaleX + 1);
      let scaleY = bone.ascaleY * ((target.ascaleY - 1 + this.data.offsetScaleY) * mixScaleY + 1);
      let shearY = bone.ashearY + (target.ashearY + this.data.offsetShearY) * mixShearY;
      bone.updateWorldTransformWith(x, y, rotation, scaleX, scaleY, bone.ashearX, shearY);
    }
  }
}

// node_modules/@esotericsoftware/spine-core/dist/Skeleton.js
class Skeleton {
  static yDown = false;
  data;
  bones;
  slots;
  drawOrder;
  ikConstraints;
  transformConstraints;
  pathConstraints;
  _updateCache = new Array;
  skin = null;
  color;
  scaleX = 1;
  _scaleY = 1;
  get scaleY() {
    return Skeleton.yDown ? -this._scaleY : this._scaleY;
  }
  set scaleY(scaleY) {
    this._scaleY = scaleY;
  }
  x = 0;
  y = 0;
  constructor(data) {
    if (!data)
      throw new Error("data cannot be null.");
    this.data = data;
    this.bones = new Array;
    for (let i = 0;i < data.bones.length; i++) {
      let boneData = data.bones[i];
      let bone;
      if (!boneData.parent)
        bone = new Bone(boneData, this, null);
      else {
        let parent = this.bones[boneData.parent.index];
        bone = new Bone(boneData, this, parent);
        parent.children.push(bone);
      }
      this.bones.push(bone);
    }
    this.slots = new Array;
    this.drawOrder = new Array;
    for (let i = 0;i < data.slots.length; i++) {
      let slotData = data.slots[i];
      let bone = this.bones[slotData.boneData.index];
      let slot = new Slot(slotData, bone);
      this.slots.push(slot);
      this.drawOrder.push(slot);
    }
    this.ikConstraints = new Array;
    for (let i = 0;i < data.ikConstraints.length; i++) {
      let ikConstraintData = data.ikConstraints[i];
      this.ikConstraints.push(new IkConstraint(ikConstraintData, this));
    }
    this.transformConstraints = new Array;
    for (let i = 0;i < data.transformConstraints.length; i++) {
      let transformConstraintData = data.transformConstraints[i];
      this.transformConstraints.push(new TransformConstraint(transformConstraintData, this));
    }
    this.pathConstraints = new Array;
    for (let i = 0;i < data.pathConstraints.length; i++) {
      let pathConstraintData = data.pathConstraints[i];
      this.pathConstraints.push(new PathConstraint(pathConstraintData, this));
    }
    this.color = new Color(1, 1, 1, 1);
    this.updateCache();
  }
  updateCache() {
    let updateCache = this._updateCache;
    updateCache.length = 0;
    let bones = this.bones;
    for (let i = 0, n = bones.length;i < n; i++) {
      let bone = bones[i];
      bone.sorted = bone.data.skinRequired;
      bone.active = !bone.sorted;
    }
    if (this.skin) {
      let skinBones = this.skin.bones;
      for (let i = 0, n = this.skin.bones.length;i < n; i++) {
        let bone = this.bones[skinBones[i].index];
        do {
          bone.sorted = false;
          bone.active = true;
          bone = bone.parent;
        } while (bone);
      }
    }
    let ikConstraints = this.ikConstraints;
    let transformConstraints = this.transformConstraints;
    let pathConstraints = this.pathConstraints;
    let ikCount = ikConstraints.length, transformCount = transformConstraints.length, pathCount = pathConstraints.length;
    let constraintCount = ikCount + transformCount + pathCount;
    outer:
      for (let i = 0;i < constraintCount; i++) {
        for (let ii = 0;ii < ikCount; ii++) {
          let constraint = ikConstraints[ii];
          if (constraint.data.order == i) {
            this.sortIkConstraint(constraint);
            continue outer;
          }
        }
        for (let ii = 0;ii < transformCount; ii++) {
          let constraint = transformConstraints[ii];
          if (constraint.data.order == i) {
            this.sortTransformConstraint(constraint);
            continue outer;
          }
        }
        for (let ii = 0;ii < pathCount; ii++) {
          let constraint = pathConstraints[ii];
          if (constraint.data.order == i) {
            this.sortPathConstraint(constraint);
            continue outer;
          }
        }
      }
    for (let i = 0, n = bones.length;i < n; i++)
      this.sortBone(bones[i]);
  }
  sortIkConstraint(constraint) {
    constraint.active = constraint.target.isActive() && (!constraint.data.skinRequired || this.skin && Utils.contains(this.skin.constraints, constraint.data, true));
    if (!constraint.active)
      return;
    let target = constraint.target;
    this.sortBone(target);
    let constrained = constraint.bones;
    let parent = constrained[0];
    this.sortBone(parent);
    if (constrained.length == 1) {
      this._updateCache.push(constraint);
      this.sortReset(parent.children);
    } else {
      let child = constrained[constrained.length - 1];
      this.sortBone(child);
      this._updateCache.push(constraint);
      this.sortReset(parent.children);
      child.sorted = true;
    }
  }
  sortPathConstraint(constraint) {
    constraint.active = constraint.target.bone.isActive() && (!constraint.data.skinRequired || this.skin && Utils.contains(this.skin.constraints, constraint.data, true));
    if (!constraint.active)
      return;
    let slot = constraint.target;
    let slotIndex = slot.data.index;
    let slotBone = slot.bone;
    if (this.skin)
      this.sortPathConstraintAttachment(this.skin, slotIndex, slotBone);
    if (this.data.defaultSkin && this.data.defaultSkin != this.skin)
      this.sortPathConstraintAttachment(this.data.defaultSkin, slotIndex, slotBone);
    for (let i = 0, n = this.data.skins.length;i < n; i++)
      this.sortPathConstraintAttachment(this.data.skins[i], slotIndex, slotBone);
    let attachment = slot.getAttachment();
    if (attachment instanceof PathAttachment)
      this.sortPathConstraintAttachmentWith(attachment, slotBone);
    let constrained = constraint.bones;
    let boneCount = constrained.length;
    for (let i = 0;i < boneCount; i++)
      this.sortBone(constrained[i]);
    this._updateCache.push(constraint);
    for (let i = 0;i < boneCount; i++)
      this.sortReset(constrained[i].children);
    for (let i = 0;i < boneCount; i++)
      constrained[i].sorted = true;
  }
  sortTransformConstraint(constraint) {
    constraint.active = constraint.target.isActive() && (!constraint.data.skinRequired || this.skin && Utils.contains(this.skin.constraints, constraint.data, true));
    if (!constraint.active)
      return;
    this.sortBone(constraint.target);
    let constrained = constraint.bones;
    let boneCount = constrained.length;
    if (constraint.data.local) {
      for (let i = 0;i < boneCount; i++) {
        let child = constrained[i];
        this.sortBone(child.parent);
        this.sortBone(child);
      }
    } else {
      for (let i = 0;i < boneCount; i++) {
        this.sortBone(constrained[i]);
      }
    }
    this._updateCache.push(constraint);
    for (let i = 0;i < boneCount; i++)
      this.sortReset(constrained[i].children);
    for (let i = 0;i < boneCount; i++)
      constrained[i].sorted = true;
  }
  sortPathConstraintAttachment(skin, slotIndex, slotBone) {
    let attachments = skin.attachments[slotIndex];
    if (!attachments)
      return;
    for (let key in attachments) {
      this.sortPathConstraintAttachmentWith(attachments[key], slotBone);
    }
  }
  sortPathConstraintAttachmentWith(attachment, slotBone) {
    if (!(attachment instanceof PathAttachment))
      return;
    let pathBones = attachment.bones;
    if (!pathBones)
      this.sortBone(slotBone);
    else {
      let bones = this.bones;
      for (let i = 0, n = pathBones.length;i < n; ) {
        let nn = pathBones[i++];
        nn += i;
        while (i < nn)
          this.sortBone(bones[pathBones[i++]]);
      }
    }
  }
  sortBone(bone) {
    if (!bone)
      return;
    if (bone.sorted)
      return;
    let parent = bone.parent;
    if (parent)
      this.sortBone(parent);
    bone.sorted = true;
    this._updateCache.push(bone);
  }
  sortReset(bones) {
    for (let i = 0, n = bones.length;i < n; i++) {
      let bone = bones[i];
      if (!bone.active)
        continue;
      if (bone.sorted)
        this.sortReset(bone.children);
      bone.sorted = false;
    }
  }
  updateWorldTransform() {
    let bones = this.bones;
    for (let i = 0, n = bones.length;i < n; i++) {
      let bone = bones[i];
      bone.ax = bone.x;
      bone.ay = bone.y;
      bone.arotation = bone.rotation;
      bone.ascaleX = bone.scaleX;
      bone.ascaleY = bone.scaleY;
      bone.ashearX = bone.shearX;
      bone.ashearY = bone.shearY;
    }
    let updateCache = this._updateCache;
    for (let i = 0, n = updateCache.length;i < n; i++)
      updateCache[i].update();
  }
  updateWorldTransformWith(parent) {
    let rootBone = this.getRootBone();
    if (!rootBone)
      throw new Error("Root bone must not be null.");
    let { a: pa, b: pb, c: pc, d: pd } = parent;
    rootBone.worldX = pa * this.x + pb * this.y + parent.worldX;
    rootBone.worldY = pc * this.x + pd * this.y + parent.worldY;
    let rotationY = rootBone.rotation + 90 + rootBone.shearY;
    let la = MathUtils.cosDeg(rootBone.rotation + rootBone.shearX) * rootBone.scaleX;
    let lb = MathUtils.cosDeg(rotationY) * rootBone.scaleY;
    let lc = MathUtils.sinDeg(rootBone.rotation + rootBone.shearX) * rootBone.scaleX;
    let ld = MathUtils.sinDeg(rotationY) * rootBone.scaleY;
    rootBone.a = (pa * la + pb * lc) * this.scaleX;
    rootBone.b = (pa * lb + pb * ld) * this.scaleX;
    rootBone.c = (pc * la + pd * lc) * this.scaleY;
    rootBone.d = (pc * lb + pd * ld) * this.scaleY;
    let updateCache = this._updateCache;
    for (let i = 0, n = updateCache.length;i < n; i++) {
      let updatable = updateCache[i];
      if (updatable != rootBone)
        updatable.update();
    }
  }
  setToSetupPose() {
    this.setBonesToSetupPose();
    this.setSlotsToSetupPose();
  }
  setBonesToSetupPose() {
    let bones = this.bones;
    for (let i = 0, n = bones.length;i < n; i++)
      bones[i].setToSetupPose();
    let ikConstraints = this.ikConstraints;
    for (let i = 0, n = ikConstraints.length;i < n; i++) {
      let constraint = ikConstraints[i];
      constraint.mix = constraint.data.mix;
      constraint.softness = constraint.data.softness;
      constraint.bendDirection = constraint.data.bendDirection;
      constraint.compress = constraint.data.compress;
      constraint.stretch = constraint.data.stretch;
    }
    let transformConstraints = this.transformConstraints;
    for (let i = 0, n = transformConstraints.length;i < n; i++) {
      let constraint = transformConstraints[i];
      let data = constraint.data;
      constraint.mixRotate = data.mixRotate;
      constraint.mixX = data.mixX;
      constraint.mixY = data.mixY;
      constraint.mixScaleX = data.mixScaleX;
      constraint.mixScaleY = data.mixScaleY;
      constraint.mixShearY = data.mixShearY;
    }
    let pathConstraints = this.pathConstraints;
    for (let i = 0, n = pathConstraints.length;i < n; i++) {
      let constraint = pathConstraints[i];
      let data = constraint.data;
      constraint.position = data.position;
      constraint.spacing = data.spacing;
      constraint.mixRotate = data.mixRotate;
      constraint.mixX = data.mixX;
      constraint.mixY = data.mixY;
    }
  }
  setSlotsToSetupPose() {
    let slots = this.slots;
    Utils.arrayCopy(slots, 0, this.drawOrder, 0, slots.length);
    for (let i = 0, n = slots.length;i < n; i++)
      slots[i].setToSetupPose();
  }
  getRootBone() {
    if (this.bones.length == 0)
      return null;
    return this.bones[0];
  }
  findBone(boneName) {
    if (!boneName)
      throw new Error("boneName cannot be null.");
    let bones = this.bones;
    for (let i = 0, n = bones.length;i < n; i++) {
      let bone = bones[i];
      if (bone.data.name == boneName)
        return bone;
    }
    return null;
  }
  findSlot(slotName) {
    if (!slotName)
      throw new Error("slotName cannot be null.");
    let slots = this.slots;
    for (let i = 0, n = slots.length;i < n; i++) {
      let slot = slots[i];
      if (slot.data.name == slotName)
        return slot;
    }
    return null;
  }
  setSkinByName(skinName) {
    let skin = this.data.findSkin(skinName);
    if (!skin)
      throw new Error("Skin not found: " + skinName);
    this.setSkin(skin);
  }
  setSkin(newSkin) {
    if (newSkin == this.skin)
      return;
    if (newSkin) {
      if (this.skin)
        newSkin.attachAll(this, this.skin);
      else {
        let slots = this.slots;
        for (let i = 0, n = slots.length;i < n; i++) {
          let slot = slots[i];
          let name = slot.data.attachmentName;
          if (name) {
            let attachment = newSkin.getAttachment(i, name);
            if (attachment)
              slot.setAttachment(attachment);
          }
        }
      }
    }
    this.skin = newSkin;
    this.updateCache();
  }
  getAttachmentByName(slotName, attachmentName) {
    let slot = this.data.findSlot(slotName);
    if (!slot)
      throw new Error(`Can't find slot with name ${slotName}`);
    return this.getAttachment(slot.index, attachmentName);
  }
  getAttachment(slotIndex, attachmentName) {
    if (!attachmentName)
      throw new Error("attachmentName cannot be null.");
    if (this.skin) {
      let attachment = this.skin.getAttachment(slotIndex, attachmentName);
      if (attachment)
        return attachment;
    }
    if (this.data.defaultSkin)
      return this.data.defaultSkin.getAttachment(slotIndex, attachmentName);
    return null;
  }
  setAttachment(slotName, attachmentName) {
    if (!slotName)
      throw new Error("slotName cannot be null.");
    let slots = this.slots;
    for (let i = 0, n = slots.length;i < n; i++) {
      let slot = slots[i];
      if (slot.data.name == slotName) {
        let attachment = null;
        if (attachmentName) {
          attachment = this.getAttachment(i, attachmentName);
          if (!attachment)
            throw new Error("Attachment not found: " + attachmentName + ", for slot: " + slotName);
        }
        slot.setAttachment(attachment);
        return;
      }
    }
    throw new Error("Slot not found: " + slotName);
  }
  findIkConstraint(constraintName) {
    if (!constraintName)
      throw new Error("constraintName cannot be null.");
    let ikConstraints = this.ikConstraints;
    for (let i = 0, n = ikConstraints.length;i < n; i++) {
      let ikConstraint = ikConstraints[i];
      if (ikConstraint.data.name == constraintName)
        return ikConstraint;
    }
    return null;
  }
  findTransformConstraint(constraintName) {
    if (!constraintName)
      throw new Error("constraintName cannot be null.");
    let transformConstraints = this.transformConstraints;
    for (let i = 0, n = transformConstraints.length;i < n; i++) {
      let constraint = transformConstraints[i];
      if (constraint.data.name == constraintName)
        return constraint;
    }
    return null;
  }
  findPathConstraint(constraintName) {
    if (!constraintName)
      throw new Error("constraintName cannot be null.");
    let pathConstraints = this.pathConstraints;
    for (let i = 0, n = pathConstraints.length;i < n; i++) {
      let constraint = pathConstraints[i];
      if (constraint.data.name == constraintName)
        return constraint;
    }
    return null;
  }
  getBoundsRect() {
    let offset = new Vector2;
    let size = new Vector2;
    this.getBounds(offset, size);
    return { x: offset.x, y: offset.y, width: size.x, height: size.y };
  }
  getBounds(offset, size, temp = new Array(2)) {
    if (!offset)
      throw new Error("offset cannot be null.");
    if (!size)
      throw new Error("size cannot be null.");
    let drawOrder = this.drawOrder;
    let { POSITIVE_INFINITY: minX, POSITIVE_INFINITY: minY, NEGATIVE_INFINITY: maxX, NEGATIVE_INFINITY: maxY } = Number;
    for (let i = 0, n = drawOrder.length;i < n; i++) {
      let slot = drawOrder[i];
      if (!slot.bone.active)
        continue;
      let verticesLength = 0;
      let vertices = null;
      let attachment = slot.getAttachment();
      if (attachment instanceof RegionAttachment) {
        verticesLength = 8;
        vertices = Utils.setArraySize(temp, verticesLength, 0);
        attachment.computeWorldVertices(slot, vertices, 0, 2);
      } else if (attachment instanceof MeshAttachment) {
        let mesh = attachment;
        verticesLength = mesh.worldVerticesLength;
        vertices = Utils.setArraySize(temp, verticesLength, 0);
        mesh.computeWorldVertices(slot, 0, verticesLength, vertices, 0, 2);
      }
      if (vertices) {
        for (let ii = 0, nn = vertices.length;ii < nn; ii += 2) {
          let x = vertices[ii], y = vertices[ii + 1];
          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
          maxX = Math.max(maxX, x);
          maxY = Math.max(maxY, y);
        }
      }
    }
    offset.set(minX, minY);
    size.set(maxX - minX, maxY - minY);
  }
}
// node_modules/@esotericsoftware/spine-core/dist/SkeletonData.js
class SkeletonData {
  name = null;
  bones = new Array;
  slots = new Array;
  skins = new Array;
  defaultSkin = null;
  events = new Array;
  animations = new Array;
  ikConstraints = new Array;
  transformConstraints = new Array;
  pathConstraints = new Array;
  x = 0;
  y = 0;
  width = 0;
  height = 0;
  version = null;
  hash = null;
  fps = 0;
  imagesPath = null;
  audioPath = null;
  findBone(boneName) {
    if (!boneName)
      throw new Error("boneName cannot be null.");
    let bones = this.bones;
    for (let i = 0, n = bones.length;i < n; i++) {
      let bone = bones[i];
      if (bone.name == boneName)
        return bone;
    }
    return null;
  }
  findSlot(slotName) {
    if (!slotName)
      throw new Error("slotName cannot be null.");
    let slots = this.slots;
    for (let i = 0, n = slots.length;i < n; i++) {
      let slot = slots[i];
      if (slot.name == slotName)
        return slot;
    }
    return null;
  }
  findSkin(skinName) {
    if (!skinName)
      throw new Error("skinName cannot be null.");
    let skins = this.skins;
    for (let i = 0, n = skins.length;i < n; i++) {
      let skin = skins[i];
      if (skin.name == skinName)
        return skin;
    }
    return null;
  }
  findEvent(eventDataName) {
    if (!eventDataName)
      throw new Error("eventDataName cannot be null.");
    let events = this.events;
    for (let i = 0, n = events.length;i < n; i++) {
      let event = events[i];
      if (event.name == eventDataName)
        return event;
    }
    return null;
  }
  findAnimation(animationName) {
    if (!animationName)
      throw new Error("animationName cannot be null.");
    let animations = this.animations;
    for (let i = 0, n = animations.length;i < n; i++) {
      let animation = animations[i];
      if (animation.name == animationName)
        return animation;
    }
    return null;
  }
  findIkConstraint(constraintName) {
    if (!constraintName)
      throw new Error("constraintName cannot be null.");
    let ikConstraints = this.ikConstraints;
    for (let i = 0, n = ikConstraints.length;i < n; i++) {
      let constraint = ikConstraints[i];
      if (constraint.name == constraintName)
        return constraint;
    }
    return null;
  }
  findTransformConstraint(constraintName) {
    if (!constraintName)
      throw new Error("constraintName cannot be null.");
    let transformConstraints = this.transformConstraints;
    for (let i = 0, n = transformConstraints.length;i < n; i++) {
      let constraint = transformConstraints[i];
      if (constraint.name == constraintName)
        return constraint;
    }
    return null;
  }
  findPathConstraint(constraintName) {
    if (!constraintName)
      throw new Error("constraintName cannot be null.");
    let pathConstraints = this.pathConstraints;
    for (let i = 0, n = pathConstraints.length;i < n; i++) {
      let constraint = pathConstraints[i];
      if (constraint.name == constraintName)
        return constraint;
    }
    return null;
  }
}

// node_modules/@esotericsoftware/spine-core/dist/Skin.js
class SkinEntry {
  slotIndex;
  name;
  attachment;
  constructor(slotIndex = 0, name, attachment) {
    this.slotIndex = slotIndex;
    this.name = name;
    this.attachment = attachment;
  }
}

class Skin {
  name;
  attachments = new Array;
  bones = Array();
  constraints = new Array;
  constructor(name) {
    if (!name)
      throw new Error("name cannot be null.");
    this.name = name;
  }
  setAttachment(slotIndex, name, attachment) {
    if (!attachment)
      throw new Error("attachment cannot be null.");
    let attachments = this.attachments;
    if (slotIndex >= attachments.length)
      attachments.length = slotIndex + 1;
    if (!attachments[slotIndex])
      attachments[slotIndex] = {};
    attachments[slotIndex][name] = attachment;
  }
  addSkin(skin) {
    for (let i = 0;i < skin.bones.length; i++) {
      let bone = skin.bones[i];
      let contained = false;
      for (let ii = 0;ii < this.bones.length; ii++) {
        if (this.bones[ii] == bone) {
          contained = true;
          break;
        }
      }
      if (!contained)
        this.bones.push(bone);
    }
    for (let i = 0;i < skin.constraints.length; i++) {
      let constraint = skin.constraints[i];
      let contained = false;
      for (let ii = 0;ii < this.constraints.length; ii++) {
        if (this.constraints[ii] == constraint) {
          contained = true;
          break;
        }
      }
      if (!contained)
        this.constraints.push(constraint);
    }
    let attachments = skin.getAttachments();
    for (let i = 0;i < attachments.length; i++) {
      var attachment = attachments[i];
      this.setAttachment(attachment.slotIndex, attachment.name, attachment.attachment);
    }
  }
  copySkin(skin) {
    for (let i = 0;i < skin.bones.length; i++) {
      let bone = skin.bones[i];
      let contained = false;
      for (let ii = 0;ii < this.bones.length; ii++) {
        if (this.bones[ii] == bone) {
          contained = true;
          break;
        }
      }
      if (!contained)
        this.bones.push(bone);
    }
    for (let i = 0;i < skin.constraints.length; i++) {
      let constraint = skin.constraints[i];
      let contained = false;
      for (let ii = 0;ii < this.constraints.length; ii++) {
        if (this.constraints[ii] == constraint) {
          contained = true;
          break;
        }
      }
      if (!contained)
        this.constraints.push(constraint);
    }
    let attachments = skin.getAttachments();
    for (let i = 0;i < attachments.length; i++) {
      var attachment = attachments[i];
      if (!attachment.attachment)
        continue;
      if (attachment.attachment instanceof MeshAttachment) {
        attachment.attachment = attachment.attachment.newLinkedMesh();
        this.setAttachment(attachment.slotIndex, attachment.name, attachment.attachment);
      } else {
        attachment.attachment = attachment.attachment.copy();
        this.setAttachment(attachment.slotIndex, attachment.name, attachment.attachment);
      }
    }
  }
  getAttachment(slotIndex, name) {
    let dictionary = this.attachments[slotIndex];
    return dictionary ? dictionary[name] : null;
  }
  removeAttachment(slotIndex, name) {
    let dictionary = this.attachments[slotIndex];
    if (dictionary)
      delete dictionary[name];
  }
  getAttachments() {
    let entries = new Array;
    for (var i = 0;i < this.attachments.length; i++) {
      let slotAttachments = this.attachments[i];
      if (slotAttachments) {
        for (let name in slotAttachments) {
          let attachment = slotAttachments[name];
          if (attachment)
            entries.push(new SkinEntry(i, name, attachment));
        }
      }
    }
    return entries;
  }
  getAttachmentsForSlot(slotIndex, attachments) {
    let slotAttachments = this.attachments[slotIndex];
    if (slotAttachments) {
      for (let name in slotAttachments) {
        let attachment = slotAttachments[name];
        if (attachment)
          attachments.push(new SkinEntry(slotIndex, name, attachment));
      }
    }
  }
  clear() {
    this.attachments.length = 0;
    this.bones.length = 0;
    this.constraints.length = 0;
  }
  attachAll(skeleton, oldSkin) {
    let slotIndex = 0;
    for (let i = 0;i < skeleton.slots.length; i++) {
      let slot = skeleton.slots[i];
      let slotAttachment = slot.getAttachment();
      if (slotAttachment && slotIndex < oldSkin.attachments.length) {
        let dictionary = oldSkin.attachments[slotIndex];
        for (let key in dictionary) {
          let skinAttachment = dictionary[key];
          if (slotAttachment == skinAttachment) {
            let attachment = this.getAttachment(slotIndex, key);
            if (attachment)
              slot.setAttachment(attachment);
            break;
          }
        }
      }
      slotIndex++;
    }
  }
}

// node_modules/@esotericsoftware/spine-core/dist/SlotData.js
class SlotData {
  index = 0;
  name;
  boneData;
  color = new Color(1, 1, 1, 1);
  darkColor = null;
  attachmentName = null;
  blendMode = BlendMode.Normal;
  constructor(index, name, boneData) {
    if (index < 0)
      throw new Error("index must be >= 0.");
    if (!name)
      throw new Error("name cannot be null.");
    if (!boneData)
      throw new Error("boneData cannot be null.");
    this.index = index;
    this.name = name;
    this.boneData = boneData;
  }
}
var BlendMode;
(function(BlendMode) {
  BlendMode[BlendMode["Normal"] = 0] = "Normal";
  BlendMode[BlendMode["Additive"] = 1] = "Additive";
  BlendMode[BlendMode["Multiply"] = 2] = "Multiply";
  BlendMode[BlendMode["Screen"] = 3] = "Screen";
})(BlendMode || (BlendMode = {}));

// node_modules/@esotericsoftware/spine-core/dist/TransformConstraintData.js
class TransformConstraintData extends ConstraintData {
  bones = new Array;
  _target = null;
  set target(boneData) {
    this._target = boneData;
  }
  get target() {
    if (!this._target)
      throw new Error("BoneData not set.");
    else
      return this._target;
  }
  mixRotate = 0;
  mixX = 0;
  mixY = 0;
  mixScaleX = 0;
  mixScaleY = 0;
  mixShearY = 0;
  offsetRotation = 0;
  offsetX = 0;
  offsetY = 0;
  offsetScaleX = 0;
  offsetScaleY = 0;
  offsetShearY = 0;
  relative = false;
  local = false;
  constructor(name) {
    super(name, 0, false);
  }
}

// node_modules/@esotericsoftware/spine-core/dist/SkeletonBinary.js
class SkeletonBinary {
  scale = 1;
  attachmentLoader;
  linkedMeshes = new Array;
  constructor(attachmentLoader) {
    this.attachmentLoader = attachmentLoader;
  }
  readSkeletonData(binary) {
    let scale = this.scale;
    let skeletonData = new SkeletonData;
    skeletonData.name = "";
    let input = new BinaryInput(binary);
    let lowHash = input.readInt32();
    let highHash = input.readInt32();
    skeletonData.hash = highHash == 0 && lowHash == 0 ? null : highHash.toString(16) + lowHash.toString(16);
    skeletonData.version = input.readString();
    skeletonData.x = input.readFloat();
    skeletonData.y = input.readFloat();
    skeletonData.width = input.readFloat();
    skeletonData.height = input.readFloat();
    let nonessential = input.readBoolean();
    if (nonessential) {
      skeletonData.fps = input.readFloat();
      skeletonData.imagesPath = input.readString();
      skeletonData.audioPath = input.readString();
    }
    let n = 0;
    n = input.readInt(true);
    for (let i = 0;i < n; i++) {
      let str = input.readString();
      if (!str)
        throw new Error("String in string table must not be null.");
      input.strings.push(str);
    }
    n = input.readInt(true);
    for (let i = 0;i < n; i++) {
      let name = input.readString();
      if (!name)
        throw new Error("Bone name must not be null.");
      let parent = i == 0 ? null : skeletonData.bones[input.readInt(true)];
      let data = new BoneData(i, name, parent);
      data.rotation = input.readFloat();
      data.x = input.readFloat() * scale;
      data.y = input.readFloat() * scale;
      data.scaleX = input.readFloat();
      data.scaleY = input.readFloat();
      data.shearX = input.readFloat();
      data.shearY = input.readFloat();
      data.length = input.readFloat() * scale;
      data.transformMode = input.readInt(true);
      data.skinRequired = input.readBoolean();
      if (nonessential)
        Color.rgba8888ToColor(data.color, input.readInt32());
      skeletonData.bones.push(data);
    }
    n = input.readInt(true);
    for (let i = 0;i < n; i++) {
      let slotName = input.readString();
      if (!slotName)
        throw new Error("Slot name must not be null.");
      let boneData = skeletonData.bones[input.readInt(true)];
      let data = new SlotData(i, slotName, boneData);
      Color.rgba8888ToColor(data.color, input.readInt32());
      let darkColor = input.readInt32();
      if (darkColor != -1)
        Color.rgb888ToColor(data.darkColor = new Color, darkColor);
      data.attachmentName = input.readStringRef();
      data.blendMode = input.readInt(true);
      skeletonData.slots.push(data);
    }
    n = input.readInt(true);
    for (let i = 0, nn;i < n; i++) {
      let name = input.readString();
      if (!name)
        throw new Error("IK constraint data name must not be null.");
      let data = new IkConstraintData(name);
      data.order = input.readInt(true);
      data.skinRequired = input.readBoolean();
      nn = input.readInt(true);
      for (let ii = 0;ii < nn; ii++)
        data.bones.push(skeletonData.bones[input.readInt(true)]);
      data.target = skeletonData.bones[input.readInt(true)];
      data.mix = input.readFloat();
      data.softness = input.readFloat() * scale;
      data.bendDirection = input.readByte();
      data.compress = input.readBoolean();
      data.stretch = input.readBoolean();
      data.uniform = input.readBoolean();
      skeletonData.ikConstraints.push(data);
    }
    n = input.readInt(true);
    for (let i = 0, nn;i < n; i++) {
      let name = input.readString();
      if (!name)
        throw new Error("Transform constraint data name must not be null.");
      let data = new TransformConstraintData(name);
      data.order = input.readInt(true);
      data.skinRequired = input.readBoolean();
      nn = input.readInt(true);
      for (let ii = 0;ii < nn; ii++)
        data.bones.push(skeletonData.bones[input.readInt(true)]);
      data.target = skeletonData.bones[input.readInt(true)];
      data.local = input.readBoolean();
      data.relative = input.readBoolean();
      data.offsetRotation = input.readFloat();
      data.offsetX = input.readFloat() * scale;
      data.offsetY = input.readFloat() * scale;
      data.offsetScaleX = input.readFloat();
      data.offsetScaleY = input.readFloat();
      data.offsetShearY = input.readFloat();
      data.mixRotate = input.readFloat();
      data.mixX = input.readFloat();
      data.mixY = input.readFloat();
      data.mixScaleX = input.readFloat();
      data.mixScaleY = input.readFloat();
      data.mixShearY = input.readFloat();
      skeletonData.transformConstraints.push(data);
    }
    n = input.readInt(true);
    for (let i = 0, nn;i < n; i++) {
      let name = input.readString();
      if (!name)
        throw new Error("Path constraint data name must not be null.");
      let data = new PathConstraintData(name);
      data.order = input.readInt(true);
      data.skinRequired = input.readBoolean();
      nn = input.readInt(true);
      for (let ii = 0;ii < nn; ii++)
        data.bones.push(skeletonData.bones[input.readInt(true)]);
      data.target = skeletonData.slots[input.readInt(true)];
      data.positionMode = input.readInt(true);
      data.spacingMode = input.readInt(true);
      data.rotateMode = input.readInt(true);
      data.offsetRotation = input.readFloat();
      data.position = input.readFloat();
      if (data.positionMode == PositionMode.Fixed)
        data.position *= scale;
      data.spacing = input.readFloat();
      if (data.spacingMode == SpacingMode.Length || data.spacingMode == SpacingMode.Fixed)
        data.spacing *= scale;
      data.mixRotate = input.readFloat();
      data.mixX = input.readFloat();
      data.mixY = input.readFloat();
      skeletonData.pathConstraints.push(data);
    }
    let defaultSkin = this.readSkin(input, skeletonData, true, nonessential);
    if (defaultSkin) {
      skeletonData.defaultSkin = defaultSkin;
      skeletonData.skins.push(defaultSkin);
    }
    {
      let i = skeletonData.skins.length;
      Utils.setArraySize(skeletonData.skins, n = i + input.readInt(true));
      for (;i < n; i++) {
        let skin = this.readSkin(input, skeletonData, false, nonessential);
        if (!skin)
          throw new Error("readSkin() should not have returned null.");
        skeletonData.skins[i] = skin;
      }
    }
    n = this.linkedMeshes.length;
    for (let i = 0;i < n; i++) {
      let linkedMesh = this.linkedMeshes[i];
      let skin = !linkedMesh.skin ? skeletonData.defaultSkin : skeletonData.findSkin(linkedMesh.skin);
      if (!skin)
        throw new Error("Not skin found for linked mesh.");
      if (!linkedMesh.parent)
        throw new Error("Linked mesh parent must not be null");
      let parent = skin.getAttachment(linkedMesh.slotIndex, linkedMesh.parent);
      if (!parent)
        throw new Error(`Parent mesh not found: ${linkedMesh.parent}`);
      linkedMesh.mesh.timelineAttachment = linkedMesh.inheritTimeline ? parent : linkedMesh.mesh;
      linkedMesh.mesh.setParentMesh(parent);
      if (linkedMesh.mesh.region != null)
        linkedMesh.mesh.updateRegion();
    }
    this.linkedMeshes.length = 0;
    n = input.readInt(true);
    for (let i = 0;i < n; i++) {
      let eventName = input.readStringRef();
      if (!eventName)
        throw new Error;
      let data = new EventData(eventName);
      data.intValue = input.readInt(false);
      data.floatValue = input.readFloat();
      data.stringValue = input.readString();
      data.audioPath = input.readString();
      if (data.audioPath) {
        data.volume = input.readFloat();
        data.balance = input.readFloat();
      }
      skeletonData.events.push(data);
    }
    n = input.readInt(true);
    for (let i = 0;i < n; i++) {
      let animationName = input.readString();
      if (!animationName)
        throw new Error("Animatio name must not be null.");
      skeletonData.animations.push(this.readAnimation(input, animationName, skeletonData));
    }
    return skeletonData;
  }
  readSkin(input, skeletonData, defaultSkin, nonessential) {
    let skin = null;
    let slotCount = 0;
    if (defaultSkin) {
      slotCount = input.readInt(true);
      if (slotCount == 0)
        return null;
      skin = new Skin("default");
    } else {
      let skinName = input.readStringRef();
      if (!skinName)
        throw new Error("Skin name must not be null.");
      skin = new Skin(skinName);
      skin.bones.length = input.readInt(true);
      for (let i = 0, n = skin.bones.length;i < n; i++)
        skin.bones[i] = skeletonData.bones[input.readInt(true)];
      for (let i = 0, n = input.readInt(true);i < n; i++)
        skin.constraints.push(skeletonData.ikConstraints[input.readInt(true)]);
      for (let i = 0, n = input.readInt(true);i < n; i++)
        skin.constraints.push(skeletonData.transformConstraints[input.readInt(true)]);
      for (let i = 0, n = input.readInt(true);i < n; i++)
        skin.constraints.push(skeletonData.pathConstraints[input.readInt(true)]);
      slotCount = input.readInt(true);
    }
    for (let i = 0;i < slotCount; i++) {
      let slotIndex = input.readInt(true);
      for (let ii = 0, nn = input.readInt(true);ii < nn; ii++) {
        let name = input.readStringRef();
        if (!name)
          throw new Error("Attachment name must not be null");
        let attachment = this.readAttachment(input, skeletonData, skin, slotIndex, name, nonessential);
        if (attachment)
          skin.setAttachment(slotIndex, name, attachment);
      }
    }
    return skin;
  }
  readAttachment(input, skeletonData, skin, slotIndex, attachmentName, nonessential) {
    let scale = this.scale;
    let name = input.readStringRef();
    if (!name)
      name = attachmentName;
    switch (input.readByte()) {
      case AttachmentType.Region: {
        let path = input.readStringRef();
        let rotation = input.readFloat();
        let x = input.readFloat();
        let y = input.readFloat();
        let scaleX = input.readFloat();
        let scaleY = input.readFloat();
        let width = input.readFloat();
        let height = input.readFloat();
        let color = input.readInt32();
        let sequence = this.readSequence(input);
        if (!path)
          path = name;
        let region = this.attachmentLoader.newRegionAttachment(skin, name, path, sequence);
        if (!region)
          return null;
        region.path = path;
        region.x = x * scale;
        region.y = y * scale;
        region.scaleX = scaleX;
        region.scaleY = scaleY;
        region.rotation = rotation;
        region.width = width * scale;
        region.height = height * scale;
        Color.rgba8888ToColor(region.color, color);
        region.sequence = sequence;
        if (sequence == null)
          region.updateRegion();
        return region;
      }
      case AttachmentType.BoundingBox: {
        let vertexCount = input.readInt(true);
        let vertices = this.readVertices(input, vertexCount);
        let color = nonessential ? input.readInt32() : 0;
        let box = this.attachmentLoader.newBoundingBoxAttachment(skin, name);
        if (!box)
          return null;
        box.worldVerticesLength = vertexCount << 1;
        box.vertices = vertices.vertices;
        box.bones = vertices.bones;
        if (nonessential)
          Color.rgba8888ToColor(box.color, color);
        return box;
      }
      case AttachmentType.Mesh: {
        let path = input.readStringRef();
        let color = input.readInt32();
        let vertexCount = input.readInt(true);
        let uvs = this.readFloatArray(input, vertexCount << 1, 1);
        let triangles = this.readShortArray(input);
        let vertices = this.readVertices(input, vertexCount);
        let hullLength = input.readInt(true);
        let sequence = this.readSequence(input);
        let edges = [];
        let width = 0, height = 0;
        if (nonessential) {
          edges = this.readShortArray(input);
          width = input.readFloat();
          height = input.readFloat();
        }
        if (!path)
          path = name;
        let mesh = this.attachmentLoader.newMeshAttachment(skin, name, path, sequence);
        if (!mesh)
          return null;
        mesh.path = path;
        Color.rgba8888ToColor(mesh.color, color);
        mesh.bones = vertices.bones;
        mesh.vertices = vertices.vertices;
        mesh.worldVerticesLength = vertexCount << 1;
        mesh.triangles = triangles;
        mesh.regionUVs = uvs;
        if (sequence == null)
          mesh.updateRegion();
        mesh.hullLength = hullLength << 1;
        mesh.sequence = sequence;
        if (nonessential) {
          mesh.edges = edges;
          mesh.width = width * scale;
          mesh.height = height * scale;
        }
        return mesh;
      }
      case AttachmentType.LinkedMesh: {
        let path = input.readStringRef();
        let color = input.readInt32();
        let skinName = input.readStringRef();
        let parent = input.readStringRef();
        let inheritTimelines = input.readBoolean();
        let sequence = this.readSequence(input);
        let width = 0, height = 0;
        if (nonessential) {
          width = input.readFloat();
          height = input.readFloat();
        }
        if (!path)
          path = name;
        let mesh = this.attachmentLoader.newMeshAttachment(skin, name, path, sequence);
        if (!mesh)
          return null;
        mesh.path = path;
        Color.rgba8888ToColor(mesh.color, color);
        mesh.sequence = sequence;
        if (nonessential) {
          mesh.width = width * scale;
          mesh.height = height * scale;
        }
        this.linkedMeshes.push(new LinkedMesh(mesh, skinName, slotIndex, parent, inheritTimelines));
        return mesh;
      }
      case AttachmentType.Path: {
        let closed2 = input.readBoolean();
        let constantSpeed = input.readBoolean();
        let vertexCount = input.readInt(true);
        let vertices = this.readVertices(input, vertexCount);
        let lengths = Utils.newArray(vertexCount / 3, 0);
        for (let i = 0, n = lengths.length;i < n; i++)
          lengths[i] = input.readFloat() * scale;
        let color = nonessential ? input.readInt32() : 0;
        let path = this.attachmentLoader.newPathAttachment(skin, name);
        if (!path)
          return null;
        path.closed = closed2;
        path.constantSpeed = constantSpeed;
        path.worldVerticesLength = vertexCount << 1;
        path.vertices = vertices.vertices;
        path.bones = vertices.bones;
        path.lengths = lengths;
        if (nonessential)
          Color.rgba8888ToColor(path.color, color);
        return path;
      }
      case AttachmentType.Point: {
        let rotation = input.readFloat();
        let x = input.readFloat();
        let y = input.readFloat();
        let color = nonessential ? input.readInt32() : 0;
        let point = this.attachmentLoader.newPointAttachment(skin, name);
        if (!point)
          return null;
        point.x = x * scale;
        point.y = y * scale;
        point.rotation = rotation;
        if (nonessential)
          Color.rgba8888ToColor(point.color, color);
        return point;
      }
      case AttachmentType.Clipping: {
        let endSlotIndex = input.readInt(true);
        let vertexCount = input.readInt(true);
        let vertices = this.readVertices(input, vertexCount);
        let color = nonessential ? input.readInt32() : 0;
        let clip = this.attachmentLoader.newClippingAttachment(skin, name);
        if (!clip)
          return null;
        clip.endSlot = skeletonData.slots[endSlotIndex];
        clip.worldVerticesLength = vertexCount << 1;
        clip.vertices = vertices.vertices;
        clip.bones = vertices.bones;
        if (nonessential)
          Color.rgba8888ToColor(clip.color, color);
        return clip;
      }
    }
    return null;
  }
  readSequence(input) {
    if (!input.readBoolean())
      return null;
    let sequence = new Sequence(input.readInt(true));
    sequence.start = input.readInt(true);
    sequence.digits = input.readInt(true);
    sequence.setupIndex = input.readInt(true);
    return sequence;
  }
  readVertices(input, vertexCount) {
    let scale = this.scale;
    let verticesLength = vertexCount << 1;
    let vertices = new Vertices;
    if (!input.readBoolean()) {
      vertices.vertices = this.readFloatArray(input, verticesLength, scale);
      return vertices;
    }
    let weights = new Array;
    let bonesArray = new Array;
    for (let i = 0;i < vertexCount; i++) {
      let boneCount = input.readInt(true);
      bonesArray.push(boneCount);
      for (let ii = 0;ii < boneCount; ii++) {
        bonesArray.push(input.readInt(true));
        weights.push(input.readFloat() * scale);
        weights.push(input.readFloat() * scale);
        weights.push(input.readFloat());
      }
    }
    vertices.vertices = Utils.toFloatArray(weights);
    vertices.bones = bonesArray;
    return vertices;
  }
  readFloatArray(input, n, scale) {
    let array = new Array(n);
    if (scale == 1) {
      for (let i = 0;i < n; i++)
        array[i] = input.readFloat();
    } else {
      for (let i = 0;i < n; i++)
        array[i] = input.readFloat() * scale;
    }
    return array;
  }
  readShortArray(input) {
    let n = input.readInt(true);
    let array = new Array(n);
    for (let i = 0;i < n; i++)
      array[i] = input.readShort();
    return array;
  }
  readAnimation(input, name, skeletonData) {
    input.readInt(true);
    let timelines = new Array;
    let scale = this.scale;
    let tempColor1 = new Color;
    let tempColor2 = new Color;
    for (let i = 0, n = input.readInt(true);i < n; i++) {
      let slotIndex = input.readInt(true);
      for (let ii = 0, nn = input.readInt(true);ii < nn; ii++) {
        let timelineType = input.readByte();
        let frameCount = input.readInt(true);
        let frameLast = frameCount - 1;
        switch (timelineType) {
          case SLOT_ATTACHMENT: {
            let timeline = new AttachmentTimeline(frameCount, slotIndex);
            for (let frame = 0;frame < frameCount; frame++)
              timeline.setFrame(frame, input.readFloat(), input.readStringRef());
            timelines.push(timeline);
            break;
          }
          case SLOT_RGBA: {
            let bezierCount = input.readInt(true);
            let timeline = new RGBATimeline(frameCount, bezierCount, slotIndex);
            let time = input.readFloat();
            let r = input.readUnsignedByte() / 255;
            let g = input.readUnsignedByte() / 255;
            let b = input.readUnsignedByte() / 255;
            let a = input.readUnsignedByte() / 255;
            for (let frame = 0, bezier = 0;; frame++) {
              timeline.setFrame(frame, time, r, g, b, a);
              if (frame == frameLast)
                break;
              let time2 = input.readFloat();
              let r2 = input.readUnsignedByte() / 255;
              let g2 = input.readUnsignedByte() / 255;
              let b2 = input.readUnsignedByte() / 255;
              let a2 = input.readUnsignedByte() / 255;
              switch (input.readByte()) {
                case CURVE_STEPPED:
                  timeline.setStepped(frame);
                  break;
                case CURVE_BEZIER:
                  setBezier(input, timeline, bezier++, frame, 0, time, time2, r, r2, 1);
                  setBezier(input, timeline, bezier++, frame, 1, time, time2, g, g2, 1);
                  setBezier(input, timeline, bezier++, frame, 2, time, time2, b, b2, 1);
                  setBezier(input, timeline, bezier++, frame, 3, time, time2, a, a2, 1);
              }
              time = time2;
              r = r2;
              g = g2;
              b = b2;
              a = a2;
            }
            timelines.push(timeline);
            break;
          }
          case SLOT_RGB: {
            let bezierCount = input.readInt(true);
            let timeline = new RGBTimeline(frameCount, bezierCount, slotIndex);
            let time = input.readFloat();
            let r = input.readUnsignedByte() / 255;
            let g = input.readUnsignedByte() / 255;
            let b = input.readUnsignedByte() / 255;
            for (let frame = 0, bezier = 0;; frame++) {
              timeline.setFrame(frame, time, r, g, b);
              if (frame == frameLast)
                break;
              let time2 = input.readFloat();
              let r2 = input.readUnsignedByte() / 255;
              let g2 = input.readUnsignedByte() / 255;
              let b2 = input.readUnsignedByte() / 255;
              switch (input.readByte()) {
                case CURVE_STEPPED:
                  timeline.setStepped(frame);
                  break;
                case CURVE_BEZIER:
                  setBezier(input, timeline, bezier++, frame, 0, time, time2, r, r2, 1);
                  setBezier(input, timeline, bezier++, frame, 1, time, time2, g, g2, 1);
                  setBezier(input, timeline, bezier++, frame, 2, time, time2, b, b2, 1);
              }
              time = time2;
              r = r2;
              g = g2;
              b = b2;
            }
            timelines.push(timeline);
            break;
          }
          case SLOT_RGBA2: {
            let bezierCount = input.readInt(true);
            let timeline = new RGBA2Timeline(frameCount, bezierCount, slotIndex);
            let time = input.readFloat();
            let r = input.readUnsignedByte() / 255;
            let g = input.readUnsignedByte() / 255;
            let b = input.readUnsignedByte() / 255;
            let a = input.readUnsignedByte() / 255;
            let r2 = input.readUnsignedByte() / 255;
            let g2 = input.readUnsignedByte() / 255;
            let b2 = input.readUnsignedByte() / 255;
            for (let frame = 0, bezier = 0;; frame++) {
              timeline.setFrame(frame, time, r, g, b, a, r2, g2, b2);
              if (frame == frameLast)
                break;
              let time2 = input.readFloat();
              let nr = input.readUnsignedByte() / 255;
              let ng = input.readUnsignedByte() / 255;
              let nb = input.readUnsignedByte() / 255;
              let na = input.readUnsignedByte() / 255;
              let nr2 = input.readUnsignedByte() / 255;
              let ng2 = input.readUnsignedByte() / 255;
              let nb2 = input.readUnsignedByte() / 255;
              switch (input.readByte()) {
                case CURVE_STEPPED:
                  timeline.setStepped(frame);
                  break;
                case CURVE_BEZIER:
                  setBezier(input, timeline, bezier++, frame, 0, time, time2, r, nr, 1);
                  setBezier(input, timeline, bezier++, frame, 1, time, time2, g, ng, 1);
                  setBezier(input, timeline, bezier++, frame, 2, time, time2, b, nb, 1);
                  setBezier(input, timeline, bezier++, frame, 3, time, time2, a, na, 1);
                  setBezier(input, timeline, bezier++, frame, 4, time, time2, r2, nr2, 1);
                  setBezier(input, timeline, bezier++, frame, 5, time, time2, g2, ng2, 1);
                  setBezier(input, timeline, bezier++, frame, 6, time, time2, b2, nb2, 1);
              }
              time = time2;
              r = nr;
              g = ng;
              b = nb;
              a = na;
              r2 = nr2;
              g2 = ng2;
              b2 = nb2;
            }
            timelines.push(timeline);
            break;
          }
          case SLOT_RGB2: {
            let bezierCount = input.readInt(true);
            let timeline = new RGB2Timeline(frameCount, bezierCount, slotIndex);
            let time = input.readFloat();
            let r = input.readUnsignedByte() / 255;
            let g = input.readUnsignedByte() / 255;
            let b = input.readUnsignedByte() / 255;
            let r2 = input.readUnsignedByte() / 255;
            let g2 = input.readUnsignedByte() / 255;
            let b2 = input.readUnsignedByte() / 255;
            for (let frame = 0, bezier = 0;; frame++) {
              timeline.setFrame(frame, time, r, g, b, r2, g2, b2);
              if (frame == frameLast)
                break;
              let time2 = input.readFloat();
              let nr = input.readUnsignedByte() / 255;
              let ng = input.readUnsignedByte() / 255;
              let nb = input.readUnsignedByte() / 255;
              let nr2 = input.readUnsignedByte() / 255;
              let ng2 = input.readUnsignedByte() / 255;
              let nb2 = input.readUnsignedByte() / 255;
              switch (input.readByte()) {
                case CURVE_STEPPED:
                  timeline.setStepped(frame);
                  break;
                case CURVE_BEZIER:
                  setBezier(input, timeline, bezier++, frame, 0, time, time2, r, nr, 1);
                  setBezier(input, timeline, bezier++, frame, 1, time, time2, g, ng, 1);
                  setBezier(input, timeline, bezier++, frame, 2, time, time2, b, nb, 1);
                  setBezier(input, timeline, bezier++, frame, 3, time, time2, r2, nr2, 1);
                  setBezier(input, timeline, bezier++, frame, 4, time, time2, g2, ng2, 1);
                  setBezier(input, timeline, bezier++, frame, 5, time, time2, b2, nb2, 1);
              }
              time = time2;
              r = nr;
              g = ng;
              b = nb;
              r2 = nr2;
              g2 = ng2;
              b2 = nb2;
            }
            timelines.push(timeline);
            break;
          }
          case SLOT_ALPHA: {
            let timeline = new AlphaTimeline(frameCount, input.readInt(true), slotIndex);
            let time = input.readFloat(), a = input.readUnsignedByte() / 255;
            for (let frame = 0, bezier = 0;; frame++) {
              timeline.setFrame(frame, time, a);
              if (frame == frameLast)
                break;
              let time2 = input.readFloat();
              let a2 = input.readUnsignedByte() / 255;
              switch (input.readByte()) {
                case CURVE_STEPPED:
                  timeline.setStepped(frame);
                  break;
                case CURVE_BEZIER:
                  setBezier(input, timeline, bezier++, frame, 0, time, time2, a, a2, 1);
              }
              time = time2;
              a = a2;
            }
            timelines.push(timeline);
          }
        }
      }
    }
    for (let i = 0, n = input.readInt(true);i < n; i++) {
      let boneIndex = input.readInt(true);
      for (let ii = 0, nn = input.readInt(true);ii < nn; ii++) {
        let type = input.readByte(), frameCount = input.readInt(true), bezierCount = input.readInt(true);
        switch (type) {
          case BONE_ROTATE:
            timelines.push(readTimeline1(input, new RotateTimeline(frameCount, bezierCount, boneIndex), 1));
            break;
          case BONE_TRANSLATE:
            timelines.push(readTimeline2(input, new TranslateTimeline(frameCount, bezierCount, boneIndex), scale));
            break;
          case BONE_TRANSLATEX:
            timelines.push(readTimeline1(input, new TranslateXTimeline(frameCount, bezierCount, boneIndex), scale));
            break;
          case BONE_TRANSLATEY:
            timelines.push(readTimeline1(input, new TranslateYTimeline(frameCount, bezierCount, boneIndex), scale));
            break;
          case BONE_SCALE:
            timelines.push(readTimeline2(input, new ScaleTimeline(frameCount, bezierCount, boneIndex), 1));
            break;
          case BONE_SCALEX:
            timelines.push(readTimeline1(input, new ScaleXTimeline(frameCount, bezierCount, boneIndex), 1));
            break;
          case BONE_SCALEY:
            timelines.push(readTimeline1(input, new ScaleYTimeline(frameCount, bezierCount, boneIndex), 1));
            break;
          case BONE_SHEAR:
            timelines.push(readTimeline2(input, new ShearTimeline(frameCount, bezierCount, boneIndex), 1));
            break;
          case BONE_SHEARX:
            timelines.push(readTimeline1(input, new ShearXTimeline(frameCount, bezierCount, boneIndex), 1));
            break;
          case BONE_SHEARY:
            timelines.push(readTimeline1(input, new ShearYTimeline(frameCount, bezierCount, boneIndex), 1));
        }
      }
    }
    for (let i = 0, n = input.readInt(true);i < n; i++) {
      let index = input.readInt(true), frameCount = input.readInt(true), frameLast = frameCount - 1;
      let timeline = new IkConstraintTimeline(frameCount, input.readInt(true), index);
      let time = input.readFloat(), mix = input.readFloat(), softness = input.readFloat() * scale;
      for (let frame = 0, bezier = 0;; frame++) {
        timeline.setFrame(frame, time, mix, softness, input.readByte(), input.readBoolean(), input.readBoolean());
        if (frame == frameLast)
          break;
        let time2 = input.readFloat(), mix2 = input.readFloat(), softness2 = input.readFloat() * scale;
        switch (input.readByte()) {
          case CURVE_STEPPED:
            timeline.setStepped(frame);
            break;
          case CURVE_BEZIER:
            setBezier(input, timeline, bezier++, frame, 0, time, time2, mix, mix2, 1);
            setBezier(input, timeline, bezier++, frame, 1, time, time2, softness, softness2, scale);
        }
        time = time2;
        mix = mix2;
        softness = softness2;
      }
      timelines.push(timeline);
    }
    for (let i = 0, n = input.readInt(true);i < n; i++) {
      let index = input.readInt(true), frameCount = input.readInt(true), frameLast = frameCount - 1;
      let timeline = new TransformConstraintTimeline(frameCount, input.readInt(true), index);
      let time = input.readFloat(), mixRotate = input.readFloat(), mixX = input.readFloat(), mixY = input.readFloat(), mixScaleX = input.readFloat(), mixScaleY = input.readFloat(), mixShearY = input.readFloat();
      for (let frame = 0, bezier = 0;; frame++) {
        timeline.setFrame(frame, time, mixRotate, mixX, mixY, mixScaleX, mixScaleY, mixShearY);
        if (frame == frameLast)
          break;
        let time2 = input.readFloat(), mixRotate2 = input.readFloat(), mixX2 = input.readFloat(), mixY2 = input.readFloat(), mixScaleX2 = input.readFloat(), mixScaleY2 = input.readFloat(), mixShearY2 = input.readFloat();
        switch (input.readByte()) {
          case CURVE_STEPPED:
            timeline.setStepped(frame);
            break;
          case CURVE_BEZIER:
            setBezier(input, timeline, bezier++, frame, 0, time, time2, mixRotate, mixRotate2, 1);
            setBezier(input, timeline, bezier++, frame, 1, time, time2, mixX, mixX2, 1);
            setBezier(input, timeline, bezier++, frame, 2, time, time2, mixY, mixY2, 1);
            setBezier(input, timeline, bezier++, frame, 3, time, time2, mixScaleX, mixScaleX2, 1);
            setBezier(input, timeline, bezier++, frame, 4, time, time2, mixScaleY, mixScaleY2, 1);
            setBezier(input, timeline, bezier++, frame, 5, time, time2, mixShearY, mixShearY2, 1);
        }
        time = time2;
        mixRotate = mixRotate2;
        mixX = mixX2;
        mixY = mixY2;
        mixScaleX = mixScaleX2;
        mixScaleY = mixScaleY2;
        mixShearY = mixShearY2;
      }
      timelines.push(timeline);
    }
    for (let i = 0, n = input.readInt(true);i < n; i++) {
      let index = input.readInt(true);
      let data = skeletonData.pathConstraints[index];
      for (let ii = 0, nn = input.readInt(true);ii < nn; ii++) {
        switch (input.readByte()) {
          case PATH_POSITION:
            timelines.push(readTimeline1(input, new PathConstraintPositionTimeline(input.readInt(true), input.readInt(true), index), data.positionMode == PositionMode.Fixed ? scale : 1));
            break;
          case PATH_SPACING:
            timelines.push(readTimeline1(input, new PathConstraintSpacingTimeline(input.readInt(true), input.readInt(true), index), data.spacingMode == SpacingMode.Length || data.spacingMode == SpacingMode.Fixed ? scale : 1));
            break;
          case PATH_MIX:
            let timeline = new PathConstraintMixTimeline(input.readInt(true), input.readInt(true), index);
            let time = input.readFloat(), mixRotate = input.readFloat(), mixX = input.readFloat(), mixY = input.readFloat();
            for (let frame = 0, bezier = 0, frameLast = timeline.getFrameCount() - 1;; frame++) {
              timeline.setFrame(frame, time, mixRotate, mixX, mixY);
              if (frame == frameLast)
                break;
              let time2 = input.readFloat(), mixRotate2 = input.readFloat(), mixX2 = input.readFloat(), mixY2 = input.readFloat();
              switch (input.readByte()) {
                case CURVE_STEPPED:
                  timeline.setStepped(frame);
                  break;
                case CURVE_BEZIER:
                  setBezier(input, timeline, bezier++, frame, 0, time, time2, mixRotate, mixRotate2, 1);
                  setBezier(input, timeline, bezier++, frame, 1, time, time2, mixX, mixX2, 1);
                  setBezier(input, timeline, bezier++, frame, 2, time, time2, mixY, mixY2, 1);
              }
              time = time2;
              mixRotate = mixRotate2;
              mixX = mixX2;
              mixY = mixY2;
            }
            timelines.push(timeline);
        }
      }
    }
    for (let i = 0, n = input.readInt(true);i < n; i++) {
      let skin = skeletonData.skins[input.readInt(true)];
      for (let ii = 0, nn = input.readInt(true);ii < nn; ii++) {
        let slotIndex = input.readInt(true);
        for (let iii = 0, nnn = input.readInt(true);iii < nnn; iii++) {
          let attachmentName = input.readStringRef();
          if (!attachmentName)
            throw new Error("attachmentName must not be null.");
          let attachment = skin.getAttachment(slotIndex, attachmentName);
          let timelineType = input.readByte();
          let frameCount = input.readInt(true);
          let frameLast = frameCount - 1;
          switch (timelineType) {
            case ATTACHMENT_DEFORM: {
              let vertexAttachment = attachment;
              let weighted = vertexAttachment.bones;
              let vertices = vertexAttachment.vertices;
              let deformLength = weighted ? vertices.length / 3 * 2 : vertices.length;
              let bezierCount = input.readInt(true);
              let timeline = new DeformTimeline(frameCount, bezierCount, slotIndex, vertexAttachment);
              let time = input.readFloat();
              for (let frame = 0, bezier = 0;; frame++) {
                let deform;
                let end = input.readInt(true);
                if (end == 0)
                  deform = weighted ? Utils.newFloatArray(deformLength) : vertices;
                else {
                  deform = Utils.newFloatArray(deformLength);
                  let start = input.readInt(true);
                  end += start;
                  if (scale == 1) {
                    for (let v = start;v < end; v++)
                      deform[v] = input.readFloat();
                  } else {
                    for (let v = start;v < end; v++)
                      deform[v] = input.readFloat() * scale;
                  }
                  if (!weighted) {
                    for (let v = 0, vn = deform.length;v < vn; v++)
                      deform[v] += vertices[v];
                  }
                }
                timeline.setFrame(frame, time, deform);
                if (frame == frameLast)
                  break;
                let time2 = input.readFloat();
                switch (input.readByte()) {
                  case CURVE_STEPPED:
                    timeline.setStepped(frame);
                    break;
                  case CURVE_BEZIER:
                    setBezier(input, timeline, bezier++, frame, 0, time, time2, 0, 1, 1);
                }
                time = time2;
              }
              timelines.push(timeline);
              break;
            }
            case ATTACHMENT_SEQUENCE: {
              let timeline = new SequenceTimeline(frameCount, slotIndex, attachment);
              for (let frame = 0;frame < frameCount; frame++) {
                let time = input.readFloat();
                let modeAndIndex = input.readInt32();
                timeline.setFrame(frame, time, SequenceModeValues[modeAndIndex & 15], modeAndIndex >> 4, input.readFloat());
              }
              timelines.push(timeline);
              break;
            }
          }
        }
      }
    }
    let drawOrderCount = input.readInt(true);
    if (drawOrderCount > 0) {
      let timeline = new DrawOrderTimeline(drawOrderCount);
      let slotCount = skeletonData.slots.length;
      for (let i = 0;i < drawOrderCount; i++) {
        let time = input.readFloat();
        let offsetCount = input.readInt(true);
        let drawOrder = Utils.newArray(slotCount, 0);
        for (let ii = slotCount - 1;ii >= 0; ii--)
          drawOrder[ii] = -1;
        let unchanged = Utils.newArray(slotCount - offsetCount, 0);
        let originalIndex = 0, unchangedIndex = 0;
        for (let ii = 0;ii < offsetCount; ii++) {
          let slotIndex = input.readInt(true);
          while (originalIndex != slotIndex)
            unchanged[unchangedIndex++] = originalIndex++;
          drawOrder[originalIndex + input.readInt(true)] = originalIndex++;
        }
        while (originalIndex < slotCount)
          unchanged[unchangedIndex++] = originalIndex++;
        for (let ii = slotCount - 1;ii >= 0; ii--)
          if (drawOrder[ii] == -1)
            drawOrder[ii] = unchanged[--unchangedIndex];
        timeline.setFrame(i, time, drawOrder);
      }
      timelines.push(timeline);
    }
    let eventCount = input.readInt(true);
    if (eventCount > 0) {
      let timeline = new EventTimeline(eventCount);
      for (let i = 0;i < eventCount; i++) {
        let time = input.readFloat();
        let eventData = skeletonData.events[input.readInt(true)];
        let event = new Event(time, eventData);
        event.intValue = input.readInt(false);
        event.floatValue = input.readFloat();
        event.stringValue = input.readBoolean() ? input.readString() : eventData.stringValue;
        if (event.data.audioPath) {
          event.volume = input.readFloat();
          event.balance = input.readFloat();
        }
        timeline.setFrame(i, event);
      }
      timelines.push(timeline);
    }
    let duration = 0;
    for (let i = 0, n = timelines.length;i < n; i++)
      duration = Math.max(duration, timelines[i].getDuration());
    return new Animation(name, timelines, duration);
  }
}

class BinaryInput {
  strings;
  index;
  buffer;
  constructor(data, strings = new Array, index = 0, buffer = new DataView(data.buffer)) {
    this.strings = strings;
    this.index = index;
    this.buffer = buffer;
  }
  readByte() {
    return this.buffer.getInt8(this.index++);
  }
  readUnsignedByte() {
    return this.buffer.getUint8(this.index++);
  }
  readShort() {
    let value = this.buffer.getInt16(this.index);
    this.index += 2;
    return value;
  }
  readInt32() {
    let value = this.buffer.getInt32(this.index);
    this.index += 4;
    return value;
  }
  readInt(optimizePositive) {
    let b = this.readByte();
    let result = b & 127;
    if ((b & 128) != 0) {
      b = this.readByte();
      result |= (b & 127) << 7;
      if ((b & 128) != 0) {
        b = this.readByte();
        result |= (b & 127) << 14;
        if ((b & 128) != 0) {
          b = this.readByte();
          result |= (b & 127) << 21;
          if ((b & 128) != 0) {
            b = this.readByte();
            result |= (b & 127) << 28;
          }
        }
      }
    }
    return optimizePositive ? result : result >>> 1 ^ -(result & 1);
  }
  readStringRef() {
    let index = this.readInt(true);
    return index == 0 ? null : this.strings[index - 1];
  }
  readString() {
    let byteCount = this.readInt(true);
    switch (byteCount) {
      case 0:
        return null;
      case 1:
        return "";
    }
    byteCount--;
    let chars = "";
    let charCount = 0;
    for (let i = 0;i < byteCount; ) {
      let b = this.readUnsignedByte();
      switch (b >> 4) {
        case 12:
        case 13:
          chars += String.fromCharCode((b & 31) << 6 | this.readByte() & 63);
          i += 2;
          break;
        case 14:
          chars += String.fromCharCode((b & 15) << 12 | (this.readByte() & 63) << 6 | this.readByte() & 63);
          i += 3;
          break;
        default:
          chars += String.fromCharCode(b);
          i++;
      }
    }
    return chars;
  }
  readFloat() {
    let value = this.buffer.getFloat32(this.index);
    this.index += 4;
    return value;
  }
  readBoolean() {
    return this.readByte() != 0;
  }
}

class LinkedMesh {
  parent;
  skin;
  slotIndex;
  mesh;
  inheritTimeline;
  constructor(mesh, skin, slotIndex, parent, inheritDeform) {
    this.mesh = mesh;
    this.skin = skin;
    this.slotIndex = slotIndex;
    this.parent = parent;
    this.inheritTimeline = inheritDeform;
  }
}

class Vertices {
  bones;
  vertices;
  constructor(bones = null, vertices = null) {
    this.bones = bones;
    this.vertices = vertices;
  }
}
var AttachmentType;
(function(AttachmentType) {
  AttachmentType[AttachmentType["Region"] = 0] = "Region";
  AttachmentType[AttachmentType["BoundingBox"] = 1] = "BoundingBox";
  AttachmentType[AttachmentType["Mesh"] = 2] = "Mesh";
  AttachmentType[AttachmentType["LinkedMesh"] = 3] = "LinkedMesh";
  AttachmentType[AttachmentType["Path"] = 4] = "Path";
  AttachmentType[AttachmentType["Point"] = 5] = "Point";
  AttachmentType[AttachmentType["Clipping"] = 6] = "Clipping";
})(AttachmentType || (AttachmentType = {}));
function readTimeline1(input, timeline, scale) {
  let time = input.readFloat(), value = input.readFloat() * scale;
  for (let frame = 0, bezier = 0, frameLast = timeline.getFrameCount() - 1;; frame++) {
    timeline.setFrame(frame, time, value);
    if (frame == frameLast)
      break;
    let time2 = input.readFloat(), value2 = input.readFloat() * scale;
    switch (input.readByte()) {
      case CURVE_STEPPED:
        timeline.setStepped(frame);
        break;
      case CURVE_BEZIER:
        setBezier(input, timeline, bezier++, frame, 0, time, time2, value, value2, scale);
    }
    time = time2;
    value = value2;
  }
  return timeline;
}
function readTimeline2(input, timeline, scale) {
  let time = input.readFloat(), value1 = input.readFloat() * scale, value2 = input.readFloat() * scale;
  for (let frame = 0, bezier = 0, frameLast = timeline.getFrameCount() - 1;; frame++) {
    timeline.setFrame(frame, time, value1, value2);
    if (frame == frameLast)
      break;
    let time2 = input.readFloat(), nvalue1 = input.readFloat() * scale, nvalue2 = input.readFloat() * scale;
    switch (input.readByte()) {
      case CURVE_STEPPED:
        timeline.setStepped(frame);
        break;
      case CURVE_BEZIER:
        setBezier(input, timeline, bezier++, frame, 0, time, time2, value1, nvalue1, scale);
        setBezier(input, timeline, bezier++, frame, 1, time, time2, value2, nvalue2, scale);
    }
    time = time2;
    value1 = nvalue1;
    value2 = nvalue2;
  }
  return timeline;
}
function setBezier(input, timeline, bezier, frame, value, time1, time2, value1, value2, scale) {
  timeline.setBezier(bezier, frame, value, time1, value1, input.readFloat(), input.readFloat() * scale, input.readFloat(), input.readFloat() * scale, time2, value2);
}
var BONE_ROTATE = 0;
var BONE_TRANSLATE = 1;
var BONE_TRANSLATEX = 2;
var BONE_TRANSLATEY = 3;
var BONE_SCALE = 4;
var BONE_SCALEX = 5;
var BONE_SCALEY = 6;
var BONE_SHEAR = 7;
var BONE_SHEARX = 8;
var BONE_SHEARY = 9;
var SLOT_ATTACHMENT = 0;
var SLOT_RGBA = 1;
var SLOT_RGB = 2;
var SLOT_RGBA2 = 3;
var SLOT_RGB2 = 4;
var SLOT_ALPHA = 5;
var ATTACHMENT_DEFORM = 0;
var ATTACHMENT_SEQUENCE = 1;
var PATH_POSITION = 0;
var PATH_SPACING = 1;
var PATH_MIX = 2;
var CURVE_STEPPED = 1;
var CURVE_BEZIER = 2;
// node_modules/@esotericsoftware/spine-core/dist/SkeletonBounds.js
class SkeletonBounds {
  minX = 0;
  minY = 0;
  maxX = 0;
  maxY = 0;
  boundingBoxes = new Array;
  polygons = new Array;
  polygonPool = new Pool(() => {
    return Utils.newFloatArray(16);
  });
  update(skeleton, updateAabb) {
    if (!skeleton)
      throw new Error("skeleton cannot be null.");
    let boundingBoxes = this.boundingBoxes;
    let polygons = this.polygons;
    let polygonPool = this.polygonPool;
    let slots = skeleton.slots;
    let slotCount = slots.length;
    boundingBoxes.length = 0;
    polygonPool.freeAll(polygons);
    polygons.length = 0;
    for (let i = 0;i < slotCount; i++) {
      let slot = slots[i];
      if (!slot.bone.active)
        continue;
      let attachment = slot.getAttachment();
      if (attachment instanceof BoundingBoxAttachment) {
        let boundingBox = attachment;
        boundingBoxes.push(boundingBox);
        let polygon = polygonPool.obtain();
        if (polygon.length != boundingBox.worldVerticesLength) {
          polygon = Utils.newFloatArray(boundingBox.worldVerticesLength);
        }
        polygons.push(polygon);
        boundingBox.computeWorldVertices(slot, 0, boundingBox.worldVerticesLength, polygon, 0, 2);
      }
    }
    if (updateAabb) {
      this.aabbCompute();
    } else {
      this.minX = Number.POSITIVE_INFINITY;
      this.minY = Number.POSITIVE_INFINITY;
      this.maxX = Number.NEGATIVE_INFINITY;
      this.maxY = Number.NEGATIVE_INFINITY;
    }
  }
  aabbCompute() {
    let { POSITIVE_INFINITY: minX, POSITIVE_INFINITY: minY, NEGATIVE_INFINITY: maxX, NEGATIVE_INFINITY: maxY } = Number;
    let polygons = this.polygons;
    for (let i = 0, n = polygons.length;i < n; i++) {
      let polygon = polygons[i];
      let vertices = polygon;
      for (let ii = 0, nn = polygon.length;ii < nn; ii += 2) {
        let x = vertices[ii];
        let y = vertices[ii + 1];
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
    this.minX = minX;
    this.minY = minY;
    this.maxX = maxX;
    this.maxY = maxY;
  }
  aabbContainsPoint(x, y) {
    return x >= this.minX && x <= this.maxX && y >= this.minY && y <= this.maxY;
  }
  aabbIntersectsSegment(x1, y1, x2, y2) {
    let minX = this.minX;
    let minY = this.minY;
    let maxX = this.maxX;
    let maxY = this.maxY;
    if (x1 <= minX && x2 <= minX || y1 <= minY && y2 <= minY || x1 >= maxX && x2 >= maxX || y1 >= maxY && y2 >= maxY)
      return false;
    let m = (y2 - y1) / (x2 - x1);
    let y = m * (minX - x1) + y1;
    if (y > minY && y < maxY)
      return true;
    y = m * (maxX - x1) + y1;
    if (y > minY && y < maxY)
      return true;
    let x = (minY - y1) / m + x1;
    if (x > minX && x < maxX)
      return true;
    x = (maxY - y1) / m + x1;
    if (x > minX && x < maxX)
      return true;
    return false;
  }
  aabbIntersectsSkeleton(bounds) {
    return this.minX < bounds.maxX && this.maxX > bounds.minX && this.minY < bounds.maxY && this.maxY > bounds.minY;
  }
  containsPoint(x, y) {
    let polygons = this.polygons;
    for (let i = 0, n = polygons.length;i < n; i++)
      if (this.containsPointPolygon(polygons[i], x, y))
        return this.boundingBoxes[i];
    return null;
  }
  containsPointPolygon(polygon, x, y) {
    let vertices = polygon;
    let nn = polygon.length;
    let prevIndex = nn - 2;
    let inside = false;
    for (let ii = 0;ii < nn; ii += 2) {
      let vertexY = vertices[ii + 1];
      let prevY = vertices[prevIndex + 1];
      if (vertexY < y && prevY >= y || prevY < y && vertexY >= y) {
        let vertexX = vertices[ii];
        if (vertexX + (y - vertexY) / (prevY - vertexY) * (vertices[prevIndex] - vertexX) < x)
          inside = !inside;
      }
      prevIndex = ii;
    }
    return inside;
  }
  intersectsSegment(x1, y1, x2, y2) {
    let polygons = this.polygons;
    for (let i = 0, n = polygons.length;i < n; i++)
      if (this.intersectsSegmentPolygon(polygons[i], x1, y1, x2, y2))
        return this.boundingBoxes[i];
    return null;
  }
  intersectsSegmentPolygon(polygon, x1, y1, x2, y2) {
    let vertices = polygon;
    let nn = polygon.length;
    let width12 = x1 - x2, height12 = y1 - y2;
    let det1 = x1 * y2 - y1 * x2;
    let x3 = vertices[nn - 2], y3 = vertices[nn - 1];
    for (let ii = 0;ii < nn; ii += 2) {
      let x4 = vertices[ii], y4 = vertices[ii + 1];
      let det2 = x3 * y4 - y3 * x4;
      let width34 = x3 - x4, height34 = y3 - y4;
      let det3 = width12 * height34 - height12 * width34;
      let x = (det1 * width34 - width12 * det2) / det3;
      if ((x >= x3 && x <= x4 || x >= x4 && x <= x3) && (x >= x1 && x <= x2 || x >= x2 && x <= x1)) {
        let y = (det1 * height34 - height12 * det2) / det3;
        if ((y >= y3 && y <= y4 || y >= y4 && y <= y3) && (y >= y1 && y <= y2 || y >= y2 && y <= y1))
          return true;
      }
      x3 = x4;
      y3 = y4;
    }
    return false;
  }
  getPolygon(boundingBox) {
    if (!boundingBox)
      throw new Error("boundingBox cannot be null.");
    let index = this.boundingBoxes.indexOf(boundingBox);
    return index == -1 ? null : this.polygons[index];
  }
  getWidth() {
    return this.maxX - this.minX;
  }
  getHeight() {
    return this.maxY - this.minY;
  }
}
// node_modules/@esotericsoftware/spine-core/dist/Triangulator.js
class Triangulator {
  convexPolygons = new Array;
  convexPolygonsIndices = new Array;
  indicesArray = new Array;
  isConcaveArray = new Array;
  triangles = new Array;
  polygonPool = new Pool(() => {
    return new Array;
  });
  polygonIndicesPool = new Pool(() => {
    return new Array;
  });
  triangulate(verticesArray) {
    let vertices = verticesArray;
    let vertexCount = verticesArray.length >> 1;
    let indices = this.indicesArray;
    indices.length = 0;
    for (let i = 0;i < vertexCount; i++)
      indices[i] = i;
    let isConcave = this.isConcaveArray;
    isConcave.length = 0;
    for (let i = 0, n = vertexCount;i < n; ++i)
      isConcave[i] = Triangulator.isConcave(i, vertexCount, vertices, indices);
    let triangles = this.triangles;
    triangles.length = 0;
    while (vertexCount > 3) {
      let previous = vertexCount - 1, i = 0, next = 1;
      while (true) {
        outer:
          if (!isConcave[i]) {
            let p1 = indices[previous] << 1, p2 = indices[i] << 1, p3 = indices[next] << 1;
            let p1x = vertices[p1], p1y = vertices[p1 + 1];
            let p2x = vertices[p2], p2y = vertices[p2 + 1];
            let p3x = vertices[p3], p3y = vertices[p3 + 1];
            for (let ii = (next + 1) % vertexCount;ii != previous; ii = (ii + 1) % vertexCount) {
              if (!isConcave[ii])
                continue;
              let v = indices[ii] << 1;
              let vx = vertices[v], vy = vertices[v + 1];
              if (Triangulator.positiveArea(p3x, p3y, p1x, p1y, vx, vy)) {
                if (Triangulator.positiveArea(p1x, p1y, p2x, p2y, vx, vy)) {
                  if (Triangulator.positiveArea(p2x, p2y, p3x, p3y, vx, vy))
                    break outer;
                }
              }
            }
            break;
          }
        if (next == 0) {
          do {
            if (!isConcave[i])
              break;
            i--;
          } while (i > 0);
          break;
        }
        previous = i;
        i = next;
        next = (next + 1) % vertexCount;
      }
      triangles.push(indices[(vertexCount + i - 1) % vertexCount]);
      triangles.push(indices[i]);
      triangles.push(indices[(i + 1) % vertexCount]);
      indices.splice(i, 1);
      isConcave.splice(i, 1);
      vertexCount--;
      let previousIndex = (vertexCount + i - 1) % vertexCount;
      let nextIndex = i == vertexCount ? 0 : i;
      isConcave[previousIndex] = Triangulator.isConcave(previousIndex, vertexCount, vertices, indices);
      isConcave[nextIndex] = Triangulator.isConcave(nextIndex, vertexCount, vertices, indices);
    }
    if (vertexCount == 3) {
      triangles.push(indices[2]);
      triangles.push(indices[0]);
      triangles.push(indices[1]);
    }
    return triangles;
  }
  decompose(verticesArray, triangles) {
    let vertices = verticesArray;
    let convexPolygons = this.convexPolygons;
    this.polygonPool.freeAll(convexPolygons);
    convexPolygons.length = 0;
    let convexPolygonsIndices = this.convexPolygonsIndices;
    this.polygonIndicesPool.freeAll(convexPolygonsIndices);
    convexPolygonsIndices.length = 0;
    let polygonIndices = this.polygonIndicesPool.obtain();
    polygonIndices.length = 0;
    let polygon = this.polygonPool.obtain();
    polygon.length = 0;
    let fanBaseIndex = -1, lastWinding = 0;
    for (let i = 0, n = triangles.length;i < n; i += 3) {
      let t1 = triangles[i] << 1, t2 = triangles[i + 1] << 1, t3 = triangles[i + 2] << 1;
      let x1 = vertices[t1], y1 = vertices[t1 + 1];
      let x2 = vertices[t2], y2 = vertices[t2 + 1];
      let x3 = vertices[t3], y3 = vertices[t3 + 1];
      let merged = false;
      if (fanBaseIndex == t1) {
        let o = polygon.length - 4;
        let winding1 = Triangulator.winding(polygon[o], polygon[o + 1], polygon[o + 2], polygon[o + 3], x3, y3);
        let winding2 = Triangulator.winding(x3, y3, polygon[0], polygon[1], polygon[2], polygon[3]);
        if (winding1 == lastWinding && winding2 == lastWinding) {
          polygon.push(x3);
          polygon.push(y3);
          polygonIndices.push(t3);
          merged = true;
        }
      }
      if (!merged) {
        if (polygon.length > 0) {
          convexPolygons.push(polygon);
          convexPolygonsIndices.push(polygonIndices);
        } else {
          this.polygonPool.free(polygon);
          this.polygonIndicesPool.free(polygonIndices);
        }
        polygon = this.polygonPool.obtain();
        polygon.length = 0;
        polygon.push(x1);
        polygon.push(y1);
        polygon.push(x2);
        polygon.push(y2);
        polygon.push(x3);
        polygon.push(y3);
        polygonIndices = this.polygonIndicesPool.obtain();
        polygonIndices.length = 0;
        polygonIndices.push(t1);
        polygonIndices.push(t2);
        polygonIndices.push(t3);
        lastWinding = Triangulator.winding(x1, y1, x2, y2, x3, y3);
        fanBaseIndex = t1;
      }
    }
    if (polygon.length > 0) {
      convexPolygons.push(polygon);
      convexPolygonsIndices.push(polygonIndices);
    }
    for (let i = 0, n = convexPolygons.length;i < n; i++) {
      polygonIndices = convexPolygonsIndices[i];
      if (polygonIndices.length == 0)
        continue;
      let firstIndex = polygonIndices[0];
      let lastIndex = polygonIndices[polygonIndices.length - 1];
      polygon = convexPolygons[i];
      let o = polygon.length - 4;
      let prevPrevX = polygon[o], prevPrevY = polygon[o + 1];
      let prevX = polygon[o + 2], prevY = polygon[o + 3];
      let firstX = polygon[0], firstY = polygon[1];
      let secondX = polygon[2], secondY = polygon[3];
      let winding = Triangulator.winding(prevPrevX, prevPrevY, prevX, prevY, firstX, firstY);
      for (let ii = 0;ii < n; ii++) {
        if (ii == i)
          continue;
        let otherIndices = convexPolygonsIndices[ii];
        if (otherIndices.length != 3)
          continue;
        let otherFirstIndex = otherIndices[0];
        let otherSecondIndex = otherIndices[1];
        let otherLastIndex = otherIndices[2];
        let otherPoly = convexPolygons[ii];
        let x3 = otherPoly[otherPoly.length - 2], y3 = otherPoly[otherPoly.length - 1];
        if (otherFirstIndex != firstIndex || otherSecondIndex != lastIndex)
          continue;
        let winding1 = Triangulator.winding(prevPrevX, prevPrevY, prevX, prevY, x3, y3);
        let winding2 = Triangulator.winding(x3, y3, firstX, firstY, secondX, secondY);
        if (winding1 == winding && winding2 == winding) {
          otherPoly.length = 0;
          otherIndices.length = 0;
          polygon.push(x3);
          polygon.push(y3);
          polygonIndices.push(otherLastIndex);
          prevPrevX = prevX;
          prevPrevY = prevY;
          prevX = x3;
          prevY = y3;
          ii = 0;
        }
      }
    }
    for (let i = convexPolygons.length - 1;i >= 0; i--) {
      polygon = convexPolygons[i];
      if (polygon.length == 0) {
        convexPolygons.splice(i, 1);
        this.polygonPool.free(polygon);
        polygonIndices = convexPolygonsIndices[i];
        convexPolygonsIndices.splice(i, 1);
        this.polygonIndicesPool.free(polygonIndices);
      }
    }
    return convexPolygons;
  }
  static isConcave(index, vertexCount, vertices, indices) {
    let previous = indices[(vertexCount + index - 1) % vertexCount] << 1;
    let current = indices[index] << 1;
    let next = indices[(index + 1) % vertexCount] << 1;
    return !this.positiveArea(vertices[previous], vertices[previous + 1], vertices[current], vertices[current + 1], vertices[next], vertices[next + 1]);
  }
  static positiveArea(p1x, p1y, p2x, p2y, p3x, p3y) {
    return p1x * (p3y - p2y) + p2x * (p1y - p3y) + p3x * (p2y - p1y) >= 0;
  }
  static winding(p1x, p1y, p2x, p2y, p3x, p3y) {
    let px = p2x - p1x, py = p2y - p1y;
    return p3x * py - p3y * px + px * p1y - p1x * py >= 0 ? 1 : -1;
  }
}

// node_modules/@esotericsoftware/spine-core/dist/SkeletonClipping.js
class SkeletonClipping {
  triangulator = new Triangulator;
  clippingPolygon = new Array;
  clipOutput = new Array;
  clippedVertices = new Array;
  clippedTriangles = new Array;
  scratch = new Array;
  clipAttachment = null;
  clippingPolygons = null;
  clipStart(slot, clip) {
    if (this.clipAttachment)
      return 0;
    this.clipAttachment = clip;
    let n = clip.worldVerticesLength;
    let vertices = Utils.setArraySize(this.clippingPolygon, n);
    clip.computeWorldVertices(slot, 0, n, vertices, 0, 2);
    let clippingPolygon = this.clippingPolygon;
    SkeletonClipping.makeClockwise(clippingPolygon);
    let clippingPolygons = this.clippingPolygons = this.triangulator.decompose(clippingPolygon, this.triangulator.triangulate(clippingPolygon));
    for (let i = 0, n = clippingPolygons.length;i < n; i++) {
      let polygon = clippingPolygons[i];
      SkeletonClipping.makeClockwise(polygon);
      polygon.push(polygon[0]);
      polygon.push(polygon[1]);
    }
    return clippingPolygons.length;
  }
  clipEndWithSlot(slot) {
    if (this.clipAttachment && this.clipAttachment.endSlot == slot.data)
      this.clipEnd();
  }
  clipEnd() {
    if (!this.clipAttachment)
      return;
    this.clipAttachment = null;
    this.clippingPolygons = null;
    this.clippedVertices.length = 0;
    this.clippedTriangles.length = 0;
    this.clippingPolygon.length = 0;
  }
  isClipping() {
    return this.clipAttachment != null;
  }
  clipTriangles(vertices, verticesLength, triangles, trianglesLength, uvs, light, dark, twoColor) {
    let clipOutput = this.clipOutput, clippedVertices = this.clippedVertices;
    let clippedTriangles = this.clippedTriangles;
    let polygons = this.clippingPolygons;
    let polygonsCount = polygons.length;
    let vertexSize = twoColor ? 12 : 8;
    let index = 0;
    clippedVertices.length = 0;
    clippedTriangles.length = 0;
    outer:
      for (let i = 0;i < trianglesLength; i += 3) {
        let vertexOffset = triangles[i] << 1;
        let x1 = vertices[vertexOffset], y1 = vertices[vertexOffset + 1];
        let u1 = uvs[vertexOffset], v1 = uvs[vertexOffset + 1];
        vertexOffset = triangles[i + 1] << 1;
        let x2 = vertices[vertexOffset], y2 = vertices[vertexOffset + 1];
        let u2 = uvs[vertexOffset], v2 = uvs[vertexOffset + 1];
        vertexOffset = triangles[i + 2] << 1;
        let x3 = vertices[vertexOffset], y3 = vertices[vertexOffset + 1];
        let u3 = uvs[vertexOffset], v3 = uvs[vertexOffset + 1];
        for (let p = 0;p < polygonsCount; p++) {
          let s = clippedVertices.length;
          if (this.clip(x1, y1, x2, y2, x3, y3, polygons[p], clipOutput)) {
            let clipOutputLength = clipOutput.length;
            if (clipOutputLength == 0)
              continue;
            let d0 = y2 - y3, d1 = x3 - x2, d2 = x1 - x3, d4 = y3 - y1;
            let d = 1 / (d0 * d2 + d1 * (y1 - y3));
            let clipOutputCount = clipOutputLength >> 1;
            let clipOutputItems = this.clipOutput;
            let clippedVerticesItems = Utils.setArraySize(clippedVertices, s + clipOutputCount * vertexSize);
            for (let ii = 0;ii < clipOutputLength; ii += 2) {
              let x = clipOutputItems[ii], y = clipOutputItems[ii + 1];
              clippedVerticesItems[s] = x;
              clippedVerticesItems[s + 1] = y;
              clippedVerticesItems[s + 2] = light.r;
              clippedVerticesItems[s + 3] = light.g;
              clippedVerticesItems[s + 4] = light.b;
              clippedVerticesItems[s + 5] = light.a;
              let c0 = x - x3, c1 = y - y3;
              let a = (d0 * c0 + d1 * c1) * d;
              let b = (d4 * c0 + d2 * c1) * d;
              let c = 1 - a - b;
              clippedVerticesItems[s + 6] = u1 * a + u2 * b + u3 * c;
              clippedVerticesItems[s + 7] = v1 * a + v2 * b + v3 * c;
              if (twoColor) {
                clippedVerticesItems[s + 8] = dark.r;
                clippedVerticesItems[s + 9] = dark.g;
                clippedVerticesItems[s + 10] = dark.b;
                clippedVerticesItems[s + 11] = dark.a;
              }
              s += vertexSize;
            }
            s = clippedTriangles.length;
            let clippedTrianglesItems = Utils.setArraySize(clippedTriangles, s + 3 * (clipOutputCount - 2));
            clipOutputCount--;
            for (let ii = 1;ii < clipOutputCount; ii++) {
              clippedTrianglesItems[s] = index;
              clippedTrianglesItems[s + 1] = index + ii;
              clippedTrianglesItems[s + 2] = index + ii + 1;
              s += 3;
            }
            index += clipOutputCount + 1;
          } else {
            let clippedVerticesItems = Utils.setArraySize(clippedVertices, s + 3 * vertexSize);
            clippedVerticesItems[s] = x1;
            clippedVerticesItems[s + 1] = y1;
            clippedVerticesItems[s + 2] = light.r;
            clippedVerticesItems[s + 3] = light.g;
            clippedVerticesItems[s + 4] = light.b;
            clippedVerticesItems[s + 5] = light.a;
            if (!twoColor) {
              clippedVerticesItems[s + 6] = u1;
              clippedVerticesItems[s + 7] = v1;
              clippedVerticesItems[s + 8] = x2;
              clippedVerticesItems[s + 9] = y2;
              clippedVerticesItems[s + 10] = light.r;
              clippedVerticesItems[s + 11] = light.g;
              clippedVerticesItems[s + 12] = light.b;
              clippedVerticesItems[s + 13] = light.a;
              clippedVerticesItems[s + 14] = u2;
              clippedVerticesItems[s + 15] = v2;
              clippedVerticesItems[s + 16] = x3;
              clippedVerticesItems[s + 17] = y3;
              clippedVerticesItems[s + 18] = light.r;
              clippedVerticesItems[s + 19] = light.g;
              clippedVerticesItems[s + 20] = light.b;
              clippedVerticesItems[s + 21] = light.a;
              clippedVerticesItems[s + 22] = u3;
              clippedVerticesItems[s + 23] = v3;
            } else {
              clippedVerticesItems[s + 6] = u1;
              clippedVerticesItems[s + 7] = v1;
              clippedVerticesItems[s + 8] = dark.r;
              clippedVerticesItems[s + 9] = dark.g;
              clippedVerticesItems[s + 10] = dark.b;
              clippedVerticesItems[s + 11] = dark.a;
              clippedVerticesItems[s + 12] = x2;
              clippedVerticesItems[s + 13] = y2;
              clippedVerticesItems[s + 14] = light.r;
              clippedVerticesItems[s + 15] = light.g;
              clippedVerticesItems[s + 16] = light.b;
              clippedVerticesItems[s + 17] = light.a;
              clippedVerticesItems[s + 18] = u2;
              clippedVerticesItems[s + 19] = v2;
              clippedVerticesItems[s + 20] = dark.r;
              clippedVerticesItems[s + 21] = dark.g;
              clippedVerticesItems[s + 22] = dark.b;
              clippedVerticesItems[s + 23] = dark.a;
              clippedVerticesItems[s + 24] = x3;
              clippedVerticesItems[s + 25] = y3;
              clippedVerticesItems[s + 26] = light.r;
              clippedVerticesItems[s + 27] = light.g;
              clippedVerticesItems[s + 28] = light.b;
              clippedVerticesItems[s + 29] = light.a;
              clippedVerticesItems[s + 30] = u3;
              clippedVerticesItems[s + 31] = v3;
              clippedVerticesItems[s + 32] = dark.r;
              clippedVerticesItems[s + 33] = dark.g;
              clippedVerticesItems[s + 34] = dark.b;
              clippedVerticesItems[s + 35] = dark.a;
            }
            s = clippedTriangles.length;
            let clippedTrianglesItems = Utils.setArraySize(clippedTriangles, s + 3);
            clippedTrianglesItems[s] = index;
            clippedTrianglesItems[s + 1] = index + 1;
            clippedTrianglesItems[s + 2] = index + 2;
            index += 3;
            continue outer;
          }
        }
      }
  }
  clip(x1, y1, x2, y2, x3, y3, clippingArea, output) {
    let originalOutput = output;
    let clipped = false;
    let input;
    if (clippingArea.length % 4 >= 2) {
      input = output;
      output = this.scratch;
    } else
      input = this.scratch;
    input.length = 0;
    input.push(x1);
    input.push(y1);
    input.push(x2);
    input.push(y2);
    input.push(x3);
    input.push(y3);
    input.push(x1);
    input.push(y1);
    output.length = 0;
    let clippingVertices = clippingArea;
    let clippingVerticesLast = clippingArea.length - 4;
    for (let i = 0;; i += 2) {
      let edgeX = clippingVertices[i], edgeY = clippingVertices[i + 1];
      let edgeX2 = clippingVertices[i + 2], edgeY2 = clippingVertices[i + 3];
      let deltaX = edgeX - edgeX2, deltaY = edgeY - edgeY2;
      let inputVertices = input;
      let inputVerticesLength = input.length - 2, outputStart = output.length;
      for (let ii = 0;ii < inputVerticesLength; ii += 2) {
        let inputX = inputVertices[ii], inputY = inputVertices[ii + 1];
        let inputX2 = inputVertices[ii + 2], inputY2 = inputVertices[ii + 3];
        let side2 = deltaX * (inputY2 - edgeY2) - deltaY * (inputX2 - edgeX2) > 0;
        if (deltaX * (inputY - edgeY2) - deltaY * (inputX - edgeX2) > 0) {
          if (side2) {
            output.push(inputX2);
            output.push(inputY2);
            continue;
          }
          let c0 = inputY2 - inputY, c2 = inputX2 - inputX;
          let s = c0 * (edgeX2 - edgeX) - c2 * (edgeY2 - edgeY);
          if (Math.abs(s) > 0.000001) {
            let ua = (c2 * (edgeY - inputY) - c0 * (edgeX - inputX)) / s;
            output.push(edgeX + (edgeX2 - edgeX) * ua);
            output.push(edgeY + (edgeY2 - edgeY) * ua);
          } else {
            output.push(edgeX);
            output.push(edgeY);
          }
        } else if (side2) {
          let c0 = inputY2 - inputY, c2 = inputX2 - inputX;
          let s = c0 * (edgeX2 - edgeX) - c2 * (edgeY2 - edgeY);
          if (Math.abs(s) > 0.000001) {
            let ua = (c2 * (edgeY - inputY) - c0 * (edgeX - inputX)) / s;
            output.push(edgeX + (edgeX2 - edgeX) * ua);
            output.push(edgeY + (edgeY2 - edgeY) * ua);
          } else {
            output.push(edgeX);
            output.push(edgeY);
          }
          output.push(inputX2);
          output.push(inputY2);
        }
        clipped = true;
      }
      if (outputStart == output.length) {
        originalOutput.length = 0;
        return true;
      }
      output.push(output[0]);
      output.push(output[1]);
      if (i == clippingVerticesLast)
        break;
      let temp = output;
      output = input;
      output.length = 0;
      input = temp;
    }
    if (originalOutput != output) {
      originalOutput.length = 0;
      for (let i = 0, n = output.length - 2;i < n; i++)
        originalOutput[i] = output[i];
    } else
      originalOutput.length = originalOutput.length - 2;
    return clipped;
  }
  static makeClockwise(polygon) {
    let vertices = polygon;
    let verticeslength = polygon.length;
    let area = vertices[verticeslength - 2] * vertices[1] - vertices[0] * vertices[verticeslength - 1], p1x = 0, p1y = 0, p2x = 0, p2y = 0;
    for (let i = 0, n = verticeslength - 3;i < n; i += 2) {
      p1x = vertices[i];
      p1y = vertices[i + 1];
      p2x = vertices[i + 2];
      p2y = vertices[i + 3];
      area += p1x * p2y - p2x * p1y;
    }
    if (area < 0)
      return;
    for (let i = 0, lastX = verticeslength - 2, n = verticeslength >> 1;i < n; i += 2) {
      let x = vertices[i], y = vertices[i + 1];
      let other = lastX - i;
      vertices[i] = vertices[other];
      vertices[i + 1] = vertices[other + 1];
      vertices[other] = x;
      vertices[other + 1] = y;
    }
  }
}
// node_modules/@esotericsoftware/spine-core/dist/SkeletonJson.js
class SkeletonJson {
  attachmentLoader;
  scale = 1;
  linkedMeshes = new Array;
  constructor(attachmentLoader) {
    this.attachmentLoader = attachmentLoader;
  }
  readSkeletonData(json) {
    let scale = this.scale;
    let skeletonData = new SkeletonData;
    let root = typeof json === "string" ? JSON.parse(json) : json;
    let skeletonMap = root.skeleton;
    if (skeletonMap) {
      skeletonData.hash = skeletonMap.hash;
      skeletonData.version = skeletonMap.spine;
      skeletonData.x = skeletonMap.x;
      skeletonData.y = skeletonMap.y;
      skeletonData.width = skeletonMap.width;
      skeletonData.height = skeletonMap.height;
      skeletonData.fps = skeletonMap.fps;
      skeletonData.imagesPath = skeletonMap.images;
    }
    if (root.bones) {
      for (let i = 0;i < root.bones.length; i++) {
        let boneMap = root.bones[i];
        let parent = null;
        let parentName = getValue(boneMap, "parent", null);
        if (parentName)
          parent = skeletonData.findBone(parentName);
        let data = new BoneData(skeletonData.bones.length, boneMap.name, parent);
        data.length = getValue(boneMap, "length", 0) * scale;
        data.x = getValue(boneMap, "x", 0) * scale;
        data.y = getValue(boneMap, "y", 0) * scale;
        data.rotation = getValue(boneMap, "rotation", 0);
        data.scaleX = getValue(boneMap, "scaleX", 1);
        data.scaleY = getValue(boneMap, "scaleY", 1);
        data.shearX = getValue(boneMap, "shearX", 0);
        data.shearY = getValue(boneMap, "shearY", 0);
        data.transformMode = Utils.enumValue(TransformMode, getValue(boneMap, "transform", "Normal"));
        data.skinRequired = getValue(boneMap, "skin", false);
        let color = getValue(boneMap, "color", null);
        if (color)
          data.color.setFromString(color);
        skeletonData.bones.push(data);
      }
    }
    if (root.slots) {
      for (let i = 0;i < root.slots.length; i++) {
        let slotMap = root.slots[i];
        let boneData = skeletonData.findBone(slotMap.bone);
        if (!boneData)
          throw new Error(`Couldn't find bone ${slotMap.bone} for slot ${slotMap.name}`);
        let data = new SlotData(skeletonData.slots.length, slotMap.name, boneData);
        let color = getValue(slotMap, "color", null);
        if (color)
          data.color.setFromString(color);
        let dark = getValue(slotMap, "dark", null);
        if (dark)
          data.darkColor = Color.fromString(dark);
        data.attachmentName = getValue(slotMap, "attachment", null);
        data.blendMode = Utils.enumValue(BlendMode, getValue(slotMap, "blend", "normal"));
        skeletonData.slots.push(data);
      }
    }
    if (root.ik) {
      for (let i = 0;i < root.ik.length; i++) {
        let constraintMap = root.ik[i];
        let data = new IkConstraintData(constraintMap.name);
        data.order = getValue(constraintMap, "order", 0);
        data.skinRequired = getValue(constraintMap, "skin", false);
        for (let ii = 0;ii < constraintMap.bones.length; ii++) {
          let bone = skeletonData.findBone(constraintMap.bones[ii]);
          if (!bone)
            throw new Error(`Couldn't find bone ${constraintMap.bones[ii]} for IK constraint ${constraintMap.name}.`);
          data.bones.push(bone);
        }
        let target = skeletonData.findBone(constraintMap.target);
        if (!target)
          throw new Error(`Couldn't find target bone ${constraintMap.target} for IK constraint ${constraintMap.name}.`);
        data.target = target;
        data.mix = getValue(constraintMap, "mix", 1);
        data.softness = getValue(constraintMap, "softness", 0) * scale;
        data.bendDirection = getValue(constraintMap, "bendPositive", true) ? 1 : -1;
        data.compress = getValue(constraintMap, "compress", false);
        data.stretch = getValue(constraintMap, "stretch", false);
        data.uniform = getValue(constraintMap, "uniform", false);
        skeletonData.ikConstraints.push(data);
      }
    }
    if (root.transform) {
      for (let i = 0;i < root.transform.length; i++) {
        let constraintMap = root.transform[i];
        let data = new TransformConstraintData(constraintMap.name);
        data.order = getValue(constraintMap, "order", 0);
        data.skinRequired = getValue(constraintMap, "skin", false);
        for (let ii = 0;ii < constraintMap.bones.length; ii++) {
          let boneName = constraintMap.bones[ii];
          let bone = skeletonData.findBone(boneName);
          if (!bone)
            throw new Error(`Couldn't find bone ${boneName} for transform constraint ${constraintMap.name}.`);
          data.bones.push(bone);
        }
        let targetName = constraintMap.target;
        let target = skeletonData.findBone(targetName);
        if (!target)
          throw new Error(`Couldn't find target bone ${targetName} for transform constraint ${constraintMap.name}.`);
        data.target = target;
        data.local = getValue(constraintMap, "local", false);
        data.relative = getValue(constraintMap, "relative", false);
        data.offsetRotation = getValue(constraintMap, "rotation", 0);
        data.offsetX = getValue(constraintMap, "x", 0) * scale;
        data.offsetY = getValue(constraintMap, "y", 0) * scale;
        data.offsetScaleX = getValue(constraintMap, "scaleX", 0);
        data.offsetScaleY = getValue(constraintMap, "scaleY", 0);
        data.offsetShearY = getValue(constraintMap, "shearY", 0);
        data.mixRotate = getValue(constraintMap, "mixRotate", 1);
        data.mixX = getValue(constraintMap, "mixX", 1);
        data.mixY = getValue(constraintMap, "mixY", data.mixX);
        data.mixScaleX = getValue(constraintMap, "mixScaleX", 1);
        data.mixScaleY = getValue(constraintMap, "mixScaleY", data.mixScaleX);
        data.mixShearY = getValue(constraintMap, "mixShearY", 1);
        skeletonData.transformConstraints.push(data);
      }
    }
    if (root.path) {
      for (let i = 0;i < root.path.length; i++) {
        let constraintMap = root.path[i];
        let data = new PathConstraintData(constraintMap.name);
        data.order = getValue(constraintMap, "order", 0);
        data.skinRequired = getValue(constraintMap, "skin", false);
        for (let ii = 0;ii < constraintMap.bones.length; ii++) {
          let boneName = constraintMap.bones[ii];
          let bone = skeletonData.findBone(boneName);
          if (!bone)
            throw new Error(`Couldn't find bone ${boneName} for path constraint ${constraintMap.name}.`);
          data.bones.push(bone);
        }
        let targetName = constraintMap.target;
        let target = skeletonData.findSlot(targetName);
        if (!target)
          throw new Error(`Couldn't find target slot ${targetName} for path constraint ${constraintMap.name}.`);
        data.target = target;
        data.positionMode = Utils.enumValue(PositionMode, getValue(constraintMap, "positionMode", "Percent"));
        data.spacingMode = Utils.enumValue(SpacingMode, getValue(constraintMap, "spacingMode", "Length"));
        data.rotateMode = Utils.enumValue(RotateMode, getValue(constraintMap, "rotateMode", "Tangent"));
        data.offsetRotation = getValue(constraintMap, "rotation", 0);
        data.position = getValue(constraintMap, "position", 0);
        if (data.positionMode == PositionMode.Fixed)
          data.position *= scale;
        data.spacing = getValue(constraintMap, "spacing", 0);
        if (data.spacingMode == SpacingMode.Length || data.spacingMode == SpacingMode.Fixed)
          data.spacing *= scale;
        data.mixRotate = getValue(constraintMap, "mixRotate", 1);
        data.mixX = getValue(constraintMap, "mixX", 1);
        data.mixY = getValue(constraintMap, "mixY", data.mixX);
        skeletonData.pathConstraints.push(data);
      }
    }
    if (root.skins) {
      for (let i = 0;i < root.skins.length; i++) {
        let skinMap = root.skins[i];
        let skin = new Skin(skinMap.name);
        if (skinMap.bones) {
          for (let ii = 0;ii < skinMap.bones.length; ii++) {
            let boneName = skinMap.bones[ii];
            let bone = skeletonData.findBone(boneName);
            if (!bone)
              throw new Error(`Couldn't find bone ${boneName} for skin ${skinMap.name}.`);
            skin.bones.push(bone);
          }
        }
        if (skinMap.ik) {
          for (let ii = 0;ii < skinMap.ik.length; ii++) {
            let constraintName = skinMap.ik[ii];
            let constraint = skeletonData.findIkConstraint(constraintName);
            if (!constraint)
              throw new Error(`Couldn't find IK constraint ${constraintName} for skin ${skinMap.name}.`);
            skin.constraints.push(constraint);
          }
        }
        if (skinMap.transform) {
          for (let ii = 0;ii < skinMap.transform.length; ii++) {
            let constraintName = skinMap.transform[ii];
            let constraint = skeletonData.findTransformConstraint(constraintName);
            if (!constraint)
              throw new Error(`Couldn't find transform constraint ${constraintName} for skin ${skinMap.name}.`);
            skin.constraints.push(constraint);
          }
        }
        if (skinMap.path) {
          for (let ii = 0;ii < skinMap.path.length; ii++) {
            let constraintName = skinMap.path[ii];
            let constraint = skeletonData.findPathConstraint(constraintName);
            if (!constraint)
              throw new Error(`Couldn't find path constraint ${constraintName} for skin ${skinMap.name}.`);
            skin.constraints.push(constraint);
          }
        }
        for (let slotName in skinMap.attachments) {
          let slot = skeletonData.findSlot(slotName);
          if (!slot)
            throw new Error(`Couldn't find slot ${slotName} for skin ${skinMap.name}.`);
          let slotMap = skinMap.attachments[slotName];
          for (let entryName in slotMap) {
            let attachment = this.readAttachment(slotMap[entryName], skin, slot.index, entryName, skeletonData);
            if (attachment)
              skin.setAttachment(slot.index, entryName, attachment);
          }
        }
        skeletonData.skins.push(skin);
        if (skin.name == "default")
          skeletonData.defaultSkin = skin;
      }
    }
    for (let i = 0, n = this.linkedMeshes.length;i < n; i++) {
      let linkedMesh = this.linkedMeshes[i];
      let skin = !linkedMesh.skin ? skeletonData.defaultSkin : skeletonData.findSkin(linkedMesh.skin);
      if (!skin)
        throw new Error(`Skin not found: ${linkedMesh.skin}`);
      let parent = skin.getAttachment(linkedMesh.slotIndex, linkedMesh.parent);
      if (!parent)
        throw new Error(`Parent mesh not found: ${linkedMesh.parent}`);
      linkedMesh.mesh.timelineAttachment = linkedMesh.inheritTimeline ? parent : linkedMesh.mesh;
      linkedMesh.mesh.setParentMesh(parent);
      if (linkedMesh.mesh.region != null)
        linkedMesh.mesh.updateRegion();
    }
    this.linkedMeshes.length = 0;
    if (root.events) {
      for (let eventName in root.events) {
        let eventMap = root.events[eventName];
        let data = new EventData(eventName);
        data.intValue = getValue(eventMap, "int", 0);
        data.floatValue = getValue(eventMap, "float", 0);
        data.stringValue = getValue(eventMap, "string", "");
        data.audioPath = getValue(eventMap, "audio", null);
        if (data.audioPath) {
          data.volume = getValue(eventMap, "volume", 1);
          data.balance = getValue(eventMap, "balance", 0);
        }
        skeletonData.events.push(data);
      }
    }
    if (root.animations) {
      for (let animationName in root.animations) {
        let animationMap = root.animations[animationName];
        this.readAnimation(animationMap, animationName, skeletonData);
      }
    }
    return skeletonData;
  }
  readAttachment(map, skin, slotIndex, name, skeletonData) {
    let scale = this.scale;
    name = getValue(map, "name", name);
    switch (getValue(map, "type", "region")) {
      case "region": {
        let path = getValue(map, "path", name);
        let sequence = this.readSequence(getValue(map, "sequence", null));
        let region = this.attachmentLoader.newRegionAttachment(skin, name, path, sequence);
        if (!region)
          return null;
        region.path = path;
        region.x = getValue(map, "x", 0) * scale;
        region.y = getValue(map, "y", 0) * scale;
        region.scaleX = getValue(map, "scaleX", 1);
        region.scaleY = getValue(map, "scaleY", 1);
        region.rotation = getValue(map, "rotation", 0);
        region.width = map.width * scale;
        region.height = map.height * scale;
        region.sequence = sequence;
        let color = getValue(map, "color", null);
        if (color)
          region.color.setFromString(color);
        if (region.region != null)
          region.updateRegion();
        return region;
      }
      case "boundingbox": {
        let box = this.attachmentLoader.newBoundingBoxAttachment(skin, name);
        if (!box)
          return null;
        this.readVertices(map, box, map.vertexCount << 1);
        let color = getValue(map, "color", null);
        if (color)
          box.color.setFromString(color);
        return box;
      }
      case "mesh":
      case "linkedmesh": {
        let path = getValue(map, "path", name);
        let sequence = this.readSequence(getValue(map, "sequence", null));
        let mesh = this.attachmentLoader.newMeshAttachment(skin, name, path, sequence);
        if (!mesh)
          return null;
        mesh.path = path;
        let color = getValue(map, "color", null);
        if (color)
          mesh.color.setFromString(color);
        mesh.width = getValue(map, "width", 0) * scale;
        mesh.height = getValue(map, "height", 0) * scale;
        mesh.sequence = sequence;
        let parent = getValue(map, "parent", null);
        if (parent) {
          this.linkedMeshes.push(new LinkedMesh2(mesh, getValue(map, "skin", null), slotIndex, parent, getValue(map, "timelines", true)));
          return mesh;
        }
        let uvs = map.uvs;
        this.readVertices(map, mesh, uvs.length);
        mesh.triangles = map.triangles;
        mesh.regionUVs = uvs;
        if (mesh.region != null)
          mesh.updateRegion();
        mesh.edges = getValue(map, "edges", null);
        mesh.hullLength = getValue(map, "hull", 0) * 2;
        return mesh;
      }
      case "path": {
        let path = this.attachmentLoader.newPathAttachment(skin, name);
        if (!path)
          return null;
        path.closed = getValue(map, "closed", false);
        path.constantSpeed = getValue(map, "constantSpeed", true);
        let vertexCount = map.vertexCount;
        this.readVertices(map, path, vertexCount << 1);
        let lengths = Utils.newArray(vertexCount / 3, 0);
        for (let i = 0;i < map.lengths.length; i++)
          lengths[i] = map.lengths[i] * scale;
        path.lengths = lengths;
        let color = getValue(map, "color", null);
        if (color)
          path.color.setFromString(color);
        return path;
      }
      case "point": {
        let point = this.attachmentLoader.newPointAttachment(skin, name);
        if (!point)
          return null;
        point.x = getValue(map, "x", 0) * scale;
        point.y = getValue(map, "y", 0) * scale;
        point.rotation = getValue(map, "rotation", 0);
        let color = getValue(map, "color", null);
        if (color)
          point.color.setFromString(color);
        return point;
      }
      case "clipping": {
        let clip = this.attachmentLoader.newClippingAttachment(skin, name);
        if (!clip)
          return null;
        let end = getValue(map, "end", null);
        if (end)
          clip.endSlot = skeletonData.findSlot(end);
        let vertexCount = map.vertexCount;
        this.readVertices(map, clip, vertexCount << 1);
        let color = getValue(map, "color", null);
        if (color)
          clip.color.setFromString(color);
        return clip;
      }
    }
    return null;
  }
  readSequence(map) {
    if (map == null)
      return null;
    let sequence = new Sequence(getValue(map, "count", 0));
    sequence.start = getValue(map, "start", 1);
    sequence.digits = getValue(map, "digits", 0);
    sequence.setupIndex = getValue(map, "setup", 0);
    return sequence;
  }
  readVertices(map, attachment, verticesLength) {
    let scale = this.scale;
    attachment.worldVerticesLength = verticesLength;
    let vertices = map.vertices;
    if (verticesLength == vertices.length) {
      let scaledVertices = Utils.toFloatArray(vertices);
      if (scale != 1) {
        for (let i = 0, n = vertices.length;i < n; i++)
          scaledVertices[i] *= scale;
      }
      attachment.vertices = scaledVertices;
      return;
    }
    let weights = new Array;
    let bones = new Array;
    for (let i = 0, n = vertices.length;i < n; ) {
      let boneCount = vertices[i++];
      bones.push(boneCount);
      for (let nn = i + boneCount * 4;i < nn; i += 4) {
        bones.push(vertices[i]);
        weights.push(vertices[i + 1] * scale);
        weights.push(vertices[i + 2] * scale);
        weights.push(vertices[i + 3]);
      }
    }
    attachment.bones = bones;
    attachment.vertices = Utils.toFloatArray(weights);
  }
  readAnimation(map, name, skeletonData) {
    let scale = this.scale;
    let timelines = new Array;
    if (map.slots) {
      for (let slotName in map.slots) {
        let slotMap = map.slots[slotName];
        let slot = skeletonData.findSlot(slotName);
        if (!slot)
          throw new Error("Slot not found: " + slotName);
        let slotIndex = slot.index;
        for (let timelineName in slotMap) {
          let timelineMap = slotMap[timelineName];
          if (!timelineMap)
            continue;
          let frames = timelineMap.length;
          if (timelineName == "attachment") {
            let timeline = new AttachmentTimeline(frames, slotIndex);
            for (let frame = 0;frame < frames; frame++) {
              let keyMap = timelineMap[frame];
              timeline.setFrame(frame, getValue(keyMap, "time", 0), getValue(keyMap, "name", null));
            }
            timelines.push(timeline);
          } else if (timelineName == "rgba") {
            let timeline = new RGBATimeline(frames, frames << 2, slotIndex);
            let keyMap = timelineMap[0];
            let time = getValue(keyMap, "time", 0);
            let color = Color.fromString(keyMap.color);
            for (let frame = 0, bezier = 0;; frame++) {
              timeline.setFrame(frame, time, color.r, color.g, color.b, color.a);
              let nextMap = timelineMap[frame + 1];
              if (!nextMap) {
                timeline.shrink(bezier);
                break;
              }
              let time2 = getValue(nextMap, "time", 0);
              let newColor = Color.fromString(nextMap.color);
              let curve = keyMap.curve;
              if (curve) {
                bezier = readCurve(curve, timeline, bezier, frame, 0, time, time2, color.r, newColor.r, 1);
                bezier = readCurve(curve, timeline, bezier, frame, 1, time, time2, color.g, newColor.g, 1);
                bezier = readCurve(curve, timeline, bezier, frame, 2, time, time2, color.b, newColor.b, 1);
                bezier = readCurve(curve, timeline, bezier, frame, 3, time, time2, color.a, newColor.a, 1);
              }
              time = time2;
              color = newColor;
              keyMap = nextMap;
            }
            timelines.push(timeline);
          } else if (timelineName == "rgb") {
            let timeline = new RGBTimeline(frames, frames * 3, slotIndex);
            let keyMap = timelineMap[0];
            let time = getValue(keyMap, "time", 0);
            let color = Color.fromString(keyMap.color);
            for (let frame = 0, bezier = 0;; frame++) {
              timeline.setFrame(frame, time, color.r, color.g, color.b);
              let nextMap = timelineMap[frame + 1];
              if (!nextMap) {
                timeline.shrink(bezier);
                break;
              }
              let time2 = getValue(nextMap, "time", 0);
              let newColor = Color.fromString(nextMap.color);
              let curve = keyMap.curve;
              if (curve) {
                bezier = readCurve(curve, timeline, bezier, frame, 0, time, time2, color.r, newColor.r, 1);
                bezier = readCurve(curve, timeline, bezier, frame, 1, time, time2, color.g, newColor.g, 1);
                bezier = readCurve(curve, timeline, bezier, frame, 2, time, time2, color.b, newColor.b, 1);
              }
              time = time2;
              color = newColor;
              keyMap = nextMap;
            }
            timelines.push(timeline);
          } else if (timelineName == "alpha") {
            timelines.push(readTimeline12(timelineMap, new AlphaTimeline(frames, frames, slotIndex), 0, 1));
          } else if (timelineName == "rgba2") {
            let timeline = new RGBA2Timeline(frames, frames * 7, slotIndex);
            let keyMap = timelineMap[0];
            let time = getValue(keyMap, "time", 0);
            let color = Color.fromString(keyMap.light);
            let color2 = Color.fromString(keyMap.dark);
            for (let frame = 0, bezier = 0;; frame++) {
              timeline.setFrame(frame, time, color.r, color.g, color.b, color.a, color2.r, color2.g, color2.b);
              let nextMap = timelineMap[frame + 1];
              if (!nextMap) {
                timeline.shrink(bezier);
                break;
              }
              let time2 = getValue(nextMap, "time", 0);
              let newColor = Color.fromString(nextMap.light);
              let newColor2 = Color.fromString(nextMap.dark);
              let curve = keyMap.curve;
              if (curve) {
                bezier = readCurve(curve, timeline, bezier, frame, 0, time, time2, color.r, newColor.r, 1);
                bezier = readCurve(curve, timeline, bezier, frame, 1, time, time2, color.g, newColor.g, 1);
                bezier = readCurve(curve, timeline, bezier, frame, 2, time, time2, color.b, newColor.b, 1);
                bezier = readCurve(curve, timeline, bezier, frame, 3, time, time2, color.a, newColor.a, 1);
                bezier = readCurve(curve, timeline, bezier, frame, 4, time, time2, color2.r, newColor2.r, 1);
                bezier = readCurve(curve, timeline, bezier, frame, 5, time, time2, color2.g, newColor2.g, 1);
                bezier = readCurve(curve, timeline, bezier, frame, 6, time, time2, color2.b, newColor2.b, 1);
              }
              time = time2;
              color = newColor;
              color2 = newColor2;
              keyMap = nextMap;
            }
            timelines.push(timeline);
          } else if (timelineName == "rgb2") {
            let timeline = new RGB2Timeline(frames, frames * 6, slotIndex);
            let keyMap = timelineMap[0];
            let time = getValue(keyMap, "time", 0);
            let color = Color.fromString(keyMap.light);
            let color2 = Color.fromString(keyMap.dark);
            for (let frame = 0, bezier = 0;; frame++) {
              timeline.setFrame(frame, time, color.r, color.g, color.b, color2.r, color2.g, color2.b);
              let nextMap = timelineMap[frame + 1];
              if (!nextMap) {
                timeline.shrink(bezier);
                break;
              }
              let time2 = getValue(nextMap, "time", 0);
              let newColor = Color.fromString(nextMap.light);
              let newColor2 = Color.fromString(nextMap.dark);
              let curve = keyMap.curve;
              if (curve) {
                bezier = readCurve(curve, timeline, bezier, frame, 0, time, time2, color.r, newColor.r, 1);
                bezier = readCurve(curve, timeline, bezier, frame, 1, time, time2, color.g, newColor.g, 1);
                bezier = readCurve(curve, timeline, bezier, frame, 2, time, time2, color.b, newColor.b, 1);
                bezier = readCurve(curve, timeline, bezier, frame, 3, time, time2, color2.r, newColor2.r, 1);
                bezier = readCurve(curve, timeline, bezier, frame, 4, time, time2, color2.g, newColor2.g, 1);
                bezier = readCurve(curve, timeline, bezier, frame, 5, time, time2, color2.b, newColor2.b, 1);
              }
              time = time2;
              color = newColor;
              color2 = newColor2;
              keyMap = nextMap;
            }
            timelines.push(timeline);
          }
        }
      }
    }
    if (map.bones) {
      for (let boneName in map.bones) {
        let boneMap = map.bones[boneName];
        let bone = skeletonData.findBone(boneName);
        if (!bone)
          throw new Error("Bone not found: " + boneName);
        let boneIndex = bone.index;
        for (let timelineName in boneMap) {
          let timelineMap = boneMap[timelineName];
          let frames = timelineMap.length;
          if (frames == 0)
            continue;
          if (timelineName === "rotate") {
            timelines.push(readTimeline12(timelineMap, new RotateTimeline(frames, frames, boneIndex), 0, 1));
          } else if (timelineName === "translate") {
            let timeline = new TranslateTimeline(frames, frames << 1, boneIndex);
            timelines.push(readTimeline22(timelineMap, timeline, "x", "y", 0, scale));
          } else if (timelineName === "translatex") {
            let timeline = new TranslateXTimeline(frames, frames, boneIndex);
            timelines.push(readTimeline12(timelineMap, timeline, 0, scale));
          } else if (timelineName === "translatey") {
            let timeline = new TranslateYTimeline(frames, frames, boneIndex);
            timelines.push(readTimeline12(timelineMap, timeline, 0, scale));
          } else if (timelineName === "scale") {
            let timeline = new ScaleTimeline(frames, frames << 1, boneIndex);
            timelines.push(readTimeline22(timelineMap, timeline, "x", "y", 1, 1));
          } else if (timelineName === "scalex") {
            let timeline = new ScaleXTimeline(frames, frames, boneIndex);
            timelines.push(readTimeline12(timelineMap, timeline, 1, 1));
          } else if (timelineName === "scaley") {
            let timeline = new ScaleYTimeline(frames, frames, boneIndex);
            timelines.push(readTimeline12(timelineMap, timeline, 1, 1));
          } else if (timelineName === "shear") {
            let timeline = new ShearTimeline(frames, frames << 1, boneIndex);
            timelines.push(readTimeline22(timelineMap, timeline, "x", "y", 0, 1));
          } else if (timelineName === "shearx") {
            let timeline = new ShearXTimeline(frames, frames, boneIndex);
            timelines.push(readTimeline12(timelineMap, timeline, 0, 1));
          } else if (timelineName === "sheary") {
            let timeline = new ShearYTimeline(frames, frames, boneIndex);
            timelines.push(readTimeline12(timelineMap, timeline, 0, 1));
          }
        }
      }
    }
    if (map.ik) {
      for (let constraintName in map.ik) {
        let constraintMap = map.ik[constraintName];
        let keyMap = constraintMap[0];
        if (!keyMap)
          continue;
        let constraint = skeletonData.findIkConstraint(constraintName);
        if (!constraint)
          throw new Error("IK Constraint not found: " + constraintName);
        let constraintIndex = skeletonData.ikConstraints.indexOf(constraint);
        let timeline = new IkConstraintTimeline(constraintMap.length, constraintMap.length << 1, constraintIndex);
        let time = getValue(keyMap, "time", 0);
        let mix = getValue(keyMap, "mix", 1);
        let softness = getValue(keyMap, "softness", 0) * scale;
        for (let frame = 0, bezier = 0;; frame++) {
          timeline.setFrame(frame, time, mix, softness, getValue(keyMap, "bendPositive", true) ? 1 : -1, getValue(keyMap, "compress", false), getValue(keyMap, "stretch", false));
          let nextMap = constraintMap[frame + 1];
          if (!nextMap) {
            timeline.shrink(bezier);
            break;
          }
          let time2 = getValue(nextMap, "time", 0);
          let mix2 = getValue(nextMap, "mix", 1);
          let softness2 = getValue(nextMap, "softness", 0) * scale;
          let curve = keyMap.curve;
          if (curve) {
            bezier = readCurve(curve, timeline, bezier, frame, 0, time, time2, mix, mix2, 1);
            bezier = readCurve(curve, timeline, bezier, frame, 1, time, time2, softness, softness2, scale);
          }
          time = time2;
          mix = mix2;
          softness = softness2;
          keyMap = nextMap;
        }
        timelines.push(timeline);
      }
    }
    if (map.transform) {
      for (let constraintName in map.transform) {
        let timelineMap = map.transform[constraintName];
        let keyMap = timelineMap[0];
        if (!keyMap)
          continue;
        let constraint = skeletonData.findTransformConstraint(constraintName);
        if (!constraint)
          throw new Error("Transform constraint not found: " + constraintName);
        let constraintIndex = skeletonData.transformConstraints.indexOf(constraint);
        let timeline = new TransformConstraintTimeline(timelineMap.length, timelineMap.length * 6, constraintIndex);
        let time = getValue(keyMap, "time", 0);
        let mixRotate = getValue(keyMap, "mixRotate", 1);
        let mixX = getValue(keyMap, "mixX", 1);
        let mixY = getValue(keyMap, "mixY", mixX);
        let mixScaleX = getValue(keyMap, "mixScaleX", 1);
        let mixScaleY = getValue(keyMap, "mixScaleY", mixScaleX);
        let mixShearY = getValue(keyMap, "mixShearY", 1);
        for (let frame = 0, bezier = 0;; frame++) {
          timeline.setFrame(frame, time, mixRotate, mixX, mixY, mixScaleX, mixScaleY, mixShearY);
          let nextMap = timelineMap[frame + 1];
          if (!nextMap) {
            timeline.shrink(bezier);
            break;
          }
          let time2 = getValue(nextMap, "time", 0);
          let mixRotate2 = getValue(nextMap, "mixRotate", 1);
          let mixX2 = getValue(nextMap, "mixX", 1);
          let mixY2 = getValue(nextMap, "mixY", mixX2);
          let mixScaleX2 = getValue(nextMap, "mixScaleX", 1);
          let mixScaleY2 = getValue(nextMap, "mixScaleY", mixScaleX2);
          let mixShearY2 = getValue(nextMap, "mixShearY", 1);
          let curve = keyMap.curve;
          if (curve) {
            bezier = readCurve(curve, timeline, bezier, frame, 0, time, time2, mixRotate, mixRotate2, 1);
            bezier = readCurve(curve, timeline, bezier, frame, 1, time, time2, mixX, mixX2, 1);
            bezier = readCurve(curve, timeline, bezier, frame, 2, time, time2, mixY, mixY2, 1);
            bezier = readCurve(curve, timeline, bezier, frame, 3, time, time2, mixScaleX, mixScaleX2, 1);
            bezier = readCurve(curve, timeline, bezier, frame, 4, time, time2, mixScaleY, mixScaleY2, 1);
            bezier = readCurve(curve, timeline, bezier, frame, 5, time, time2, mixShearY, mixShearY2, 1);
          }
          time = time2;
          mixRotate = mixRotate2;
          mixX = mixX2;
          mixY = mixY2;
          mixScaleX = mixScaleX2;
          mixScaleY = mixScaleY2;
          mixScaleX = mixScaleX2;
          keyMap = nextMap;
        }
        timelines.push(timeline);
      }
    }
    if (map.path) {
      for (let constraintName in map.path) {
        let constraintMap = map.path[constraintName];
        let constraint = skeletonData.findPathConstraint(constraintName);
        if (!constraint)
          throw new Error("Path constraint not found: " + constraintName);
        let constraintIndex = skeletonData.pathConstraints.indexOf(constraint);
        for (let timelineName in constraintMap) {
          let timelineMap = constraintMap[timelineName];
          let keyMap = timelineMap[0];
          if (!keyMap)
            continue;
          let frames = timelineMap.length;
          if (timelineName === "position") {
            let timeline = new PathConstraintPositionTimeline(frames, frames, constraintIndex);
            timelines.push(readTimeline12(timelineMap, timeline, 0, constraint.positionMode == PositionMode.Fixed ? scale : 1));
          } else if (timelineName === "spacing") {
            let timeline = new PathConstraintSpacingTimeline(frames, frames, constraintIndex);
            timelines.push(readTimeline12(timelineMap, timeline, 0, constraint.spacingMode == SpacingMode.Length || constraint.spacingMode == SpacingMode.Fixed ? scale : 1));
          } else if (timelineName === "mix") {
            let timeline = new PathConstraintMixTimeline(frames, frames * 3, constraintIndex);
            let time = getValue(keyMap, "time", 0);
            let mixRotate = getValue(keyMap, "mixRotate", 1);
            let mixX = getValue(keyMap, "mixX", 1);
            let mixY = getValue(keyMap, "mixY", mixX);
            for (let frame = 0, bezier = 0;; frame++) {
              timeline.setFrame(frame, time, mixRotate, mixX, mixY);
              let nextMap = timelineMap[frame + 1];
              if (!nextMap) {
                timeline.shrink(bezier);
                break;
              }
              let time2 = getValue(nextMap, "time", 0);
              let mixRotate2 = getValue(nextMap, "mixRotate", 1);
              let mixX2 = getValue(nextMap, "mixX", 1);
              let mixY2 = getValue(nextMap, "mixY", mixX2);
              let curve = keyMap.curve;
              if (curve) {
                bezier = readCurve(curve, timeline, bezier, frame, 0, time, time2, mixRotate, mixRotate2, 1);
                bezier = readCurve(curve, timeline, bezier, frame, 1, time, time2, mixX, mixX2, 1);
                bezier = readCurve(curve, timeline, bezier, frame, 2, time, time2, mixY, mixY2, 1);
              }
              time = time2;
              mixRotate = mixRotate2;
              mixX = mixX2;
              mixY = mixY2;
              keyMap = nextMap;
            }
            timelines.push(timeline);
          }
        }
      }
    }
    if (map.attachments) {
      for (let attachmentsName in map.attachments) {
        let attachmentsMap = map.attachments[attachmentsName];
        let skin = skeletonData.findSkin(attachmentsName);
        if (!skin)
          throw new Error("Skin not found: " + attachmentsName);
        for (let slotMapName in attachmentsMap) {
          let slotMap = attachmentsMap[slotMapName];
          let slot = skeletonData.findSlot(slotMapName);
          if (!slot)
            throw new Error("Slot not found: " + slotMapName);
          let slotIndex = slot.index;
          for (let attachmentMapName in slotMap) {
            let attachmentMap = slotMap[attachmentMapName];
            let attachment = skin.getAttachment(slotIndex, attachmentMapName);
            for (let timelineMapName in attachmentMap) {
              let timelineMap = attachmentMap[timelineMapName];
              let keyMap = timelineMap[0];
              if (!keyMap)
                continue;
              if (timelineMapName == "deform") {
                let weighted = attachment.bones;
                let vertices = attachment.vertices;
                let deformLength = weighted ? vertices.length / 3 * 2 : vertices.length;
                let timeline = new DeformTimeline(timelineMap.length, timelineMap.length, slotIndex, attachment);
                let time = getValue(keyMap, "time", 0);
                for (let frame = 0, bezier = 0;; frame++) {
                  let deform;
                  let verticesValue = getValue(keyMap, "vertices", null);
                  if (!verticesValue)
                    deform = weighted ? Utils.newFloatArray(deformLength) : vertices;
                  else {
                    deform = Utils.newFloatArray(deformLength);
                    let start = getValue(keyMap, "offset", 0);
                    Utils.arrayCopy(verticesValue, 0, deform, start, verticesValue.length);
                    if (scale != 1) {
                      for (let i = start, n = i + verticesValue.length;i < n; i++)
                        deform[i] *= scale;
                    }
                    if (!weighted) {
                      for (let i = 0;i < deformLength; i++)
                        deform[i] += vertices[i];
                    }
                  }
                  timeline.setFrame(frame, time, deform);
                  let nextMap = timelineMap[frame + 1];
                  if (!nextMap) {
                    timeline.shrink(bezier);
                    break;
                  }
                  let time2 = getValue(nextMap, "time", 0);
                  let curve = keyMap.curve;
                  if (curve)
                    bezier = readCurve(curve, timeline, bezier, frame, 0, time, time2, 0, 1, 1);
                  time = time2;
                  keyMap = nextMap;
                }
                timelines.push(timeline);
              } else if (timelineMapName == "sequence") {
                let timeline = new SequenceTimeline(timelineMap.length, slotIndex, attachment);
                let lastDelay = 0;
                for (let frame = 0;frame < timelineMap.length; frame++) {
                  let delay = getValue(keyMap, "delay", lastDelay);
                  let time = getValue(keyMap, "time", 0);
                  let mode = SequenceMode[getValue(keyMap, "mode", "hold")];
                  let index = getValue(keyMap, "index", 0);
                  timeline.setFrame(frame, time, mode, index, delay);
                  lastDelay = delay;
                  keyMap = timelineMap[frame + 1];
                }
                timelines.push(timeline);
              }
            }
          }
        }
      }
    }
    if (map.drawOrder) {
      let timeline = new DrawOrderTimeline(map.drawOrder.length);
      let slotCount = skeletonData.slots.length;
      let frame = 0;
      for (let i = 0;i < map.drawOrder.length; i++, frame++) {
        let drawOrderMap = map.drawOrder[i];
        let drawOrder = null;
        let offsets = getValue(drawOrderMap, "offsets", null);
        if (offsets) {
          drawOrder = Utils.newArray(slotCount, -1);
          let unchanged = Utils.newArray(slotCount - offsets.length, 0);
          let originalIndex = 0, unchangedIndex = 0;
          for (let ii = 0;ii < offsets.length; ii++) {
            let offsetMap = offsets[ii];
            let slot = skeletonData.findSlot(offsetMap.slot);
            if (!slot)
              throw new Error("Slot not found: " + slot);
            let slotIndex = slot.index;
            while (originalIndex != slotIndex)
              unchanged[unchangedIndex++] = originalIndex++;
            drawOrder[originalIndex + offsetMap.offset] = originalIndex++;
          }
          while (originalIndex < slotCount)
            unchanged[unchangedIndex++] = originalIndex++;
          for (let ii = slotCount - 1;ii >= 0; ii--)
            if (drawOrder[ii] == -1)
              drawOrder[ii] = unchanged[--unchangedIndex];
        }
        timeline.setFrame(frame, getValue(drawOrderMap, "time", 0), drawOrder);
      }
      timelines.push(timeline);
    }
    if (map.events) {
      let timeline = new EventTimeline(map.events.length);
      let frame = 0;
      for (let i = 0;i < map.events.length; i++, frame++) {
        let eventMap = map.events[i];
        let eventData = skeletonData.findEvent(eventMap.name);
        if (!eventData)
          throw new Error("Event not found: " + eventMap.name);
        let event = new Event(Utils.toSinglePrecision(getValue(eventMap, "time", 0)), eventData);
        event.intValue = getValue(eventMap, "int", eventData.intValue);
        event.floatValue = getValue(eventMap, "float", eventData.floatValue);
        event.stringValue = getValue(eventMap, "string", eventData.stringValue);
        if (event.data.audioPath) {
          event.volume = getValue(eventMap, "volume", 1);
          event.balance = getValue(eventMap, "balance", 0);
        }
        timeline.setFrame(frame, event);
      }
      timelines.push(timeline);
    }
    let duration = 0;
    for (let i = 0, n = timelines.length;i < n; i++)
      duration = Math.max(duration, timelines[i].getDuration());
    skeletonData.animations.push(new Animation(name, timelines, duration));
  }
}

class LinkedMesh2 {
  parent;
  skin;
  slotIndex;
  mesh;
  inheritTimeline;
  constructor(mesh, skin, slotIndex, parent, inheritDeform) {
    this.mesh = mesh;
    this.skin = skin;
    this.slotIndex = slotIndex;
    this.parent = parent;
    this.inheritTimeline = inheritDeform;
  }
}
function readTimeline12(keys, timeline, defaultValue, scale) {
  let keyMap = keys[0];
  let time = getValue(keyMap, "time", 0);
  let value = getValue(keyMap, "value", defaultValue) * scale;
  let bezier = 0;
  for (let frame = 0;; frame++) {
    timeline.setFrame(frame, time, value);
    let nextMap = keys[frame + 1];
    if (!nextMap) {
      timeline.shrink(bezier);
      return timeline;
    }
    let time2 = getValue(nextMap, "time", 0);
    let value2 = getValue(nextMap, "value", defaultValue) * scale;
    if (keyMap.curve)
      bezier = readCurve(keyMap.curve, timeline, bezier, frame, 0, time, time2, value, value2, scale);
    time = time2;
    value = value2;
    keyMap = nextMap;
  }
}
function readTimeline22(keys, timeline, name1, name2, defaultValue, scale) {
  let keyMap = keys[0];
  let time = getValue(keyMap, "time", 0);
  let value1 = getValue(keyMap, name1, defaultValue) * scale;
  let value2 = getValue(keyMap, name2, defaultValue) * scale;
  let bezier = 0;
  for (let frame = 0;; frame++) {
    timeline.setFrame(frame, time, value1, value2);
    let nextMap = keys[frame + 1];
    if (!nextMap) {
      timeline.shrink(bezier);
      return timeline;
    }
    let time2 = getValue(nextMap, "time", 0);
    let nvalue1 = getValue(nextMap, name1, defaultValue) * scale;
    let nvalue2 = getValue(nextMap, name2, defaultValue) * scale;
    let curve = keyMap.curve;
    if (curve) {
      bezier = readCurve(curve, timeline, bezier, frame, 0, time, time2, value1, nvalue1, scale);
      bezier = readCurve(curve, timeline, bezier, frame, 1, time, time2, value2, nvalue2, scale);
    }
    time = time2;
    value1 = nvalue1;
    value2 = nvalue2;
    keyMap = nextMap;
  }
}
function readCurve(curve, timeline, bezier, frame, value, time1, time2, value1, value2, scale) {
  if (curve == "stepped") {
    timeline.setStepped(frame);
    return bezier;
  }
  let i = value << 2;
  let cx1 = curve[i];
  let cy1 = curve[i + 1] * scale;
  let cx2 = curve[i + 2];
  let cy2 = curve[i + 3] * scale;
  timeline.setBezier(bezier, frame, value, time1, value1, cx1, cy1, cx2, cy2, time2, value2);
  return bezier + 1;
}
function getValue(map, property, defaultValue) {
  return map[property] !== undefined ? map[property] : defaultValue;
}
// node_modules/@esotericsoftware/spine-core/dist/polyfills.js
(() => {
  if (typeof Math.fround === "undefined") {
    Math.fround = function(array) {
      return function(x) {
        return array[0] = x, array[0];
      };
    }(new Float32Array(1));
  }
})();
// node_modules/@esotericsoftware/spine-webgl/dist/WebGL.js
class ManagedWebGLRenderingContext {
  canvas;
  gl;
  restorables = new Array;
  constructor(canvasOrContext, contextConfig = { alpha: "true" }) {
    if (!(canvasOrContext instanceof WebGLRenderingContext || typeof WebGL2RenderingContext !== "undefined" && canvasOrContext instanceof WebGL2RenderingContext)) {
      let canvas = canvasOrContext;
      this.gl = canvas.getContext("webgl2", contextConfig) || canvas.getContext("webgl", contextConfig);
      this.canvas = canvas;
      canvas.addEventListener("webglcontextlost", (e) => {
        let event = e;
        if (e)
          e.preventDefault();
      });
      canvas.addEventListener("webglcontextrestored", (e) => {
        for (let i = 0, n = this.restorables.length;i < n; i++)
          this.restorables[i].restore();
      });
    } else {
      this.gl = canvasOrContext;
      this.canvas = this.gl.canvas;
    }
  }
  addRestorable(restorable) {
    this.restorables.push(restorable);
  }
  removeRestorable(restorable) {
    let index = this.restorables.indexOf(restorable);
    if (index > -1)
      this.restorables.splice(index, 1);
  }
}

// node_modules/@esotericsoftware/spine-webgl/dist/GLTexture.js
class GLTexture extends Texture {
  context;
  texture = null;
  boundUnit = 0;
  useMipMaps = false;
  static DISABLE_UNPACK_PREMULTIPLIED_ALPHA_WEBGL = false;
  constructor(context, image, useMipMaps = false) {
    super(image);
    this.context = context instanceof ManagedWebGLRenderingContext ? context : new ManagedWebGLRenderingContext(context);
    this.useMipMaps = useMipMaps;
    this.restore();
    this.context.addRestorable(this);
  }
  setFilters(minFilter, magFilter) {
    let gl = this.context.gl;
    this.bind();
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, minFilter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, GLTexture.validateMagFilter(magFilter));
    this.useMipMaps = GLTexture.usesMipMaps(minFilter);
    if (this.useMipMaps)
      gl.generateMipmap(gl.TEXTURE_2D);
  }
  static validateMagFilter(magFilter) {
    switch (magFilter) {
      case TextureFilter.MipMapLinearLinear:
      case TextureFilter.MipMapLinearNearest:
      case TextureFilter.MipMapNearestLinear:
      case TextureFilter.MipMapNearestNearest:
        return TextureFilter.Linear;
      default:
        return magFilter;
    }
  }
  static usesMipMaps(filter) {
    switch (filter) {
      case TextureFilter.MipMapLinearLinear:
      case TextureFilter.MipMapLinearNearest:
      case TextureFilter.MipMapNearestLinear:
      case TextureFilter.MipMapNearestNearest:
        return true;
      default:
        return false;
    }
  }
  setWraps(uWrap, vWrap) {
    let gl = this.context.gl;
    this.bind();
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, uWrap);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, vWrap);
  }
  update(useMipMaps) {
    let gl = this.context.gl;
    if (!this.texture)
      this.texture = this.context.gl.createTexture();
    this.bind();
    if (GLTexture.DISABLE_UNPACK_PREMULTIPLIED_ALPHA_WEBGL)
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this._image);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, useMipMaps ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (useMipMaps)
      gl.generateMipmap(gl.TEXTURE_2D);
  }
  restore() {
    this.texture = null;
    this.update(this.useMipMaps);
  }
  bind(unit = 0) {
    let gl = this.context.gl;
    this.boundUnit = unit;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
  }
  unbind() {
    let gl = this.context.gl;
    gl.activeTexture(gl.TEXTURE0 + this.boundUnit);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }
  dispose() {
    this.context.removeRestorable(this);
    let gl = this.context.gl;
    gl.deleteTexture(this.texture);
  }
}
// node_modules/@esotericsoftware/spine-webgl/dist/Vector3.js
class Vector3 {
  x = 0;
  y = 0;
  z = 0;
  constructor(x = 0, y = 0, z = 0) {
    this.x = x;
    this.y = y;
    this.z = z;
  }
  setFrom(v) {
    this.x = v.x;
    this.y = v.y;
    this.z = v.z;
    return this;
  }
  set(x, y, z) {
    this.x = x;
    this.y = y;
    this.z = z;
    return this;
  }
  add(v) {
    this.x += v.x;
    this.y += v.y;
    this.z += v.z;
    return this;
  }
  sub(v) {
    this.x -= v.x;
    this.y -= v.y;
    this.z -= v.z;
    return this;
  }
  scale(s) {
    this.x *= s;
    this.y *= s;
    this.z *= s;
    return this;
  }
  normalize() {
    let len = this.length();
    if (len == 0)
      return this;
    len = 1 / len;
    this.x *= len;
    this.y *= len;
    this.z *= len;
    return this;
  }
  cross(v) {
    return this.set(this.y * v.z - this.z * v.y, this.z * v.x - this.x * v.z, this.x * v.y - this.y * v.x);
  }
  multiply(matrix) {
    let l_mat = matrix.values;
    return this.set(this.x * l_mat[M00] + this.y * l_mat[M01] + this.z * l_mat[M02] + l_mat[M03], this.x * l_mat[M10] + this.y * l_mat[M11] + this.z * l_mat[M12] + l_mat[M13], this.x * l_mat[M20] + this.y * l_mat[M21] + this.z * l_mat[M22] + l_mat[M23]);
  }
  project(matrix) {
    let l_mat = matrix.values;
    let l_w = 1 / (this.x * l_mat[M30] + this.y * l_mat[M31] + this.z * l_mat[M32] + l_mat[M33]);
    return this.set((this.x * l_mat[M00] + this.y * l_mat[M01] + this.z * l_mat[M02] + l_mat[M03]) * l_w, (this.x * l_mat[M10] + this.y * l_mat[M11] + this.z * l_mat[M12] + l_mat[M13]) * l_w, (this.x * l_mat[M20] + this.y * l_mat[M21] + this.z * l_mat[M22] + l_mat[M23]) * l_w);
  }
  dot(v) {
    return this.x * v.x + this.y * v.y + this.z * v.z;
  }
  length() {
    return Math.sqrt(this.x * this.x + this.y * this.y + this.z * this.z);
  }
  distance(v) {
    let a = v.x - this.x;
    let b = v.y - this.y;
    let c = v.z - this.z;
    return Math.sqrt(a * a + b * b + c * c);
  }
}

// node_modules/@esotericsoftware/spine-webgl/dist/Matrix4.js
var M00 = 0;
var M01 = 4;
var M02 = 8;
var M03 = 12;
var M10 = 1;
var M11 = 5;
var M12 = 9;
var M13 = 13;
var M20 = 2;
var M21 = 6;
var M22 = 10;
var M23 = 14;
var M30 = 3;
var M31 = 7;
var M32 = 11;
var M33 = 15;

class Matrix4 {
  temp = new Float32Array(16);
  values = new Float32Array(16);
  static xAxis = new Vector3;
  static yAxis = new Vector3;
  static zAxis = new Vector3;
  static tmpMatrix = new Matrix4;
  constructor() {
    let v = this.values;
    v[M00] = 1;
    v[M11] = 1;
    v[M22] = 1;
    v[M33] = 1;
  }
  set(values) {
    this.values.set(values);
    return this;
  }
  transpose() {
    let t = this.temp;
    let v = this.values;
    t[M00] = v[M00];
    t[M01] = v[M10];
    t[M02] = v[M20];
    t[M03] = v[M30];
    t[M10] = v[M01];
    t[M11] = v[M11];
    t[M12] = v[M21];
    t[M13] = v[M31];
    t[M20] = v[M02];
    t[M21] = v[M12];
    t[M22] = v[M22];
    t[M23] = v[M32];
    t[M30] = v[M03];
    t[M31] = v[M13];
    t[M32] = v[M23];
    t[M33] = v[M33];
    return this.set(t);
  }
  identity() {
    let v = this.values;
    v[M00] = 1;
    v[M01] = 0;
    v[M02] = 0;
    v[M03] = 0;
    v[M10] = 0;
    v[M11] = 1;
    v[M12] = 0;
    v[M13] = 0;
    v[M20] = 0;
    v[M21] = 0;
    v[M22] = 1;
    v[M23] = 0;
    v[M30] = 0;
    v[M31] = 0;
    v[M32] = 0;
    v[M33] = 1;
    return this;
  }
  invert() {
    let v = this.values;
    let t = this.temp;
    let l_det = v[M30] * v[M21] * v[M12] * v[M03] - v[M20] * v[M31] * v[M12] * v[M03] - v[M30] * v[M11] * v[M22] * v[M03] + v[M10] * v[M31] * v[M22] * v[M03] + v[M20] * v[M11] * v[M32] * v[M03] - v[M10] * v[M21] * v[M32] * v[M03] - v[M30] * v[M21] * v[M02] * v[M13] + v[M20] * v[M31] * v[M02] * v[M13] + v[M30] * v[M01] * v[M22] * v[M13] - v[M00] * v[M31] * v[M22] * v[M13] - v[M20] * v[M01] * v[M32] * v[M13] + v[M00] * v[M21] * v[M32] * v[M13] + v[M30] * v[M11] * v[M02] * v[M23] - v[M10] * v[M31] * v[M02] * v[M23] - v[M30] * v[M01] * v[M12] * v[M23] + v[M00] * v[M31] * v[M12] * v[M23] + v[M10] * v[M01] * v[M32] * v[M23] - v[M00] * v[M11] * v[M32] * v[M23] - v[M20] * v[M11] * v[M02] * v[M33] + v[M10] * v[M21] * v[M02] * v[M33] + v[M20] * v[M01] * v[M12] * v[M33] - v[M00] * v[M21] * v[M12] * v[M33] - v[M10] * v[M01] * v[M22] * v[M33] + v[M00] * v[M11] * v[M22] * v[M33];
    if (l_det == 0)
      throw new Error("non-invertible matrix");
    let inv_det = 1 / l_det;
    t[M00] = v[M12] * v[M23] * v[M31] - v[M13] * v[M22] * v[M31] + v[M13] * v[M21] * v[M32] - v[M11] * v[M23] * v[M32] - v[M12] * v[M21] * v[M33] + v[M11] * v[M22] * v[M33];
    t[M01] = v[M03] * v[M22] * v[M31] - v[M02] * v[M23] * v[M31] - v[M03] * v[M21] * v[M32] + v[M01] * v[M23] * v[M32] + v[M02] * v[M21] * v[M33] - v[M01] * v[M22] * v[M33];
    t[M02] = v[M02] * v[M13] * v[M31] - v[M03] * v[M12] * v[M31] + v[M03] * v[M11] * v[M32] - v[M01] * v[M13] * v[M32] - v[M02] * v[M11] * v[M33] + v[M01] * v[M12] * v[M33];
    t[M03] = v[M03] * v[M12] * v[M21] - v[M02] * v[M13] * v[M21] - v[M03] * v[M11] * v[M22] + v[M01] * v[M13] * v[M22] + v[M02] * v[M11] * v[M23] - v[M01] * v[M12] * v[M23];
    t[M10] = v[M13] * v[M22] * v[M30] - v[M12] * v[M23] * v[M30] - v[M13] * v[M20] * v[M32] + v[M10] * v[M23] * v[M32] + v[M12] * v[M20] * v[M33] - v[M10] * v[M22] * v[M33];
    t[M11] = v[M02] * v[M23] * v[M30] - v[M03] * v[M22] * v[M30] + v[M03] * v[M20] * v[M32] - v[M00] * v[M23] * v[M32] - v[M02] * v[M20] * v[M33] + v[M00] * v[M22] * v[M33];
    t[M12] = v[M03] * v[M12] * v[M30] - v[M02] * v[M13] * v[M30] - v[M03] * v[M10] * v[M32] + v[M00] * v[M13] * v[M32] + v[M02] * v[M10] * v[M33] - v[M00] * v[M12] * v[M33];
    t[M13] = v[M02] * v[M13] * v[M20] - v[M03] * v[M12] * v[M20] + v[M03] * v[M10] * v[M22] - v[M00] * v[M13] * v[M22] - v[M02] * v[M10] * v[M23] + v[M00] * v[M12] * v[M23];
    t[M20] = v[M11] * v[M23] * v[M30] - v[M13] * v[M21] * v[M30] + v[M13] * v[M20] * v[M31] - v[M10] * v[M23] * v[M31] - v[M11] * v[M20] * v[M33] + v[M10] * v[M21] * v[M33];
    t[M21] = v[M03] * v[M21] * v[M30] - v[M01] * v[M23] * v[M30] - v[M03] * v[M20] * v[M31] + v[M00] * v[M23] * v[M31] + v[M01] * v[M20] * v[M33] - v[M00] * v[M21] * v[M33];
    t[M22] = v[M01] * v[M13] * v[M30] - v[M03] * v[M11] * v[M30] + v[M03] * v[M10] * v[M31] - v[M00] * v[M13] * v[M31] - v[M01] * v[M10] * v[M33] + v[M00] * v[M11] * v[M33];
    t[M23] = v[M03] * v[M11] * v[M20] - v[M01] * v[M13] * v[M20] - v[M03] * v[M10] * v[M21] + v[M00] * v[M13] * v[M21] + v[M01] * v[M10] * v[M23] - v[M00] * v[M11] * v[M23];
    t[M30] = v[M12] * v[M21] * v[M30] - v[M11] * v[M22] * v[M30] - v[M12] * v[M20] * v[M31] + v[M10] * v[M22] * v[M31] + v[M11] * v[M20] * v[M32] - v[M10] * v[M21] * v[M32];
    t[M31] = v[M01] * v[M22] * v[M30] - v[M02] * v[M21] * v[M30] + v[M02] * v[M20] * v[M31] - v[M00] * v[M22] * v[M31] - v[M01] * v[M20] * v[M32] + v[M00] * v[M21] * v[M32];
    t[M32] = v[M02] * v[M11] * v[M30] - v[M01] * v[M12] * v[M30] - v[M02] * v[M10] * v[M31] + v[M00] * v[M12] * v[M31] + v[M01] * v[M10] * v[M32] - v[M00] * v[M11] * v[M32];
    t[M33] = v[M01] * v[M12] * v[M20] - v[M02] * v[M11] * v[M20] + v[M02] * v[M10] * v[M21] - v[M00] * v[M12] * v[M21] - v[M01] * v[M10] * v[M22] + v[M00] * v[M11] * v[M22];
    v[M00] = t[M00] * inv_det;
    v[M01] = t[M01] * inv_det;
    v[M02] = t[M02] * inv_det;
    v[M03] = t[M03] * inv_det;
    v[M10] = t[M10] * inv_det;
    v[M11] = t[M11] * inv_det;
    v[M12] = t[M12] * inv_det;
    v[M13] = t[M13] * inv_det;
    v[M20] = t[M20] * inv_det;
    v[M21] = t[M21] * inv_det;
    v[M22] = t[M22] * inv_det;
    v[M23] = t[M23] * inv_det;
    v[M30] = t[M30] * inv_det;
    v[M31] = t[M31] * inv_det;
    v[M32] = t[M32] * inv_det;
    v[M33] = t[M33] * inv_det;
    return this;
  }
  determinant() {
    let v = this.values;
    return v[M30] * v[M21] * v[M12] * v[M03] - v[M20] * v[M31] * v[M12] * v[M03] - v[M30] * v[M11] * v[M22] * v[M03] + v[M10] * v[M31] * v[M22] * v[M03] + v[M20] * v[M11] * v[M32] * v[M03] - v[M10] * v[M21] * v[M32] * v[M03] - v[M30] * v[M21] * v[M02] * v[M13] + v[M20] * v[M31] * v[M02] * v[M13] + v[M30] * v[M01] * v[M22] * v[M13] - v[M00] * v[M31] * v[M22] * v[M13] - v[M20] * v[M01] * v[M32] * v[M13] + v[M00] * v[M21] * v[M32] * v[M13] + v[M30] * v[M11] * v[M02] * v[M23] - v[M10] * v[M31] * v[M02] * v[M23] - v[M30] * v[M01] * v[M12] * v[M23] + v[M00] * v[M31] * v[M12] * v[M23] + v[M10] * v[M01] * v[M32] * v[M23] - v[M00] * v[M11] * v[M32] * v[M23] - v[M20] * v[M11] * v[M02] * v[M33] + v[M10] * v[M21] * v[M02] * v[M33] + v[M20] * v[M01] * v[M12] * v[M33] - v[M00] * v[M21] * v[M12] * v[M33] - v[M10] * v[M01] * v[M22] * v[M33] + v[M00] * v[M11] * v[M22] * v[M33];
  }
  translate(x, y, z) {
    let v = this.values;
    v[M03] += x;
    v[M13] += y;
    v[M23] += z;
    return this;
  }
  copy() {
    return new Matrix4().set(this.values);
  }
  projection(near, far, fovy, aspectRatio) {
    this.identity();
    let l_fd = 1 / Math.tan(fovy * (Math.PI / 180) / 2);
    let l_a1 = (far + near) / (near - far);
    let l_a2 = 2 * far * near / (near - far);
    let v = this.values;
    v[M00] = l_fd / aspectRatio;
    v[M10] = 0;
    v[M20] = 0;
    v[M30] = 0;
    v[M01] = 0;
    v[M11] = l_fd;
    v[M21] = 0;
    v[M31] = 0;
    v[M02] = 0;
    v[M12] = 0;
    v[M22] = l_a1;
    v[M32] = -1;
    v[M03] = 0;
    v[M13] = 0;
    v[M23] = l_a2;
    v[M33] = 0;
    return this;
  }
  ortho2d(x, y, width, height) {
    return this.ortho(x, x + width, y, y + height, 0, 1);
  }
  ortho(left, right, bottom, top, near, far) {
    this.identity();
    let x_orth = 2 / (right - left);
    let y_orth = 2 / (top - bottom);
    let z_orth = -2 / (far - near);
    let tx = -(right + left) / (right - left);
    let ty = -(top + bottom) / (top - bottom);
    let tz = -(far + near) / (far - near);
    let v = this.values;
    v[M00] = x_orth;
    v[M10] = 0;
    v[M20] = 0;
    v[M30] = 0;
    v[M01] = 0;
    v[M11] = y_orth;
    v[M21] = 0;
    v[M31] = 0;
    v[M02] = 0;
    v[M12] = 0;
    v[M22] = z_orth;
    v[M32] = 0;
    v[M03] = tx;
    v[M13] = ty;
    v[M23] = tz;
    v[M33] = 1;
    return this;
  }
  multiply(matrix) {
    let t = this.temp;
    let v = this.values;
    let m = matrix.values;
    t[M00] = v[M00] * m[M00] + v[M01] * m[M10] + v[M02] * m[M20] + v[M03] * m[M30];
    t[M01] = v[M00] * m[M01] + v[M01] * m[M11] + v[M02] * m[M21] + v[M03] * m[M31];
    t[M02] = v[M00] * m[M02] + v[M01] * m[M12] + v[M02] * m[M22] + v[M03] * m[M32];
    t[M03] = v[M00] * m[M03] + v[M01] * m[M13] + v[M02] * m[M23] + v[M03] * m[M33];
    t[M10] = v[M10] * m[M00] + v[M11] * m[M10] + v[M12] * m[M20] + v[M13] * m[M30];
    t[M11] = v[M10] * m[M01] + v[M11] * m[M11] + v[M12] * m[M21] + v[M13] * m[M31];
    t[M12] = v[M10] * m[M02] + v[M11] * m[M12] + v[M12] * m[M22] + v[M13] * m[M32];
    t[M13] = v[M10] * m[M03] + v[M11] * m[M13] + v[M12] * m[M23] + v[M13] * m[M33];
    t[M20] = v[M20] * m[M00] + v[M21] * m[M10] + v[M22] * m[M20] + v[M23] * m[M30];
    t[M21] = v[M20] * m[M01] + v[M21] * m[M11] + v[M22] * m[M21] + v[M23] * m[M31];
    t[M22] = v[M20] * m[M02] + v[M21] * m[M12] + v[M22] * m[M22] + v[M23] * m[M32];
    t[M23] = v[M20] * m[M03] + v[M21] * m[M13] + v[M22] * m[M23] + v[M23] * m[M33];
    t[M30] = v[M30] * m[M00] + v[M31] * m[M10] + v[M32] * m[M20] + v[M33] * m[M30];
    t[M31] = v[M30] * m[M01] + v[M31] * m[M11] + v[M32] * m[M21] + v[M33] * m[M31];
    t[M32] = v[M30] * m[M02] + v[M31] * m[M12] + v[M32] * m[M22] + v[M33] * m[M32];
    t[M33] = v[M30] * m[M03] + v[M31] * m[M13] + v[M32] * m[M23] + v[M33] * m[M33];
    return this.set(this.temp);
  }
  multiplyLeft(matrix) {
    let t = this.temp;
    let v = this.values;
    let m = matrix.values;
    t[M00] = m[M00] * v[M00] + m[M01] * v[M10] + m[M02] * v[M20] + m[M03] * v[M30];
    t[M01] = m[M00] * v[M01] + m[M01] * v[M11] + m[M02] * v[M21] + m[M03] * v[M31];
    t[M02] = m[M00] * v[M02] + m[M01] * v[M12] + m[M02] * v[M22] + m[M03] * v[M32];
    t[M03] = m[M00] * v[M03] + m[M01] * v[M13] + m[M02] * v[M23] + m[M03] * v[M33];
    t[M10] = m[M10] * v[M00] + m[M11] * v[M10] + m[M12] * v[M20] + m[M13] * v[M30];
    t[M11] = m[M10] * v[M01] + m[M11] * v[M11] + m[M12] * v[M21] + m[M13] * v[M31];
    t[M12] = m[M10] * v[M02] + m[M11] * v[M12] + m[M12] * v[M22] + m[M13] * v[M32];
    t[M13] = m[M10] * v[M03] + m[M11] * v[M13] + m[M12] * v[M23] + m[M13] * v[M33];
    t[M20] = m[M20] * v[M00] + m[M21] * v[M10] + m[M22] * v[M20] + m[M23] * v[M30];
    t[M21] = m[M20] * v[M01] + m[M21] * v[M11] + m[M22] * v[M21] + m[M23] * v[M31];
    t[M22] = m[M20] * v[M02] + m[M21] * v[M12] + m[M22] * v[M22] + m[M23] * v[M32];
    t[M23] = m[M20] * v[M03] + m[M21] * v[M13] + m[M22] * v[M23] + m[M23] * v[M33];
    t[M30] = m[M30] * v[M00] + m[M31] * v[M10] + m[M32] * v[M20] + m[M33] * v[M30];
    t[M31] = m[M30] * v[M01] + m[M31] * v[M11] + m[M32] * v[M21] + m[M33] * v[M31];
    t[M32] = m[M30] * v[M02] + m[M31] * v[M12] + m[M32] * v[M22] + m[M33] * v[M32];
    t[M33] = m[M30] * v[M03] + m[M31] * v[M13] + m[M32] * v[M23] + m[M33] * v[M33];
    return this.set(this.temp);
  }
  lookAt(position, direction, up) {
    let { xAxis, yAxis, zAxis } = Matrix4;
    zAxis.setFrom(direction).normalize();
    xAxis.setFrom(direction).normalize();
    xAxis.cross(up).normalize();
    yAxis.setFrom(xAxis).cross(zAxis).normalize();
    this.identity();
    let val = this.values;
    val[M00] = xAxis.x;
    val[M01] = xAxis.y;
    val[M02] = xAxis.z;
    val[M10] = yAxis.x;
    val[M11] = yAxis.y;
    val[M12] = yAxis.z;
    val[M20] = -zAxis.x;
    val[M21] = -zAxis.y;
    val[M22] = -zAxis.z;
    Matrix4.tmpMatrix.identity();
    Matrix4.tmpMatrix.values[M03] = -position.x;
    Matrix4.tmpMatrix.values[M13] = -position.y;
    Matrix4.tmpMatrix.values[M23] = -position.z;
    this.multiply(Matrix4.tmpMatrix);
    return this;
  }
}
// node_modules/@esotericsoftware/spine-webgl/dist/Shader.js
class Shader {
  vertexShader;
  fragmentShader;
  static MVP_MATRIX = "u_projTrans";
  static POSITION = "a_position";
  static COLOR = "a_color";
  static COLOR2 = "a_color2";
  static TEXCOORDS = "a_texCoords";
  static SAMPLER = "u_texture";
  context;
  vs = null;
  vsSource;
  fs = null;
  fsSource;
  program = null;
  tmp2x2 = new Float32Array(2 * 2);
  tmp3x3 = new Float32Array(3 * 3);
  tmp4x4 = new Float32Array(4 * 4);
  getProgram() {
    return this.program;
  }
  getVertexShader() {
    return this.vertexShader;
  }
  getFragmentShader() {
    return this.fragmentShader;
  }
  getVertexShaderSource() {
    return this.vsSource;
  }
  getFragmentSource() {
    return this.fsSource;
  }
  constructor(context, vertexShader, fragmentShader) {
    this.vertexShader = vertexShader;
    this.fragmentShader = fragmentShader;
    this.vsSource = vertexShader;
    this.fsSource = fragmentShader;
    this.context = context instanceof ManagedWebGLRenderingContext ? context : new ManagedWebGLRenderingContext(context);
    this.context.addRestorable(this);
    this.compile();
  }
  compile() {
    let gl = this.context.gl;
    try {
      this.vs = this.compileShader(gl.VERTEX_SHADER, this.vertexShader);
      if (!this.vs)
        throw new Error("Couldn't compile vertex shader.");
      this.fs = this.compileShader(gl.FRAGMENT_SHADER, this.fragmentShader);
      if (!this.fs)
        throw new Error("Couldn#t compile fragment shader.");
      this.program = this.compileProgram(this.vs, this.fs);
    } catch (e) {
      this.dispose();
      throw e;
    }
  }
  compileShader(type, source) {
    let gl = this.context.gl;
    let shader = gl.createShader(type);
    if (!shader)
      throw new Error("Couldn't create shader.");
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      let error = "Couldn't compile shader: " + gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      if (!gl.isContextLost())
        throw new Error(error);
    }
    return shader;
  }
  compileProgram(vs, fs) {
    let gl = this.context.gl;
    let program = gl.createProgram();
    if (!program)
      throw new Error("Couldn't compile program.");
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      let error = "Couldn't compile shader program: " + gl.getProgramInfoLog(program);
      gl.deleteProgram(program);
      if (!gl.isContextLost())
        throw new Error(error);
    }
    return program;
  }
  restore() {
    this.compile();
  }
  bind() {
    this.context.gl.useProgram(this.program);
  }
  unbind() {
    this.context.gl.useProgram(null);
  }
  setUniformi(uniform, value) {
    this.context.gl.uniform1i(this.getUniformLocation(uniform), value);
  }
  setUniformf(uniform, value) {
    this.context.gl.uniform1f(this.getUniformLocation(uniform), value);
  }
  setUniform2f(uniform, value, value2) {
    this.context.gl.uniform2f(this.getUniformLocation(uniform), value, value2);
  }
  setUniform3f(uniform, value, value2, value3) {
    this.context.gl.uniform3f(this.getUniformLocation(uniform), value, value2, value3);
  }
  setUniform4f(uniform, value, value2, value3, value4) {
    this.context.gl.uniform4f(this.getUniformLocation(uniform), value, value2, value3, value4);
  }
  setUniform2x2f(uniform, value) {
    let gl = this.context.gl;
    this.tmp2x2.set(value);
    gl.uniformMatrix2fv(this.getUniformLocation(uniform), false, this.tmp2x2);
  }
  setUniform3x3f(uniform, value) {
    let gl = this.context.gl;
    this.tmp3x3.set(value);
    gl.uniformMatrix3fv(this.getUniformLocation(uniform), false, this.tmp3x3);
  }
  setUniform4x4f(uniform, value) {
    let gl = this.context.gl;
    this.tmp4x4.set(value);
    gl.uniformMatrix4fv(this.getUniformLocation(uniform), false, this.tmp4x4);
  }
  getUniformLocation(uniform) {
    let gl = this.context.gl;
    if (!this.program)
      throw new Error("Shader not compiled.");
    let location = gl.getUniformLocation(this.program, uniform);
    if (!location && !gl.isContextLost())
      throw new Error(`Couldn't find location for uniform ${uniform}`);
    return location;
  }
  getAttributeLocation(attribute) {
    let gl = this.context.gl;
    if (!this.program)
      throw new Error("Shader not compiled.");
    let location = gl.getAttribLocation(this.program, attribute);
    if (location == -1 && !gl.isContextLost())
      throw new Error(`Couldn't find location for attribute ${attribute}`);
    return location;
  }
  dispose() {
    this.context.removeRestorable(this);
    let gl = this.context.gl;
    if (this.vs) {
      gl.deleteShader(this.vs);
      this.vs = null;
    }
    if (this.fs) {
      gl.deleteShader(this.fs);
      this.fs = null;
    }
    if (this.program) {
      gl.deleteProgram(this.program);
      this.program = null;
    }
  }
  static newColoredTextured(context) {
    let vs = `
attribute vec4 ${Shader.POSITION};
attribute vec4 ${Shader.COLOR};
attribute vec2 ${Shader.TEXCOORDS};
uniform mat4 ${Shader.MVP_MATRIX};
varying vec4 v_color;
varying vec2 v_texCoords;

void main () {
	v_color = ${Shader.COLOR};
	v_texCoords = ${Shader.TEXCOORDS};
	gl_Position = ${Shader.MVP_MATRIX} * ${Shader.POSITION};
}
`;
    let fs = `
#ifdef GL_ES
	#define LOWP lowp
	precision mediump float;
#else
	#define LOWP
#endif
varying LOWP vec4 v_color;
varying vec2 v_texCoords;
uniform sampler2D u_texture;

void main () {
	gl_FragColor = v_color * texture2D(u_texture, v_texCoords);
}
`;
    return new Shader(context, vs, fs);
  }
  static newTwoColoredTextured(context) {
    let vs = `
attribute vec4 ${Shader.POSITION};
attribute vec4 ${Shader.COLOR};
attribute vec4 ${Shader.COLOR2};
attribute vec2 ${Shader.TEXCOORDS};
uniform mat4 ${Shader.MVP_MATRIX};
varying vec4 v_light;
varying vec4 v_dark;
varying vec2 v_texCoords;

void main () {
	v_light = ${Shader.COLOR};
	v_dark = ${Shader.COLOR2};
	v_texCoords = ${Shader.TEXCOORDS};
	gl_Position = ${Shader.MVP_MATRIX} * ${Shader.POSITION};
}
`;
    let fs = `
#ifdef GL_ES
	#define LOWP lowp
	precision mediump float;
#else
	#define LOWP
#endif
varying LOWP vec4 v_light;
varying LOWP vec4 v_dark;
varying vec2 v_texCoords;
uniform sampler2D u_texture;

void main () {
	vec4 texColor = texture2D(u_texture, v_texCoords);
	gl_FragColor.a = texColor.a * v_light.a;
	gl_FragColor.rgb = ((texColor.a - 1.0) * v_dark.a + 1.0 - texColor.rgb) * v_dark.rgb + texColor.rgb * v_light.rgb;
}
`;
    return new Shader(context, vs, fs);
  }
  static newColored(context) {
    let vs = `
attribute vec4 ${Shader.POSITION};
attribute vec4 ${Shader.COLOR};
uniform mat4 ${Shader.MVP_MATRIX};
varying vec4 v_color;

void main () {
	v_color = ${Shader.COLOR};
	gl_Position = ${Shader.MVP_MATRIX} * ${Shader.POSITION};
}
`;
    let fs = `
#ifdef GL_ES
	#define LOWP lowp
	precision mediump float;
#else
	#define LOWP
#endif
varying LOWP vec4 v_color;

void main () {
	gl_FragColor = v_color;
}
`;
    return new Shader(context, vs, fs);
  }
}

// node_modules/@esotericsoftware/spine-webgl/dist/Mesh.js
class Mesh {
  attributes;
  context;
  vertices;
  verticesBuffer = null;
  verticesLength = 0;
  dirtyVertices = false;
  indices;
  indicesBuffer = null;
  indicesLength = 0;
  dirtyIndices = false;
  elementsPerVertex = 0;
  getAttributes() {
    return this.attributes;
  }
  maxVertices() {
    return this.vertices.length / this.elementsPerVertex;
  }
  numVertices() {
    return this.verticesLength / this.elementsPerVertex;
  }
  setVerticesLength(length) {
    this.dirtyVertices = true;
    this.verticesLength = length;
  }
  getVertices() {
    return this.vertices;
  }
  maxIndices() {
    return this.indices.length;
  }
  numIndices() {
    return this.indicesLength;
  }
  setIndicesLength(length) {
    this.dirtyIndices = true;
    this.indicesLength = length;
  }
  getIndices() {
    return this.indices;
  }
  getVertexSizeInFloats() {
    let size = 0;
    for (var i = 0;i < this.attributes.length; i++) {
      let attribute = this.attributes[i];
      size += attribute.numElements;
    }
    return size;
  }
  constructor(context, attributes, maxVertices, maxIndices) {
    this.attributes = attributes;
    this.context = context instanceof ManagedWebGLRenderingContext ? context : new ManagedWebGLRenderingContext(context);
    this.elementsPerVertex = 0;
    for (let i = 0;i < attributes.length; i++) {
      this.elementsPerVertex += attributes[i].numElements;
    }
    this.vertices = new Float32Array(maxVertices * this.elementsPerVertex);
    this.indices = new Uint16Array(maxIndices);
    this.context.addRestorable(this);
  }
  setVertices(vertices) {
    this.dirtyVertices = true;
    if (vertices.length > this.vertices.length)
      throw Error("Mesh can't store more than " + this.maxVertices() + " vertices");
    this.vertices.set(vertices, 0);
    this.verticesLength = vertices.length;
  }
  setIndices(indices) {
    this.dirtyIndices = true;
    if (indices.length > this.indices.length)
      throw Error("Mesh can't store more than " + this.maxIndices() + " indices");
    this.indices.set(indices, 0);
    this.indicesLength = indices.length;
  }
  draw(shader, primitiveType) {
    this.drawWithOffset(shader, primitiveType, 0, this.indicesLength > 0 ? this.indicesLength : this.verticesLength / this.elementsPerVertex);
  }
  drawWithOffset(shader, primitiveType, offset, count) {
    let gl = this.context.gl;
    if (this.dirtyVertices || this.dirtyIndices)
      this.update();
    this.bind(shader);
    if (this.indicesLength > 0) {
      gl.drawElements(primitiveType, count, gl.UNSIGNED_SHORT, offset * 2);
    } else {
      gl.drawArrays(primitiveType, offset, count);
    }
    this.unbind(shader);
  }
  bind(shader) {
    let gl = this.context.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.verticesBuffer);
    let offset = 0;
    for (let i = 0;i < this.attributes.length; i++) {
      let attrib = this.attributes[i];
      let location = shader.getAttributeLocation(attrib.name);
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, attrib.numElements, gl.FLOAT, false, this.elementsPerVertex * 4, offset * 4);
      offset += attrib.numElements;
    }
    if (this.indicesLength > 0)
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indicesBuffer);
  }
  unbind(shader) {
    let gl = this.context.gl;
    for (let i = 0;i < this.attributes.length; i++) {
      let attrib = this.attributes[i];
      let location = shader.getAttributeLocation(attrib.name);
      gl.disableVertexAttribArray(location);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    if (this.indicesLength > 0)
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);
  }
  update() {
    let gl = this.context.gl;
    if (this.dirtyVertices) {
      if (!this.verticesBuffer) {
        this.verticesBuffer = gl.createBuffer();
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, this.verticesBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, this.vertices.subarray(0, this.verticesLength), gl.DYNAMIC_DRAW);
      this.dirtyVertices = false;
    }
    if (this.dirtyIndices) {
      if (!this.indicesBuffer) {
        this.indicesBuffer = gl.createBuffer();
      }
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indicesBuffer);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, this.indices.subarray(0, this.indicesLength), gl.DYNAMIC_DRAW);
      this.dirtyIndices = false;
    }
  }
  restore() {
    this.verticesBuffer = null;
    this.indicesBuffer = null;
    this.update();
  }
  dispose() {
    this.context.removeRestorable(this);
    let gl = this.context.gl;
    gl.deleteBuffer(this.verticesBuffer);
    gl.deleteBuffer(this.indicesBuffer);
  }
}

class VertexAttribute {
  name;
  type;
  numElements;
  constructor(name, type, numElements) {
    this.name = name;
    this.type = type;
    this.numElements = numElements;
  }
}

class Position2Attribute extends VertexAttribute {
  constructor() {
    super(Shader.POSITION, VertexAttributeType.Float, 2);
  }
}
class TexCoordAttribute extends VertexAttribute {
  constructor(unit = 0) {
    super(Shader.TEXCOORDS + (unit == 0 ? "" : unit), VertexAttributeType.Float, 2);
  }
}

class ColorAttribute extends VertexAttribute {
  constructor() {
    super(Shader.COLOR, VertexAttributeType.Float, 4);
  }
}

class Color2Attribute extends VertexAttribute {
  constructor() {
    super(Shader.COLOR2, VertexAttributeType.Float, 4);
  }
}
var VertexAttributeType;
(function(VertexAttributeType) {
  VertexAttributeType[VertexAttributeType["Float"] = 0] = "Float";
})(VertexAttributeType || (VertexAttributeType = {}));

// node_modules/@esotericsoftware/spine-webgl/dist/PolygonBatcher.js
var GL_ONE = 1;
var GL_ONE_MINUS_SRC_COLOR = 769;
var GL_SRC_ALPHA = 770;
var GL_ONE_MINUS_SRC_ALPHA = 771;
var GL_DST_COLOR = 774;

class PolygonBatcher {
  static disableCulling = false;
  context;
  drawCalls = 0;
  static globalDrawCalls = 0;
  isDrawing = false;
  mesh;
  shader = null;
  lastTexture = null;
  verticesLength = 0;
  indicesLength = 0;
  srcColorBlend;
  srcAlphaBlend;
  dstBlend;
  cullWasEnabled = false;
  constructor(context, twoColorTint = true, maxVertices = 10920) {
    if (maxVertices > 10920)
      throw new Error("Can't have more than 10920 triangles per batch: " + maxVertices);
    this.context = context instanceof ManagedWebGLRenderingContext ? context : new ManagedWebGLRenderingContext(context);
    let attributes = twoColorTint ? [new Position2Attribute, new ColorAttribute, new TexCoordAttribute, new Color2Attribute] : [new Position2Attribute, new ColorAttribute, new TexCoordAttribute];
    this.mesh = new Mesh(context, attributes, maxVertices, maxVertices * 3);
    let gl = this.context.gl;
    this.srcColorBlend = gl.SRC_ALPHA;
    this.srcAlphaBlend = gl.ONE;
    this.dstBlend = gl.ONE_MINUS_SRC_ALPHA;
  }
  begin(shader) {
    if (this.isDrawing)
      throw new Error("PolygonBatch is already drawing. Call PolygonBatch.end() before calling PolygonBatch.begin()");
    this.drawCalls = 0;
    this.shader = shader;
    this.lastTexture = null;
    this.isDrawing = true;
    let gl = this.context.gl;
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(this.srcColorBlend, this.dstBlend, this.srcAlphaBlend, this.dstBlend);
    if (PolygonBatcher.disableCulling) {
      this.cullWasEnabled = gl.isEnabled(gl.CULL_FACE);
      if (this.cullWasEnabled)
        gl.disable(gl.CULL_FACE);
    }
  }
  static blendModesGL = [
    { srcRgb: GL_SRC_ALPHA, srcRgbPma: GL_ONE, dstRgb: GL_ONE_MINUS_SRC_ALPHA, srcAlpha: GL_ONE },
    { srcRgb: GL_SRC_ALPHA, srcRgbPma: GL_ONE, dstRgb: GL_ONE, srcAlpha: GL_ONE },
    { srcRgb: GL_DST_COLOR, srcRgbPma: GL_DST_COLOR, dstRgb: GL_ONE_MINUS_SRC_ALPHA, srcAlpha: GL_ONE },
    { srcRgb: GL_ONE, srcRgbPma: GL_ONE, dstRgb: GL_ONE_MINUS_SRC_COLOR, srcAlpha: GL_ONE }
  ];
  setBlendMode(blendMode, premultipliedAlpha) {
    const blendModeGL = PolygonBatcher.blendModesGL[blendMode];
    const srcColorBlend = premultipliedAlpha ? blendModeGL.srcRgbPma : blendModeGL.srcRgb;
    const srcAlphaBlend = blendModeGL.srcAlpha;
    const dstBlend = blendModeGL.dstRgb;
    if (this.srcColorBlend == srcColorBlend && this.srcAlphaBlend == srcAlphaBlend && this.dstBlend == dstBlend)
      return;
    this.srcColorBlend = srcColorBlend;
    this.srcAlphaBlend = srcAlphaBlend;
    this.dstBlend = dstBlend;
    if (this.isDrawing) {
      this.flush();
    }
    let gl = this.context.gl;
    gl.blendFuncSeparate(srcColorBlend, dstBlend, srcAlphaBlend, dstBlend);
  }
  draw(texture, vertices, indices) {
    if (texture != this.lastTexture) {
      this.flush();
      this.lastTexture = texture;
    } else if (this.verticesLength + vertices.length > this.mesh.getVertices().length || this.indicesLength + indices.length > this.mesh.getIndices().length) {
      this.flush();
    }
    let indexStart = this.mesh.numVertices();
    this.mesh.getVertices().set(vertices, this.verticesLength);
    this.verticesLength += vertices.length;
    this.mesh.setVerticesLength(this.verticesLength);
    let indicesArray = this.mesh.getIndices();
    for (let i = this.indicesLength, j = 0;j < indices.length; i++, j++)
      indicesArray[i] = indices[j] + indexStart;
    this.indicesLength += indices.length;
    this.mesh.setIndicesLength(this.indicesLength);
  }
  flush() {
    if (this.verticesLength == 0)
      return;
    if (!this.lastTexture)
      throw new Error("No texture set.");
    if (!this.shader)
      throw new Error("No shader set.");
    this.lastTexture.bind();
    this.mesh.draw(this.shader, this.context.gl.TRIANGLES);
    this.verticesLength = 0;
    this.indicesLength = 0;
    this.mesh.setVerticesLength(0);
    this.mesh.setIndicesLength(0);
    this.drawCalls++;
    PolygonBatcher.globalDrawCalls++;
  }
  end() {
    if (!this.isDrawing)
      throw new Error("PolygonBatch is not drawing. Call PolygonBatch.begin() before calling PolygonBatch.end()");
    if (this.verticesLength > 0 || this.indicesLength > 0)
      this.flush();
    this.shader = null;
    this.lastTexture = null;
    this.isDrawing = false;
    let gl = this.context.gl;
    gl.disable(gl.BLEND);
    if (PolygonBatcher.disableCulling) {
      if (this.cullWasEnabled)
        gl.enable(gl.CULL_FACE);
    }
  }
  getDrawCalls() {
    return this.drawCalls;
  }
  static getAndResetGlobalDrawCalls() {
    let result = PolygonBatcher.globalDrawCalls;
    PolygonBatcher.globalDrawCalls = 0;
    return result;
  }
  dispose() {
    this.mesh.dispose();
  }
}

// node_modules/@esotericsoftware/spine-webgl/dist/ShapeRenderer.js
class ShapeRenderer {
  context;
  isDrawing = false;
  mesh;
  shapeType = ShapeType.Filled;
  color = new Color(1, 1, 1, 1);
  shader = null;
  vertexIndex = 0;
  tmp = new Vector2;
  srcColorBlend;
  srcAlphaBlend;
  dstBlend;
  constructor(context, maxVertices = 10920) {
    if (maxVertices > 10920)
      throw new Error("Can't have more than 10920 triangles per batch: " + maxVertices);
    this.context = context instanceof ManagedWebGLRenderingContext ? context : new ManagedWebGLRenderingContext(context);
    this.mesh = new Mesh(context, [new Position2Attribute, new ColorAttribute], maxVertices, 0);
    let gl = this.context.gl;
    this.srcColorBlend = gl.SRC_ALPHA;
    this.srcAlphaBlend = gl.ONE;
    this.dstBlend = gl.ONE_MINUS_SRC_ALPHA;
  }
  begin(shader) {
    if (this.isDrawing)
      throw new Error("ShapeRenderer.begin() has already been called");
    this.shader = shader;
    this.vertexIndex = 0;
    this.isDrawing = true;
    let gl = this.context.gl;
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(this.srcColorBlend, this.dstBlend, this.srcAlphaBlend, this.dstBlend);
  }
  setBlendMode(srcColorBlend, srcAlphaBlend, dstBlend) {
    this.srcColorBlend = srcColorBlend;
    this.srcAlphaBlend = srcAlphaBlend;
    this.dstBlend = dstBlend;
    if (this.isDrawing) {
      this.flush();
      let gl = this.context.gl;
      gl.blendFuncSeparate(srcColorBlend, dstBlend, srcAlphaBlend, dstBlend);
    }
  }
  setColor(color) {
    this.color.setFromColor(color);
  }
  setColorWith(r, g, b, a) {
    this.color.set(r, g, b, a);
  }
  point(x, y, color) {
    this.check(ShapeType.Point, 1);
    if (!color)
      color = this.color;
    this.vertex(x, y, color);
  }
  line(x, y, x2, y2, color) {
    this.check(ShapeType.Line, 2);
    let vertices = this.mesh.getVertices();
    let idx = this.vertexIndex;
    if (!color)
      color = this.color;
    this.vertex(x, y, color);
    this.vertex(x2, y2, color);
  }
  triangle(filled, x, y, x2, y2, x3, y3, color, color2, color3) {
    this.check(filled ? ShapeType.Filled : ShapeType.Line, 3);
    let vertices = this.mesh.getVertices();
    let idx = this.vertexIndex;
    if (!color)
      color = this.color;
    if (!color2)
      color2 = this.color;
    if (!color3)
      color3 = this.color;
    if (filled) {
      this.vertex(x, y, color);
      this.vertex(x2, y2, color2);
      this.vertex(x3, y3, color3);
    } else {
      this.vertex(x, y, color);
      this.vertex(x2, y2, color2);
      this.vertex(x2, y2, color);
      this.vertex(x3, y3, color2);
      this.vertex(x3, y3, color);
      this.vertex(x, y, color2);
    }
  }
  quad(filled, x, y, x2, y2, x3, y3, x4, y4, color, color2, color3, color4) {
    this.check(filled ? ShapeType.Filled : ShapeType.Line, 3);
    let vertices = this.mesh.getVertices();
    let idx = this.vertexIndex;
    if (!color)
      color = this.color;
    if (!color2)
      color2 = this.color;
    if (!color3)
      color3 = this.color;
    if (!color4)
      color4 = this.color;
    if (filled) {
      this.vertex(x, y, color);
      this.vertex(x2, y2, color2);
      this.vertex(x3, y3, color3);
      this.vertex(x3, y3, color3);
      this.vertex(x4, y4, color4);
      this.vertex(x, y, color);
    } else {
      this.vertex(x, y, color);
      this.vertex(x2, y2, color2);
      this.vertex(x2, y2, color2);
      this.vertex(x3, y3, color3);
      this.vertex(x3, y3, color3);
      this.vertex(x4, y4, color4);
      this.vertex(x4, y4, color4);
      this.vertex(x, y, color);
    }
  }
  rect(filled, x, y, width, height, color) {
    this.quad(filled, x, y, x + width, y, x + width, y + height, x, y + height, color, color, color, color);
  }
  rectLine(filled, x1, y1, x2, y2, width, color) {
    this.check(filled ? ShapeType.Filled : ShapeType.Line, 8);
    if (!color)
      color = this.color;
    let t = this.tmp.set(y2 - y1, x1 - x2);
    t.normalize();
    width *= 0.5;
    let tx = t.x * width;
    let ty = t.y * width;
    if (!filled) {
      this.vertex(x1 + tx, y1 + ty, color);
      this.vertex(x1 - tx, y1 - ty, color);
      this.vertex(x2 + tx, y2 + ty, color);
      this.vertex(x2 - tx, y2 - ty, color);
      this.vertex(x2 + tx, y2 + ty, color);
      this.vertex(x1 + tx, y1 + ty, color);
      this.vertex(x2 - tx, y2 - ty, color);
      this.vertex(x1 - tx, y1 - ty, color);
    } else {
      this.vertex(x1 + tx, y1 + ty, color);
      this.vertex(x1 - tx, y1 - ty, color);
      this.vertex(x2 + tx, y2 + ty, color);
      this.vertex(x2 - tx, y2 - ty, color);
      this.vertex(x2 + tx, y2 + ty, color);
      this.vertex(x1 - tx, y1 - ty, color);
    }
  }
  x(x, y, size) {
    this.line(x - size, y - size, x + size, y + size);
    this.line(x - size, y + size, x + size, y - size);
  }
  polygon(polygonVertices, offset, count, color) {
    if (count < 3)
      throw new Error("Polygon must contain at least 3 vertices");
    this.check(ShapeType.Line, count * 2);
    if (!color)
      color = this.color;
    let vertices = this.mesh.getVertices();
    let idx = this.vertexIndex;
    offset <<= 1;
    count <<= 1;
    let firstX = polygonVertices[offset];
    let firstY = polygonVertices[offset + 1];
    let last = offset + count;
    for (let i = offset, n = offset + count - 2;i < n; i += 2) {
      let x1 = polygonVertices[i];
      let y1 = polygonVertices[i + 1];
      let x2 = 0;
      let y2 = 0;
      if (i + 2 >= last) {
        x2 = firstX;
        y2 = firstY;
      } else {
        x2 = polygonVertices[i + 2];
        y2 = polygonVertices[i + 3];
      }
      this.vertex(x1, y1, color);
      this.vertex(x2, y2, color);
    }
  }
  circle(filled, x, y, radius, color, segments = 0) {
    if (segments == 0)
      segments = Math.max(1, 6 * MathUtils.cbrt(radius) | 0);
    if (segments <= 0)
      throw new Error("segments must be > 0.");
    if (!color)
      color = this.color;
    let angle = 2 * MathUtils.PI / segments;
    let cos = Math.cos(angle);
    let sin = Math.sin(angle);
    let cx = radius, cy = 0;
    if (!filled) {
      this.check(ShapeType.Line, segments * 2 + 2);
      for (let i = 0;i < segments; i++) {
        this.vertex(x + cx, y + cy, color);
        let temp = cx;
        cx = cos * cx - sin * cy;
        cy = sin * temp + cos * cy;
        this.vertex(x + cx, y + cy, color);
      }
      this.vertex(x + cx, y + cy, color);
    } else {
      this.check(ShapeType.Filled, segments * 3 + 3);
      segments--;
      for (let i = 0;i < segments; i++) {
        this.vertex(x, y, color);
        this.vertex(x + cx, y + cy, color);
        let temp = cx;
        cx = cos * cx - sin * cy;
        cy = sin * temp + cos * cy;
        this.vertex(x + cx, y + cy, color);
      }
      this.vertex(x, y, color);
      this.vertex(x + cx, y + cy, color);
    }
    let temp = cx;
    cx = radius;
    cy = 0;
    this.vertex(x + cx, y + cy, color);
  }
  curve(x1, y1, cx1, cy1, cx2, cy2, x2, y2, segments, color) {
    this.check(ShapeType.Line, segments * 2 + 2);
    if (!color)
      color = this.color;
    let subdiv_step = 1 / segments;
    let subdiv_step2 = subdiv_step * subdiv_step;
    let subdiv_step3 = subdiv_step * subdiv_step * subdiv_step;
    let pre1 = 3 * subdiv_step;
    let pre2 = 3 * subdiv_step2;
    let pre4 = 6 * subdiv_step2;
    let pre5 = 6 * subdiv_step3;
    let tmp1x = x1 - cx1 * 2 + cx2;
    let tmp1y = y1 - cy1 * 2 + cy2;
    let tmp2x = (cx1 - cx2) * 3 - x1 + x2;
    let tmp2y = (cy1 - cy2) * 3 - y1 + y2;
    let fx = x1;
    let fy = y1;
    let dfx = (cx1 - x1) * pre1 + tmp1x * pre2 + tmp2x * subdiv_step3;
    let dfy = (cy1 - y1) * pre1 + tmp1y * pre2 + tmp2y * subdiv_step3;
    let ddfx = tmp1x * pre4 + tmp2x * pre5;
    let ddfy = tmp1y * pre4 + tmp2y * pre5;
    let dddfx = tmp2x * pre5;
    let dddfy = tmp2y * pre5;
    while (segments-- > 0) {
      this.vertex(fx, fy, color);
      fx += dfx;
      fy += dfy;
      dfx += ddfx;
      dfy += ddfy;
      ddfx += dddfx;
      ddfy += dddfy;
      this.vertex(fx, fy, color);
    }
    this.vertex(fx, fy, color);
    this.vertex(x2, y2, color);
  }
  vertex(x, y, color) {
    let idx = this.vertexIndex;
    let vertices = this.mesh.getVertices();
    vertices[idx++] = x;
    vertices[idx++] = y;
    vertices[idx++] = color.r;
    vertices[idx++] = color.g;
    vertices[idx++] = color.b;
    vertices[idx++] = color.a;
    this.vertexIndex = idx;
  }
  end() {
    if (!this.isDrawing)
      throw new Error("ShapeRenderer.begin() has not been called");
    this.flush();
    let gl = this.context.gl;
    gl.disable(gl.BLEND);
    this.isDrawing = false;
  }
  flush() {
    if (this.vertexIndex == 0)
      return;
    if (!this.shader)
      throw new Error("No shader set.");
    this.mesh.setVerticesLength(this.vertexIndex);
    this.mesh.draw(this.shader, this.shapeType);
    this.vertexIndex = 0;
  }
  check(shapeType, numVertices) {
    if (!this.isDrawing)
      throw new Error("ShapeRenderer.begin() has not been called");
    if (this.shapeType == shapeType) {
      if (this.mesh.maxVertices() - this.mesh.numVertices() < numVertices)
        this.flush();
      else
        return;
    } else {
      this.flush();
      this.shapeType = shapeType;
    }
  }
  dispose() {
    this.mesh.dispose();
  }
}
var ShapeType;
(function(ShapeType) {
  ShapeType[ShapeType["Point"] = 0] = "Point";
  ShapeType[ShapeType["Line"] = 1] = "Line";
  ShapeType[ShapeType["Filled"] = 4] = "Filled";
})(ShapeType || (ShapeType = {}));

// node_modules/@esotericsoftware/spine-webgl/dist/SkeletonDebugRenderer.js
class SkeletonDebugRenderer {
  boneLineColor = new Color(1, 0, 0, 1);
  boneOriginColor = new Color(0, 1, 0, 1);
  attachmentLineColor = new Color(0, 0, 1, 0.5);
  triangleLineColor = new Color(1, 0.64, 0, 0.5);
  pathColor = new Color().setFromString("FF7F00");
  clipColor = new Color(0.8, 0, 0, 2);
  aabbColor = new Color(0, 1, 0, 0.5);
  drawBones = true;
  drawRegionAttachments = true;
  drawBoundingBoxes = true;
  drawMeshHull = true;
  drawMeshTriangles = true;
  drawPaths = true;
  drawSkeletonXY = false;
  drawClipping = true;
  premultipliedAlpha = false;
  scale = 1;
  boneWidth = 2;
  context;
  bounds = new SkeletonBounds;
  temp = new Array;
  vertices = Utils.newFloatArray(2 * 1024);
  static LIGHT_GRAY = new Color(192 / 255, 192 / 255, 192 / 255, 1);
  static GREEN = new Color(0, 1, 0, 1);
  constructor(context) {
    this.context = context instanceof ManagedWebGLRenderingContext ? context : new ManagedWebGLRenderingContext(context);
  }
  draw(shapes, skeleton, ignoredBones) {
    let skeletonX = skeleton.x;
    let skeletonY = skeleton.y;
    let gl = this.context.gl;
    let srcFunc = this.premultipliedAlpha ? gl.ONE : gl.SRC_ALPHA;
    shapes.setBlendMode(srcFunc, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    let bones = skeleton.bones;
    if (this.drawBones) {
      shapes.setColor(this.boneLineColor);
      for (let i = 0, n = bones.length;i < n; i++) {
        let bone = bones[i];
        if (ignoredBones && ignoredBones.indexOf(bone.data.name) > -1)
          continue;
        if (!bone.parent)
          continue;
        let x = bone.data.length * bone.a + bone.worldX;
        let y = bone.data.length * bone.c + bone.worldY;
        shapes.rectLine(true, bone.worldX, bone.worldY, x, y, this.boneWidth * this.scale);
      }
      if (this.drawSkeletonXY)
        shapes.x(skeletonX, skeletonY, 4 * this.scale);
    }
    if (this.drawRegionAttachments) {
      shapes.setColor(this.attachmentLineColor);
      let slots = skeleton.slots;
      for (let i = 0, n = slots.length;i < n; i++) {
        let slot = slots[i];
        let attachment = slot.getAttachment();
        if (attachment instanceof RegionAttachment) {
          let regionAttachment = attachment;
          let vertices = this.vertices;
          regionAttachment.computeWorldVertices(slot, vertices, 0, 2);
          shapes.line(vertices[0], vertices[1], vertices[2], vertices[3]);
          shapes.line(vertices[2], vertices[3], vertices[4], vertices[5]);
          shapes.line(vertices[4], vertices[5], vertices[6], vertices[7]);
          shapes.line(vertices[6], vertices[7], vertices[0], vertices[1]);
        }
      }
    }
    if (this.drawMeshHull || this.drawMeshTriangles) {
      let slots = skeleton.slots;
      for (let i = 0, n = slots.length;i < n; i++) {
        let slot = slots[i];
        if (!slot.bone.active)
          continue;
        let attachment = slot.getAttachment();
        if (!(attachment instanceof MeshAttachment))
          continue;
        let mesh = attachment;
        let vertices = this.vertices;
        mesh.computeWorldVertices(slot, 0, mesh.worldVerticesLength, vertices, 0, 2);
        let triangles = mesh.triangles;
        let hullLength = mesh.hullLength;
        if (this.drawMeshTriangles) {
          shapes.setColor(this.triangleLineColor);
          for (let ii = 0, nn = triangles.length;ii < nn; ii += 3) {
            let v1 = triangles[ii] * 2, v2 = triangles[ii + 1] * 2, v3 = triangles[ii + 2] * 2;
            shapes.triangle(false, vertices[v1], vertices[v1 + 1], vertices[v2], vertices[v2 + 1], vertices[v3], vertices[v3 + 1]);
          }
        }
        if (this.drawMeshHull && hullLength > 0) {
          shapes.setColor(this.attachmentLineColor);
          hullLength = (hullLength >> 1) * 2;
          let lastX = vertices[hullLength - 2], lastY = vertices[hullLength - 1];
          for (let ii = 0, nn = hullLength;ii < nn; ii += 2) {
            let x = vertices[ii], y = vertices[ii + 1];
            shapes.line(x, y, lastX, lastY);
            lastX = x;
            lastY = y;
          }
        }
      }
    }
    if (this.drawBoundingBoxes) {
      let bounds = this.bounds;
      bounds.update(skeleton, true);
      shapes.setColor(this.aabbColor);
      shapes.rect(false, bounds.minX, bounds.minY, bounds.getWidth(), bounds.getHeight());
      let polygons = bounds.polygons;
      let boxes = bounds.boundingBoxes;
      for (let i = 0, n = polygons.length;i < n; i++) {
        let polygon = polygons[i];
        shapes.setColor(boxes[i].color);
        shapes.polygon(polygon, 0, polygon.length);
      }
    }
    if (this.drawPaths) {
      let slots = skeleton.slots;
      for (let i = 0, n = slots.length;i < n; i++) {
        let slot = slots[i];
        if (!slot.bone.active)
          continue;
        let attachment = slot.getAttachment();
        if (!(attachment instanceof PathAttachment))
          continue;
        let path = attachment;
        let nn = path.worldVerticesLength;
        let world = this.temp = Utils.setArraySize(this.temp, nn, 0);
        path.computeWorldVertices(slot, 0, nn, world, 0, 2);
        let color = this.pathColor;
        let x1 = world[2], y1 = world[3], x2 = 0, y2 = 0;
        if (path.closed) {
          shapes.setColor(color);
          let cx1 = world[0], cy1 = world[1], cx2 = world[nn - 2], cy2 = world[nn - 1];
          x2 = world[nn - 4];
          y2 = world[nn - 3];
          shapes.curve(x1, y1, cx1, cy1, cx2, cy2, x2, y2, 32);
          shapes.setColor(SkeletonDebugRenderer.LIGHT_GRAY);
          shapes.line(x1, y1, cx1, cy1);
          shapes.line(x2, y2, cx2, cy2);
        }
        nn -= 4;
        for (let ii = 4;ii < nn; ii += 6) {
          let cx1 = world[ii], cy1 = world[ii + 1], cx2 = world[ii + 2], cy2 = world[ii + 3];
          x2 = world[ii + 4];
          y2 = world[ii + 5];
          shapes.setColor(color);
          shapes.curve(x1, y1, cx1, cy1, cx2, cy2, x2, y2, 32);
          shapes.setColor(SkeletonDebugRenderer.LIGHT_GRAY);
          shapes.line(x1, y1, cx1, cy1);
          shapes.line(x2, y2, cx2, cy2);
          x1 = x2;
          y1 = y2;
        }
      }
    }
    if (this.drawBones) {
      shapes.setColor(this.boneOriginColor);
      for (let i = 0, n = bones.length;i < n; i++) {
        let bone = bones[i];
        if (ignoredBones && ignoredBones.indexOf(bone.data.name) > -1)
          continue;
        shapes.circle(true, bone.worldX, bone.worldY, 3 * this.scale, this.boneOriginColor, 8);
      }
    }
    if (this.drawClipping) {
      let slots = skeleton.slots;
      shapes.setColor(this.clipColor);
      for (let i = 0, n = slots.length;i < n; i++) {
        let slot = slots[i];
        if (!slot.bone.active)
          continue;
        let attachment = slot.getAttachment();
        if (!(attachment instanceof ClippingAttachment))
          continue;
        let clip = attachment;
        let nn = clip.worldVerticesLength;
        let world = this.temp = Utils.setArraySize(this.temp, nn, 0);
        clip.computeWorldVertices(slot, 0, nn, world, 0, 2);
        for (let i = 0, n = world.length;i < n; i += 2) {
          let x = world[i];
          let y = world[i + 1];
          let x2 = world[(i + 2) % world.length];
          let y2 = world[(i + 3) % world.length];
          shapes.line(x, y, x2, y2);
        }
      }
    }
  }
  dispose() {}
}

// node_modules/@esotericsoftware/spine-webgl/dist/SkeletonRenderer.js
class Renderable {
  vertices;
  numVertices;
  numFloats;
  constructor(vertices, numVertices, numFloats) {
    this.vertices = vertices;
    this.numVertices = numVertices;
    this.numFloats = numFloats;
  }
}

class SkeletonRenderer {
  static QUAD_TRIANGLES = [0, 1, 2, 2, 3, 0];
  premultipliedAlpha = false;
  tempColor = new Color;
  tempColor2 = new Color;
  vertices;
  vertexSize = 2 + 2 + 4;
  twoColorTint = false;
  renderable = new Renderable([], 0, 0);
  clipper = new SkeletonClipping;
  temp = new Vector2;
  temp2 = new Vector2;
  temp3 = new Color;
  temp4 = new Color;
  constructor(context, twoColorTint = true) {
    this.twoColorTint = twoColorTint;
    if (twoColorTint)
      this.vertexSize += 4;
    this.vertices = Utils.newFloatArray(this.vertexSize * 1024);
  }
  draw(batcher, skeleton, slotRangeStart = -1, slotRangeEnd = -1, transformer = null) {
    let clipper = this.clipper;
    let premultipliedAlpha = this.premultipliedAlpha;
    let twoColorTint = this.twoColorTint;
    let blendMode = null;
    let renderable = this.renderable;
    let uvs;
    let triangles;
    let drawOrder = skeleton.drawOrder;
    let attachmentColor;
    let skeletonColor = skeleton.color;
    let vertexSize = twoColorTint ? 12 : 8;
    let inRange = false;
    if (slotRangeStart == -1)
      inRange = true;
    for (let i = 0, n = drawOrder.length;i < n; i++) {
      let clippedVertexSize = clipper.isClipping() ? 2 : vertexSize;
      let slot = drawOrder[i];
      if (!slot.bone.active) {
        clipper.clipEndWithSlot(slot);
        continue;
      }
      if (slotRangeStart >= 0 && slotRangeStart == slot.data.index) {
        inRange = true;
      }
      if (!inRange) {
        clipper.clipEndWithSlot(slot);
        continue;
      }
      if (slotRangeEnd >= 0 && slotRangeEnd == slot.data.index) {
        inRange = false;
      }
      let attachment = slot.getAttachment();
      let texture;
      if (attachment instanceof RegionAttachment) {
        let region = attachment;
        renderable.vertices = this.vertices;
        renderable.numVertices = 4;
        renderable.numFloats = clippedVertexSize << 2;
        region.computeWorldVertices(slot, renderable.vertices, 0, clippedVertexSize);
        triangles = SkeletonRenderer.QUAD_TRIANGLES;
        uvs = region.uvs;
        texture = region.region.texture;
        attachmentColor = region.color;
      } else if (attachment instanceof MeshAttachment) {
        let mesh = attachment;
        renderable.vertices = this.vertices;
        renderable.numVertices = mesh.worldVerticesLength >> 1;
        renderable.numFloats = renderable.numVertices * clippedVertexSize;
        if (renderable.numFloats > renderable.vertices.length) {
          renderable.vertices = this.vertices = Utils.newFloatArray(renderable.numFloats);
        }
        mesh.computeWorldVertices(slot, 0, mesh.worldVerticesLength, renderable.vertices, 0, clippedVertexSize);
        triangles = mesh.triangles;
        texture = mesh.region.texture;
        uvs = mesh.uvs;
        attachmentColor = mesh.color;
      } else if (attachment instanceof ClippingAttachment) {
        let clip = attachment;
        clipper.clipStart(slot, clip);
        continue;
      } else {
        clipper.clipEndWithSlot(slot);
        continue;
      }
      if (texture) {
        let slotColor = slot.color;
        let finalColor = this.tempColor;
        finalColor.r = skeletonColor.r * slotColor.r * attachmentColor.r;
        finalColor.g = skeletonColor.g * slotColor.g * attachmentColor.g;
        finalColor.b = skeletonColor.b * slotColor.b * attachmentColor.b;
        finalColor.a = skeletonColor.a * slotColor.a * attachmentColor.a;
        if (premultipliedAlpha) {
          finalColor.r *= finalColor.a;
          finalColor.g *= finalColor.a;
          finalColor.b *= finalColor.a;
        }
        let darkColor = this.tempColor2;
        if (!slot.darkColor)
          darkColor.set(0, 0, 0, 1);
        else {
          if (premultipliedAlpha) {
            darkColor.r = slot.darkColor.r * finalColor.a;
            darkColor.g = slot.darkColor.g * finalColor.a;
            darkColor.b = slot.darkColor.b * finalColor.a;
          } else {
            darkColor.setFromColor(slot.darkColor);
          }
          darkColor.a = premultipliedAlpha ? 1 : 0;
        }
        let slotBlendMode = slot.data.blendMode;
        if (slotBlendMode != blendMode) {
          blendMode = slotBlendMode;
          batcher.setBlendMode(blendMode, premultipliedAlpha);
        }
        if (clipper.isClipping()) {
          clipper.clipTriangles(renderable.vertices, renderable.numFloats, triangles, triangles.length, uvs, finalColor, darkColor, twoColorTint);
          let clippedVertices = new Float32Array(clipper.clippedVertices);
          let clippedTriangles = clipper.clippedTriangles;
          if (transformer)
            transformer(clippedVertices, clippedVertices.length, vertexSize);
          batcher.draw(texture, clippedVertices, clippedTriangles);
        } else {
          let verts = renderable.vertices;
          if (!twoColorTint) {
            for (let v = 2, u = 0, n = renderable.numFloats;v < n; v += vertexSize, u += 2) {
              verts[v] = finalColor.r;
              verts[v + 1] = finalColor.g;
              verts[v + 2] = finalColor.b;
              verts[v + 3] = finalColor.a;
              verts[v + 4] = uvs[u];
              verts[v + 5] = uvs[u + 1];
            }
          } else {
            for (let v = 2, u = 0, n = renderable.numFloats;v < n; v += vertexSize, u += 2) {
              verts[v] = finalColor.r;
              verts[v + 1] = finalColor.g;
              verts[v + 2] = finalColor.b;
              verts[v + 3] = finalColor.a;
              verts[v + 4] = uvs[u];
              verts[v + 5] = uvs[u + 1];
              verts[v + 6] = darkColor.r;
              verts[v + 7] = darkColor.g;
              verts[v + 8] = darkColor.b;
              verts[v + 9] = darkColor.a;
            }
          }
          let view = renderable.vertices.subarray(0, renderable.numFloats);
          if (transformer)
            transformer(renderable.vertices, renderable.numFloats, vertexSize);
          batcher.draw(texture, view, triangles);
        }
      }
      clipper.clipEndWithSlot(slot);
    }
    clipper.clipEnd();
  }
}

// node_modules/@esotericsoftware/spine-webgl/dist/SceneRenderer.js
var WHITE = new Color(1, 1, 1, 1);
var ResizeMode;
(function(ResizeMode) {
  ResizeMode[ResizeMode["Stretch"] = 0] = "Stretch";
  ResizeMode[ResizeMode["Expand"] = 1] = "Expand";
  ResizeMode[ResizeMode["Fit"] = 2] = "Fit";
})(ResizeMode || (ResizeMode = {}));
// src/frontend/thumbnail.ts
var THUMBNAIL_PIXELS = 256;
var THUMBNAIL_RENDER_PIXELS = 512;
function squareThumbnail(source, size) {
  const copy = document.createElement("canvas");
  copy.width = size;
  copy.height = size;
  const context = copy.getContext("2d", { willReadFrequently: true });
  context.drawImage(source, 0, 0, size, size, 0, 0, size, size);
  const { data } = context.getImageData(0, 0, size, size);
  let minX = size;
  let minY = size;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0;y < size; y++) {
    for (let x = 0;x < size; x++) {
      if (data[(y * size + x) * 4 + 3] < 8)
        continue;
      if (x < minX)
        minX = x;
      if (x > maxX)
        maxX = x;
      if (y < minY)
        minY = y;
      if (y > maxY)
        maxY = y;
    }
  }
  if (maxX < 0)
    return null;
  const side = Math.min(size, Math.ceil(Math.max(maxX - minX + 1, maxY - minY + 1) * 1.06));
  const clamp = (start) => Math.min(size - side, Math.max(0, Math.round(start)));
  const left = clamp((minX + maxX + 1) / 2 - side / 2);
  const top = clamp((minY + maxY + 1) / 2 - side / 2);
  const outSize = Math.min(THUMBNAIL_PIXELS, side);
  const out = document.createElement("canvas");
  out.width = outSize;
  out.height = outSize;
  const outContext = out.getContext("2d");
  outContext.imageSmoothingQuality = "high";
  outContext.drawImage(copy, left, top, side, side, 0, 0, outSize, outSize);
  return out.toDataURL("image/webp", 0.85);
}

// src/shared/settings.ts
var CLASSIFY_EXPRESSIONS = [
  "admiration",
  "amusement",
  "anger",
  "annoyance",
  "approval",
  "caring",
  "confusion",
  "curiosity",
  "desire",
  "disappointment",
  "disapproval",
  "disgust",
  "embarrassment",
  "excitement",
  "fear",
  "gratitude",
  "grief",
  "joy",
  "love",
  "nervousness",
  "optimism",
  "pride",
  "realization",
  "relief",
  "remorse",
  "sadness",
  "surprise",
  "neutral"
];
var EMOTION_ANIMATION_HINTS = {
  admiration: ["admiration", "delight", "happy", "joy", "smile"],
  amusement: ["amusement", "laugh", "delight", "happy", "smile"],
  anger: ["anger", "angry", "mad"],
  annoyance: ["annoyance", "annoyed", "angry"],
  approval: ["approval", "nod", "delight", "happy"],
  caring: ["caring", "shy", "smile"],
  confusion: ["confusion", "confused", "worry", "worry_02"],
  curiosity: ["curiosity", "curious", "surprise"],
  desire: ["desire", "shy"],
  disappointment: ["disappointment", "disappointed", "sad"],
  disapproval: ["disapproval", "angry"],
  disgust: ["disgust", "disgusted", "angry"],
  embarrassment: ["embarrassment", "embarrassed", "shy", "blush"],
  excitement: ["excitement", "excited", "special", "delight", "happy"],
  fear: ["fear", "scared", "afraid", "worry"],
  gratitude: ["gratitude", "thanks", "delight", "happy"],
  grief: ["grief", "cry", "sad"],
  joy: ["joy", "happy", "delight", "smile"],
  love: ["love", "shy", "delight"],
  nervousness: ["nervousness", "nervous", "worry", "worry_02"],
  optimism: ["optimism", "delight", "happy"],
  pride: ["pride", "proud", "special", "delight"],
  realization: ["realization", "surprise"],
  relief: ["relief", "relieved", "delight"],
  remorse: ["remorse", "sad", "worry"],
  sadness: ["sadness", "sad", "cry"],
  surprise: ["surprise", "surprised", "shock"],
  neutral: []
};
var IDLE_ANIMATION_HINTS = ["idle", "idle_0", "idle_1", "idle01", "stand", "wait", "loop", "animation"];
var TALK_ANIMATION_HINTS = ["talk", "talk_start", "speak", "talking", "mouth"];
var SETTINGS_LIMITS = {
  renderScale: { min: 0.25, max: 2, step: 0.05 },
  zoom: { min: 0.05, max: 5, step: 0.01 },
  rotation: { min: -180, max: 180, step: 1 },
  speed: { min: 0, max: 3, step: 0.05 },
  offset: { min: -100, max: 100, step: 1 }
};
function defaultGlobalSettings() {
  return {
    enabled: true,
    autoSendInteraction: false,
    backgroundMode: false,
    showBounds: false,
    expressionSource: "llm",
    librarySort: "name",
    libraryView: "tiles"
  };
}
function defaultSettings() {
  return {
    global: defaultGlobalSettings(),
    characterModelMapping: {},
    characterModelsSettings: {}
  };
}
function findAnimation(names, hints) {
  const byLower = new Map(names.map((name) => [name.toLowerCase(), name]));
  for (const hint of hints) {
    const found = byLower.get(hint);
    if (found)
      return found;
  }
  return null;
}
function defaultModelSettings(description = null) {
  const names = description?.animations.map((animation) => animation.name) ?? [];
  const settings = {
    renderScale: 1,
    zoom: 1,
    rotation: 0,
    speed: 1,
    premultipliedAlpha: description?.pma ?? true,
    x: 0,
    y: 0,
    skin: "",
    animation_idle: findAnimation(names, IDLE_ANIMATION_HINTS) ?? names[0] ?? "none",
    animation_starter: { animation: "none", delay: 0 },
    animation_click: { animation: "none", message: "" },
    animation_talk: findAnimation(names, TALK_ANIMATION_HINTS) ?? "none",
    talk_time_per_character: 30,
    classify_mapping: {}
  };
  for (const label of CLASSIFY_EXPRESSIONS) {
    settings.classify_mapping[label] = findAnimation(names, EMOTION_ANIMATION_HINTS[label] ?? []) ?? "none";
  }
  return settings;
}
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function normalizeSettings(raw) {
  const base = defaultSettings();
  if (!isPlainObject(raw))
    return base;
  const value = raw;
  if (isPlainObject(value.global)) {
    base.global = { ...base.global, ...value.global };
  }
  if (isPlainObject(value.characterModelMapping)) {
    for (const [characterId, modelId] of Object.entries(value.characterModelMapping)) {
      if (typeof modelId === "string")
        base.characterModelMapping[characterId] = modelId;
    }
  }
  if (isPlainObject(value.characterModelsSettings)) {
    for (const [characterId, byModel] of Object.entries(value.characterModelsSettings)) {
      if (!isPlainObject(byModel))
        continue;
      const kept = {};
      for (const [modelId, modelSettings] of Object.entries(byModel)) {
        if (isPlainObject(modelSettings))
          kept[modelId] = ensureModelSettingsShape(modelSettings);
      }
      base.characterModelsSettings[characterId] = kept;
    }
  }
  return base;
}
function clampNumber(value, min, max, fallback) {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number))
    return fallback;
  return Math.min(max, Math.max(min, number));
}
function ensureModelSettingsShape(settings, description = null) {
  const base = defaultModelSettings(description);
  const target = settings;
  for (const [key, value] of Object.entries(base)) {
    const current = target[key];
    if (current === undefined || current === null || typeof current !== typeof value)
      target[key] = value;
  }
  for (const nested of ["animation_starter", "animation_click", "classify_mapping"]) {
    if (!isPlainObject(settings[nested]))
      target[nested] = base[nested];
    const baseNested = base[nested];
    const targetNested = settings[nested];
    for (const [key, value] of Object.entries(baseNested)) {
      if (targetNested[key] === undefined || typeof targetNested[key] !== typeof value)
        targetNested[key] = value;
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
  settings.animation_starter.delay = clampNumber(settings.animation_starter.delay, 0, 60000, 0);
  return settings;
}
function sanitizeModelSettings(raw, description = null) {
  const base = defaultModelSettings(description);
  const source = isPlainObject(raw) ? raw : {};
  const out = {};
  for (const key of Object.keys(base)) {
    if (source[key] !== undefined)
      out[key] = structuredClone(source[key]);
  }
  for (const nested of ["animation_starter", "animation_click", "classify_mapping"]) {
    if (!isPlainObject(out[nested]))
      continue;
    const known = base[nested];
    out[nested] = Object.fromEntries(Object.entries(out[nested]).filter(([key]) => (key in known)));
  }
  return ensureModelSettingsShape(out, description);
}

// src/frontend/stage.ts
var INTERACTIVE_SELECTOR = [
  "input",
  "textarea",
  "select",
  "button",
  "a[href]",
  "label",
  "summary",
  '[contenteditable]:not([contenteditable="false"])',
  '[role="button"]',
  '[role="textbox"]',
  '[role="menuitem"]',
  '[role="tab"]',
  '[role="slider"]'
].join(",");
var DEFAULT_MIX = 0.2;
var MIN_VISIBLE_ALPHA = 0.05;
var MAX_DELTA = 0.1;
var MAX_CANVAS_PIXELS = 4096 * 4096;
var CONTEXT_RESTORE_WAIT_MS = 3000;
var THUMBNAIL_DELAY_MS = 1500;
PolygonBatcher.blendModesGL[BlendMode.Additive].srcAlpha = 0;
function dirname(path) {
  const index = path.lastIndexOf("/");
  return index === -1 ? "" : path.slice(0, index);
}
function normalizePath(path) {
  const parts = [];
  for (const part of path.split("/")) {
    if (!part || part === ".")
      continue;
    if (part === "..")
      parts.pop();
    else
      parts.push(part);
  }
  return parts.join("/");
}
function bundleFile(bundle, baseDir, file) {
  const resolved = normalizePath(baseDir ? `${baseDir}/${file}` : file);
  const exact = bundle.files.get(resolved);
  if (exact)
    return exact;
  const lower = resolved.toLowerCase();
  for (const [path, blob] of bundle.files) {
    if (path.toLowerCase() === lower)
      return blob;
  }
  return;
}

class NullTexture extends Texture {
  constructor(width, height) {
    super({ width, height });
  }
  setFilters() {}
  setWraps() {}
  dispose() {}
}
async function readAtlas(bundle) {
  const text = await bundle.files.get(bundle.atlasFile)?.text();
  if (text === undefined)
    throw new Error(`Atlas missing from bundle: ${bundle.atlasFile}`);
  const atlas = new TextureAtlas(text);
  for (const page of atlas.pages)
    page.setTexture(new NullTexture(page.width || 1, page.height || 1));
  return atlas;
}
async function readSkeletonData(bundle, atlas) {
  const file = bundle.files.get(bundle.skeletonFile);
  if (!file)
    throw new Error(`Skeleton missing from bundle: ${bundle.skeletonFile}`);
  const loader = new AtlasAttachmentLoader(atlas);
  if (/\.json$/i.test(bundle.skeletonFile)) {
    return new SkeletonJson(loader).readSkeletonData(await file.text());
  }
  return new SkeletonBinary(loader).readSkeletonData(new Uint8Array(await file.arrayBuffer()));
}
function describeSkeleton(data, atlas, record) {
  return {
    animations: data.animations.map((animation) => ({ name: animation.name, duration: animation.duration })),
    skins: data.skins.map((skin) => skin.name),
    pma: atlas.pages.some((page) => page.pma) || record.pma
  };
}
function forEachVisibleTriangle(skeleton, visit) {
  const vertices = [];
  for (const slot of skeleton.drawOrder) {
    if (!slot.bone.active)
      continue;
    const attachment = slot.getAttachment();
    if (!attachment)
      continue;
    let triangles;
    if (attachment instanceof RegionAttachment) {
      if (skeleton.color.a * slot.color.a * attachment.color.a < MIN_VISIBLE_ALPHA)
        continue;
      vertices.length = 8;
      attachment.computeWorldVertices(slot, vertices, 0, 2);
      triangles = SkeletonRenderer.QUAD_TRIANGLES;
    } else if (attachment instanceof MeshAttachment) {
      if (skeleton.color.a * slot.color.a * attachment.color.a < MIN_VISIBLE_ALPHA)
        continue;
      vertices.length = attachment.worldVerticesLength;
      attachment.computeWorldVertices(slot, 0, attachment.worldVerticesLength, vertices, 0, 2);
      triangles = attachment.triangles;
    } else {
      continue;
    }
    if (visit(vertices, triangles) === true)
      return;
  }
}
function visibleBounds(skeleton) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  forEachVisibleTriangle(skeleton, (vertices) => {
    for (let i = 0;i + 1 < vertices.length; i += 2) {
      const x = vertices[i];
      const y = vertices[i + 1];
      if (x < minX)
        minX = x;
      if (x > maxX)
        maxX = x;
      if (y < minY)
        minY = y;
      if (y > maxY)
        maxY = y;
    }
  });
  if (!Number.isFinite(minX) || maxX - minX <= 0 || maxY - minY <= 0)
    return null;
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}
function setPageSize(page, width, height) {
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
  if (page.texture instanceof NullTexture)
    page.setTexture(new NullTexture(width, height));
}
function measureReferenceBounds(data, settings) {
  const skeleton = new Skeleton(data);
  const skin = settings.skin && data.findSkin(settings.skin) || data.defaultSkin;
  if (skin)
    skeleton.setSkin(skin);
  skeleton.setToSetupPose();
  const idle = settings.animation_idle !== "none" ? data.findAnimation(settings.animation_idle) : null;
  if (idle)
    idle.apply(skeleton, 0, 0, false, [], 1, MixBlend.setup, MixDirection.mixIn);
  skeleton.updateWorldTransform();
  const bounds = visibleBounds(skeleton);
  if (bounds)
    return bounds;
  if (data.width > 0 && data.height > 0)
    return { x: data.x, y: data.y, width: data.width, height: data.height };
  return { x: -50, y: 0, width: 100, height: 100 };
}
function pointInTriangle(px, py, ax, ay, bx, by, cx, cy) {
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
  const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
  const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
  const hasNegative = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPositive = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNegative && hasPositive);
}

class Stage {
  deps;
  host = null;
  gl = null;
  loaded = [];
  slotCount = 1;
  chatId = null;
  characterIds = [];
  loadToken = 0;
  frameRequest = null;
  lastFrameTime = 0;
  hostWidth = 0;
  hostHeight = 0;
  resizeObserver = null;
  previousInteraction = { characterId: "", message: "" };
  descriptionCache = new Map;
  drag = null;
  suppressClick = false;
  hoverFrame = null;
  hovering = false;
  listeners = [
    [document, "pointerdown", (event) => this.onPointerDown(event), { capture: true }],
    [document, "pointermove", (event) => this.onPointerMove(event), { capture: true }],
    [document, "pointerup", (event) => this.onPointerUp(event), { capture: true }],
    [document, "pointercancel", () => this.endDrag(), { capture: true }],
    [document, "click", (event) => this.onClickCapture(event), { capture: true }],
    [document, "touchstart", (event) => this.drag && event.preventDefault(), { capture: true, passive: false }],
    [document, "touchmove", (event) => this.drag && event.preventDefault(), { capture: true, passive: false }]
  ];
  constructor(deps) {
    this.deps = deps;
    for (const [target, type, listener, options] of this.listeners)
      target.addEventListener(type, listener, options);
  }
  destroy() {
    for (const [target, type, listener, options] of this.listeners) {
      target.removeEventListener(type, listener, options);
    }
    if (this.hoverFrame !== null)
      window.cancelAnimationFrame(this.hoverFrame);
    this.hoverFrame = null;
    this.setHovering(false);
    this.teardown();
  }
  setHost(host) {
    if (this.host === host)
      return;
    this.teardown();
    this.host = host;
    this.reload();
  }
  setChatContext(chatId, characterIds) {
    const unique = [...new Set(characterIds.filter(Boolean))];
    const changed = chatId !== this.chatId || unique.length !== this.characterIds.length || unique.some((id, index) => id !== this.characterIds[index]);
    this.chatId = chatId;
    this.characterIds = unique;
    if (changed)
      this.reload();
  }
  getChatContext() {
    return { chatId: this.chatId, characterIds: [...this.characterIds] };
  }
  isOnStage(characterId, modelId) {
    const entry = this.entryFor(characterId);
    return entry !== undefined && (modelId === undefined || entry.modelId === modelId);
  }
  charactersOnStage() {
    return this.loaded.map((entry) => entry.characterId);
  }
  getDescription(characterId) {
    return this.entryFor(characterId)?.description ?? null;
  }
  entryFor(characterId) {
    return this.loaded.find((entry) => entry.characterId === characterId);
  }
  async reload() {
    this.teardown();
    const token = this.loadToken;
    const settings = this.deps.getSettings();
    if (!settings.global.enabled || !this.host)
      return;
    const cast = [];
    for (const characterId of this.characterIds) {
      const modelId = settings.characterModelMapping[characterId];
      const record = modelId ? this.deps.getModelRecord(modelId) : undefined;
      if (record)
        cast.push({ characterId, record });
    }
    if (cast.length === 0)
      return;
    this.slotCount = cast.length;
    await Promise.all(cast.map(async ({ characterId, record }, slot) => {
      let bundle;
      try {
        bundle = await this.deps.assets.load(record);
      } catch (error) {
        this.deps.log(`Failed to download model "${record.name}": ${String(error)}`);
        return;
      }
      if (token !== this.loadToken || !this.host)
        return;
      try {
        await this.loadModel(characterId, record, bundle, slot, token);
      } catch (error) {
        if (token === this.loadToken)
          this.deps.log(`Failed to load model "${record.name}": ${String(error)}`);
      }
    }));
  }
  createGl(host) {
    const canvas = document.createElement("canvas");
    canvas.className = "spine-avatars-canvas";
    host.appendChild(canvas);
    try {
      const context = new ManagedWebGLRenderingContext(canvas, {
        alpha: true,
        premultipliedAlpha: true,
        antialias: true,
        preserveDrawingBuffer: false
      });
      if (!context.gl)
        throw new Error("WebGL is unavailable in this browser.");
      const gl = context.gl;
      const maxViewport = gl.getParameter(gl.MAX_VIEWPORT_DIMS);
      const maxRenderbuffer = gl.getParameter(gl.MAX_RENDERBUFFER_SIZE);
      const result = {
        canvas,
        context,
        shader: Shader.newTwoColoredTextured(context),
        batcher: new PolygonBatcher(context, true),
        renderer: new SkeletonRenderer(context, true),
        debugShader: null,
        shapes: null,
        debugRenderer: null,
        mvp: new Matrix4,
        maxDimension: Math.max(256, Math.min(maxRenderbuffer || 4096, maxViewport?.[0] ?? 4096, 8192)),
        maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE) || 4096,
        restoreTimer: null
      };
      canvas.addEventListener("webglcontextlost", () => {
        if (this.gl !== result || result.restoreTimer !== null)
          return;
        result.restoreTimer = window.setTimeout(() => {
          result.restoreTimer = null;
          if (this.gl !== result)
            return;
          this.deps.log("WebGL context was lost and not restored; reloading the model.");
          this.reload();
        }, CONTEXT_RESTORE_WAIT_MS);
      });
      canvas.addEventListener("webglcontextrestored", () => {
        if (result.restoreTimer !== null)
          window.clearTimeout(result.restoreTimer);
        result.restoreTimer = null;
        if (this.gl !== result)
          return;
        for (const entry of this.loaded) {
          entry.atlas.pages.forEach((page, index) => {
            const texture = entry.textures[index];
            if (texture)
              page.setTexture(texture);
          });
        }
      });
      return result;
    } catch (error) {
      canvas.remove();
      throw error;
    }
  }
  async loadModel(characterId, record, bundle, slot, token) {
    const host = this.host;
    const atlas = await readAtlas(bundle);
    const atlasDir = dirname(bundle.atlasFile);
    const images = [];
    const closeImages = () => images.forEach((image) => image.close());
    const cancelled = () => token !== this.loadToken || this.host !== host;
    let data;
    try {
      for (const page of atlas.pages) {
        const blob = bundleFile(bundle, atlasDir, page.name);
        if (!blob)
          throw new Error(`Atlas page image missing: ${page.name}`);
        const image = await createImageBitmap(blob, { premultiplyAlpha: "none", colorSpaceConversion: "none" });
        images.push(image);
        if (!page.width || !page.height)
          setPageSize(page, image.width, image.height);
      }
      if (cancelled())
        return closeImages();
      data = await readSkeletonData(bundle, atlas);
    } catch (error) {
      closeImages();
      throw error;
    }
    if (cancelled())
      return closeImages();
    const description = describeSkeleton(data, atlas, record);
    this.descriptionCache.set(`${record.id}@${record.version}`, description);
    const modelSettings = this.deps.getModelSettings(characterId, record.id, description);
    let gl = this.gl;
    if (!gl) {
      try {
        gl = this.createGl(host);
      } catch (error) {
        closeImages();
        throw error;
      }
      this.gl = gl;
      this.observeSize(gl.canvas);
    }
    const textures = [];
    try {
      atlas.pages.forEach((page, index) => {
        const image = images[index];
        if (Math.max(image.width, image.height) > gl.maxTextureSize) {
          this.deps.log(`Atlas page ${page.name} is ${image.width}x${image.height}, larger than this GPU's ` + `${gl.maxTextureSize}px texture limit; it may draw black.`);
        }
        const texture = new GLTexture(gl.context, image);
        textures.push(texture);
        page.setTexture(texture);
      });
    } catch (error) {
      textures.forEach((texture) => texture.dispose());
      closeImages();
      throw error;
    }
    const skeleton = new Skeleton(data);
    const stateData = new AnimationStateData(data);
    stateData.defaultMix = DEFAULT_MIX;
    const entry = {
      characterId,
      modelId: record.id,
      description,
      atlas,
      skeleton,
      state: new AnimationState(stateData),
      bounds: { x: 0, y: 0, width: 1, height: 1 },
      textures,
      talkTimer: null,
      starterTimer: null,
      thumbnailTimer: null,
      slot
    };
    this.loaded.push(entry);
    this.loaded.sort((a, b) => a.slot - b.slot);
    this.applySkinTo(entry, modelSettings);
    this.startIdle(entry, modelSettings);
    entry.bounds = measureReferenceBounds(data, modelSettings);
    if (this.frameRequest === null) {
      this.lastFrameTime = performance.now();
      this.frameRequest = window.requestAnimationFrame(this.frame);
    }
    const starter = modelSettings.animation_starter;
    if (starter.animation !== "none") {
      entry.starterTimer = window.setTimeout(() => {
        entry.starterTimer = null;
        if (this.loaded.includes(entry))
          this.playAnimation(characterId, starter.animation);
      }, Math.max(0, starter.delay));
    }
    if (!record.thumbnail) {
      entry.thumbnailTimer = window.setTimeout(() => {
        entry.thumbnailTimer = null;
        if (!this.loaded.includes(entry) || this.deps.getModelRecord(record.id)?.thumbnail)
          return;
        const dataUrl = this.captureThumbnail(characterId);
        if (dataUrl)
          this.deps.saveThumbnail(record.id, dataUrl);
      }, THUMBNAIL_DELAY_MS);
    }
  }
  captureThumbnail(characterId) {
    const gl = this.gl;
    const entry = this.entryFor(characterId);
    const width = this.hostWidth;
    const height = this.hostHeight;
    if (!gl || !entry || width === 0 || height === 0 || gl.context.gl.isContextLost())
      return null;
    const pixels = Math.min(THUMBNAIL_RENDER_PIXELS, gl.canvas.width, gl.canvas.height);
    if (pixels < 32)
      return null;
    const box = pixels * width / gl.canvas.width;
    const bounds = visibleBounds(entry.skeleton) ?? entry.bounds;
    const scale = box * 0.96 / Math.max(bounds.width, bounds.height);
    const centerX = bounds.x + bounds.width / 2;
    const centerY = bounds.y + bounds.height / 2;
    const fitted = { a: scale, b: 0, c: 0, d: -scale, e: box / 2 - scale * centerX, f: box / 2 + scale * centerY };
    const context = gl.context.gl;
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
      this.draw(gl, this.loaded.map((other) => ({ entry: other, settings: this.settingsFor(other) })), width, height);
    }
  }
  observeSize(canvas) {
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
  settingsFor(entry) {
    const stored = this.deps.getSettings().characterModelsSettings[entry.characterId]?.[entry.modelId];
    return stored ?? this.deps.getModelSettings(entry.characterId, entry.modelId, entry.description);
  }
  frame = (now) => {
    this.frameRequest = null;
    const gl = this.gl;
    if (this.loaded.length === 0 || !gl)
      return;
    this.frameRequest = window.requestAnimationFrame(this.frame);
    const delta = Math.min(MAX_DELTA, Math.max(0, (now - this.lastFrameTime) / 1000));
    this.lastFrameTime = now;
    let renderScale = 0;
    const drawn = [];
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
    if (width === 0 || height === 0 || gl.context.gl.isContextLost())
      return;
    this.resizeCanvas(gl, width, height, renderScale);
    this.draw(gl, drawn, width, height);
  };
  resizeCanvas(gl, width, height, renderScale) {
    const density = (window.devicePixelRatio || 1) * renderScale;
    let pixelWidth = Math.max(1, Math.round(width * density));
    let pixelHeight = Math.max(1, Math.round(height * density));
    const shrink = Math.min(1, gl.maxDimension / Math.max(pixelWidth, pixelHeight), Math.sqrt(MAX_CANVAS_PIXELS / (pixelWidth * pixelHeight)));
    if (shrink < 1) {
      pixelWidth = Math.max(1, Math.floor(pixelWidth * shrink));
      pixelHeight = Math.max(1, Math.floor(pixelHeight * shrink));
    }
    if (gl.canvas.width !== pixelWidth)
      gl.canvas.width = pixelWidth;
    if (gl.canvas.height !== pixelHeight)
      gl.canvas.height = pixelHeight;
  }
  draw(gl, drawn, width, height) {
    const context = gl.context.gl;
    context.viewport(0, 0, context.drawingBufferWidth, context.drawingBufferHeight);
    context.clearColor(0, 0, 0, 0);
    context.clear(context.COLOR_BUFFER_BIT);
    const showBounds = this.deps.getSettings().global.showBounds;
    for (const { entry, settings } of drawn) {
      this.drawEntry(gl, entry, settings, width, height);
      if (showBounds)
        this.drawDebug(gl, entry, gl.mvp.values);
    }
  }
  drawEntry(gl, entry, settings, width, height, t = this.transform(entry, settings, width, height)) {
    const m = gl.mvp.values;
    m.fill(0);
    m[M00] = 2 * t.a / width;
    m[M01] = 2 * t.c / width;
    m[M03] = 2 * t.e / width - 1;
    m[M10] = -2 * t.b / height;
    m[M11] = -2 * t.d / height;
    m[M13] = 1 - 2 * t.f / height;
    m[M22] = 1;
    m[M33] = 1;
    gl.shader.bind();
    gl.shader.setUniformi(Shader.SAMPLER, 0);
    gl.shader.setUniform4x4f(Shader.MVP_MATRIX, m);
    gl.renderer.premultipliedAlpha = settings.premultipliedAlpha;
    gl.batcher.begin(gl.shader);
    gl.renderer.draw(gl.batcher, entry.skeleton);
    gl.batcher.end();
    gl.shader.unbind();
  }
  drawDebug(gl, entry, mvp) {
    if (!gl.debugShader) {
      gl.debugShader = Shader.newColored(gl.context);
      gl.shapes = new ShapeRenderer(gl.context);
      gl.debugRenderer = new SkeletonDebugRenderer(gl.context);
      gl.debugRenderer.drawMeshTriangles = false;
    }
    const shader = gl.debugShader;
    const shapes = gl.shapes;
    shader.bind();
    shader.setUniform4x4f(Shader.MVP_MATRIX, mvp);
    shapes.begin(shader);
    gl.debugRenderer.draw(shapes, entry.skeleton);
    const { x, y, width, height } = entry.bounds;
    shapes.setColor(new Color(1, 0.6, 0, 1));
    shapes.rect(false, x, y, width, height);
    shapes.end();
    shader.unbind();
  }
  slotOf(entry, width, height) {
    const slotWidth = width / Math.max(1, this.slotCount);
    return { x: slotWidth * entry.slot, width: slotWidth, height };
  }
  transform(entry, settings, stageWidth, stageHeight) {
    const { x: left, width, height } = this.slotOf(entry, stageWidth, stageHeight);
    const bounds = entry.bounds;
    const fit = Math.min(width / bounds.width, height / bounds.height);
    const scale = fit * settings.zoom;
    const angle = settings.rotation * Math.PI / 180;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const centerX = bounds.x + bounds.width / 2;
    const centerY = bounds.y + bounds.height / 2;
    const targetX = left + width / 2 + width / 2 * settings.x / 100;
    const targetY = height / 2 + height / 2 * settings.y / 100;
    const a = scale * cos;
    const c = scale * sin;
    const b = scale * sin;
    const d = -scale * cos;
    return { a, b, c, d, e: targetX - a * centerX - c * centerY, f: targetY - b * centerX - d * centerY };
  }
  toSkeletonPoint(entry, x, y) {
    const t = this.transform(entry, this.settingsFor(entry), this.hostWidth, this.hostHeight);
    const det = t.a * t.d - t.b * t.c;
    if (det === 0)
      return { x: NaN, y: NaN };
    const u = x - t.e;
    const v = y - t.f;
    return { x: (t.d * u - t.c * v) / det, y: (-t.b * u + t.a * v) / det };
  }
  fitToCanvas(characterId, modelId) {
    const entry = this.entryFor(characterId);
    if (!entry || entry.modelId !== modelId)
      return false;
    if (this.hostWidth === 0 || this.hostHeight === 0)
      return false;
    const { width, height } = this.slotOf(entry, this.hostWidth, this.hostHeight);
    const settings = this.settingsFor(entry);
    const { width: boundsWidth, height: boundsHeight } = entry.bounds;
    const angle = settings.rotation * Math.PI / 180;
    const cos = Math.abs(Math.cos(angle));
    const sin = Math.abs(Math.sin(angle));
    const rotatedWidth = cos * boundsWidth + sin * boundsHeight;
    const rotatedHeight = sin * boundsWidth + cos * boundsHeight;
    const fitRotated = Math.min(width / rotatedWidth, height / rotatedHeight);
    const fitUpright = Math.min(width / boundsWidth, height / boundsHeight);
    const { min, max } = SETTINGS_LIMITS.zoom;
    settings.zoom = Math.min(max, Math.max(min, Math.floor(fitRotated / fitUpright * 100) / 100));
    settings.x = 0;
    settings.y = 0;
    this.deps.saveSettingsDebounced();
    return true;
  }
  findAnimation(entry, name) {
    if (!name || name === "none")
      return null;
    return entry.skeleton.data.findAnimation(name);
  }
  applySkinTo(entry, settings) {
    const { skeleton } = entry;
    const skin = settings.skin && skeleton.data.findSkin(settings.skin) || skeleton.data.defaultSkin;
    if (skin)
      skeleton.setSkin(skin);
    skeleton.setSlotsToSetupPose();
  }
  startIdle(entry, settings) {
    const idle = this.findAnimation(entry, settings.animation_idle);
    if (idle)
      entry.state.setAnimation(0, idle.name, true);
    else
      entry.state.setEmptyAnimation(0, DEFAULT_MIX);
  }
  applySkin(characterId) {
    const entry = this.entryFor(characterId);
    if (!entry)
      return;
    const settings = this.settingsFor(entry);
    this.applySkinTo(entry, settings);
    entry.bounds = measureReferenceBounds(entry.skeleton.data, settings);
  }
  applyIdle(characterId) {
    const entry = this.entryFor(characterId);
    if (!entry)
      return;
    const settings = this.settingsFor(entry);
    this.startIdle(entry, settings);
    entry.bounds = measureReferenceBounds(entry.skeleton.data, settings);
  }
  playAnimation(characterId, name) {
    const entry = this.entryFor(characterId);
    if (!entry)
      return;
    const animation = this.findAnimation(entry, name);
    if (!animation)
      return;
    entry.state.setAnimation(0, animation.name, false);
    const idle = this.findAnimation(entry, this.settingsFor(entry).animation_idle);
    if (idle)
      entry.state.addAnimation(0, idle.name, true, 0);
    else
      entry.state.addEmptyAnimation(0, DEFAULT_MIX, 0);
  }
  playTalk(characterId, textLength) {
    const entry = this.entryFor(characterId);
    if (!entry || textLength <= 0)
      return;
    const settings = this.settingsFor(entry);
    const talk = this.findAnimation(entry, settings.animation_talk);
    if (!talk)
      return;
    if (entry.talkTimer !== null)
      window.clearTimeout(entry.talkTimer);
    const current = entry.state.getCurrent(1);
    if (current?.animation?.name !== talk.name) {
      if (!current)
        entry.state.setEmptyAnimation(1, 0);
      entry.state.addAnimation(1, talk.name, true, 0).mixDuration = DEFAULT_MIX;
    }
    const speed = Math.max(0.05, settings.speed);
    const duration = textLength * settings.talk_time_per_character / speed;
    entry.talkTimer = window.setTimeout(() => {
      entry.talkTimer = null;
      if (this.loaded.includes(entry))
        entry.state.setEmptyAnimation(1, DEFAULT_MIX);
    }, duration);
  }
  async describeModel(record) {
    const key = `${record.id}@${record.version}`;
    const cached = this.descriptionCache.get(key);
    if (cached)
      return cached;
    const bundle = await this.deps.assets.load(record);
    const atlas = await readAtlas(bundle);
    const data = await readSkeletonData(bundle, atlas);
    const description = describeSkeleton(data, atlas, record);
    this.descriptionCache.set(key, description);
    return description;
  }
  modelAt(event) {
    const canvas = this.gl?.canvas;
    if (this.loaded.length === 0 || !canvas)
      return null;
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest(INTERACTIVE_SELECTOR))
      return null;
    const previous = canvas.style.pointerEvents;
    canvas.style.pointerEvents = "auto";
    const topmost = document.elementFromPoint(event.clientX, event.clientY);
    canvas.style.pointerEvents = previous;
    if (topmost !== canvas)
      return null;
    const point = this.toStagePoint(event);
    for (let i = this.loaded.length - 1;i >= 0; i--) {
      const entry = this.loaded[i];
      if (this.isOverModel(entry, point.x, point.y))
        return entry;
    }
    return null;
  }
  isOverModel(entry, stageX, stageY) {
    const point = this.toSkeletonPoint(entry, stageX, stageY);
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y))
      return false;
    let hit = false;
    try {
      forEachVisibleTriangle(entry.skeleton, (vertices, triangles) => {
        for (let i = 0;i + 2 < triangles.length; i += 3) {
          const p = triangles[i] * 2;
          const q = triangles[i + 1] * 2;
          const r = triangles[i + 2] * 2;
          if (pointInTriangle(point.x, point.y, vertices[p], vertices[p + 1], vertices[q], vertices[q + 1], vertices[r], vertices[r + 1])) {
            hit = true;
            return true;
          }
        }
        return false;
      });
    } catch {}
    return hit;
  }
  modelCenter(entry) {
    const settings = this.settingsFor(entry);
    const slot = this.slotOf(entry, this.hostWidth, this.hostHeight);
    return {
      x: slot.x + slot.width / 2 + slot.width / 2 * settings.x / 100,
      y: slot.height / 2 + slot.height / 2 * settings.y / 100
    };
  }
  onPointerDown(event) {
    if (event.button !== 0)
      return;
    const entry = this.modelAt(event);
    if (!entry)
      return;
    event.preventDefault();
    event.stopPropagation();
    const point = this.toStagePoint(event);
    const center = this.modelCenter(entry);
    this.drag = {
      entry,
      pointerId: event.pointerId,
      offsetX: point.x - center.x,
      offsetY: point.y - center.y,
      moved: false
    };
    this.suppressClick = true;
  }
  onPointerMove(event) {
    const drag = this.drag;
    if (drag && event.pointerId === drag.pointerId) {
      event.preventDefault();
      event.stopPropagation();
      this.dragTo(drag, event);
      return;
    }
    if (this.loaded.length === 0)
      return;
    if (event.pointerType === "mouse" && this.hoverFrame === null) {
      this.hoverFrame = window.requestAnimationFrame(() => {
        this.hoverFrame = null;
        this.setHovering(this.modelAt(event) !== null);
      });
    }
  }
  dragTo(drag, event) {
    const { entry } = drag;
    if (!this.loaded.includes(entry) || this.hostWidth === 0 || this.hostHeight === 0)
      return;
    const point = this.toStagePoint(event);
    const center = this.modelCenter(entry);
    const newX = point.x - drag.offsetX;
    const newY = point.y - drag.offsetY;
    if (!drag.moved && Math.abs(newX - center.x) < 3 && Math.abs(newY - center.y) < 3)
      return;
    drag.moved = true;
    const settings = this.settingsFor(entry);
    const slot = this.slotOf(entry, this.hostWidth, this.hostHeight);
    const { min, max } = SETTINGS_LIMITS.offset;
    const percent = (value) => Math.min(max, Math.max(min, Math.round(value * 100) / 100));
    settings.x = percent((newX - slot.x - slot.width / 2) / (slot.width / 2) * 100);
    settings.y = percent((newY - slot.height / 2) / (slot.height / 2) * 100);
    this.deps.saveSettingsDebounced();
    this.deps.layoutChanged();
  }
  onPointerUp(event) {
    const drag = this.drag;
    if (!drag || event.pointerId !== drag.pointerId)
      return;
    event.preventDefault();
    event.stopPropagation();
    this.endDrag();
    if (!drag.moved && this.loaded.includes(drag.entry))
      this.onModelClick(drag.entry);
  }
  endDrag() {
    this.drag = null;
    window.setTimeout(() => {
      this.suppressClick = false;
    }, 0);
  }
  onClickCapture(event) {
    if (!this.suppressClick)
      return;
    this.suppressClick = false;
    event.preventDefault();
    event.stopPropagation();
  }
  setHovering(hovering) {
    if (hovering === this.hovering)
      return;
    this.hovering = hovering;
    document.documentElement.classList.toggle("spine-avatars-hover", hovering);
  }
  toStagePoint(event) {
    const rect = this.gl?.canvas.getBoundingClientRect();
    return { x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) };
  }
  onModelClick(entry) {
    const click = this.settingsFor(entry).animation_click;
    if (click.message) {
      if (this.previousInteraction.characterId === entry.characterId && this.previousInteraction.message === click.message) {
        this.deps.log("Same as last interaction, message not sent again.");
      } else {
        this.previousInteraction = { characterId: entry.characterId, message: click.message };
        this.deps.sendInteraction(click.message, entry.characterId);
      }
    }
    if (click.animation !== "none")
      this.playAnimation(entry.characterId, click.animation);
  }
  teardown() {
    this.loadToken++;
    if (this.drag)
      this.suppressClick = false;
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
    this.slotCount = 1;
    for (const entry of entries) {
      if (entry.talkTimer !== null)
        window.clearTimeout(entry.talkTimer);
      if (entry.starterTimer !== null)
        window.clearTimeout(entry.starterTimer);
      if (entry.thumbnailTimer !== null)
        window.clearTimeout(entry.thumbnailTimer);
      for (const texture of entry.textures) {
        try {
          texture.dispose();
        } catch {}
        texture.getImage()?.close?.();
      }
    }
    const gl = this.gl;
    this.gl = null;
    if (gl) {
      if (gl.restoreTimer !== null)
        window.clearTimeout(gl.restoreTimer);
      for (const disposable of [gl.batcher, gl.shader, gl.debugShader, gl.shapes]) {
        try {
          disposable?.dispose();
        } catch {}
      }
      try {
        gl.context.gl.getExtension("WEBGL_lose_context")?.loseContext();
      } catch {}
      gl.canvas.remove();
    }
  }
}

// src/frontend/ui.ts
var REQUIRED_PERMS = [
  { id: "app_manipulation", why: "show the avatar over the app (otherwise it renders inside this tab)" },
  { id: "generation", why: "classify message emotions with the LLM" },
  { id: "chat_mutation", why: "send click interaction messages" },
  { id: "chats", why: "know which characters are in the active chat (needed for group chats)" },
  { id: "characters", why: "list your characters by name when assigning models" }
];
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className)
    node.className = className;
  if (text !== undefined)
    node.textContent = text;
  return node;
}
function button(label, onClick) {
  const node = el("button", "spn-btn", label);
  node.type = "button";
  node.addEventListener("click", onClick);
  return node;
}
function checkbox(label, checked, onChange) {
  const wrap = el("label", "spn-check");
  const input = el("input");
  input.type = "checkbox";
  input.checked = checked;
  input.addEventListener("change", () => onChange(input.checked));
  wrap.appendChild(input);
  wrap.appendChild(el("span", undefined, label));
  return wrap;
}
function select(options, value, onChange) {
  const node = el("select", "spn-select");
  for (const option of options) {
    const opt = el("option", undefined, option.label);
    opt.value = option.value;
    node.appendChild(opt);
  }
  node.value = value;
  if (node.value !== value)
    node.selectedIndex = 0;
  node.addEventListener("change", () => onChange(node.value));
  return node;
}
function slider(label, limits, value, format, onInput) {
  const root = el("div", "spn-slider");
  const head = el("div", "spn-slider-head");
  head.appendChild(el("span", undefined, label));
  const valueSpan = el("span", "spn-slider-value", format(value));
  head.appendChild(valueSpan);
  const input = el("input");
  input.type = "range";
  input.min = String(limits.min);
  input.max = String(limits.max);
  input.step = String(limits.step);
  input.value = String(value);
  input.setAttribute("aria-label", label);
  input.addEventListener("input", () => {
    valueSpan.textContent = format(Number(input.value));
    onInput(Number(input.value));
  });
  root.appendChild(head);
  root.appendChild(input);
  return {
    root,
    set(next) {
      input.value = String(next);
      valueSpan.textContent = format(next);
    }
  };
}
function section(title, ...children) {
  const wrap = el("details", "spn-section");
  wrap.open = true;
  wrap.appendChild(el("summary", "spn-section-title", title));
  for (const child of children)
    if (child)
      wrap.appendChild(child);
  return wrap;
}
function row(...children) {
  const wrap = el("div", "spn-row");
  let label = null;
  for (const child of children) {
    if (typeof child === "string") {
      label = child;
      wrap.appendChild(el("span", "spn-label", child));
      continue;
    }
    if (label && (child instanceof HTMLSelectElement || child instanceof HTMLInputElement)) {
      if (!child.hasAttribute("aria-label"))
        child.setAttribute("aria-label", label);
    }
    label = null;
    wrap.appendChild(child);
  }
  return wrap;
}
function note(text) {
  return el("p", "spn-note", text);
}
var SORT_OPTIONS = [
  { value: "name", label: "Name (A–Z)" },
  { value: "name_desc", label: "Name (Z–A)" },
  { value: "newest", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
  { value: "largest", label: "Largest first" },
  { value: "smallest", label: "Smallest first" }
];
var SEARCH_THRESHOLD = 6;
var byName = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
function sortModels(models, sort) {
  const time = (model) => Date.parse(model.importedAt) || 0;
  const compare = {
    name: (a, b) => byName.compare(a.name, b.name),
    name_desc: (a, b) => byName.compare(b.name, a.name),
    newest: (a, b) => time(b) - time(a),
    oldest: (a, b) => time(a) - time(b),
    largest: (a, b) => b.sizeBytes - a.sizeBytes,
    smallest: (a, b) => a.sizeBytes - b.sizeBytes
  };
  const order = compare[sort] ?? compare.name;
  return [...models].sort((a, b) => order(a, b) || byName.compare(a.name, b.name));
}
function libraryView(view) {
  return view === "list" ? "list" : "tiles";
}
function megabytes(model) {
  return `${(model.sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}
function modelSummary(model) {
  return `Spine ${model.spineVersion} · ${megabytes(model)}`;
}
function initial(name) {
  return (name.trim()[0] ?? "?").toUpperCase();
}
function thumbnail(model, className) {
  if (model.thumbnail) {
    const image = el("img", className);
    image.src = model.thumbnail;
    image.alt = "";
    return image;
  }
  return el("div", `${className} spn-thumb-empty`, initial(model.name));
}
function modelLeading(model) {
  return model.thumbnail ? { type: "image", src: model.thumbnail, rounded: false, fallback: { text: initial(model.name) } } : { type: "initial", text: initial(model.name) };
}
function withLabel(node, label) {
  node.setAttribute("aria-label", label);
  return node;
}
function statusLine() {
  const root = el("span", "spn-dim", "");
  root.setAttribute("role", "status");
  return {
    root,
    say(text) {
      root.textContent = text;
    }
  };
}
function animationOptions(description) {
  return [
    { value: "none", label: "None" },
    ...description.animations.map((animation) => ({
      value: animation.name,
      label: `${animation.name} (${animation.duration.toFixed(2)}s)`
    }))
  ];
}
var formatFixed = (digits, suffix = "") => (value) => `${value.toFixed(digits)}${suffix}`;

class SettingsUI {
  controller;
  root = null;
  selectedCharacterId = null;
  selectedModelId = null;
  lastActiveCharacterId = null;
  renderGeneration = 0;
  syncLayout = null;
  libraryFilter = "";
  libraryList = null;
  fileStatusText = "";
  mounted = [];
  pendingMounts = [];
  constructor(controller) {
    this.controller = controller;
  }
  mount(root) {
    this.root = root;
    this.render();
  }
  layoutChanged() {
    this.syncLayout?.();
  }
  render() {
    const root = this.root;
    if (!root)
      return;
    for (const handle of this.mounted.splice(0)) {
      try {
        handle.destroy();
      } catch {}
    }
    this.pendingMounts = [];
    root.replaceChildren();
    root.classList.add("spn-root");
    this.syncLayout = null;
    const generation = ++this.renderGeneration;
    const controller = this.controller;
    const settings = controller.getSettings();
    const globals = settings.global;
    const granted = new Set(controller.getPermissions());
    const missing = REQUIRED_PERMS.filter((perm) => !granted.has(perm.id));
    if (missing.length > 0) {
      const banner = el("div", "spn-banner");
      banner.appendChild(el("div", "spn-banner-title", "Some features need permissions"));
      for (const perm of missing) {
        banner.appendChild(el("div", "spn-banner-line", `• ${perm.id} — ${perm.why}`));
      }
      banner.appendChild(button("Grant permissions", () => {
        controller.requestPermissions(missing.map((perm) => perm.id));
      }));
      root.appendChild(banner);
    }
    root.appendChild(section("Global", checkbox("Enabled", globals.enabled, (value) => {
      globals.enabled = value;
      controller.saveNow();
      controller.reloadStage();
    }), checkbox("Show model as chat background", globals.backgroundMode, (value) => {
      globals.backgroundMode = value;
      controller.saveNow();
      controller.applyBackgroundMode();
    }), checkbox("Auto-send interaction", globals.autoSendInteraction, (value) => {
      globals.autoSendInteraction = value;
      controller.saveDebounced();
    }), row("Emotion detection", select([
      { value: "llm", label: "LLM classification" },
      { value: "native", label: "Lumiverse's expression detection" },
      { value: "off", label: "Off" }
    ], globals.expressionSource, (value) => {
      globals.expressionSource = value;
      controller.saveNow();
    })), controller.usingOverlay() ? null : note("Overlay permission not granted — the avatar renders in the preview box below.")));
    const debug = section("Debug", checkbox("Show bones and bounds", globals.showBounds, (value) => {
      globals.showBounds = value;
      controller.saveDebounced();
    }), row(button("Reload Spine", () => controller.reloadStage())));
    debug.open = false;
    root.appendChild(debug);
    if (!controller.usingOverlay()) {
      const preview = section("Stage preview");
      controller.embeddedHost.classList.add("spn-embedded-host");
      preview.appendChild(controller.embeddedHost);
      root.appendChild(preview);
    }
    const models = controller.getModels();
    const library = el("div");
    const libraryList = el("div");
    this.libraryList = libraryList;
    if (models.length === 0) {
      library.appendChild(note("No models imported yet. Import a Spine model folder as a .zip archive."));
    } else {
      const filter = withLabel(el("input", "spn-input spn-library-filter"), "Filter models");
      filter.type = "search";
      filter.placeholder = "Filter models…";
      filter.value = this.libraryFilter;
      filter.addEventListener("input", () => {
        this.libraryFilter = filter.value;
        this.renderLibraryList(libraryList);
      });
      const sort = withLabel(select(SORT_OPTIONS, globals.librarySort, (value) => {
        globals.librarySort = value;
        controller.saveDebounced();
        this.renderLibraryList(libraryList);
      }), "Sort models");
      const views = el("div", "spn-segmented");
      views.setAttribute("role", "group");
      views.setAttribute("aria-label", "Library view");
      const viewButtons = ["tiles", "list"].map((view) => {
        const viewButton = button(view === "tiles" ? "Tiles" : "List", () => {
          globals.libraryView = view;
          controller.saveDebounced();
          for (const other of viewButtons) {
            other.classList.toggle("spn-active", other === viewButton);
            other.setAttribute("aria-pressed", String(other === viewButton));
          }
          this.renderLibraryList(libraryList);
        });
        const active = libraryView(globals.libraryView) === view;
        viewButton.classList.toggle("spn-active", active);
        viewButton.setAttribute("aria-pressed", String(active));
        views.appendChild(viewButton);
        return viewButton;
      });
      library.appendChild(row(filter, sort, views));
    }
    library.appendChild(libraryList);
    this.renderLibraryList(libraryList);
    const importStatus = el("span", "spn-dim", "");
    library.appendChild(row(button("Import model (.zip)", () => {
      this.controller.importZip((text) => {
        importStatus.textContent = text;
      });
    }), importStatus));
    library.appendChild(note("Zip the exported model folder: the skeleton (.skel or .json), its .atlas and the atlas page images. " + "Spine 4.1 exports are supported. A model's thumbnail is taken the first time it's shown."));
    root.appendChild(section("Model library", library));
    const known = controller.getCharacters();
    const activeCharacterId = controller.getActiveCharacterId();
    const inChat = controller.stage.getChatContext().characterIds;
    if (activeCharacterId && !inChat.includes(activeCharacterId))
      inChat.unshift(activeCharacterId);
    const isGroup = inChat.length > 1;
    const characters = [
      ...inChat.map((id, index) => {
        const name = known.find((character) => character.id === id)?.name;
        const fallback = isGroup ? `Group member ${index + 1}` : "Current chat character";
        return { id, name: `${name ?? fallback} (in this chat)` };
      }),
      ...known.filter((character) => !inChat.includes(character.id))
    ];
    if (activeCharacterId !== this.lastActiveCharacterId) {
      if (activeCharacterId && (!this.selectedCharacterId || this.selectedCharacterId === this.lastActiveCharacterId)) {
        this.selectedCharacterId = activeCharacterId;
      }
      this.lastActiveCharacterId = activeCharacterId;
    }
    if (!characters.some((character) => character.id === this.selectedCharacterId)) {
      this.selectedCharacterId = activeCharacterId ?? characters[0]?.id ?? null;
    }
    const bindingSection = el("div");
    if (characters.length === 0) {
      this.selectedModelId = null;
      bindingSection.appendChild(note('Open a chat (or grant the "characters" permission) to assign a model to a character.'));
    } else {
      const characterSelect = this.picker(characters.map((character) => ({
        value: character.id,
        label: character.name,
        leading: {
          type: "image",
          src: `/api/v1/characters/${encodeURIComponent(character.id)}/avatar?size=sm`,
          fallback: { text: initial(character.name) }
        }
      })), this.selectedCharacterId ?? characters[0].id, (value) => {
        this.selectedCharacterId = value;
        this.fileStatusText = "";
        this.render();
      }, { label: "Character", placeholder: "Choose a character", searchPlaceholder: "Search characters…" });
      const boundModelId = this.selectedCharacterId ? settings.characterModelMapping[this.selectedCharacterId] ?? "none" : "none";
      this.selectedModelId = boundModelId === "none" ? null : boundModelId;
      const modelSelect = this.picker(sortModels(models, globals.librarySort).map((model) => ({
        value: model.id,
        label: model.name,
        sublabel: modelSummary(model),
        leading: modelLeading(model)
      })), boundModelId, (value) => {
        const characterId = this.selectedCharacterId;
        if (!characterId)
          return;
        if (value === "none")
          delete settings.characterModelMapping[characterId];
        else
          settings.characterModelMapping[characterId] = value;
        controller.saveNow();
        if (this.isOnStage(characterId))
          controller.reloadStage();
        this.render();
      }, { label: "Model", placeholder: "No model", searchPlaceholder: "Search models…", noneLabel: "No model" });
      bindingSection.appendChild(row("Character", characterSelect));
      bindingSection.appendChild(row("Model", modelSelect));
      if (isGroup) {
        bindingSection.appendChild(note("Group chat: every member with a model is shown. The stage is split into equal columns, one per " + "model, in member order; zoom, X and Y offset and Fit to canvas work within that column."));
      }
      const characterName = () => characters.find((character) => character.id === this.selectedCharacterId)?.name.replace(/ \(in this chat\)$/, "") ?? "Character";
      const fileStatus = el("span", "spn-dim", this.fileStatusText);
      fileStatus.setAttribute("role", "status");
      const exportButton = button("Export settings", () => {
        if (this.selectedCharacterId)
          controller.exportModelSettings(this.selectedCharacterId, characterName());
      });
      exportButton.disabled = boundModelId === "none";
      exportButton.title = "Save this character’s model and animation settings to a file";
      const importButton = button("Import settings", () => {
        const characterId = this.selectedCharacterId;
        if (!characterId)
          return;
        fileStatus.textContent = "";
        controller.importModelSettings(characterId, characterName()).catch((error) => `Import failed: ${String(error)}`).then((status) => {
          if (this.selectedCharacterId !== characterId)
            return;
          this.fileStatusText = status;
          this.render();
        });
      });
      importButton.title = "Load model and animation settings for this character from a file";
      bindingSection.appendChild(row(exportButton, importButton, fileStatus));
      bindingSection.appendChild(row(button("Clear model settings for this character", () => {
        const characterId = this.selectedCharacterId;
        if (!characterId)
          return;
        delete settings.characterModelsSettings[characterId];
        controller.saveNow();
        if (this.isOnStage(characterId))
          controller.reloadStage();
        this.render();
      })));
    }
    root.appendChild(section("Character model", bindingSection));
    if (this.selectedCharacterId && this.selectedModelId) {
      const host = el("div");
      const status = note("Loading model details…");
      host.appendChild(status);
      root.appendChild(section("Model settings", host));
      const characterId = this.selectedCharacterId;
      const modelId = this.selectedModelId;
      const showProgress = () => {
        const progress = controller.getDownloadProgress(modelId);
        if (!progress || progress.totalBytes === 0)
          return;
        const mb = (bytes) => (bytes / (1024 * 1024)).toFixed(1);
        const percent = Math.floor(progress.receivedBytes / progress.totalBytes * 100);
        status.textContent = `Downloading model files… ${percent}% ` + `(${mb(progress.receivedBytes)} / ${mb(progress.totalBytes)} MB)`;
      };
      const progressTimer = window.setInterval(() => {
        if (!status.isConnected)
          window.clearInterval(progressTimer);
        else
          showProgress();
      }, 500);
      controller.describeModel(modelId).then((description) => {
        if (generation !== this.renderGeneration)
          return;
        host.replaceChildren();
        this.renderModelSettings(host, characterId, modelId, description);
      }).catch((error) => {
        if (generation !== this.renderGeneration)
          return;
        host.replaceChildren();
        host.appendChild(note(`Could not load model details: ${String(error)}`));
      }).finally(() => window.clearInterval(progressTimer));
    }
    const testInput = el("input", "spn-input");
    testInput.type = "text";
    testInput.placeholder = "Type a message to classify…";
    const testResult = el("span", "spn-dim", "");
    const test = section("Test emotion classification", row(testInput, button("Classify", () => {
      testResult.textContent = "…";
      controller.classifyTest(testInput.value).then((label) => {
        testResult.textContent = `→ ${label}`;
      }).catch((error) => {
        testResult.textContent = String(error);
      });
    }), testResult));
    test.open = false;
    root.appendChild(test);
    for (const mount of this.pendingMounts.splice(0))
      mount();
  }
  refreshLibrary() {
    if (this.libraryList)
      this.renderLibraryList(this.libraryList);
  }
  renderLibraryList(host) {
    const controller = this.controller;
    const settings = controller.getSettings();
    const models = controller.getModels();
    host.replaceChildren();
    if (models.length === 0)
      return;
    const needle = this.libraryFilter.trim().toLowerCase();
    const shown = sortModels(needle ? models.filter((model) => model.name.toLowerCase().includes(needle)) : models, settings.global.librarySort);
    if (shown.length === 0) {
      host.appendChild(note(`No models match “${this.libraryFilter.trim()}”.`));
      return;
    }
    const boundTo = (modelId) => Object.values(settings.characterModelMapping).filter((bound) => bound === modelId).length;
    const remove = (model, label) => {
      const removeButton = withLabel(button(label, () => {
        controller.deleteModel(model.id);
      }), `Delete ${model.name}`);
      removeButton.title = `Delete ${model.name}`;
      return removeButton;
    };
    if (libraryView(settings.global.libraryView) === "tiles") {
      const grid = el("div", "spn-tiles");
      for (const model of shown) {
        const tile = el("div", "spn-tile");
        const used = boundTo(model.id);
        tile.title = `${model.name}
${modelSummary(model)}${used ? `
Used by ${used} character${used === 1 ? "" : "s"}` : ""}`;
        tile.appendChild(thumbnail(model, "spn-tile-thumb"));
        tile.appendChild(el("div", "spn-tile-name", model.name));
        tile.appendChild(el("div", "spn-tile-meta", megabytes(model)));
        const removeButton = remove(model, "✕");
        removeButton.classList.add("spn-tile-delete");
        tile.appendChild(removeButton);
        grid.appendChild(tile);
      }
      host.appendChild(grid);
      return;
    }
    for (const model of shown) {
      const line = el("div", "spn-list-row");
      const text = el("div", "spn-list-text");
      text.appendChild(el("div", "spn-model-name", model.name));
      text.appendChild(el("div", "spn-dim", `Spine ${model.spineVersion} · ${model.fileCount} files · ${megabytes(model)}`));
      line.append(thumbnail(model, "spn-list-thumb"), text, remove(model, "Delete"));
      host.appendChild(line);
    }
  }
  picker(options, value, onChange, config) {
    const fallback = () => select([...config.noneLabel ? [{ value: "none", label: config.noneLabel }] : [], ...options], value, onChange);
    const mount = this.controller.mountSelect;
    if (!mount)
      return fallback();
    const host = el("div", "spn-picker");
    this.pendingMounts.push(() => {
      try {
        this.mounted.push(mount(host, {
          options,
          value: value === "none" ? "" : value,
          clearable: config.noneLabel !== undefined,
          clearLabel: config.noneLabel,
          placeholder: config.placeholder,
          searchPlaceholder: config.searchPlaceholder,
          noResultsMessage: "No matches",
          searchThreshold: SEARCH_THRESHOLD,
          maxHeight: 360,
          ariaLabel: config.label,
          onChange: (next) => onChange(next === "" ? "none" : next)
        }));
      } catch (error) {
        console.debug("[spine] host dropdown unavailable:", error);
        host.replaceChildren(withLabel(fallback(), config.label));
      }
    });
    return host;
  }
  isOnStage(characterId) {
    return this.controller.stage.getChatContext().characterIds.includes(characterId);
  }
  renderModelSettings(host, characterId, modelId, description) {
    const controller = this.controller;
    const stage = controller.stage;
    const modelSettings = controller.getOrCreateModelSettings(characterId, modelId, description);
    const isLive = () => stage.isOnStage(characterId, modelId);
    const notLiveReason = () => {
      if (isLive())
        return null;
      if (!controller.getSettings().global.enabled)
        return "Spine is turned off (Global → Enabled).";
      if (!this.isOnStage(characterId)) {
        return "Open a chat with this character to see the model on stage.";
      }
      return "The model isn't on stage yet. If it doesn't appear, use Debug → Reload Spine.";
    };
    const onStage = (status, action) => {
      const reason = notLiveReason();
      status.say(reason ?? "");
      if (!reason)
        action();
    };
    const changed = () => controller.saveDebounced();
    const limits = SETTINGS_LIMITS;
    const renderScale = slider("Render scale", limits.renderScale, modelSettings.renderScale, formatFixed(2, "×"), (value) => {
      modelSettings.renderScale = value;
      changed();
    });
    const zoom = slider("Zoom", limits.zoom, modelSettings.zoom, formatFixed(2, "×"), (value) => {
      modelSettings.zoom = value;
      changed();
    });
    const rotation = slider("Rotation", limits.rotation, modelSettings.rotation, formatFixed(0, "°"), (value) => {
      modelSettings.rotation = value;
      changed();
    });
    const speed = slider("Playback speed", limits.speed, modelSettings.speed, formatFixed(2, "×"), (value) => {
      modelSettings.speed = value;
      changed();
    });
    const offsetX = slider("X offset", limits.offset, modelSettings.x, formatFixed(0, "%"), (value) => {
      modelSettings.x = value;
      changed();
    });
    const offsetY = slider("Y offset", limits.offset, modelSettings.y, formatFixed(0, "%"), (value) => {
      modelSettings.y = value;
      changed();
    });
    this.syncLayout = () => {
      zoom.set(modelSettings.zoom);
      offsetX.set(modelSettings.x);
      offsetY.set(modelSettings.y);
    };
    const viewStatus = statusLine();
    const view = el("div");
    view.appendChild(row(button("Fit to canvas", () => onStage(viewStatus, () => {
      if (!stage.fitToCanvas(characterId, modelId)) {
        viewStatus.say("The stage is hidden or has no size yet. Show it, then try again.");
        return;
      }
      this.syncLayout?.();
    })), button("Center model", () => {
      modelSettings.x = 0;
      modelSettings.y = 0;
      changed();
      viewStatus.say("");
      this.syncLayout?.();
    }), button("Update thumbnail", () => onStage(viewStatus, () => {
      viewStatus.say(controller.updateThumbnail(characterId, modelId) ? "Thumbnail updated." : "The stage is hidden or has no size yet. Show it, then try again.");
    })), viewStatus.root));
    view.append(renderScale.root, zoom.root, rotation.root, speed.root, offsetX.root, offsetY.root);
    view.appendChild(checkbox("Premultiplied alpha", modelSettings.premultipliedAlpha, (value) => {
      modelSettings.premultipliedAlpha = value;
      changed();
    }));
    view.appendChild(note(`Render scale is the drawing resolution (lower is faster, higher is sharper); zoom is the model's size. ` + `Drag the model to move it. This model's atlas says premultiplied alpha is ${description.pma ? "on" : "off"}; ` + `if edges look dark or haloed, flip the toggle.`));
    host.appendChild(section("View", view));
    const options = animationOptions(description);
    const animationStatus = statusLine();
    const emotionStatus = statusLine();
    const preview = (label, status, name) => {
      const play = button("▶", () => onStage(status, () => stage.playAnimation(characterId, name())));
      play.setAttribute("aria-label", `Play ${label} animation`);
      return play;
    };
    const animations = el("div");
    animations.appendChild(animationStatus.root);
    if (description.skins.length > 1) {
      animations.appendChild(row("Skin", select(description.skins.map((skin) => ({ value: skin === "default" ? "" : skin, label: skin })), modelSettings.skin, (value) => {
        modelSettings.skin = value;
        changed();
        if (isLive())
          stage.applySkin(characterId);
      })));
    }
    animations.appendChild(row("Idle (loops)", select(options, modelSettings.animation_idle, (value) => {
      modelSettings.animation_idle = value;
      changed();
      if (isLive())
        stage.applyIdle(characterId);
    })));
    animations.appendChild(row("On chat open", select(options, modelSettings.animation_starter.animation, (value) => {
      modelSettings.animation_starter.animation = value;
      changed();
    }), preview("chat open", animationStatus, () => modelSettings.animation_starter.animation)));
    animations.appendChild(slider("Delay before it plays (ms)", { min: 0, max: 1e4, step: 100 }, modelSettings.animation_starter.delay, formatFixed(0), (value) => {
      modelSettings.animation_starter.delay = value;
      changed();
    }).root);
    const clickMessage = el("input", "spn-input");
    clickMessage.type = "text";
    clickMessage.placeholder = "Message sent when clicked (optional)";
    clickMessage.value = modelSettings.animation_click.message;
    clickMessage.addEventListener("change", () => {
      modelSettings.animation_click.message = clickMessage.value;
      changed();
    });
    animations.appendChild(row("On click", select(options, modelSettings.animation_click.animation, (value) => {
      modelSettings.animation_click.animation = value;
      changed();
    }), preview("click", animationStatus, () => modelSettings.animation_click.animation)));
    animations.appendChild(row("Click message", clickMessage));
    animations.appendChild(row("While talking", select(options, modelSettings.animation_talk, (value) => {
      modelSettings.animation_talk = value;
      changed();
    })));
    animations.appendChild(slider("Talk time per character (ms)", { min: 0, max: 100, step: 1 }, modelSettings.talk_time_per_character, formatFixed(0), (value) => {
      modelSettings.talk_time_per_character = value;
      changed();
    }).root);
    animations.appendChild(note("Chat-open, click and emotion animations play once, then the idle loop resumes. " + "The talking animation plays on a layer above them."));
    host.appendChild(section("Animations", animations));
    const classify = el("div");
    classify.appendChild(emotionStatus.root);
    for (const label of CLASSIFY_EXPRESSIONS) {
      const current = modelSettings.classify_mapping[label] ?? "none";
      classify.appendChild(row(el("span", "spn-emotion", label), withLabel(select(options, current, (value) => {
        modelSettings.classify_mapping[label] = value;
        changed();
      }), `Animation for ${label}`), preview(label, emotionStatus, () => modelSettings.classify_mapping[label] ?? "none")));
    }
    classify.appendChild(note("Emotions whose names match one of the model’s animations are mapped on first load."));
    const classifySection = section("Emotion mappings", classify);
    classifySection.open = false;
    host.appendChild(classifySection);
  }
}
var UI_CSS = `
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

// src/frontend/tus.ts
var ENDPOINT = "/api/v1/spindle-uploads";
var PATCH_CHUNK = 8 * 1024 * 1024;
function encodeMetadata(pairs) {
  return Object.entries(pairs).map(([key, value]) => `${key} ${btoa(unescape(encodeURIComponent(value)))}`).join(",");
}
async function tusUpload(bytes, filename, extensionIdentifier, onProgress) {
  const created = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "Tus-Resumable": "1.0.0",
      "Upload-Length": String(bytes.length),
      "Upload-Metadata": encodeMetadata({ filename, extension: extensionIdentifier })
    },
    credentials: "same-origin"
  });
  if (created.status !== 201) {
    throw new Error(`Upload could not be created (HTTP ${created.status}).`);
  }
  const location = created.headers.get("Location");
  if (!location)
    throw new Error("Upload endpoint returned no Location header.");
  const uploadUrl = new URL(location, window.location.origin).toString();
  let offset = 0;
  while (offset < bytes.length) {
    const chunk = bytes.subarray(offset, Math.min(offset + PATCH_CHUNK, bytes.length));
    const patched = await fetch(uploadUrl, {
      method: "PATCH",
      headers: {
        "Tus-Resumable": "1.0.0",
        "Upload-Offset": String(offset),
        "Content-Type": "application/offset+octet-stream"
      },
      credentials: "same-origin",
      body: chunk
    });
    if (patched.status !== 204) {
      throw new Error(`Upload chunk failed (HTTP ${patched.status}).`);
    }
    offset = Number(patched.headers.get("Upload-Offset") ?? offset + chunk.length);
    onProgress?.(offset, bytes.length);
  }
  const uploadId = uploadUrl.split("/").filter(Boolean).pop();
  if (!uploadId)
    throw new Error("Could not determine upload id.");
  return uploadId;
}

// src/shared/settings-file.ts
var SETTINGS_FILE_FORMAT = "lumiverse-avatar-model-settings";
var SETTINGS_FILE_VERSION = 1;
var SETTINGS_FILE_EXTENSION = "spine";
var EXTENSION_NAMES = { live2d: "Live2D", spine: "Spine" };
function buildSettingsFile(character, model, settings) {
  return {
    format: SETTINGS_FILE_FORMAT,
    version: SETTINGS_FILE_VERSION,
    extension: SETTINGS_FILE_EXTENSION,
    exportedAt: new Date().toISOString(),
    character: { id: character.id, name: character.name },
    model: { id: model.id, name: model.name },
    settings: JSON.parse(JSON.stringify(settings))
  };
}
function settingsFileName(characterName, modelName) {
  const clean = (text) => text.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "_").trim().slice(0, 60) || "model";
  return `${clean(characterName)} - ${clean(modelName)}.${SETTINGS_FILE_EXTENSION}-settings.json`;
}
function parseSettingsFile(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return { error: "This file isn't valid JSON." };
  }
  const value = raw;
  if (!value || typeof value !== "object" || value.format !== SETTINGS_FILE_FORMAT) {
    return { error: "This isn't a model settings file exported from the Live2D or Spine Avatars extension." };
  }
  if (value.extension !== SETTINGS_FILE_EXTENSION) {
    const name = EXTENSION_NAMES[String(value.extension)] ?? String(value.extension);
    return { error: `This file holds ${name} model settings. Import it in the ${name} Avatars extension.` };
  }
  if (typeof value.version !== "number" || value.version > SETTINGS_FILE_VERSION) {
    return { error: "This file was made by a newer version of the extension. Update the extension, then try again." };
  }
  if (!value.settings || typeof value.settings !== "object" || Array.isArray(value.settings)) {
    return { error: "This file has no model settings in it." };
  }
  const named = (part) => {
    const object = part && typeof part === "object" ? part : {};
    return {
      id: typeof object.id === "string" ? object.id : "",
      name: typeof object.name === "string" ? object.name : ""
    };
  };
  return {
    file: {
      format: SETTINGS_FILE_FORMAT,
      version: value.version,
      extension: value.extension,
      exportedAt: typeof value.exportedAt === "string" ? value.exportedAt : "",
      character: named(value.character),
      model: named(value.model),
      settings: value.settings
    }
  };
}

// src/frontend.ts
var EXTENSION_ID = "spine_avatars";
var STAGE_CSS = `
.spine-avatars-overlay { position: fixed; inset: 0; pointer-events: none; z-index: 4; }
.spine-avatars-canvas { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; background: transparent; }
html.spine-avatars-hover, html.spine-avatars-hover * { cursor: grab !important; }
/* Background mode: the host mounts the overlay at z-index 9990 above the whole
   app. Drop it to 0 so it sits above the app's backdrop and global wallpaper
   but under <main> (z-index 1), which holds the chat. While a chat is open the
   overlay moves into the chat view instead (see placeOverlay). */
html.spine-avatars-bg .spine-avatars-mount { z-index: 0 !important; }
html.spine-avatars-bg .spine-avatars-overlay { z-index: 0; }
`;
var TAB_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="4.5" r="2"/><path d="M12 6.5v6.5"/><path d="M12 8.5l-4 2.5-1.5 3.5M12 8.5l4 2.5 1.5 3.5"/><path d="M12 13l-3 3.5L8 21M12 13l3 3.5 1 4.5"/><circle cx="12" cy="13" r=".8"/><circle cx="8" cy="11" r=".8"/><circle cx="16" cy="11" r=".8"/><circle cx="9" cy="16.5" r=".8"/><circle cx="15" cy="16.5" r=".8"/></svg>';
function downloadJson(fileName, value) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60000);
}
function setup(ctx) {
  ctx.deferReady();
  let settings = defaultSettings();
  let models = [];
  let characters = [];
  let permissions = [];
  let stateReceived = false;
  const cleanups = [];
  const removeStyle = ctx.dom.addStyle(STAGE_CSS + UI_CSS);
  cleanups.push(removeStyle);
  const assets = new ModelAssets((payload) => ctx.sendToBackend(payload));
  let saveTimer = null;
  const saveNow = () => {
    if (saveTimer !== null) {
      window.clearTimeout(saveTimer);
      saveTimer = null;
    }
    ctx.sendToBackend({ type: "save_settings", settings });
  };
  const saveDebounced = () => {
    if (saveTimer !== null)
      window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(saveNow, 500);
  };
  const getOrCreateModelSettings = (characterId, modelId, description) => {
    const byCharacter = settings.characterModelsSettings[characterId] ??= {};
    let modelSettings = byCharacter[modelId];
    if (!modelSettings) {
      modelSettings = defaultModelSettings(description);
      byCharacter[modelId] = modelSettings;
      saveDebounced();
    } else {
      ensureModelSettingsShape(modelSettings, description);
    }
    return modelSettings;
  };
  const stage = new Stage({
    getSettings: () => settings,
    getModelRecord: (modelId) => models.find((model) => model.id === modelId),
    getModelSettings: getOrCreateModelSettings,
    saveSettingsDebounced: saveDebounced,
    layoutChanged: () => ui.layoutChanged(),
    assets,
    sendInteraction: (message, characterId) => {
      const { chatId } = stage.getChatContext();
      if (!chatId)
        return;
      ctx.sendToBackend({
        type: "interaction",
        chatId,
        message,
        generate: settings.global.autoSendInteraction,
        characterId
      });
    },
    saveThumbnail: (modelId, dataUrl) => {
      models = models.map((model) => model.id === modelId ? { ...model, thumbnail: dataUrl } : model);
      ctx.sendToBackend({ type: "save_thumbnail", modelId, dataUrl });
      ui.refreshLibrary();
    },
    log: (message) => console.debug("[spine]", message)
  });
  cleanups.push(() => stage.destroy());
  const embeddedHost = document.createElement("div");
  let overlayMount = null;
  let overlayActive = false;
  const ensureStageHost = () => {
    if (permissions.includes("app_manipulation")) {
      if (!overlayMount) {
        try {
          const mount = ctx.ui.mountApp({ className: "spine-avatars-mount", position: "app-overlay" });
          const host = document.createElement("div");
          host.className = "spine-avatars-overlay";
          mount.root.appendChild(host);
          overlayMount = {
            root: host,
            mountRoot: mount.root,
            destroy: () => {
              host.remove();
              mount.destroy();
            }
          };
          cleanups.push(() => overlayMount?.destroy());
        } catch (error) {
          console.debug("[spine] overlay mount unavailable:", error);
        }
      }
      if (overlayMount) {
        overlayActive = true;
        stage.setHost(overlayMount.root);
        applyBackgroundMode();
        return;
      }
    }
    overlayActive = false;
    stage.setHost(embeddedHost);
    applyBackgroundMode();
  };
  const applyBackgroundMode = () => {
    const on = settings.global.enabled && settings.global.backgroundMode && overlayActive;
    document.documentElement.classList.toggle("spine-avatars-bg", on);
    setOverlayTracking(on);
    placeOverlay();
  };
  cleanups.push(() => document.documentElement.classList.remove("spine-avatars-bg"));
  const placeOverlay = () => {
    if (!overlayMount)
      return;
    const host = overlayMount.root;
    const bgOn = document.documentElement.classList.contains("spine-avatars-bg");
    const next = host.nextElementSibling;
    if (bgOn && host.isConnected && next?.getAttribute("data-lumiverse-surface") === "chat-body")
      return;
    const chatBody = bgOn ? document.querySelector('[data-component="ChatView"] > [data-lumiverse-surface="chat-body"]') : null;
    const target = chatBody?.parentElement ?? overlayMount.mountRoot;
    if (host.parentElement === target && (!chatBody || host.nextElementSibling === chatBody))
      return;
    target.insertBefore(host, chatBody ?? null);
  };
  let overlayObserver = null;
  let placeFrame = null;
  const setOverlayTracking = (on) => {
    if (on && !overlayObserver) {
      overlayObserver = new MutationObserver(() => {
        if (placeFrame !== null)
          return;
        placeFrame = window.requestAnimationFrame(() => {
          placeFrame = null;
          placeOverlay();
        });
      });
      overlayObserver.observe(document.querySelector("[data-app-root]") ?? document.body, {
        childList: true,
        subtree: true
      });
    } else if (!on && overlayObserver) {
      overlayObserver.disconnect();
      overlayObserver = null;
      if (placeFrame !== null)
        window.cancelAnimationFrame(placeFrame);
      placeFrame = null;
    }
  };
  cleanups.push(() => setOverlayTracking(false));
  let classifyPending = null;
  const controller = {
    getSettings: () => settings,
    getModels: () => models,
    getCharacters: () => characters,
    getPermissions: () => permissions,
    getActiveCharacterId: () => ctx.getActiveChat().characterId,
    stage,
    saveDebounced,
    saveNow,
    reloadStage: () => {
      applyBackgroundMode();
      stage.reload();
    },
    importZip: async (status) => {
      const files = await ctx.uploads.pickFile({
        accept: [".zip", "application/zip"],
        maxSizeBytes: 512 * 1024 * 1024
      });
      const file = files[0];
      if (!file)
        return;
      status("Uploading…");
      try {
        const uploadId = await tusUpload(file.bytes, file.name, EXTENSION_ID, (sent, total) => {
          status(`Uploading… ${Math.round(sent / total * 100)}%`);
        });
        status("Importing…");
        ctx.sendToBackend({ type: "import_model_zip", uploadId, name: file.name.replace(/\.zip$/i, "") });
      } catch (error) {
        status(`Upload failed: ${String(error)}`);
      }
    },
    deleteModel: async (modelId) => {
      const record = models.find((model) => model.id === modelId);
      const { confirmed } = await ctx.ui.showConfirm({
        title: "Delete Spine model",
        message: `Delete "${record?.name ?? modelId}" and its files? Character bindings to it are removed.`,
        variant: "danger",
        confirmLabel: "Delete"
      });
      if (confirmed)
        ctx.sendToBackend({ type: "delete_model", modelId });
    },
    classifyTest: (text) => new Promise((resolve, reject) => {
      classifyPending?.reject(new Error("Replaced by a newer test."));
      const pending = { resolve, reject };
      classifyPending = pending;
      ctx.sendToBackend({ type: "classify_test", text });
      setTimeout(() => {
        if (classifyPending === pending) {
          classifyPending = null;
          reject(new Error("Timed out."));
        }
      }, 60000);
    }),
    describeModel: async (modelId) => {
      const record = models.find((model) => model.id === modelId);
      if (!record)
        throw new Error(`Unknown model: ${modelId}`);
      return stage.describeModel(record);
    },
    getDownloadProgress: (modelId) => assets.progress(modelId),
    getOrCreateModelSettings,
    requestPermissions: async (perms) => {
      try {
        permissions = await ctx.permissions.request(perms);
      } catch {}
      ensureStageHost();
      ui.render();
    },
    embeddedHost,
    usingOverlay: () => overlayActive,
    applyBackgroundMode,
    mountSelect: ctx.components?.mountSelect ? (target, options) => ctx.components.mountSelect(target, options) : undefined,
    exportModelSettings: (characterId, characterName) => {
      const modelId = settings.characterModelMapping[characterId];
      const record = models.find((model) => model.id === modelId);
      if (!modelId || !record)
        return;
      const stored = settings.characterModelsSettings[characterId]?.[modelId] ?? defaultModelSettings();
      const file = buildSettingsFile({ id: characterId, name: characterName }, record, stored);
      downloadJson(settingsFileName(characterName, record.name), file);
    },
    importModelSettings: async (characterId, characterName) => {
      const files = await ctx.uploads.pickFile({ accept: [".json", "application/json"], maxSizeBytes: 1024 * 1024 });
      const picked = files[0];
      if (!picked)
        return "";
      const parsed = parseSettingsFile(new TextDecoder().decode(picked.bytes));
      if ("error" in parsed)
        return parsed.error;
      const { file } = parsed;
      const fileModel = file.model.name || file.model.id || "unknown";
      const target = models.find((model) => model.id === file.model.id) ?? models.find((model) => model.name.toLowerCase() === file.model.name.toLowerCase());
      const bound = models.find((model) => model.id === settings.characterModelMapping[characterId]);
      const record = target ?? bound;
      if (!record)
        return `The model "${fileModel}" isn't in your library. Import it first, then try again.`;
      const from = file.character.name && file.character.name !== characterName ? ` (exported from "${file.character.name}")` : "";
      const message = target ? `${characterName} will use "${record.name}" with the settings from this file${from}. ` + `${characterName}'s current settings for that model are replaced.` : `This file is for "${fileModel}", which isn't in your library. Apply its settings${from} to ` + `"${record.name}", ${characterName}'s current model, instead? Animations it names that ` + `"${record.name}" doesn't have are left unset.`;
      const { confirmed } = await ctx.ui.showConfirm({
        title: "Import model settings",
        message,
        variant: target ? "info" : "warning",
        confirmLabel: "Import"
      });
      if (!confirmed)
        return "";
      const description = await stage.describeModel(record).catch(() => null);
      settings.characterModelMapping[characterId] = record.id;
      (settings.characterModelsSettings[characterId] ??= {})[record.id] = sanitizeModelSettings(file.settings, description);
      saveNow();
      stage.reload();
      return `Imported settings for "${record.name}".`;
    },
    updateThumbnail: (characterId, modelId) => {
      if (!stage.isOnStage(characterId, modelId))
        return false;
      const dataUrl = stage.captureThumbnail(characterId);
      if (!dataUrl)
        return false;
      models = models.map((model) => model.id === modelId ? { ...model, thumbnail: dataUrl } : model);
      ctx.sendToBackend({ type: "save_thumbnail", modelId, dataUrl });
      ui.refreshLibrary();
      return true;
    }
  };
  const ui = new SettingsUI(controller);
  const tab = ctx.ui.registerDrawerTab({
    id: "spine",
    title: "Spine Avatars",
    shortName: "Spine",
    description: "Animated Spine character avatars",
    keywords: ["spine", "avatar", "model", "skeleton", "animation"],
    headerTitle: "Spine",
    iconSvg: TAB_ICON
  });
  ui.mount(tab.root);
  cleanups.push(() => tab.destroy());
  const inputAction = ctx.ui.registerInputBarAction({
    id: "spine-settings",
    label: "Spine Settings",
    iconSvg: TAB_ICON
  });
  const unsubAction = inputAction.onClick(() => tab.activate());
  cleanups.push(() => {
    unsubAction();
    inputAction.destroy();
  });
  const followActiveChat = () => {
    const active = ctx.getActiveChat();
    if (stage.getChatContext().chatId !== active.chatId) {
      const own = active.characterId && !permissions.includes("chats") ? [active.characterId] : [];
      stage.setChatContext(active.chatId, own);
    }
    if (active.chatId)
      ctx.sendToBackend({ type: "get_chat_context", chatId: active.chatId });
  };
  const stageCharacterFor = (chatId, characterId) => {
    const context = stage.getChatContext();
    if (!context.chatId || chatId !== context.chatId)
      return null;
    const onStage = stage.charactersOnStage();
    if (characterId)
      return onStage.includes(characterId) ? characterId : null;
    return onStage.length === 1 ? onStage[0] : null;
  };
  const playMappedExpression = (msg) => {
    const characterId = stageCharacterFor(msg.chatId, msg.characterId);
    if (!characterId)
      return;
    const modelId = settings.characterModelMapping[characterId];
    if (!modelId)
      return;
    const modelSettings = getOrCreateModelSettings(characterId, modelId, stage.getDescription(characterId));
    const animation = modelSettings.classify_mapping[msg.label] ?? "none";
    if (animation !== "none")
      stage.playAnimation(characterId, animation);
  };
  const unsubBackend = ctx.onBackendMessage((payload) => {
    const msg = payload;
    if (assets.handleMessage(msg))
      return;
    switch (msg.type) {
      case "state": {
        if (!stateReceived)
          settings = normalizeSettings(msg.settings);
        models = msg.models;
        characters = msg.characters;
        permissions = msg.permissions;
        stateReceived = true;
        ensureStageHost();
        followActiveChat();
        ui.render();
        break;
      }
      case "settings_saved":
        break;
      case "model_imported":
        models = [...models.filter((model) => model.id !== msg.model.id), msg.model];
        ui.render();
        stage.reload();
        break;
      case "model_updated":
        models = models.map((model) => model.id === msg.model.id ? msg.model : model);
        break;
      case "model_deleted":
        models = models.filter((model) => model.id !== msg.modelId);
        assets.invalidate(msg.modelId);
        for (const characterId of Object.keys(settings.characterModelMapping)) {
          if (settings.characterModelMapping[characterId] === msg.modelId) {
            delete settings.characterModelMapping[characterId];
          }
        }
        for (const byModel of Object.values(settings.characterModelsSettings)) {
          if (byModel)
            delete byModel[msg.modelId];
        }
        ui.render();
        stage.reload();
        break;
      case "import_error":
        ui.render();
        ctx.ui.showConfirm({
          title: "Spine import failed",
          message: msg.error,
          variant: "warning",
          confirmLabel: "OK"
        });
        break;
      case "expression":
        playMappedExpression(msg);
        break;
      case "character_message": {
        const characterId = stageCharacterFor(msg.chatId, msg.characterId);
        if (characterId && msg.textLength > 0)
          stage.playTalk(characterId, msg.textLength);
        break;
      }
      case "chat_context": {
        const active = ctx.getActiveChat();
        if (msg.chatId !== active.chatId)
          break;
        const fallback = active.characterId ? [active.characterId] : [];
        stage.setChatContext(msg.chatId, msg.characterIds?.length ? msg.characterIds : fallback);
        ui.render();
        break;
      }
      case "chat_members":
        if (msg.chatId !== stage.getChatContext().chatId)
          break;
        stage.setChatContext(msg.chatId, msg.characterIds);
        ui.render();
        break;
      case "classify_test_result":
        if (classifyPending) {
          const pending = classifyPending;
          classifyPending = null;
          if (msg.error)
            pending.reject(new Error(msg.error));
          else
            pending.resolve(msg.label);
        }
        break;
      case "permissions_changed":
        permissions = msg.permissions;
        ensureStageHost();
        followActiveChat();
        ui.render();
        break;
      case "focus_tab":
        tab.activate();
        break;
      case "reload_models":
        stage.reload();
        break;
      case "toggle_enabled":
        settings.global.enabled = msg.enabled;
        applyBackgroundMode();
        ui.render();
        stage.reload();
        break;
    }
  });
  cleanups.push(unsubBackend);
  const unsubChat = ctx.events.on("CHAT_SWITCHED", () => {
    window.setTimeout(() => {
      followActiveChat();
      ui.render();
    }, 50);
  });
  cleanups.push(unsubChat);
  ctx.sendToBackend({ type: "get_state" });
  ctx.ready();
  window.setTimeout(() => {
    if (!stateReceived)
      ctx.sendToBackend({ type: "get_state" });
  }, 3000);
  return () => {
    for (const cleanup of cleanups.reverse()) {
      try {
        cleanup();
      } catch {}
    }
    ctx.dom.cleanup();
  };
}
export {
  setup
};
