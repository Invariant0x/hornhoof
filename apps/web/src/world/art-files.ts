/* Where every world picture of a pack comes from (#1947). art-index.json names each file with its byte size and the
   hash of its bytes; a file is downloaded once per hash and kept in the browser (IndexedDB), so a reopen reads it from
   disk and an art version change downloads only the files whose hash changed. Copies the index no longer lists are
   dropped. A file the index gives no hash (an index written before hashes, or a file outside it) is read from the
   network as before and not kept. Without browser storage everything still loads from the network. */

import { ART_INDEX_FILE, drawnArtPaths, type ArtIndex } from './art';
import type { WorldPackManifest } from './manifest';

export type StoredArtFile = Readonly<{ hash: string; blob: Blob }>;

/* Kept files, by key `<pack>/<path>`. */
export type ArtFileStore = Readonly<{
  read(keys: readonly string[]): Promise<ReadonlyMap<string, StoredArtFile>>;
  write(key: string, file: StoredArtFile): Promise<void>;
  /* Drops every kept file whose key starts with `prefix` and is not in `keep`. */
  prune(prefix: string, keep: ReadonlySet<string>): Promise<void>;
}>;

export type ArtFilesProgress = Readonly<{ loadedBytes: number; totalBytes: number; loadedFiles: number; totalFiles: number }>;

export type ArtFetcher = (url: string) => Promise<Response>;

const PARALLEL_DOWNLOADS = 6;

function isIndexShape(value: unknown): value is ArtIndex {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<ArtIndex>;
  return typeof v.contract === 'number' && typeof v.pack === 'string' && Boolean(v.files) && typeof v.files === 'object';
}

/* Reads a response body chunk by chunk, telling each chunk's size as it arrives. */
async function readCounting(res: Response, onBytes: (n: number) => void): Promise<Blob> {
  const type = res.headers.get('content-type') ?? 'application/octet-stream';
  if (!res.body) {
    const blob = await res.blob();
    onBytes(blob.size);
    return blob;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    onBytes(value.byteLength);
  }
  return new Blob(chunks as BlobPart[], { type });
}

export class WorldArtFiles {
  private readonly packId: string;
  private readonly baseUrl: string;
  private readonly store: ArtFileStore | null;
  private readonly fetchFile: ArtFetcher;
  private readonly wanted: ((index: ArtIndex) => ReadonlySet<string>) | null;
  private indexJob: Promise<ArtIndex | null> | null = null;
  private readonly blobs = new Map<string, Promise<Blob | null>>();
  private fillJob: Promise<void> | null = null;
  private lastProgress: ArtFilesProgress | null = null;
  private readonly listeners = new Set<(p: ArtFilesProgress) => void>();

  /* `wanted` names the files worth downloading ahead (those the engine draws); without it, every hashed file. */
  constructor(
    opts: Readonly<{
      packId: string;
      baseUrl: string;
      store: ArtFileStore | null;
      fetch: ArtFetcher;
      wanted?: (index: ArtIndex) => ReadonlySet<string>;
    }>,
  ) {
    this.packId = opts.packId;
    this.baseUrl = opts.baseUrl;
    this.store = opts.store;
    this.fetchFile = opts.fetch;
    this.wanted = opts.wanted ?? null;
  }

  /* The folder's art-index.json as it stands, read once per page; null when there is none. */
  index(): Promise<ArtIndex | null> {
    this.indexJob ??= (async () => {
      try {
        const res = await this.fetchFile(`${this.baseUrl}${ART_INDEX_FILE}`);
        if (!res.ok) return null;
        const raw: unknown = await res.json();
        return isIndexShape(raw) ? raw : null;
      } catch {
        return null;
      }
    })();
    return this.indexJob;
  }

  private key(path: string): string {
    return `${this.packId}/${path}`;
  }

  /* The wanted hashed files of the index that the browser does not keep at their hash, and their bytes. */
  async missing(): Promise<{ paths: string[]; bytes: number }> {
    const index = await this.index();
    if (!index) return { paths: [], bytes: 0 };
    const wanted = this.wanted?.(index) ?? null;
    const hashed = Object.entries(index.files).filter(([p, e]) => e.hash && (!wanted || wanted.has(p)));
    const kept = await this.readKept(hashed.map(([p]) => p));
    const paths: string[] = [];
    let bytes = 0;
    for (const [path, entry] of hashed) {
      if (kept.get(path)?.hash === entry.hash) continue;
      paths.push(path);
      bytes += entry.bytes ?? 0;
    }
    return { paths, bytes };
  }

  /* Downloads and keeps every missing file, telling progress by the bytes as they arrive; then drops the copies the
     index no longer lists. A file that fails counts as done and stays missing for the next page. One fill runs at a
     time per page: a second caller (a remount) joins it and hears the same progress. */
  fill(onProgress?: (p: ArtFilesProgress) => void): Promise<void> {
    if (onProgress) {
      this.listeners.add(onProgress);
      if (this.lastProgress) onProgress(this.lastProgress);
    }
    this.fillJob ??= this.runFill().finally(() => {
      this.fillJob = null;
      this.lastProgress = null;
      this.listeners.clear();
    });
    return this.fillJob;
  }

  private async runFill(): Promise<void> {
    const index = await this.index();
    if (!index) return;
    const { paths, bytes } = await this.missing();
    let loadedBytes = 0;
    let loadedFiles = 0;
    const tell = () => {
      this.lastProgress = { loadedBytes: Math.min(loadedBytes, bytes), totalBytes: bytes, loadedFiles, totalFiles: paths.length };
      for (const l of this.listeners) l(this.lastProgress);
    };
    tell();
    /* Every file of this fill is claimed before the first download starts, so a reader meanwhile waits for it. */
    const mine = new Map<string, (blob: Blob | null) => void>();
    const theirs: Promise<void>[] = [];
    for (const path of paths) {
      const busy = this.blobs.get(path);
      if (busy) {
        theirs.push(
          busy.then(() => {
            loadedBytes += index.files[path]!.bytes ?? 0;
            loadedFiles++;
            tell();
          }),
        );
        continue;
      }
      this.blobs.set(path, new Promise(resolve => mine.set(path, resolve)));
    }
    const queue = [...mine.keys()];
    const worker = async () => {
      for (let path = queue.shift(); path !== undefined; path = queue.shift()) {
        const entry = index.files[path]!;
        let got = 0;
        const blob = await this.download(path, n => {
          got += n;
          loadedBytes += n;
          tell();
        });
        /* Settle the file at its declared size, so the total is reached whatever the wire said. */
        loadedBytes += (entry.bytes ?? got) - got;
        loadedFiles++;
        if (blob && this.store) await this.store.write(this.key(path), { hash: entry.hash!, blob }).catch(() => undefined);
        mine.get(path)!(blob);
        tell();
      }
    };
    await Promise.all([...Array.from({ length: Math.min(PARALLEL_DOWNLOADS, queue.length) }, worker), ...theirs]);
    if (this.store) {
      const keep = new Set(Object.entries(index.files).filter(([, e]) => e.hash).map(([p]) => this.key(p)));
      await this.store.prune(`${this.packId}/`, keep).catch(() => undefined);
    }
  }

  /* One file's bytes: from this page, then from what the browser keeps at the file's hash, else downloaded (and kept
     when the index hashes it). Null when it cannot be had. */
  blob(path: string): Promise<Blob | null> {
    let job = this.blobs.get(path);
    if (!job) {
      job = this.readBlob(path);
      this.blobs.set(path, job);
    }
    return job;
  }

  private async readBlob(path: string): Promise<Blob | null> {
    const entry = (await this.index())?.files[path];
    if (entry?.hash) {
      const kept = (await this.readKept([path])).get(path);
      if (kept?.hash === entry.hash) return kept.blob;
    }
    const blob = await this.download(path, () => undefined);
    if (blob && entry?.hash && this.store) {
      await this.store.write(this.key(path), { hash: entry.hash, blob }).catch(() => undefined);
    }
    if (!blob) this.blobs.delete(path);
    return blob;
  }

  private async readKept(paths: readonly string[]): Promise<Map<string, StoredArtFile>> {
    const out = new Map<string, StoredArtFile>();
    if (!this.store || paths.length === 0) return out;
    try {
      const kept = await this.store.read(paths.map(p => this.key(p)));
      for (const p of paths) {
        const f = kept.get(this.key(p));
        if (f) out.set(p, f);
      }
    } catch {
      /* Storage that cannot be read is storage that keeps nothing. */
    }
    return out;
  }

  private async download(path: string, onBytes: (n: number) => void): Promise<Blob | null> {
    try {
      const res = await this.fetchFile(`${this.baseUrl}${path}`);
      if (!res.ok) return null;
      return await readCounting(res, onBytes);
    } catch {
      return null;
    }
  }
}

/* Kept files in memory, for tests and for pages without IndexedDB. */
export function memoryArtFileStore(): ArtFileStore & { keys(): Promise<ReadonlySet<string>> } {
  const files = new Map<string, StoredArtFile>();
  return {
    read: async keys => new Map(keys.flatMap(k => (files.has(k) ? [[k, files.get(k)!] as const] : []))),
    write: async (key, file) => {
      files.set(key, file);
    },
    prune: async (prefix, keep) => {
      for (const k of [...files.keys()]) if (k.startsWith(prefix) && !keep.has(k)) files.delete(k);
    },
    keys: async () => new Set(files.keys()),
  };
}

const DATABASE = 'hornhoof-world-art';
const FILES = 'files';

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/* Kept files in the browser's IndexedDB, one record per file: { key, hash, blob }. Null where there is none. */
export function indexedDbArtFileStore(): ArtFileStore | null {
  if (typeof indexedDB === 'undefined') return null;
  let opened: Promise<IDBDatabase> | null = null;
  const db = () => {
    opened ??= new Promise<IDBDatabase>((resolve, reject) => {
      const asked = indexedDB.open(DATABASE, 1);
      asked.onupgradeneeded = () => {
        if (!asked.result.objectStoreNames.contains(FILES)) asked.result.createObjectStore(FILES, { keyPath: 'key' });
      };
      asked.onsuccess = () => resolve(asked.result);
      asked.onerror = () => reject(asked.error);
      asked.onblocked = () => reject(new Error('art store blocked'));
    });
    return opened;
  };
  return {
    read: async keys => {
      const store = (await db()).transaction(FILES, 'readonly').objectStore(FILES);
      const rows = await Promise.all(keys.map(k => request(store.get(k) as IDBRequest<{ key: string; hash: string; blob: Blob } | undefined>)));
      const out = new Map<string, StoredArtFile>();
      for (const row of rows) if (row) out.set(row.key, { hash: row.hash, blob: row.blob });
      return out;
    },
    write: async (key, file) => {
      const tx = (await db()).transaction(FILES, 'readwrite');
      tx.objectStore(FILES).put({ key, hash: file.hash, blob: file.blob });
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    },
    prune: async (prefix, keep) => {
      const store = (await db()).transaction(FILES, 'readwrite').objectStore(FILES);
      const keys = (await request(store.getAllKeys(IDBKeyRange.bound(prefix, `${prefix}￿`)))) as string[];
      await Promise.all(keys.filter(k => !keep.has(k)).map(k => request(store.delete(k))));
    },
  };
}

const perPack = new WeakMap<WorldPackManifest, WorldArtFiles>();

/* The art files of a pack for this page, one per pack, kept in IndexedDB; null for a pack without art. */
export function worldArtFiles(pack: WorldPackManifest): WorldArtFiles | null {
  const baseUrl = pack.art?.baseUrl;
  if (!baseUrl || typeof fetch !== 'function') return null;
  let files = perPack.get(pack);
  if (!files) {
    files = new WorldArtFiles({
      packId: pack.id,
      baseUrl,
      store: indexedDbArtFileStore(),
      fetch: url => fetch(url, { cache: 'no-cache' }),
      wanted: index => drawnArtPaths(pack, index),
    });
    perPack.set(pack, files);
  }
  return files;
}
