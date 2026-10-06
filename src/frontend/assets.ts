/**
 * Fetches imported model files from the backend over the extension message
 * channel and caches them in the browser's Cache Storage so repeat loads skip
 * the transfer entirely.
 *
 * The browser pulls chunks a few at a time. The host relays extension messages
 * through Bun's pub/sub, which silently drops messages once ~16 MB is queued for
 * a connection, so pushing a large model in one burst loses chunks on any link
 * slower than the server. A small request window keeps the queue far below that,
 * and chunks that still go missing are requested again.
 */

import type {
  BackendToFrontend,
  ModelChunkMsg,
  ModelFilesErrorMsg,
  ModelManifestMsg,
} from '../shared/protocol';
import type { ModelRecord } from '../shared/settings';

const CACHE_NAME = 'spine_avatars_v1';

/** Chunk requests in flight at once (~1.4 MB each once encoded). */
const WINDOW = 4;
const MANIFEST_RETRY_MS = 15_000;
const CHUNK_RETRY_MS = 20_000;
const MAX_ATTEMPTS = 4;
/** Give up when no data at all has arrived for this long. */
const STALL_MS = 90_000;

export interface ModelBundle {
  modelId: string;
  version: number;
  skeletonFile: string;
  atlasFile: string;
  files: Map<string, Blob>;
}

export interface TransferProgress {
  receivedBytes: number;
  totalBytes: number;
}

interface ChunkRequest {
  path: string;
  seq: number;
  sentAt: number;
  attempts: number;
}

interface Transfer {
  reqId: string;
  record: ModelRecord;
  resolve: (bundle: ModelBundle) => void;
  reject: (error: Error) => void;
  manifest: ModelManifestMsg | null;
  manifestRequestedAt: number;
  manifestAttempts: number;
  queue: Array<{ path: string; seq: number }>;
  outstanding: Map<string, ChunkRequest>;
  parts: Map<string, Uint8Array[]>;
  receivedBytes: number;
  totalBytes: number;
  lastProgress: number;
  watchdog: number;
}

interface CachedManifest {
  version: number;
  skeletonFile: string;
  atlasFile: string;
  files: string[];
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function cacheUrl(modelId: string, version: number, path: string): string {
  return `${window.location.origin}/__spine_avatars__/${encodeURIComponent(modelId)}/${version}/${path
    .split('/')
    .map(encodeURIComponent)
    .join('/')}`;
}

async function openCache(): Promise<Cache | null> {
  try {
    return await caches.open(CACHE_NAME);
  } catch {
    return null; // Cache API unavailable (rare); fall back to always transferring
  }
}

const chunkKey = (path: string, seq: number) => `${seq}:${path}`;

export class ModelAssets {
  private transfers = new Map<string, Transfer>();
  private memory = new Map<string, Promise<ModelBundle>>();
  private progressByModel = new Map<string, TransferProgress>();
  private nextReq = 1;

  constructor(private sendToBackend: (payload: unknown) => void) {}

  /** Route backend messages related to file transfers. Returns true if consumed. */
  handleMessage(msg: BackendToFrontend): boolean {
    switch (msg.type) {
      case 'model_manifest': {
        const transfer = this.transfers.get(msg.reqId);
        if (transfer && !transfer.manifest) this.onManifest(transfer, msg);
        return true;
      }
      case 'model_chunk': {
        const transfer = this.transfers.get(msg.reqId);
        if (transfer) this.onChunk(transfer, msg);
        return true;
      }
      case 'model_files_error': {
        const transfer = this.transfers.get(msg.reqId);
        if (transfer) this.fail(transfer, new Error((msg as ModelFilesErrorMsg).error));
        return true;
      }
      default:
        return false;
    }
  }

  /** Download progress for a model currently being transferred, if any. */
  progress(modelId: string): TransferProgress | null {
    return this.progressByModel.get(modelId) ?? null;
  }

  /** Load a model bundle, preferring the local cache when the version matches. */
  load(record: ModelRecord): Promise<ModelBundle> {
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

  invalidate(modelId: string): void {
    for (const key of [...this.memory.keys()]) {
      if (key.startsWith(`${modelId}@`)) this.memory.delete(key);
    }
    void (async () => {
      const cache = await openCache();
      if (!cache) return;
      const prefix = `${window.location.origin}/__spine_avatars__/${encodeURIComponent(modelId)}/`;
      for (const request of await cache.keys()) {
        if (request.url.startsWith(prefix)) await cache.delete(request);
      }
    })();
  }

  private async loadUncached(record: ModelRecord): Promise<ModelBundle> {
    const fromCache = await this.loadFromCache(record);
    if (fromCache) return fromCache;
    return await this.transferFromBackend(record);
  }

  private async loadFromCache(record: ModelRecord): Promise<ModelBundle | null> {
    const cache = await openCache();
    if (!cache) return null;
    try {
      const manifestRes = await cache.match(cacheUrl(record.id, record.version, '__manifest__'));
      if (!manifestRes) return null;
      const manifest = (await manifestRes.json()) as CachedManifest;
      const files = new Map<string, Blob>();
      for (const path of manifest.files) {
        const res = await cache.match(cacheUrl(record.id, record.version, path));
        if (!res) return null; // incomplete cache; re-transfer
        files.set(path, await res.blob());
      }
      return {
        modelId: record.id,
        version: manifest.version,
        skeletonFile: manifest.skeletonFile,
        atlasFile: manifest.atlasFile,
        files,
      };
    } catch {
      return null;
    }
  }

  // ── Transfer ──────────────────────────────────────────────────────────────

  private transferFromBackend(record: ModelRecord): Promise<ModelBundle> {
    return new Promise<ModelBundle>((resolve, reject) => {
      const now = Date.now();
      const transfer: Transfer = {
        reqId: `req_${this.nextReq++}_${now}`,
        record,
        resolve,
        reject,
        manifest: null,
        manifestRequestedAt: now,
        manifestAttempts: 1,
        queue: [],
        outstanding: new Map(),
        parts: new Map(),
        receivedBytes: 0,
        totalBytes: 0,
        lastProgress: now,
        watchdog: window.setInterval(() => this.checkTransfer(transfer), 2000),
      };
      this.transfers.set(transfer.reqId, transfer);
      this.sendToBackend({ type: 'get_model_manifest', reqId: transfer.reqId, modelId: record.id });
    });
  }

  private onManifest(transfer: Transfer, manifest: ModelManifestMsg): void {
    transfer.manifest = manifest;
    transfer.lastProgress = Date.now();
    for (const file of manifest.files) {
      const chunks = Math.max(1, Math.ceil(file.size / manifest.chunkBytes));
      transfer.parts.set(file.path, new Array(chunks));
      transfer.totalBytes += file.size;
      for (let seq = 0; seq < chunks; seq++) transfer.queue.push({ path: file.path, seq });
    }
    this.reportProgress(transfer);
    this.pump(transfer);
  }

  private pump(transfer: Transfer): void {
    while (transfer.outstanding.size < WINDOW && transfer.queue.length > 0) {
      const next = transfer.queue.shift()!;
      this.requestChunk(transfer, { ...next, sentAt: 0, attempts: 0 });
    }
    if (transfer.queue.length === 0 && transfer.outstanding.size === 0) void this.finish(transfer);
  }

  private requestChunk(transfer: Transfer, request: ChunkRequest): void {
    request.sentAt = Date.now();
    request.attempts++;
    transfer.outstanding.set(chunkKey(request.path, request.seq), request);
    this.sendToBackend({ type: 'get_model_chunk', reqId: transfer.reqId, path: request.path, seq: request.seq });
  }

  private onChunk(transfer: Transfer, msg: ModelChunkMsg): void {
    const key = chunkKey(msg.path, msg.seq);
    if (!transfer.outstanding.has(key)) return; // duplicate from a retry
    transfer.outstanding.delete(key);
    const bytes = base64ToBytes(msg.dataB64);
    transfer.parts.get(msg.path)![msg.seq] = bytes;
    transfer.receivedBytes += bytes.length;
    transfer.lastProgress = Date.now();
    this.reportProgress(transfer);
    this.pump(transfer);
  }

  private checkTransfer(transfer: Transfer): void {
    const now = Date.now();
    if (now - transfer.lastProgress > STALL_MS) {
      this.fail(transfer, new Error('Model download stalled: no data from the backend for 90 seconds.'));
      return;
    }
    if (!transfer.manifest) {
      if (now - transfer.manifestRequestedAt > MANIFEST_RETRY_MS) {
        if (transfer.manifestAttempts >= MAX_ATTEMPTS) {
          this.fail(transfer, new Error('The backend did not answer the model file list request.'));
          return;
        }
        transfer.manifestAttempts++;
        transfer.manifestRequestedAt = now;
        this.sendToBackend({ type: 'get_model_manifest', reqId: transfer.reqId, modelId: transfer.record.id });
      }
      return;
    }
    for (const request of transfer.outstanding.values()) {
      if (now - request.sentAt <= CHUNK_RETRY_MS) continue;
      if (request.attempts >= MAX_ATTEMPTS) {
        this.fail(transfer, new Error(`Chunk ${request.seq} of ${request.path} never arrived.`));
        return;
      }
      this.requestChunk(transfer, request);
    }
  }

  private reportProgress(transfer: Transfer): void {
    this.progressByModel.set(transfer.record.id, {
      receivedBytes: transfer.receivedBytes,
      totalBytes: transfer.totalBytes,
    });
  }

  private endTransfer(transfer: Transfer): boolean {
    if (!this.transfers.delete(transfer.reqId)) return false;
    window.clearInterval(transfer.watchdog);
    this.progressByModel.delete(transfer.record.id);
    return true;
  }

  private fail(transfer: Transfer, error: Error): void {
    if (this.endTransfer(transfer)) transfer.reject(error);
  }

  private async finish(transfer: Transfer): Promise<void> {
    if (!this.endTransfer(transfer)) return;
    const manifest = transfer.manifest!;
    try {
      const files = new Map<string, Blob>();
      for (const file of manifest.files) {
        const parts = transfer.parts.get(file.path)!;
        const received = parts.reduce((sum, part) => sum + (part?.length ?? 0), 0);
        if (received !== file.size) {
          throw new Error(`Incomplete transfer for ${file.path} (${received}/${file.size} bytes).`);
        }
        files.set(file.path, new Blob(parts as BlobPart[]));
      }

      const bundle: ModelBundle = {
        modelId: manifest.modelId,
        version: manifest.version,
        skeletonFile: manifest.skeletonFile,
        atlasFile: manifest.atlasFile,
        files,
      };

      await this.storeInCache(bundle);
      transfer.resolve(bundle);
    } catch (error) {
      transfer.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /** Persist to Cache Storage (best-effort) and drop stale versions. */
  private async storeInCache(bundle: ModelBundle): Promise<void> {
    const cache = await openCache();
    if (!cache) return;
    const stalePrefix = `${window.location.origin}/__spine_avatars__/${encodeURIComponent(bundle.modelId)}/`;
    const currentPrefix = `${stalePrefix}${bundle.version}/`;
    for (const request of await cache.keys()) {
      if (request.url.startsWith(stalePrefix) && !request.url.startsWith(currentPrefix)) {
        await cache.delete(request);
      }
    }
    const manifest: CachedManifest = {
      version: bundle.version,
      skeletonFile: bundle.skeletonFile,
      atlasFile: bundle.atlasFile,
      files: [...bundle.files.keys()],
    };
    try {
      for (const [path, blob] of bundle.files) {
        await cache.put(cacheUrl(bundle.modelId, bundle.version, path), new Response(blob));
      }
      await cache.put(
        cacheUrl(bundle.modelId, bundle.version, '__manifest__'),
        new Response(JSON.stringify(manifest), { headers: { 'Content-Type': 'application/json' } }),
      );
    } catch {
      // Quota exceeded or similar — the in-memory bundle still works.
    }
  }
}
