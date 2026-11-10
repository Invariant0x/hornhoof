import { randomUUID } from 'node:crypto';
import { renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { UpdateState } from '../../db/schema.js';
import { FOLLOW_RETRY_MS, type Go, type LeaderBuild } from '../network/build.js';
import { UpdaterControl } from '../updates/control.js';
import { Hourly, readJson, reasonOf, writePrivately } from './machine-keys.js';

/* The request for the server's build this keeper gave its updater last: its id, the build's tag, and when. */
export const FOLLOW_FILE = 'follow.json';
/* The server's word to install, as the updater reads it. until: seconds since 1970. */
export const GO_FILE = 'go.json';

const Asked = z.object({ id: z.string(), tag: z.string(), at: z.string() });
type Asked = z.infer<typeof Asked>;
/* The steps in which the updater changes what runs: a request given now would cut it. */
const CHANGING = new Set(['install', 'health', 'rollback']);

/* A worker follows the server's build. Told of a build it does not run, its keeper asks the machine's updater to
   download it at once; the updater then waits, and installs when the keeper passes on the server's word that it is this
   machine's turn. The keeper tells the server how far its updater is. */
export class Following {
  private readonly control: UpdaterControl;
  private readonly hourly = new Hourly();

  constructor(private readonly opts: { dir: string; controlDir: string; now?: () => Date; log: (line: string) => void }) {
    this.control = new UpdaterControl(opts.controlDir);
  }

  /* What the server's last view said of its build and of this machine's turn. */
  heard(build: LeaderBuild | null, go: Go | null): void {
    try {
      if (build) this.ask(build);
      if (go) this.pass(go);
    } catch (err) {
      if (this.hourly.due('follow')) this.opts.log(`Could not hand the server's build to this machine's updater: ${reasonOf(err)}`);
    }
  }

  /* How far the updater is with the request this keeper gave it; null with none, or while it only downloads. */
  update(): { commit: string; state: UpdateState } | null {
    const mine = this.asked();
    const status = this.control.status();
    if (!mine || status?.id !== mine.id) return null;
    if (status.state === 'failed' || status.state === 'rolled_back') return { commit: mine.tag, state: 'failed' };
    if (status.state !== 'running') return null;
    if (status.step === 'wait') return { commit: mine.tag, state: 'ready' };
    return status.step === 'install' || status.step === 'health' ? { commit: mine.tag, state: 'installing' } : null;
  }

  private now(): Date {
    return this.opts.now?.() ?? new Date();
  }

  private asked(): Asked | null {
    const mine = Asked.safeParse(readJson(join(this.opts.dir, FOLLOW_FILE)));
    return mine.success ? mine.data : null;
  }

  /* One request per build. A newer build replaces a request that still downloads or waits, and never one that is being
     installed. A build whose install failed here is asked for again only hours later. */
  private ask(build: LeaderBuild): void {
    const mine = this.asked();
    const status = this.control.status();
    if (status?.state === 'running' && CHANGING.has(status.step)) return;
    if (mine?.tag === build.tag) {
      const failed = status?.id === mine.id && (status.state === 'failed' || status.state === 'rolled_back');
      if (!failed || this.now().getTime() - Date.parse(mine.at) < FOLLOW_RETRY_MS) return;
    }
    const id = randomUUID();
    this.control.request({ version: build.version, tag: build.tag, digest: build.digest, nodeDigest: build.nodeDigest, updaterDigest: build.updaterDigest }, id);
    writePrivately(join(this.opts.dir, FOLLOW_FILE), JSON.stringify({ id, tag: build.tag, at: this.now().toISOString() } satisfies Asked));
  }

  /* The word is passed on as it came, for the request it is for. Written whole and then moved, so the updater never
     reads half of it. */
  private pass(go: Go): void {
    const mine = this.asked();
    if (!mine || go.commit !== mine.tag) return;
    const word = { id: mine.id, commit: go.commit, until: Math.floor(Date.parse(go.until) / 1000) };
    const file = join(this.opts.controlDir, GO_FILE);
    if (JSON.stringify(readJson(file)) === JSON.stringify(word)) return;
    writeFileSync(`${file}.new`, JSON.stringify(word));
    renameSync(`${file}.new`, file);
  }
}
