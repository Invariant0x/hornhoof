import { describe, expect, it } from 'vitest';
import { reapProfile, sweepStale, type Folders, type ProcessTable } from '../src/web-page/processes.js';

type Row = { pid: number; group: number; owner: number; args: string[] };

/* A process table as /proc shows one: the browser of this run with its helpers in its group, another run's browser, and
   the same profile in a process of someone else. */
function table(rows: Row[]) {
  const killed: [number, string][] = [];
  const alive = new Set(rows.map(r => r.pid));
  const of = (pid: number) => rows.find(r => r.pid === pid);
  const t: ProcessTable = {
    pids: () => rows.map(r => r.pid),
    args: pid => of(pid)?.args ?? null,
    group: pid => of(pid)?.group ?? null,
    owner: pid => of(pid)?.owner ?? null,
    alive: pid => alive.has(pid),
    kill: (pid, signal) => {
      killed.push([pid, signal]);
      if (pid === 4242) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
    },
  };
  return { t, killed };
}

const PROFILE = '/tmp/hh-browse-700-a1/profile';
const CHROME = '/data/browsers/chromium_headless_shell-1248/chrome-headless-shell-linux-arm64/chrome-headless-shell';

describe('cleaning up after hh-browse', () => {
  it('kills the group of the browser that holds this run profile, and nothing of other runs or users', () => {
    const { t, killed } = table([
      { pid: 900, group: 900, owner: 1000, args: [CHROME, '--headless', `--user-data-dir=${PROFILE}`, '--remote-debugging-pipe'] },
      { pid: 901, group: 900, owner: 1000, args: [CHROME, '--type=zygote'] },
      { pid: 950, group: 950, owner: 1000, args: [CHROME, '--user-data-dir=/tmp/hh-browse-800-b2/profile'] },
      { pid: 960, group: 960, owner: 1001, args: [CHROME, `--user-data-dir=${PROFILE}`] },
      { pid: 970, group: 970, owner: 1000, args: [CHROME, `--user-data-dir=${PROFILE}-old`] },
    ]);
    expect(reapProfile(PROFILE, t, 1000)).toEqual([900]);
    expect(killed).toEqual([[-900, 'SIGKILL']]);
  });

  it('kills a browser process that leads no group by itself, and goes on past one that is already gone', () => {
    const { t, killed } = table([
      { pid: 4242, group: 4242, owner: 1000, args: [CHROME, `--user-data-dir=${PROFILE}`] },
      { pid: 977, group: 300, owner: 1000, args: [CHROME, `--user-data-dir=${PROFILE}`] },
    ]);
    expect(reapProfile(PROFILE, t, 1000)).toEqual([4242, 977]);
    expect(killed).toEqual([[-4242, 'SIGKILL'], [977, 'SIGKILL']]);
  });

  it('removes the folders and browsers of runs whose process is gone, and leaves a live run and other users alone', () => {
    const { t, killed } = table([
      { pid: 700, group: 700, owner: 1000, args: ['node', '/usr/local/bin/hh-browse', 'https://example.org/'] },
      { pid: 990, group: 990, owner: 1000, args: [CHROME, '--user-data-dir=/tmp/hh-browse-555-c3/profile'] },
    ]);
    const removed: string[] = [];
    const folders: Folders = {
      list: () => ['hh-browse-700-a1', 'hh-browse-555-c3', 'hh-browse-556-d4', 'hh-browse-x-e5', 'other-folder'],
      owner: path => (path.endsWith('d4') ? 1001 : 1000),
      remove: path => { removed.push(path); },
    };
    expect(sweepStale('/tmp', folders, t, 1000)).toEqual(['/tmp/hh-browse-555-c3']);
    expect(removed).toEqual(['/tmp/hh-browse-555-c3']);
    expect(killed).toEqual([[-990, 'SIGKILL']]);
  });
});
