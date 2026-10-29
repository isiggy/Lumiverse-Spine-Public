// @bun
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

// node_modules/@esotericsoftware/spine-core/dist/attachments/Sequence.js
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
// node_modules/@esotericsoftware/spine-core/dist/Texture.js
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
// node_modules/@esotericsoftware/spine-core/dist/BoneData.js
var TransformMode;
(function(TransformMode) {
  TransformMode[TransformMode["Normal"] = 0] = "Normal";
  TransformMode[TransformMode["OnlyTranslation"] = 1] = "OnlyTranslation";
  TransformMode[TransformMode["NoRotationOrReflection"] = 2] = "NoRotationOrReflection";
  TransformMode[TransformMode["NoScale"] = 3] = "NoScale";
  TransformMode[TransformMode["NoScaleOrReflection"] = 4] = "NoScaleOrReflection";
})(TransformMode || (TransformMode = {}));
// node_modules/@esotericsoftware/spine-core/dist/PathConstraintData.js
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
// node_modules/@esotericsoftware/spine-core/dist/SlotData.js
var BlendMode;
(function(BlendMode) {
  BlendMode[BlendMode["Normal"] = 0] = "Normal";
  BlendMode[BlendMode["Additive"] = 1] = "Additive";
  BlendMode[BlendMode["Multiply"] = 2] = "Multiply";
  BlendMode[BlendMode["Screen"] = 3] = "Screen";
})(BlendMode || (BlendMode = {}));

// node_modules/@esotericsoftware/spine-core/dist/SkeletonBinary.js
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
// node_modules/fflate/esm/index.mjs
import { createRequire } from "module";
var require2 = createRequire("/");
var _a;
var Worker;
var isMarkedAsUntransferable;
try {
  _a = require2("worker_threads"), Worker = _a.Worker, isMarkedAsUntransferable = _a.isMarkedAsUntransferable;
} catch (e) {}
var u8 = Uint8Array;
var u16 = Uint16Array;
var i32 = Int32Array;
var fleb = new u8([0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0, 0, 0, 0]);
var fdeb = new u8([0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13, 0, 0]);
var clim = new u8([16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]);
var freb = function(eb, start) {
  var b = new u16(31);
  for (var i = 0;i < 31; ++i) {
    b[i] = start += 1 << eb[i - 1];
  }
  var r = new i32(b[30]);
  for (var i = 1;i < 30; ++i) {
    for (var j = b[i];j < b[i + 1]; ++j) {
      r[j] = j - b[i] << 5 | i;
    }
  }
  return { b, r };
};
var _a = freb(fleb, 2);
var fl = _a.b;
var revfl = _a.r;
fl[28] = 258, revfl[258] = 28;
var _b = freb(fdeb, 0);
var fd = _b.b;
var revfd = _b.r;
var rev = new u16(32768);
for (i = 0;i < 32768; ++i) {
  x = (i & 43690) >> 1 | (i & 21845) << 1;
  x = (x & 52428) >> 2 | (x & 13107) << 2;
  x = (x & 61680) >> 4 | (x & 3855) << 4;
  rev[i] = ((x & 65280) >> 8 | (x & 255) << 8) >> 1;
}
var x;
var i;
var hMap = function(cd, mb, r) {
  var s = cd.length;
  var i = 0;
  var l = new u16(mb);
  for (;i < s; ++i) {
    if (cd[i])
      ++l[cd[i] - 1];
  }
  var le = new u16(mb);
  for (i = 1;i < mb; ++i) {
    le[i] = le[i - 1] + l[i - 1] << 1;
  }
  var co;
  if (r) {
    co = new u16(1 << mb);
    var rvb = 15 - mb;
    for (i = 0;i < s; ++i) {
      if (cd[i]) {
        var sv = i << 4 | cd[i];
        var r_1 = mb - cd[i];
        var v = le[cd[i] - 1]++ << r_1;
        for (var m = v | (1 << r_1) - 1;v <= m; ++v) {
          co[rev[v] >> rvb] = sv;
        }
      }
    }
  } else {
    co = new u16(s);
    for (i = 0;i < s; ++i) {
      if (cd[i]) {
        co[i] = rev[le[cd[i] - 1]++] >> 15 - cd[i];
      }
    }
  }
  return co;
};
var flt = new u8(288);
for (i = 0;i < 144; ++i)
  flt[i] = 8;
var i;
for (i = 144;i < 256; ++i)
  flt[i] = 9;
var i;
for (i = 256;i < 280; ++i)
  flt[i] = 7;
var i;
for (i = 280;i < 288; ++i)
  flt[i] = 8;
var i;
var fdt = new u8(32);
for (i = 0;i < 32; ++i)
  fdt[i] = 5;
var i;
var flrm = /* @__PURE__ */ hMap(flt, 9, 1);
var fdrm = /* @__PURE__ */ hMap(fdt, 5, 1);
var max = function(a) {
  var m = a[0];
  for (var i = 1;i < a.length; ++i) {
    if (a[i] > m)
      m = a[i];
  }
  return m;
};
var bits = function(d, p, m) {
  var o = p / 8 | 0;
  return (d[o] | d[o + 1] << 8) >> (p & 7) & m;
};
var bits16 = function(d, p) {
  var o = p / 8 | 0;
  return (d[o] | d[o + 1] << 8 | d[o + 2] << 16) >> (p & 7);
};
var shft = function(p) {
  return (p + 7) / 8 | 0;
};
var slc = function(v, s, e) {
  if (s == null || s < 0)
    s = 0;
  if (e == null || e > v.length)
    e = v.length;
  return new u8(v.subarray(s, e));
};
var ec = [
  "unexpected EOF",
  "invalid block type",
  "invalid length/literal",
  "invalid distance",
  "stream finished",
  "no stream handler",
  ,
  "no callback",
  "invalid UTF-8 data",
  "extra field too long",
  "date not in range 1980-2099",
  "filename too long",
  "stream finishing",
  "invalid zip data"
];
var err = function(ind, msg, nt) {
  var e = new Error(msg || ec[ind]);
  e.code = ind;
  if (Error.captureStackTrace)
    Error.captureStackTrace(e, err);
  if (!nt)
    throw e;
  return e;
};
var inflt = function(dat, st, buf, dict) {
  var sl = dat.length, dl = dict ? dict.length : 0;
  if (!sl || st.f && !st.l)
    return buf || new u8(0);
  var noBuf = !buf;
  var resize = noBuf || st.i != 2;
  var noSt = st.i;
  if (noBuf)
    buf = new u8(sl * 3);
  var cbuf = function(l) {
    var bl = buf.length;
    if (l > bl) {
      var nbuf = new u8(Math.max(bl * 2, l));
      nbuf.set(buf);
      buf = nbuf;
    }
  };
  var final = st.f || 0, pos = st.p || 0, bt = st.b || 0, { l: lm, d: dm, m: lbt, n: dbt } = st;
  var tbts = sl * 8;
  do {
    if (!lm) {
      final = bits(dat, pos, 1);
      var type = bits(dat, pos + 1, 3);
      pos += 3;
      if (!type) {
        var s = shft(pos) + 4, l = dat[s - 4] | dat[s - 3] << 8, t = s + l;
        if (t > sl) {
          if (noSt)
            err(0);
          break;
        }
        if (resize)
          cbuf(bt + l);
        buf.set(dat.subarray(s, t), bt);
        st.b = bt += l, st.p = pos = t * 8, st.f = final;
        continue;
      } else if (type == 1)
        lm = flrm, dm = fdrm, lbt = 9, dbt = 5;
      else if (type == 2) {
        var hLit = bits(dat, pos, 31) + 257, hcLen = bits(dat, pos + 10, 15) + 4;
        var tl = hLit + bits(dat, pos + 5, 31) + 1;
        pos += 14;
        var ldt = new u8(tl);
        var clt = new u8(19);
        for (var i = 0;i < hcLen; ++i) {
          clt[clim[i]] = bits(dat, pos + i * 3, 7);
        }
        pos += hcLen * 3;
        var clb = max(clt), clbmsk = (1 << clb) - 1;
        var clm = hMap(clt, clb, 1);
        for (var i = 0;i < tl; ) {
          var r = clm[bits(dat, pos, clbmsk)];
          pos += r & 15;
          var s = r >> 4;
          if (s < 16) {
            ldt[i++] = s;
          } else {
            var c = 0, n = 0;
            if (s == 16)
              n = 3 + bits(dat, pos, 3), pos += 2, c = ldt[i - 1];
            else if (s == 17)
              n = 3 + bits(dat, pos, 7), pos += 3;
            else if (s == 18)
              n = 11 + bits(dat, pos, 127), pos += 7;
            while (n--)
              ldt[i++] = c;
          }
        }
        var lt = ldt.subarray(0, hLit), dt = ldt.subarray(hLit);
        lbt = max(lt);
        dbt = max(dt);
        lm = hMap(lt, lbt, 1);
        dm = hMap(dt, dbt, 1);
      } else
        err(1);
      if (pos > tbts) {
        if (noSt)
          err(0);
        break;
      }
    }
    if (resize)
      cbuf(bt + 131072);
    var lms = (1 << lbt) - 1, dms = (1 << dbt) - 1;
    var lpos = pos;
    for (;; lpos = pos) {
      var c = lm[bits16(dat, pos) & lms], sym = c >> 4;
      pos += c & 15;
      if (pos > tbts) {
        if (noSt)
          err(0);
        break;
      }
      if (!c)
        err(2);
      if (sym < 256)
        buf[bt++] = sym;
      else if (sym == 256) {
        lpos = pos, lm = null;
        break;
      } else {
        var add = sym - 254;
        if (sym > 264) {
          var i = sym - 257, b = fleb[i];
          add = bits(dat, pos, (1 << b) - 1) + fl[i];
          pos += b;
        }
        var d = dm[bits16(dat, pos) & dms], dsym = d >> 4;
        if (!d)
          err(3);
        pos += d & 15;
        var dt = fd[dsym];
        if (dsym > 3) {
          var b = fdeb[dsym];
          dt += bits16(dat, pos) & (1 << b) - 1, pos += b;
        }
        if (pos > tbts) {
          if (noSt)
            err(0);
          break;
        }
        if (resize)
          cbuf(bt + 131072);
        var end = bt + add;
        if (bt < dt) {
          var shift = dl - dt, dend = Math.min(dt, end);
          if (shift + bt < 0)
            err(3);
          for (;bt < dend; ++bt)
            buf[bt] = dict[shift + bt];
        }
        for (;bt < end; ++bt)
          buf[bt] = buf[bt - dt];
      }
    }
    st.l = lm, st.p = lpos, st.b = bt, st.f = final;
    if (lm)
      final = 1, st.m = lbt, st.d = dm, st.n = dbt;
  } while (!final);
  return bt != buf.length && noBuf ? slc(buf, 0, bt) : buf.subarray(0, bt);
};
var et = /* @__PURE__ */ new u8(0);
var b2 = function(d, b) {
  return d[b] | d[b + 1] << 8;
};
var b4 = function(d, b) {
  return (d[b] | d[b + 1] << 8 | d[b + 2] << 16 | d[b + 3] << 24) >>> 0;
};
var b8 = function(d, b) {
  return b4(d, b) + b4(d, b + 4) * 4294967296;
};
function inflateSync(data, opts) {
  return inflt(data, { i: 2 }, opts && opts.out, opts && opts.dictionary);
}
var td = typeof TextDecoder != "undefined" && /* @__PURE__ */ new TextDecoder;
var tds = 0;
try {
  td.decode(et, { stream: true });
  tds = 1;
} catch (e) {}
var dutf8 = function(d) {
  for (var r = "", i = 0;; ) {
    var c = d[i++];
    var eb = (c > 127) + (c > 223) + (c > 239);
    if (i + eb > d.length)
      return { s: r, r: slc(d, i - 1) };
    if (!eb)
      r += String.fromCharCode(c);
    else if (eb == 3) {
      c = ((c & 15) << 18 | (d[i++] & 63) << 12 | (d[i++] & 63) << 6 | d[i++] & 63) - 65536, r += String.fromCharCode(55296 | c >> 10, 56320 | c & 1023);
    } else if (eb & 1)
      r += String.fromCharCode((c & 31) << 6 | d[i++] & 63);
    else
      r += String.fromCharCode((c & 15) << 12 | (d[i++] & 63) << 6 | d[i++] & 63);
  }
};
function strFromU8(dat, latin1) {
  if (latin1) {
    var r = "";
    for (var i = 0;i < dat.length; i += 16384)
      r += String.fromCharCode.apply(null, dat.subarray(i, i + 16384));
    return r;
  } else if (td) {
    return td.decode(dat);
  } else {
    var _a = dutf8(dat), { s, r } = _a;
    if (r.length)
      err(8);
    return s;
  }
}
var slzh = function(d, b) {
  return b + 30 + b2(d, b + 26) + b2(d, b + 28);
};
var zh = function(d, b, z) {
  var fnl = b2(d, b + 28), efl = b2(d, b + 30), fn = strFromU8(d.subarray(b + 46, b + 46 + fnl), !(b2(d, b + 8) & 2048)), es = b + 46 + fnl;
  var _a = z64hs(d, es, efl, z, b4(d, b + 20), b4(d, b + 24), b4(d, b + 42)), sc = _a[0], su = _a[1], off = _a[2];
  return [b2(d, b + 10), sc, su, fn, es + efl + b2(d, b + 32), off];
};
var z64hs = function(d, b, l, z, sc, su, off) {
  var nsc = sc == 4294967295, nsu = su == 4294967295, noff = off == 4294967295, e = b + l;
  var nf = nsc + nsu + noff;
  if (z && nf) {
    for (;b + 4 < e; b += 4 + b2(d, b + 2)) {
      if (b2(d, b) == 1) {
        return [
          nsc ? b8(d, b + 4 + 8 * nsu) : sc,
          nsu ? b8(d, b + 4) : su,
          noff ? b8(d, b + 4 + 8 * (nsu + nsc)) : off,
          1
        ];
      }
    }
    if (z < 2)
      err(13);
  }
  return [sc, su, off, 0];
};
function unzipSync(data, opts) {
  var files = {};
  var e = data.length - 22;
  for (;b4(data, e) != 101010256; --e) {
    if (!e || data.length - e > 65558)
      err(13);
  }
  var c = b2(data, e + 8);
  if (!c)
    return {};
  var o = b4(data, e + 16);
  var z = b4(data, e - 20) == 117853008;
  if (z) {
    var ze = b4(data, e - 12);
    z = b4(data, ze) == 101075792;
    if (z) {
      c = b4(data, ze + 32);
      o = b4(data, ze + 48);
    }
  }
  var fltr = opts && opts.filter;
  for (var i = 0;i < c; ++i) {
    var _a = zh(data, o, z), c_2 = _a[0], sc = _a[1], su = _a[2], fn = _a[3], no = _a[4], off = _a[5], b = slzh(data, off);
    o = no;
    if (!fltr || fltr({
      name: fn,
      size: sc,
      originalSize: su,
      compression: c_2
    })) {
      if (!c_2)
        files[fn] = slc(data, b, b + sc);
      else if (c_2 == 8)
        files[fn] = inflateSync(data.subarray(b, b + sc), { out: new u8(su) });
      else
        err(14, "unknown compression type " + c_2);
    }
  }
  return files;
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
var SUPPORTED_SPINE_VERSIONS = ["4.1", "3.8"];
function spineRuntimeFor(version) {
  const majorMinor = version.split(".").slice(0, 2).join(".");
  return SUPPORTED_SPINE_VERSIONS.find((supported) => supported === majorMinor) ?? null;
}
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
var IDLE_ANIMATION_HINTS = ["idle", "idle_0", "idle_1", "idle01", "stand", "wait", "loop", "animation", "normal"];
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

// src/backend.ts
var SETTINGS_FILE = "settings.json";
var REGISTRY_FILE = "models.json";
var MODELS_DIR = "models";
var MAX_UNPACKED_BYTES = 512 * 1024 * 1024;
var MAX_FILE_COUNT = 3000;
var CHUNK_BYTES = 1024 * 1024;
async function loadSettings(userId) {
  const raw = await spindle.userStorage.getJson(SETTINGS_FILE, {
    fallback: null,
    ...userId ? { userId } : {}
  });
  return normalizeSettings(raw);
}
async function saveSettings(settings, userId) {
  await spindle.userStorage.setJson(SETTINGS_FILE, settings, {
    indent: 2,
    ...userId ? { userId } : {}
  });
}
async function loadRegistry(userId) {
  const raw = await spindle.userStorage.getJson(REGISTRY_FILE, {
    fallback: [],
    ...userId ? { userId } : {}
  });
  return Array.isArray(raw) ? raw : [];
}
async function saveRegistry(models, userId) {
  await spindle.userStorage.setJson(REGISTRY_FILE, models, {
    indent: 2,
    ...userId ? { userId } : {}
  });
}
function send(payload, userId) {
  spindle.sendToFrontend(payload, userId);
}
function sanitizeZipPath(path) {
  const normalized = path.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized || normalized.endsWith("/"))
    return null;
  const parts = normalized.split("/");
  if (parts.some((part) => part === ".." || part === "" || part === "."))
    return null;
  if (parts.some((part) => part === "__MACOSX" || part === ".DS_Store" || part.startsWith("._")))
    return null;
  return parts.join("/");
}
function stripCommonRoot(paths) {
  const roots = new Set(paths.map((path) => path.split("/")[0]));
  const first = [...roots][0];
  if (roots.size === 1 && first !== undefined && paths.every((path) => path.includes("/"))) {
    const prefix = first + "/";
    return (path) => path.slice(prefix.length);
  }
  return (path) => path;
}
var SKELETON_BINARY = /\.skel(\.bytes)?$/i;
var SKELETON_JSON = /\.json$/i;
var ATLAS = /\.atlas(\.txt)?$/i;
var MAX_SNIFF_JSON_BYTES = 64 * 1024 * 1024;
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
function stem(path) {
  return path.split("/").pop().replace(SKELETON_BINARY, "").replace(ATLAS, "").replace(SKELETON_JSON, "").toLowerCase();
}
function readVarint(data, offset) {
  let result = 0;
  for (let shift = 0;shift < 35; shift += 7) {
    const byte = data[offset.pos++];
    if (byte === undefined)
      throw new Error("truncated");
    result |= (byte & 127) << shift;
    if ((byte & 128) === 0)
      return result >>> 0;
  }
  throw new Error("bad varint");
}
function readSpineString(data, offset) {
  const byteCount = readVarint(data, offset);
  if (byteCount === 0)
    return null;
  const length = byteCount - 1;
  if (length > 256 || offset.pos + length > data.length)
    throw new Error("bad string");
  const text = new TextDecoder().decode(data.subarray(offset.pos, offset.pos + length));
  offset.pos += length;
  return text;
}
var VERSION_PATTERN = /^\d+\.\d+[\w.-]{0,16}$/;
function binarySkeletonVersion(data) {
  try {
    const version = readSpineString(data, { pos: 8 });
    if (version && VERSION_PATTERN.test(version))
      return version;
  } catch {}
  try {
    const offset = { pos: 0 };
    readSpineString(data, offset);
    const version = readSpineString(data, offset);
    if (version && VERSION_PATTERN.test(version))
      return version;
  } catch {}
  return null;
}
function jsonSkeletonVersion(data) {
  if (data.length > MAX_SNIFF_JSON_BYTES)
    return null;
  try {
    const json = JSON.parse(new TextDecoder().decode(data));
    const version = json?.skeleton?.spine;
    return typeof version === "string" && VERSION_PATTERN.test(version) ? version : null;
  } catch {
    return null;
  }
}
function findSkeleton(files) {
  const atlases = files.filter((file) => ATLAS.test(file.path));
  const skeletons = [];
  for (const file of files) {
    if (SKELETON_BINARY.test(file.path))
      skeletons.push({ path: file.path, version: binarySkeletonVersion(file.data) });
    else if (SKELETON_JSON.test(file.path)) {
      const version = jsonSkeletonVersion(file.data);
      if (version)
        skeletons.push({ path: file.path, version });
    }
  }
  if (skeletons.length === 0) {
    return { error: "No Spine skeleton (*.skel or skeleton *.json) found in the archive." };
  }
  if (atlases.length === 0)
    return { error: "No Spine atlas (*.atlas) found in the archive." };
  const playable = skeletons.filter((skeleton) => skeleton.version !== null && spineRuntimeFor(skeleton.version) !== null);
  if (playable.length === 0) {
    const versioned = skeletons.find((skeleton) => skeleton.version !== null);
    if (!versioned) {
      return { error: `Couldn't read the Spine version of ${skeletons[0].path}; is it a Spine skeleton?` };
    }
    return {
      error: `${versioned.path} was exported from Spine ${versioned.version}. ` + `This extension plays Spine ${SUPPORTED_SPINE_VERSIONS.map((version) => `${version}.x`).join(" and ")} skeletons only.`
    };
  }
  const depth = (path) => path.split("/").length;
  const ranked = playable.map((skeleton) => {
    const folder = dirname(skeleton.path);
    const name = stem(skeleton.path);
    const candidates = [
      atlases.find((atlas) => dirname(atlas.path) === folder && stem(atlas.path) === name),
      atlases.find((atlas) => stem(atlas.path) === name),
      atlases.find((atlas) => dirname(atlas.path) === folder),
      atlases[0]
    ];
    const rank = candidates.findIndex((atlas) => atlas !== undefined);
    return { skeleton, atlas: candidates[rank], score: rank * 1000 + depth(skeleton.path) };
  }).sort((a, b) => a.score - b.score || a.skeleton.path.localeCompare(b.skeleton.path));
  const best = ranked[0];
  let atlas;
  try {
    atlas = new TextureAtlas(new TextDecoder().decode(best.atlas.data));
  } catch (error) {
    return { error: `Couldn't read the atlas ${best.atlas.path}: ${String(error)}` };
  }
  if (atlas.pages.length === 0)
    return { error: `The atlas ${best.atlas.path} has no pages.` };
  const atlasDir = dirname(best.atlas.path);
  const lowerPaths = new Set(files.map((file) => file.path.toLowerCase()));
  const missing = atlas.pages.map((page) => normalizePath(atlasDir ? `${atlasDir}/${page.name}` : page.name)).filter((page) => !lowerPaths.has(page.toLowerCase()));
  if (missing.length > 0) {
    return { error: `The atlas references images that aren't in the archive: ${missing.join(", ")}` };
  }
  return {
    skeleton: best.skeleton.path,
    atlas: best.atlas.path,
    version: best.skeleton.version,
    pma: atlas.pages.some((page) => page.pma)
  };
}
function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 48) || "model";
}
async function handleImportZip(msg, userId) {
  const upload = await spindle.uploads.get(msg.uploadId, userId);
  if (!upload) {
    send({ type: "import_error", error: "Upload not found or expired. Try again." }, userId);
    return;
  }
  try {
    let entries;
    try {
      entries = unzipSync(upload.data);
    } catch {
      send({ type: "import_error", error: "Could not read the ZIP archive." }, userId);
      return;
    }
    const cleaned = [];
    for (const [rawPath, data] of Object.entries(entries)) {
      const path = sanitizeZipPath(rawPath);
      if (!path || data.length === 0)
        continue;
      cleaned.push({ path, data });
    }
    if (cleaned.length === 0) {
      send({ type: "import_error", error: "The ZIP archive is empty." }, userId);
      return;
    }
    if (cleaned.length > MAX_FILE_COUNT) {
      send({ type: "import_error", error: `Too many files in archive (max ${MAX_FILE_COUNT}).` }, userId);
      return;
    }
    const totalBytes = cleaned.reduce((sum, file) => sum + file.data.length, 0);
    if (totalBytes > MAX_UNPACKED_BYTES) {
      send({ type: "import_error", error: "Unpacked model exceeds the 512 MB limit." }, userId);
      return;
    }
    const strip = stripCommonRoot(cleaned.map((file) => file.path));
    const files = cleaned.map((file) => ({ path: strip(file.path), data: file.data })).filter((file) => file.path.length > 0);
    const choice = findSkeleton(files);
    if ("error" in choice) {
      send({ type: "import_error", error: choice.error }, userId);
      return;
    }
    const registry = await loadRegistry(userId);
    const baseName = msg.name?.trim() || upload.fileName.replace(/\.zip$/i, "") || stem(choice.skeleton);
    let id = slugify(baseName);
    let suffix = 2;
    while (registry.some((model) => model.id === id)) {
      id = `${slugify(baseName)}_${suffix++}`;
    }
    for (const stale of await spindle.userStorage.list(`${MODELS_DIR}/${id}/`, userId)) {
      await spindle.userStorage.delete(stale, userId).catch(() => {});
    }
    for (const file of files) {
      await spindle.userStorage.writeBinary(`${MODELS_DIR}/${id}/${file.path}`, file.data, userId);
    }
    const record = {
      id,
      name: baseName,
      skeletonFile: choice.skeleton,
      atlasFile: choice.atlas,
      spineVersion: choice.version,
      pma: choice.pma,
      sizeBytes: totalBytes,
      fileCount: files.length,
      importedAt: new Date().toISOString(),
      version: Date.now()
    };
    registry.push(record);
    await saveRegistry(registry, userId);
    spindle.log.info(`spine: imported model "${record.name}" (Spine ${record.spineVersion}, ${files.length} files, ${totalBytes} bytes)`);
    send({ type: "model_imported", model: record }, userId);
    spindle.toast.success(`Spine model "${record.name}" imported.`, userId ? { userId } : undefined);
  } finally {
    await spindle.uploads.delete(msg.uploadId, userId).catch(() => {});
  }
}
async function handleDeleteModel(modelId, userId) {
  const registry = await loadRegistry(userId);
  const record = registry.find((model) => model.id === modelId);
  if (!record)
    return;
  const prefix = `${MODELS_DIR}/${modelId}/`;
  for (const key of [...fileCache.keys()]) {
    if (key.startsWith(`${userId}:${prefix}`))
      fileCache.delete(key);
  }
  const files = await spindle.userStorage.list(prefix, userId);
  for (const file of files) {
    await spindle.userStorage.delete(file, userId).catch(() => {});
  }
  await saveRegistry(registry.filter((model) => model.id !== modelId), userId);
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
  if (changed)
    await saveSettings(settings, userId);
  send({ type: "model_deleted", modelId }, userId);
}
var MAX_THUMBNAIL_CHARS = 512 * 1024;
async function handleSaveThumbnail(msg, userId) {
  if (typeof msg.dataUrl !== "string" || msg.dataUrl.length > MAX_THUMBNAIL_CHARS || !/^data:image\/(webp|png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(msg.dataUrl)) {
    return;
  }
  const registry = await loadRegistry(userId);
  const record = registry.find((model) => model.id === msg.modelId);
  if (!record)
    return;
  record.thumbnail = msg.dataUrl;
  await saveRegistry(registry, userId);
  send({ type: "model_updated", model: record }, userId);
}
function toBase64(bytes) {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
}
var TRANSFER_IDLE_MS = 10 * 60 * 1000;
var FILE_CACHE_IDLE_MS = 60 * 1000;
var FILE_CACHE_MAX_ENTRIES = 3;
var transfers = new Map;
var fileCache = new Map;
function sweepTransferState(now) {
  for (const [key, session] of transfers) {
    if (now - session.lastUsed > TRANSFER_IDLE_MS)
      transfers.delete(key);
  }
  for (const [key, entry] of fileCache) {
    if (now - entry.lastUsed > FILE_CACHE_IDLE_MS)
      fileCache.delete(key);
  }
}
function readCachedFile(userId, path) {
  const key = `${userId}:${path}`;
  const now = Date.now();
  let entry = fileCache.get(key);
  if (!entry) {
    while (fileCache.size >= FILE_CACHE_MAX_ENTRIES) {
      const oldest = [...fileCache.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
      if (!oldest)
        break;
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
async function handleGetModelManifest(msg, userId) {
  sweepTransferState(Date.now());
  const registry = await loadRegistry(userId);
  const record = registry.find((model) => model.id === msg.modelId);
  if (!record) {
    send({ type: "model_files_error", reqId: msg.reqId, error: `Unknown model: ${msg.modelId}` }, userId);
    return;
  }
  const prefix = `${MODELS_DIR}/${record.id}/`;
  const listed = await spindle.userStorage.list(prefix, userId);
  const relative = listed.map((path) => path.startsWith(prefix) ? path.slice(prefix.length) : path).filter((path) => path.length > 0);
  const files = [];
  for (const path of relative) {
    const stat = await spindle.userStorage.stat(prefix + path, userId);
    if (stat.isFile)
      files.push({ path, size: stat.sizeBytes });
  }
  transfers.set(`${userId}:${msg.reqId}`, {
    prefix,
    files: new Set(files.map((file) => file.path)),
    lastUsed: Date.now()
  });
  send({
    type: "model_manifest",
    reqId: msg.reqId,
    modelId: record.id,
    version: record.version,
    skeletonFile: record.skeletonFile,
    atlasFile: record.atlasFile,
    chunkBytes: CHUNK_BYTES,
    files
  }, userId);
}
async function handleGetModelChunk(msg, userId) {
  const session = transfers.get(`${userId}:${msg.reqId}`);
  if (!session || !session.files.has(msg.path)) {
    send({ type: "model_files_error", reqId: msg.reqId, error: "Transfer expired or unknown file; reload the model." }, userId);
    return;
  }
  session.lastUsed = Date.now();
  const bytes = await readCachedFile(userId, session.prefix + msg.path);
  const seq = Math.max(0, Math.floor(msg.seq));
  const slice = bytes.subarray(seq * CHUNK_BYTES, Math.min((seq + 1) * CHUNK_BYTES, bytes.length));
  send({ type: "model_chunk", reqId: msg.reqId, path: msg.path, seq, dataB64: toBase64(slice) }, userId);
}
function trimToEndSentence(text) {
  const punctuation = new Set([".", "!", "?", "*", '"', ")", "}", "`", "]", "$", `
`]);
  for (let i = text.length - 1;i >= 0; i--) {
    const char = text[i];
    if (punctuation.has(char)) {
      return text.substring(0, i + 1).trimEnd();
    }
  }
  return text.trimEnd();
}
function trimToStartSentence(text) {
  const punctuation = new Set([".", "!", "?", "*", '"', ")", "}", "`", "]", "$", `
`]);
  for (let i = 0;i < text.length; i++) {
    if (punctuation.has(text[i])) {
      return text.substring(i + 1).trimStart();
    }
  }
  return text;
}
function sampleClassifyText(text) {
  let result = text.replace(/[\*\"]/g, "");
  const SAMPLE_THRESHOLD = 300;
  const HALF = SAMPLE_THRESHOLD / 2;
  if (text.length < SAMPLE_THRESHOLD) {
    result = trimToEndSentence(result);
  } else {
    result = trimToEndSentence(result.slice(0, HALF)) + " " + trimToStartSentence(result.slice(-HALF));
  }
  return result.trim();
}
async function classifyExpression(text) {
  if (!text.trim())
    return { error: "Nothing to classify." };
  if (!spindle.permissions.has("generation"))
    return { error: 'Needs the "generation" permission.' };
  const labels = CLASSIFY_EXPRESSIONS.join(", ");
  try {
    const result = await spindle.generate.quiet({
      type: "quiet",
      messages: [
        {
          role: "system",
          content: "You classify the dominant emotion of a roleplay message. " + `Respond with exactly one word from this list and nothing else: ${labels}.`
        },
        { role: "user", content: sampleClassifyText(text) }
      ],
      parameters: { max_tokens: 16, temperature: 0 }
    });
    const response = (result?.content ?? "").toLowerCase();
    const words = response.split(/[^a-z]+/).filter(Boolean);
    for (const word of words) {
      if (CLASSIFY_EXPRESSIONS.includes(word))
        return { label: word };
    }
    for (const label of CLASSIFY_EXPRESSIONS) {
      if (response.includes(label))
        return { label };
    }
    return { error: `The model answered "${response.trim().slice(0, 40)}", which isn't an emotion label.` };
  } catch (error) {
    spindle.log.warn(`spine: classification failed: ${String(error)}`);
    return { error: `Classification failed: ${String(error)}` };
  }
}
function castFromChat(chat) {
  const metadata = chat.metadata ?? {};
  const members = metadata.group === true && Array.isArray(metadata.character_ids) ? metadata.character_ids.filter((id) => typeof id === "string" && id.length > 0) : [];
  const characterId = chat.character_id ?? members[0] ?? null;
  return { characterId, characterIds: members.length > 0 ? [...new Set(members)] : characterId ? [characterId] : [] };
}
async function resolveChatCast(chatId, userId) {
  if (!spindle.permissions.has("chats"))
    return null;
  try {
    const chat = await spindle.chats.get(chatId, userId);
    return chat ? castFromChat(chat) : null;
  } catch {
    return null;
  }
}
async function sendChatContext(chatId, userId) {
  const cast = chatId ? await resolveChatCast(chatId, userId) : null;
  send({ type: "chat_context", chatId, characterId: cast?.characterId ?? null, characterIds: cast?.characterIds ?? null }, userId);
}
async function handleCharacterMessage(chatId, message, userId) {
  const settings = await loadSettings(userId);
  if (!settings.global.enabled)
    return;
  const author = [message.extra?.character_id, message.extra?.greeting_character_id].find((id) => typeof id === "string" && id.length > 0);
  const characterId = author ?? (await resolveChatCast(chatId, userId))?.characterId ?? null;
  const text = message.content ?? "";
  send({ type: "character_message", chatId, characterId, messageId: message.id, textLength: text.length }, userId);
  if (settings.global.expressionSource !== "llm")
    return;
  if (!text)
    return;
  const result = await classifyExpression(text);
  if (!("label" in result))
    return;
  send({ type: "expression", chatId, characterId, label: result.label, source: "llm" }, userId);
}
async function handleInteraction(msg, userId) {
  if (!spindle.permissions.has("chat_mutation")) {
    spindle.toast.warning('Grant the "Chat mutation" permission to send Spine interaction messages.', userId ? { userId } : undefined);
    return;
  }
  try {
    await spindle.chat.appendMessage(msg.chatId, { role: "user", content: msg.message }, msg.generate ? {
      triggerGeneration: true,
      ...msg.characterId ? { generation: { target_character_id: msg.characterId } } : {}
    } : undefined);
  } catch (error) {
    spindle.log.warn(`spine: interaction failed: ${String(error)}`);
    spindle.toast.error(`Spine interaction failed: ${String(error)}`, userId ? { userId } : undefined);
  }
}
async function sendState(userId) {
  const settings = await loadSettings(userId);
  const models = await loadRegistry(userId);
  let characters = [];
  if (spindle.permissions.has("characters")) {
    try {
      const { data } = await spindle.characters.list({ limit: 200, userId });
      characters = data.map((character) => ({ id: character.id, name: character.name }));
    } catch {
      characters = [];
    }
  }
  const permissions = await spindle.permissions.getGranted();
  send({ type: "state", settings, models, characters, permissions }, userId);
}
spindle.onFrontendMessage(async (payload, userId) => {
  const msg = payload;
  try {
    switch (msg.type) {
      case "get_state":
        await sendState(userId);
        break;
      case "save_settings":
        await saveSettings(normalizeSettings(msg.settings), userId);
        send({ type: "settings_saved" }, userId);
        break;
      case "import_model_zip":
        await handleImportZip(msg, userId);
        break;
      case "delete_model":
        await handleDeleteModel(msg.modelId, userId);
        break;
      case "save_thumbnail":
        await handleSaveThumbnail(msg, userId);
        break;
      case "get_model_manifest":
        await handleGetModelManifest(msg, userId);
        break;
      case "get_model_chunk":
        await handleGetModelChunk(msg, userId);
        break;
      case "interaction":
        await handleInteraction(msg, userId);
        break;
      case "get_chat_context":
        await sendChatContext(msg.chatId, userId);
        break;
      case "classify_test": {
        const result = await classifyExpression(msg.text);
        send("label" in result ? { type: "classify_test_result", label: result.label } : { type: "classify_test_result", label: "", error: result.error }, userId);
        break;
      }
    }
  } catch (error) {
    spindle.log.error(`spine: error handling ${msg?.type ?? "message"}: ${String(error)}`);
    if (msg?.type === "import_model_zip") {
      send({ type: "import_error", error: String(error) }, userId);
    } else if (msg?.type === "get_model_manifest" || msg?.type === "get_model_chunk") {
      send({ type: "model_files_error", reqId: msg.reqId, error: String(error) }, userId);
    }
  }
});
spindle.on("MESSAGE_SENT", (payload, userId) => {
  const event = payload;
  if (!event?.chatId || !event.message || event.message.is_user)
    return;
  handleCharacterMessage(event.chatId, event.message, userId);
});
spindle.on("MESSAGE_SWIPED", (payload, userId) => {
  const event = payload;
  if (!event?.chatId || !event.message || event.message.is_user || event.action !== "added")
    return;
  handleCharacterMessage(event.chatId, event.message, userId);
});
spindle.on("EXPRESSION_CHANGED", (payload, userId) => {
  const event = payload;
  if (!event?.chatId || !event?.label)
    return;
  (async () => {
    const settings = await loadSettings(userId);
    if (!settings.global.enabled || settings.global.expressionSource !== "native")
      return;
    send({
      type: "expression",
      chatId: event.chatId,
      characterId: event.characterId ?? null,
      label: event.label,
      source: "native"
    }, userId);
  })();
});
spindle.on("CHAT_SWITCHED", (payload, userId) => {
  const event = payload;
  sendChatContext(event?.chatId ?? null, userId);
});
spindle.on("CHAT_CHANGED", (payload, userId) => {
  const event = payload;
  const chatId = event?.chat?.id ?? event?.chatId;
  if (!chatId)
    return;
  const fields = event.changedFields;
  if (fields && !fields.some((field) => /^metadata(\.(group|character_ids)\b|$)/.test(field)))
    return;
  (async () => {
    const cast = event.chat?.metadata ? castFromChat(event.chat) : await resolveChatCast(chatId, userId);
    if (cast)
      send({ type: "chat_members", chatId, characterIds: cast.characterIds }, userId);
  })();
});
spindle.permissions.onChanged(({ allGranted }) => {
  send({ type: "permissions_changed", permissions: allGranted });
});
spindle.commands.register([
  {
    id: "spine-open-settings",
    label: "Spine: Open Settings",
    description: "Open the Spine Avatars settings tab",
    keywords: ["spine", "avatar", "model", "settings"]
  },
  {
    id: "spine-reload",
    label: "Spine: Reload Models",
    description: "Reload the Spine model on the stage",
    keywords: ["spine", "reload", "reset"]
  },
  {
    id: "spine-toggle",
    label: "Spine: Toggle Enabled",
    description: "Enable or disable the Spine avatar stage",
    keywords: ["spine", "toggle", "enable", "disable"]
  }
]);
spindle.commands.onInvoked((commandId) => {
  (async () => {
    switch (commandId) {
      case "spine-open-settings":
        send({ type: "focus_tab" });
        break;
      case "spine-reload":
        send({ type: "reload_models" });
        break;
      case "spine-toggle": {
        const settings = await loadSettings();
        settings.global.enabled = !settings.global.enabled;
        await saveSettings(settings);
        send({ type: "toggle_enabled", enabled: settings.global.enabled });
        spindle.toast.info(`Spine ${settings.global.enabled ? "enabled" : "disabled"}.`);
        break;
      }
    }
  })();
});
spindle.log.info("spine: backend ready");
