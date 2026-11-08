import { open, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { HarnessClaim, type HarnessUnit } from '@hornhoof/protocol';
import { bundleName, packBundle, unpackBundle } from './test-bundle.js';
import { checkCacheContext, fileDigest, type CacheContext, type CacheEntry, type CacheReady, type CacheShare } from './test-cache.js';

/* Hornhoof's registry of what is built: one machine builds a unit, every other takes it. */
export type HarnessLease = Pick<Extract<HarnessClaim, { state: 'build' }>, 'companyId' | 'attempt'>;
export type HarnessRemote = {
  claim(unit: HarnessUnit, signal: AbortSignal): Promise<HarnessClaim>;
  upload(key: string, file: string, digest: string, size: number, partBytes: number, signal: AbortSignal, lease: HarnessLease): Promise<void>;
  download(key: string, file: string, claim: Extract<HarnessClaim, { state: 'ready' }>, signal: AbortSignal): Promise<void>;
  /* error: what failed; none gives the unit back unjudged, for a build that was stopped. */
  failed(key: string, error: string | null, lease: HarnessLease): Promise<void>;
};
type UnitInfo = Omit<HarnessUnit, 'key'>;
type ShareOptions = { renewMs?: number; tail?: () => string };

/* A claim lasts a few minutes and a build may take longer, so it is said again until it ends. */
const RENEW_MS = 60_000;
const TRIES = 3;
const PAUSE_MS = 10_000;
/* Letting a unit go runs while the cache lock and the machine's turn are held, often after the work's own signal has
   stopped, so it never waits long for an answer. A unit left unanswered goes back when its claim runs out. */
const RELEASE_MS = 10_000;

function sleep(ms: number, context: CacheContext): Promise<void> {
  checkCacheContext(context);
  return new Promise((resolve, reject) => {
    const stop = () => { clearTimeout(timer); reject(context.signal.reason as Error); };
    const timer = setTimeout(() => { context.signal.removeEventListener('abort', stop); resolve(); }, Math.min(ms, Math.max(1, context.deadline - Date.now())));
    context.signal.addEventListener('abort', stop, { once: true });
  });
}

async function fetched(remote: HarnessRemote, entry: CacheEntry, claim: Extract<HarnessClaim, { state: 'ready' }>, context: CacheContext): Promise<CacheEntry | null> {
  const file = bundleName(dirname(entry.path));
  try {
    await remote.download(entry.key, file, claim, context.signal);
    return { ...entry, hit: true, fetched: true, ready: await unpackBundle(file, entry, context) };
  } catch (error) {
    checkCacheContext(context);
    context.log(`The prepared ${entry.key.slice(0, 12)} could not be taken from Hornhoof, so it is built here: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  } finally { await rm(file, { force: true }); }
}

async function handedOver(remote: HarnessRemote, entry: CacheEntry, claim: Extract<HarnessClaim, { state: 'build' }>, context: CacheContext): Promise<void> {
  const file = bundleName(dirname(entry.path));
  try {
    const { digest, size } = await packBundle(entry, file, context);
    await remote.upload(entry.key, file, digest, size, claim.partBytes, context.signal, claim);
  } catch (error) {
    await remote.failed(entry.key, null, claim).catch(() => {});
    checkCacheContext(context);
    context.log(`The prepared ${entry.key.slice(0, 12)} stays on this machine only: ${error instanceof Error ? error.message : String(error)}`);
  } finally { await rm(file, { force: true }); }
}

async function builtHere(remote: HarnessRemote, unit: HarnessUnit, entry: CacheEntry, claim: Extract<HarnessClaim, { state: 'build' }>, context: CacheContext, publish: () => Promise<CacheReady>, options: ShareOptions): Promise<CacheEntry> {
  const renew = setInterval(() => { void remote.claim(unit, context.signal).catch(() => {}); }, options.renewMs ?? RENEW_MS);
  renew.unref();
  try {
    const ready = await publish().catch(async (error: unknown) => {
      const said = error instanceof Error ? error.message : String(error);
      await remote.failed(entry.key, context.signal.aborted ? null : `${said}\n${options.tail?.() ?? ''}`.trim().slice(-4000), claim).catch(() => {});
      throw error;
    });
    const built = { ...entry, fetched: false, ready };
    await handedOver(remote, built, claim, context);
    return built;
  } finally { clearInterval(renew); }
}

async function askedClaim(remote: HarnessRemote, unit: HarnessUnit, context: CacheContext): Promise<HarnessClaim> {
  try { return await remote.claim(unit, context.signal); }
  catch (error) {
    checkCacheContext(context);
    context.log(`Hornhoof keeps no prepared ${unit.unit} for this machine now: ${error instanceof Error ? error.message : String(error)}`);
    return { state: 'local' };
  }
}

/* Where a tree this machine lacks comes from: from whichever machine built it, or from here when none did. */
export function harnessShare(remote: HarnessRemote, info: UnitInfo, options: ShareOptions = {}): CacheShare {
  return async (entry, context, publish) => {
    const unit: HarnessUnit = { ...info, key: entry.key };
    for (;;) {
      const claim = await askedClaim(remote, unit, context);
      switch (claim.state) {
        case 'ready': {
          const taken = await fetched(remote, entry, claim, context);
          return taken ?? { ...entry, fetched: false, ready: await publish() };
        }
        case 'build': return builtHere(remote, unit, entry, claim, context, publish, options);
        case 'local': return { ...entry, fetched: false, ready: await publish() };
        case 'failed': throw new Error(`The harness unit ${unit.unit} failed to build: ${claim.error}`);
        case 'wait': await sleep(claim.afterMs, context);
      }
    }
  };
}

/* Answers that are not for this machine, or from a server without a registry, all mean: build it here. */
async function answered(response: Response): Promise<Response> {
  if (response.ok) return response;
  const body = await response.json().catch(() => null) as { error?: { message?: string } } | null;
  throw new Error(`Hornhoof answered ${response.status}${body?.error?.message ? `: ${body.error.message}` : '.'}`);
}

/* A link that dropped takes a while to come back, so each new try waits longer. */
async function again<T>(signal: AbortSignal, pauseMs: number, run: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try { return await run(); }
    catch (error) {
      if (signal.aborted || attempt >= TRIES) throw error;
      await wait(pauseMs * attempt, undefined, { signal });
    }
  }
}

/* The registry over HTTP with the node's key. A bundle goes in parts, each tried again by itself, as a whole one would not
   get through a slow link between a machine and the company's link. */
export function harnessRemote(server: string, nodeKey: string, pauseMs = PAUSE_MS, releaseMs = RELEASE_MS): HarnessRemote {
  const at = (path: string) => `${server}/api/harness${path}`;
  const headers = { authorization: `Bearer ${nodeKey}` };
  const fenced = (lease: HarnessLease) => ({ ...headers, 'x-harness-company': lease.companyId, 'x-harness-attempt': lease.attempt });
  const json = (body: unknown) => ({ method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return {
    async claim(unit, signal) {
      return HarnessClaim.parse(await (await answered(await fetch(at('/claim'), { ...json({ ...unit, fencing: 1 }), signal }))).json());
    },
    async upload(key, path, digest, size, partBytes, signal, lease) {
      const file = await open(path, 'r');
      try {
        for (let index = 0; index * partBytes < size; index++) {
          const { buffer, bytesRead } = await file.read(Buffer.alloc(partBytes), 0, partBytes, index * partBytes);
          const body = new Uint8Array(buffer.buffer, buffer.byteOffset, bytesRead);
          await again(signal, pauseMs, async () => answered(await fetch(at(`/${key}/parts/${index}`), { method: 'PUT', headers: { ...fenced(lease), 'content-type': 'application/octet-stream' }, body, signal })));
        }
      } finally { await file.close(); }
      await answered(await fetch(at(`/${key}/done`), { ...json({ digest, size }), headers: { ...fenced(lease), 'content-type': 'application/json' }, signal }));
    },
    async download(key, path, claim, signal) {
      const out = await open(path, 'wx', 0o600);
      try {
        for (let start = 0; start < claim.size; start += claim.partBytes) {
          const range = `bytes=${start}-${Math.min(start + claim.partBytes, claim.size) - 1}`;
          const part = await again(signal, pauseMs, async () => Buffer.from(await (await answered(await fetch(at(`/${key}/bundle`), { headers: { ...fenced(claim), range }, signal }))).arrayBuffer()));
          await out.writeFile(part);
        }
      } finally { await out.close(); }
      if (await fileDigest(path, { deadline: Number.POSITIVE_INFINITY, signal }) !== claim.digest) throw new Error('The bundle that came differs from what Hornhoof holds.');
    },
    async failed(key, error, lease) {
      await answered(await fetch(at(`/${key}/failed`), { ...json({ error }), headers: { ...fenced(lease), 'content-type': 'application/json' }, signal: AbortSignal.timeout(releaseMs) }));
    },
  };
}
