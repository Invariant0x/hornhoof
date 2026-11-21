import { randomUUID } from 'node:crypto';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { UpdateState } from '../../db/schema.js';
import { FOLLOW_RETRY_MS, type Go, type LeaderBuild } from '../network/build.js';
import { UpdaterControl } from '../updates/control.js';
import { Hourly, readJson, reasonOf, writePrivately } from './machine-keys.js';

/* The request for the server's build this keeper gave its updater last: its id, the build's tag, and when. */
export const FOLLOW_FILE = 'follow.json';
/* The server's word to install, as the updater reads it. until: seconds since 1970, by this machine's clock. */
export const GO_FILE = 'go.json';
/* The keeper-only volume where the updater reads rollout approvals and computer control, out of the app's reach. */
const COMPUTER_CONTROL = 'computer-control';

const Asked = z.object({ id: z.string(), tag: z.string(), at: z.string() });
/* said: the server's own end of the word, by which a word already passed on is known. */
const Word = z.object({ id: z.string(), commit: z.string(), until: z.number(), said: z.string() });
type Asked = z.infer<typeof Asked>;
/* The steps in which the updater changes what runs: a request given now would cut it. */
const CHANGING = new Set(['install', 'health', 'rollback']);

/* A worker follows the server's build. Told of a build it does not run, its keeper asks the machine's updater to
   download it at once; the updater then waits, and installs when the keeper passes on the server's word that it is this
   machine's turn. The keeper tells the server how far its updater is. */
export class Following {
  private readonly control: UpdaterControl;
  private readonly hourly = new Hourly();

  /* commit: the build this machine runs, when it knows. */
  constructor(private readonly opts: { dir: string; controlDir: string; commit?: string | null; now?: () => Date; log: (line: string) => void }) {
    this.control = new UpdaterControl(opts.controlDir);
  }

  /* What the server's last view said of its build and of this machine's turn. */
  heard(build: LeaderBuild | null, go: Go | null): void {
    try {
      if (build && !this.runs(build)) this.ask(build);
      else this.leave();
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

  /* The build this machine runs is never asked for: a server that has not heard from the machine yet names its build
     to it, and the updater would wait a day for a turn the server never gives, with everything else it does for the
     machine waiting behind that. */
  private runs(build: LeaderBuild): boolean {
    return Boolean(this.opts.commit) && build.commit === this.opts.commit;
  }

  /* The server names no build to this machine, or the one it runs: a request of this keeper's that still downloads or
     waits for its turn is taken back, since that turn never comes. One that is being installed is left to end, and one
     that has ended stays as what it was. */
  private leave(): void {
    const mine = this.asked();
    if (!mine) return;
    const status = this.control.status();
    if (status?.id === mine.id && (status.state !== 'running' || CHANGING.has(status.step))) return;
    this.control.withdraw(mine.id);
    rmSync(join(this.opts.dir, FOLLOW_FILE), { force: true });
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

  /* The word is passed on as it came, for the request it is for, on the keeper-only volume so the app cannot plant one.
     Written whole and then moved, so the updater never reads half of it. */
  private pass(go: Go): void {
    const mine = this.asked();
    if (!mine || go.commit !== mine.tag) return;
    const dir = join(this.opts.dir, COMPUTER_CONTROL);
    const file = join(dir, GO_FILE);
    const held = Word.safeParse(readJson(file));
    /* One word is written once: the server repeats it with every view, each time with less of its stretch left. */
    if (held.success && held.data.id === mine.id && held.data.commit === go.commit && held.data.said === go.until) return;
    /* The stretch that is left, counted from now by this machine's own clock, which need not agree with the server's. */
    const until = Math.floor((this.now().getTime() + go.leftMs) / 1000);
    const word = { id: mine.id, commit: go.commit, until, said: go.until };
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${file}.new`, JSON.stringify(word));
    renameSync(`${file}.new`, file);
  }
}
