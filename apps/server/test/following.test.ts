import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { FOLLOW_FILE, Following, GO_FILE } from '../src/modules/keeper/following.js';
import { FOLLOW_RETRY_MS, type LeaderBuild } from '../src/modules/network/build.js';

const B1: LeaderBuild = { version: '0.19.0', tag: 'b'.repeat(40), digest: 'sha256:app1', nodeDigest: 'sha256:node1', updaterDigest: 'sha256:updater1', commit: 'b'.repeat(40) };
const B2: LeaderBuild = { version: '0.19.1', tag: 'c'.repeat(40), digest: 'sha256:app2', nodeDigest: 'sha256:node2', updaterDigest: 'sha256:updater2', commit: 'c'.repeat(40) };

function folder(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hh-following-'));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function standUp(commit?: string) {
  const [dir, controlDir] = [folder(), folder()];
  const clock = { now: new Date('2031-03-10T12:00:00Z') };
  const lines: string[] = [];
  const following = new Following({ dir, controlDir, commit, now: () => clock.now, log: line => lines.push(line) });
  const read = (file: string) => (existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>) : null);
  const request = () => read(join(controlDir, 'request.json'));
  const go = () => read(join(dir, 'computer-control', GO_FILE));
  const controlGo = () => read(join(controlDir, GO_FILE));
  const asked = () => read(join(dir, FOLLOW_FILE));
  /* What the updater says of the request it runs. */
  const updater = (id: unknown, state: string, step: string) => writeFileSync(join(controlDir, 'status.json'), JSON.stringify({ id, version: 'x', state, step, log: '', at: '' }));
  return { dir, controlDir, clock, lines, following, request, go, controlGo, asked, updater };
}

describe("a worker following the server's build", () => {
  it('asks its updater for the build once, with its digests', () => {
    const s = standUp();
    s.following.heard(null, null);
    expect(s.request()).toBeNull();
    s.following.heard(B1, null);
    const first = s.request();
    expect(first).toEqual({ id: expect.stringMatching(/^[0-9a-f-]{36}$/), version: '0.19.0', tag: B1.tag, digest: 'sha256:app1', nodeDigest: 'sha256:node1', updaterDigest: 'sha256:updater1' });
    expect(s.asked()).toEqual({ id: first!.id, tag: B1.tag, at: '2031-03-10T12:00:00.000Z' });
    /* The same build again is the same request. */
    s.following.heard(B1, null);
    expect(s.request()).toEqual(first);
  });

  it('asks for no build it runs itself, which a server that has not heard from it yet names', () => {
    const s = standUp(B1.commit);
    s.following.heard(B1, null);
    expect([s.request(), s.asked()]).toEqual([null, null]);
    /* Another build is asked for as ever. */
    s.following.heard(B2, null);
    expect(s.request()).toMatchObject({ tag: B2.tag });
  });

  it('takes back a request that only waits once the server names no build to it, or the one it runs', () => {
    for (const named of [null, B1]) {
      const s = standUp(named ? B1.commit : undefined);
      /* Asked while the server named another build, or before this machine knew what it runs. */
      const waiting = new Following({ dir: s.dir, controlDir: s.controlDir, now: () => s.clock.now, log: () => undefined });
      waiting.heard(B1, null);
      const asked = s.request()!;
      s.updater(asked.id, 'running', 'wait');
      s.following.heard(named, null);
      expect([s.request(), s.asked()], String(named?.tag)).toEqual([null, null]);
      expect(s.following.update()).toBeNull();
    }
    /* One the updater installs is left to end, and so is one that has ended. */
    for (const [state, step] of [['running', 'install'], ['running', 'health'], ['done', 'finished'], ['failed', 'finished']] as const) {
      const s = standUp();
      s.following.heard(B1, null);
      const asked = s.request()!;
      s.updater(asked.id, state, step);
      s.following.heard(null, null);
      expect(s.request(), `${state} ${step}`).toEqual(asked);
      expect(s.asked(), `${state} ${step}`).toMatchObject({ id: asked.id });
    }
  });

  it('says how far its updater is with that request, and nothing of any other', () => {
    const s = standUp();
    expect(s.following.update()).toBeNull();
    s.following.heard(B1, null);
    const { id } = s.request()!;
    expect(s.following.update()).toBeNull();
    s.updater(id, 'running', 'pull');
    expect(s.following.update()).toBeNull();
    s.updater(id, 'running', 'wait');
    expect(s.following.update()).toEqual({ commit: B1.tag, state: 'ready' });
    for (const step of ['install', 'health']) {
      s.updater(id, 'running', step);
      expect(s.following.update()).toEqual({ commit: B1.tag, state: 'installing' });
    }
    for (const state of ['failed', 'rolled_back']) {
      s.updater(id, state, 'finished');
      expect(s.following.update()).toEqual({ commit: B1.tag, state: 'failed' });
    }
    s.updater(id, 'done', 'finished');
    expect(s.following.update()).toBeNull();
    /* A request someone else gave the updater is not this keeper's to report. */
    s.updater('another', 'running', 'wait');
    expect(s.following.update()).toBeNull();
  });

  it("passes the server's word to install on to the updater, for its own request only", () => {
    const s = standUp();
    const until = '2031-03-10T12:15:00.000Z';
    /* A word for a build it never asked its updater for is nobody's. */
    s.following.heard(null, { commit: B1.tag, until, leftMs: 900_000 });
    expect(s.go()).toBeNull();
    s.following.heard(B1, { commit: B2.tag, until, leftMs: 900_000 });
    expect(s.go()).toBeNull();
    /* The stretch that is left is counted by this machine's own clock, which runs an hour ahead of the server's here. */
    s.clock.now = new Date('2031-03-10T13:00:00Z');
    s.following.heard(B1, { commit: B1.tag, until, leftMs: 900_000 });
    const word = { id: s.request()!.id, commit: B1.tag, until: Date.parse('2031-03-10T13:15:00Z') / 1000, said: until };
    expect(s.go()).toEqual(word);
    expect(s.controlGo()).toBeNull();
    /* The same word again, with less of it left, is the word already passed on. */
    s.clock.now = new Date('2031-03-10T13:05:00Z');
    s.following.heard(B1, { commit: B1.tag, until, leftMs: 600_000 });
    expect(s.go()).toEqual(word);
    expect(s.controlGo()).toBeNull();
  });

  it('takes a newer build while the old one downloads or waits, and never while it is installed', () => {
    const s = standUp();
    s.following.heard(B1, null);
    const first = s.request()!;
    s.updater(first.id, 'running', 'wait');
    s.following.heard(B2, null);
    const second = s.request()!;
    expect(second).toMatchObject({ tag: B2.tag, digest: 'sha256:app2' });
    expect(second.id).not.toBe(first.id);
    /* The updater installs: a request given now would cut it. */
    s.updater(second.id, 'running', 'install');
    s.following.heard(B1, null);
    expect(s.request()).toEqual(second);
    s.updater(second.id, 'running', 'rollback');
    s.following.heard(B1, null);
    expect(s.request()).toEqual(second);
  });

  it('asks again for a build whose install failed only hours later', () => {
    const s = standUp();
    s.following.heard(B1, null);
    const first = s.request()!;
    s.updater(first.id, 'rolled_back', 'finished');
    s.clock.now = new Date(s.clock.now.getTime() + FOLLOW_RETRY_MS - 60_000);
    s.following.heard(B1, null);
    expect(s.request()).toEqual(first);
    s.clock.now = new Date(s.clock.now.getTime() + 120_000);
    s.following.heard(B1, null);
    expect(s.request()!.id).not.toBe(first.id);
    expect(s.asked()).toMatchObject({ id: s.request()!.id, tag: B1.tag });
  });

  it('says once that it cannot reach its updater, and goes on', () => {
    const s = standUp();
    rmSync(s.controlDir, { recursive: true, force: true });
    s.following.heard(B1, null);
    s.following.heard(B1, null);
    expect(s.lines).toHaveLength(1);
    expect(s.lines[0]).toContain("Could not hand the server's build to this machine's updater");
    expect(s.following.update()).toBeNull();
  });
});
