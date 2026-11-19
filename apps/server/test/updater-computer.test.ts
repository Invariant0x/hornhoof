import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { eventually } from '../../../test-support/eventually.mjs';
import { APP, JQ, killProcessGroup, pidAlive, runOnce, type Stand, stand, startLoop, UPDATER_DIGESTS } from './updater-fixture.js';

const SLEEP_STUB = fileURLToPath(new URL('./updater-stubs/sleep', import.meta.url));
const STUBS = fileURLToPath(new URL('./updater-stubs/', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const NOW_SEC = 1_795_000_000;
const CLOCK = { STUB_COMPUTER_NOW: String(NOW_SEC) };

function treePids(rootPid: number): number[] {
  const out = spawnSync('ps', ['-eo', 'pid=,ppid='], { encoding: 'utf8' }).stdout;
  const children = new Map<number, number[]>();
  for (const line of out.split('\n')) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (pid && ppid) children.set(ppid, [...(children.get(ppid) ?? []), pid]);
  }
  const all = [rootPid];
  for (let i = 0; i < all.length; i++) {
    for (const child of children.get(all[i]!) ?? []) all.push(child);
  }
  return all;
}

/* The orchestrator's commands on the server's computer, while the CEO keeps access to it open. */
describe('updater, the computer', () => {
  const HELPER = `${APP}-updater@${UPDATER_DIGESTS['0.4.0']}`;
  /* The watch over a command counts its seconds as the stubs let them pass, with no clock. */
  const env = { ...CLOCK, HORNHOOF_COMPUTER_IMAGE: HELPER, STUB_WATCH: '1' };
  function access(s: Stand, untilSec: number) {
    writeFileSync(join(s.computerControl, 'computer.json'), JSON.stringify({ untilSec, until: new Date(untilSec * 1000).toISOString(), asked: null }));
  }
  function command(s: Stand, id: string, run: string, timeout = 60) {
    mkdirSync(join(s.computerControl, 'computer'), { recursive: true });
    writeFileSync(join(s.computerControl, 'computer', `${id}.json`), JSON.stringify({ id, command: run, timeout }));
  }
  const answer = (s: Stand, id: string) => {
    const file = join(s.computerControl, 'computer', `${id}.out.json`);
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
  };
  const later = () => NOW_SEC + 3600;

  function legacyQueueOwner(s: Stand, uid: string) {
    const tools = join(s.dir, 'queue-owner');
    mkdirSync(tools);
    writeFileSync(
      join(tools, 'stat'),
      '#!/bin/sh\ncase "$*:$PWD" in\n  "-c %u .:$LEGACY_QUEUE"|"-f %u .:$LEGACY_QUEUE") printf "%s\\n" "$LEGACY_UID" ;;\n  *) exec /usr/bin/stat "$@" ;;\nesac\n',
      { mode: 0o755 },
    );
    return { ...env, PATH: `${tools}:${STUBS}:${dirname(JQ)}:/usr/bin:/bin`, LEGACY_QUEUE: join(realpathSync(s.control), 'computer'), LEGACY_UID: uid };
  }

  it('removes old computer files, logging only the count, while a keeper request runs', async () => {
    const s = stand();
    const shared = join(s.control, 'computer');
    mkdirSync(shared);
    writeFileSync(join(shared, 'shared.json'), JSON.stringify({ id: 'shared', command: 'private sample', timeout: 30 }));
    writeFileSync(join(shared, 'old.started'), '');
    access(s, later());
    command(s, 'keeper', 'recorded sample');
    const r = await runOnce(s, null, legacyQueueOwner(s, '1000'));
    expect(r.code).toBe(0);
    expect(r.calls.filter(call => call.startsWith('docker start'))).toEqual(['docker start -a hornhoof-computer-keeper']);
    expect(r.calls).not.toContainEqual(expect.stringContaining('hornhoof-computer-shared'));
    expect(r.calls).not.toContainEqual(expect.stringContaining('hornhoof-computer-old'));
    expect(r.out).toContain('Removed 2 files from the old computer queue.');
    expect(r.out).not.toMatch(/private sample|shared\.json/);
    expect(readdirSync(shared)).toEqual([]);
    expect(answer(s, 'keeper')).toEqual({ id: 'keeper', exit: 0, output: 'ran: recorded sample\n' });
  });

  /* What the app could write before: an open window and a request in the shared folder, which an older updater ran as
     root, and a start marker, which made it stop a command. */
  it('runs and stops nothing the app drops into the shared control folder, even with an open shared window', async () => {
    const s = stand();
    const shared = join(s.control, 'computer');
    mkdirSync(shared);
    writeFileSync(join(s.control, 'computer.json'), JSON.stringify({ untilSec: later(), until: null, asked: null }));
    writeFileSync(join(shared, 'dropped.json'), JSON.stringify({ id: 'dropped', command: 'private sample', timeout: 30 }));
    writeFileSync(join(shared, 'k1.started'), '');
    const r = await runOnce(s, null, legacyQueueOwner(s, '1000'));
    expect(r.code).toBe(0);
    expect(r.calls.filter(call => call.startsWith('docker'))).toEqual([]);
    expect(r.out.match(/Removed 2 files from the old computer queue\./g) ?? []).toHaveLength(1);
    expect(r.out).not.toMatch(/private sample|dropped/);
    expect(readdirSync(shared)).toEqual([]);
  });

  it('publishes an answer without using the predictable temporary file', async () => {
    const s = stand();
    command(s, 'sample', 'recorded sample');
    const leftover = join(s.computerControl, 'computer', 'sample.out.json.new');
    writeFileSync(leftover, 'recorded leftover');
    const r = await runOnce(s, null, env);
    expect(r.code).toBe(0);
    expect(r.calls).toEqual([]);
    expect(answer(s, 'sample')).toMatchObject({ exit: 126 });
    expect(lstatSync(join(s.computerControl, 'computer', 'sample.out.json')).mode & 0o777).toBe(0o644);
    expect(existsSync(leftover)).toBe(true);
    expect(readFileSync(leftover, 'utf8')).toBe('recorded leftover');
  });

  /* A link to a file that is there, and one to a file that is not, which root would otherwise create. */
  it.each([
    { marker: 'sample.out.json', contents: 'recorded contents' },
    { marker: 'sample.started', contents: 'recorded contents' },
    { marker: 'sample.out.json', contents: null },
    { marker: 'sample.started', contents: null },
  ])('refuses a keeper request with a linked $marker whose target holds $contents', async ({ marker, contents }) => {
    const s = stand();
    access(s, later());
    command(s, 'sample', 'recorded sample');
    const target = join(s.dir, 'recorded-target');
    if (contents !== null) writeFileSync(target, contents);
    const link = join(s.computerControl, 'computer', marker);
    symlinkSync(target, link);
    const r = await runOnce(s, null, env);
    expect(r.code).toBe(0);
    expect(r.calls).toEqual([]);
    expect(r.out).toContain('Computer request refused: its answer or start marker is a link.');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(existsSync(target) ? readFileSync(target, 'utf8') : null).toBe(contents);
  });

  /* Bash sets PWD from the path it resolved before it entered a folder, so a link the keeper swaps in between goes unseen
     there. The system's own pwd says where the updater really is: here it says somewhere else for the folders named. */
  function elsewhere(s: Stand, folders: string) {
    const tools = join(s.dir, 'elsewhere');
    mkdirSync(tools);
    writeFileSync(join(tools, 'pwd'), `#!/bin/sh\ncase "$(/bin/pwd -P)" in ${folders}) echo /elsewhere ;; *) exec /bin/pwd "$@" ;; esac\n`, { mode: 0o755 });
    return { ...env, PATH: `${tools}:${STUBS}:${dirname(JQ)}:/usr/bin:/bin` };
  }

  it('works in no queue that the system places elsewhere, old or new', async () => {
    const s = stand();
    access(s, later());
    command(s, 'c5', 'recorded sample');
    const shared = join(s.control, 'computer');
    mkdirSync(shared);
    writeFileSync(join(shared, 'old.json'), 'recorded old request');
    const r = await runOnce(s, null, elsewhere(s, '*/computer'));
    expect(r.code).toBe(0);
    expect(r.calls).toEqual([]);
    expect(r.out).toContain('Skipped the old computer queue');
    expect(readdirSync(join(s.computerControl, 'computer'))).toEqual(['c5.json']);
    expect(readdirSync(shared)).toEqual(['old.json']);
  });

  it('publishes no answer from a private folder that the system places elsewhere, and keeps the mark', async () => {
    const s = stand();
    access(s, later());
    command(s, 'c6', 'recorded sample');
    const r = await runOnce(s, null, elsewhere(s, '*/.answer.*'));
    expect(r.calls.filter(c => c.startsWith('docker start'))).toEqual(['docker start -a hornhoof-computer-c6']);
    expect(r.out).toContain('Computer answer refused: it could not be published safely.');
    expect(readdirSync(join(s.computerControl, 'computer')).sort()).toEqual(['c6.json', 'c6.started']);
  });

  it('runs no command when the system places its private start-marker folder elsewhere', async () => {
    const s = stand();
    access(s, later());
    command(s, 'sample', 'recorded sample');
    const r = await runOnce(s, null, elsewhere(s, '*/.started.*'));
    expect(r.code).toBe(0);
    expect(r.calls).toEqual([]);
    expect(r.out).toContain('Computer request refused: its start marker could not be created.');
    expect(readdirSync(join(s.computerControl, 'computer'))).toEqual(['sample.json']);
  });

  it('keeps processing requests while named pipes occupy a heartbeat, start marker and answer', async () => {
    const s = stand();
    access(s, later());
    command(s, 'marked', 'recorded sample');
    command(s, 'answered', 'recorded sample');
    command(s, 'next', 'recorded sample');
    const queue = join(s.computerControl, 'computer');
    const pipes = [join(s.computerControl, 'alive'), join(queue, 'marked.started'), join(queue, 'answered.out.json')];
    expect(spawnSync('mkfifo', pipes).status).toBe(0);
    const r = await runOnce(s, null, env);
    expect(r.code).toBe(0);
    expect(r.calls.filter(call => call.startsWith('docker start'))).toEqual(['docker start -a hornhoof-computer-next']);
    expect(answer(s, 'next')).toMatchObject({ exit: 0 });
    expect(lstatSync(join(s.control, 'alive')).isFile()).toBe(true);
    expect(pipes.every(path => lstatSync(path).isFIFO())).toBe(true);
  }, 10_000);

  /* The keeper can plant a named pipe after the updater looked and found nothing there. One that appears while the
     private folder is made is refused before the start marker is written; one that appears at the last moment before
     the rename is replaced by it. Either way nothing opens the pipe, so nothing waits on it. */
  function racing(s: Stand, tool: 'mktemp' | 'mv', plant: string) {
    const tools = join(s.dir, 'racing');
    mkdirSync(tools);
    const moves = join(s.dir, 'moves');
    const script =
      tool === 'mktemp'
        ? `#!/bin/sh\ncase "$*" in *"-d .started."*) mkfifo ./sample.started ;; esac\nPATH=/usr/bin:/bin exec mktemp "$@"\n`
        : `#!/bin/sh\nlast=\nfor a in "$@"; do last=$a; done\nprintf '%s\\n' "$*" >> '${moves}'\n` +
          `case "$last" in ${plant}) mkfifo "$last" ;; esac\nexec /bin/mv "$@"\n`;
    writeFileSync(join(tools, tool), script, { mode: 0o755 });
    return { env: { ...env, PATH: `${tools}:${STUBS}:${dirname(JQ)}:/usr/bin:/bin` }, moves };
  }

  it('refuses a start marker when a named pipe appears at it after the check, and runs nothing', async () => {
    const s = stand();
    access(s, later());
    command(s, 'sample', 'recorded sample');
    const r = await runOnce(s, null, racing(s, 'mktemp', '').env);
    expect(r.code).toBe(0);
    expect(r.calls).toEqual([]);
    expect(r.out).toContain('Computer request refused: its start marker could not be created.');
    const queue = join(s.computerControl, 'computer');
    expect(lstatSync(join(queue, 'sample.started')).isFIFO()).toBe(true);
    expect(readdirSync(queue).sort()).toEqual(['sample.json', 'sample.started']);
  }, 10_000);

  it('renames the start marker and the answer over named pipes put there at the last moment, and runs once', async () => {
    const s = stand();
    access(s, later());
    command(s, 'sample', 'recorded sample');
    const { env: raced, moves } = racing(s, 'mv', '*/sample.started|*/sample.out.json');
    const r = await runOnce(s, null, raced);
    expect(r.code).toBe(0);
    expect(r.calls.filter(call => call.startsWith('docker start'))).toEqual(['docker start -a hornhoof-computer-sample']);
    const renamed = readFileSync(moves, 'utf8');
    expect(renamed).toMatch(/\.\/started \S+\/sample\.started/);
    expect(renamed).toMatch(/\.\/answer \S+\/sample\.out\.json/);
    const queue = join(s.computerControl, 'computer');
    expect(lstatSync(join(queue, 'sample.out.json')).isFile()).toBe(true);
    expect(answer(s, 'sample')).toEqual({ id: 'sample', exit: 0, output: 'ran: recorded sample\n' });
    expect(readdirSync(queue).sort()).toEqual(['sample.json', 'sample.out.json']);
  }, 10_000);

  it('leaves the old queue alone when its owner is not UID 1000', async () => {
    const s = stand();
    const shared = join(s.control, 'computer');
    mkdirSync(shared);
    const files = ['old.json', 'old.json.new', 'old.started'];
    for (const file of files) writeFileSync(join(shared, file), 'recorded contents');
    const r = await runOnce(s, null, legacyQueueOwner(s, '0'));
    expect(r.code).toBe(0);
    expect(r.out).toContain('Skipped the old computer queue');
    expect(readdirSync(shared).sort()).toEqual(files);
  });

  it('clears only old queue entries without following file or directory links', async () => {
    const s = stand();
    const shared = join(s.control, 'computer');
    const elsewhere = join(s.dir, 'elsewhere');
    mkdirSync(elsewhere);
    const sample = join(elsewhere, 'sample.json');
    writeFileSync(sample, 'recorded contents');
    symlinkSync(elsewhere, shared);
    const owned = legacyQueueOwner(s, '1000');
    const linked = await runOnce(s, null, owned);
    expect(linked.code).toBe(0);
    expect(linked.out).toContain('Skipped the old computer queue');
    expect(readFileSync(sample, 'utf8')).toBe('recorded contents');

    rmSync(shared);
    mkdirSync(shared);
    symlinkSync(sample, join(shared, 'old.json'));
    writeFileSync(join(shared, 'old.out.json'), '{}');
    writeFileSync(join(shared, 'old.out.json.new'), '{}');
    mkdirSync(join(shared, 'directory.json'));
    writeFileSync(join(shared, 'notes'), 'recorded notes');
    const cleaned = await runOnce(s, null, owned);
    expect(cleaned.code).toBe(0);
    expect(cleaned.out).toContain('Removed 3 files from the old computer queue.');
    expect(cleaned.out).not.toContain('old.json');
    expect(readdirSync(shared).sort()).toEqual(['directory.json', 'notes']);
    expect(readFileSync(sample, 'utf8')).toBe('recorded contents');
  });

  it('writes the computer heartbeat where the keeper can read it', async () => {
    const s = stand();
    const r = await runOnce(s, null, env);
    expect(r.code).toBe(0);
    expect(existsSync(join(s.computerControl, 'alive'))).toBe(true);
    expect(existsSync(join(s.control, 'alive'))).toBe(true);
  });

  it('leaves a linked computer heartbeat and its target alone', async () => {
    const s = stand();
    const target = join(s.dir, 'recorded-target');
    symlinkSync(target, join(s.computerControl, 'alive'));
    expect((await runOnce(s, null, env)).code).toBe(0);
    expect(lstatSync(join(s.computerControl, 'alive')).isSymbolicLink()).toBe(true);
    expect(existsSync(target)).toBe(false);
  });

  /* Bash opens a redirect target through a link without O_EXCL once it has seen something there that is not a regular
     file, so the keeper could swap a link in at that moment. A missing heartbeat is made in a private folder and renamed
     into place instead: here a link appears at the last moment before that rename, and the rename replaces it. */
  it('makes a missing computer heartbeat in a private folder and renames it over a link put there at the last moment', async () => {
    const s = stand();
    const outside = join(s.dir, 'outside');
    mkdirSync(outside);
    const target = join(outside, 'recorded-target');
    const tools = join(s.dir, 'racing');
    mkdirSync(tools);
    const moves = join(s.dir, 'moves');
    writeFileSync(
      join(tools, 'mv'),
      `#!/bin/sh\nlast=\nfor a in "$@"; do last=$a; done\nprintf '%s\\n' "$*" >> '${moves}'\n` +
        `case "$last" in */alive) ln -s '${target}' "$last" ;; esac\nexec /bin/mv "$@"\n`,
      { mode: 0o755 },
    );
    const r = await runOnce(s, null, { ...env, PATH: `${tools}:${STUBS}:${dirname(JQ)}:/usr/bin:/bin` });
    expect(r.code).toBe(0);
    expect(readFileSync(moves, 'utf8')).toMatch(/\.\/alive \S+\/alive/);
    expect(lstatSync(join(s.computerControl, 'alive')).isFile()).toBe(true);
    expect(existsSync(target)).toBe(false);
    expect(readdirSync(s.computerControl).filter(name => name.startsWith('.alive.'))).toEqual([]);
  });

  /* The app can write the control folder and so make its own heartbeat there fail; that never stops the updater, nor the
     keeper's heartbeat in the computer volume. */
  it('starts and writes the computer heartbeat when the app links its own heartbeat where nothing can be made', async () => {
    const s = stand();
    const target = join(s.dir, 'missing', 'recorded-target');
    symlinkSync(target, join(s.control, 'alive'));
    const r = await runOnce(s, null, env);
    expect(r.code).toBe(0);
    expect(lstatSync(join(s.computerControl, 'alive')).isFile()).toBe(true);
    expect(existsSync(join(s.dir, 'missing'))).toBe(false);
  });

  it('keeps the computer heartbeat going after the app breaks its own heartbeat', async () => {
    const s = stand();
    const keeper = join(s.computerControl, 'alive');
    /* No watch: the heartbeat's wait passes at once, as a wait the updater makes outside a command does here. */
    startLoop(s);
    await eventually(() => existsSync(keeper));
    rmSync(join(s.control, 'alive'), { force: true });
    symlinkSync(join(s.dir, 'missing', 'recorded-target'), join(s.control, 'alive'));
    rmSync(keeper);
    await eventually(() => existsSync(keeper));
    expect(lstatSync(keeper).isFile()).toBe(true);
    expect(existsSync(join(s.dir, 'missing'))).toBe(false);
  });

  it('runs a command as root on the computer, with its files at /host and its Docker, and answers with the output and exit code', async () => {
    const s = stand();
    access(s, later());
    command(s, 'c1', 'uname -a');
    const r = await runOnce(s, null, { ...env, STUB_COMPUTER_EXIT: '3' });
    /* Made first and then started, so the watch can always stop it. */
    const made = r.calls.indexOf(
      `docker create --rm --name hornhoof-computer-c1 --privileged --pid=host --network=host --ipc=host --uts=host -v /:/host -v /var/run/docker.sock:/var/run/docker.sock --entrypoint bash ${HELPER} -c uname -a`,
    );
    expect(made).toBeGreaterThanOrEqual(0);
    expect(r.calls.indexOf('docker start -a hornhoof-computer-c1')).toBeGreaterThan(made);
    expect(answer(s, 'c1')).toEqual({ id: 'c1', exit: 3, output: 'ran: uname -a\n' });
    expect(existsSync(join(s.computerControl, 'computer', 'c1.started'))).toBe(false);
    /* An answered command does not run again: the stub's log keeps the first run only. */
    expect((await runOnce(s, null, env)).calls.filter(c => c.startsWith('docker start'))).toHaveLength(1);
  });

  it('runs nothing while access is closed or over, and says so', async () => {
    const s = stand();
    access(s, NOW_SEC - 1);
    command(s, 'c2', 'recorded sample');
    const r = await runOnce(s, null, env);
    expect(r.calls.filter(c => c.startsWith('docker'))).toEqual([]);
    expect(answer(s, 'c2')).toEqual({ id: 'c2', exit: 126, output: 'Access to the computer is closed.\n' });
    /* Closed while its container was being made: it never starts. */
    const u = stand();
    access(u, later());
    command(u, 'c8', 'recorded sample');
    const raced = await runOnce(u, null, { ...env, STUB_CLOSE_ON_CREATE: '1' });
    expect(raced.calls).toContain('docker rm -f hornhoof-computer-c8');
    expect(raced.calls.filter(c => c.startsWith('docker start'))).toEqual([]);
    expect(answer(u, 'c8')).toMatchObject({ exit: 125, output: expect.stringContaining('Stopped: access to the computer was closed.') });
    const t = stand();
    writeFileSync(join(t.control, 'computer.json'), JSON.stringify({ untilSec: later() }));
    command(t, 'c3', 'uname -a');
    expect((await runOnce(t, null, env)).calls.filter(c => c.startsWith('docker'))).toEqual([]);
    expect(answer(t, 'c3')).toMatchObject({ exit: 126 });
  });

  it('stops a command at its time', async () => {
    const s = stand();
    access(s, later());
    command(s, 'c4', 'sleep 600', 1);
    const r = await runOnce(s, null, { ...env, STUB_COMPUTER_RUNS: '1' });
    expect(r.calls).toContain('docker rm -f hornhoof-computer-c4');
    expect(answer(s, 'c4')).toMatchObject({ id: 'c4', exit: 124, output: expect.stringContaining('Stopped after 1 seconds.') });
  });

  it('stops a running command when the machine owner closes access', async () => {
    const s = stand();
    access(s, later());
    command(s, 'c6', 'apt-get upgrade -y', 60);
    const close = 'if [ -f "$HORNHOOF_COMPUTER_CONTROL_DIR/computer/c6.started" ]; then echo "{}" > "$HORNHOOF_COMPUTER_CONTROL_DIR/computer.json"; fi';
    const r = await runOnce(s, null, { ...env, STUB_COMPUTER_RUNS: '1', STUB_DURING_SLEEP: close });
    expect(r.calls).toContain('docker rm -f hornhoof-computer-c6');
    expect(answer(s, 'c6')).toMatchObject({ id: 'c6', exit: 125, output: expect.stringContaining('Stopped: access to the computer was closed.') });
  });

  it('stops a command the keeper takes back even while computer access is open again', async () => {
    const s = stand();
    access(s, later());
    command(s, 'c8', 'recorded sample', 4);
    const forget = 'if [ -f "$HORNHOOF_COMPUTER_CONTROL_DIR/computer/c8.started" ]; then echo "computer watch" >> "$STUB_LOG"; rm -f "$HORNHOOF_COMPUTER_CONTROL_DIR/computer/c8.json"; fi';
    const r = await runOnce(s, null, { ...env, STUB_COMPUTER_RUNS: '1', STUB_DURING_SLEEP: forget });
    expect(r.calls.filter(line => line === 'computer watch')).toEqual(['computer watch']);
    expect(r.calls).toContain('docker rm -f hornhoof-computer-c8');
    expect(answer(s, 'c8')).toBeNull();
  });

  it('runs no command a second time after it restarted, and stops what still runs of it', async () => {
    const s = stand();
    access(s, later());
    command(s, 'c7', 'apt-get upgrade -y');
    writeFileSync(join(s.computerControl, 'computer', 'c7.started'), '');
    const r = await runOnce(s, null, env);
    expect(r.calls).toEqual(['docker rm -f hornhoof-computer-c7']);
    expect(answer(s, 'c7')).toMatchObject({ id: 'c7', exit: 125, output: expect.stringContaining('The updater restarted while this command ran') });
    expect(existsSync(join(s.computerControl, 'computer', 'c7.started'))).toBe(false);
  });

  /* A full volume, as mktemp meets it: the answer's private folder cannot be made. Every other mktemp works. */
  function onFullVolume(s: Stand) {
    const full = join(s.dir, 'full-volume');
    mkdirSync(full);
    writeFileSync(join(full, 'mktemp'), '#!/bin/sh\ncase "$*" in "-d .answer."*) exit 1 ;; esac\nexec /usr/bin/mktemp "$@"\n', { mode: 0o755 });
    return { ...env, PATH: `${full}:${STUBS}:${dirname(JQ)}:/usr/bin:/bin` };
  }

  it('never runs a command a second time when its answer cannot be written', async () => {
    const s = stand();
    access(s, later());
    command(s, 'c3', 'recorded sample');
    const first = await runOnce(s, null, onFullVolume(s));
    expect(first.calls.filter(c => c.startsWith('docker start'))).toEqual(['docker start -a hornhoof-computer-c3']);
    expect(first.out).toContain('Computer answer refused: it could not be published safely.');
    expect(answer(s, 'c3')).toBeNull();
    expect(existsSync(join(s.computerControl, 'computer', 'c3.started'))).toBe(true);
    /* The next look finds the mark and answers that the command was stopped: it never starts it again. */
    const next = await runOnce(s, null, env);
    expect(next.calls.filter(c => c.startsWith('docker start'))).toHaveLength(1);
    expect(answer(s, 'c3')).toMatchObject({ id: 'c3', exit: 125, output: expect.stringContaining('The updater restarted while this command ran') });
    expect(existsSync(join(s.computerControl, 'computer', 'c3.started'))).toBe(false);
  });

  it('answers a closed machine at the next look when its answer cannot be written', async () => {
    const s = stand();
    access(s, NOW_SEC - 1);
    command(s, 'c4', 'recorded sample');
    const first = await runOnce(s, null, onFullVolume(s));
    expect(first.code).toBe(0);
    expect(first.out).toContain('Computer answer refused: it could not be published safely.');
    expect(answer(s, 'c4')).toBeNull();
    const next = await runOnce(s, null, env);
    expect(next.calls.filter(c => c.startsWith('docker'))).toEqual([]);
    expect(answer(s, 'c4')).toMatchObject({ id: 'c4', exit: 126 });
  });

  it('stops a command it started whose request the app took back', async () => {
    const s = stand();
    mkdirSync(join(s.computerControl, 'computer'));
    writeFileSync(join(s.computerControl, 'computer', 'c9.started'), '');
    expect((await runOnce(s, null, env)).calls).toEqual(['docker rm -f hornhoof-computer-c9']);
    expect(readdirSync(join(s.computerControl, 'computer'))).toEqual([]);
  });

  it('leaves alone a command file whose name is not a plain id', async () => {
    const s = stand();
    access(s, later());
    command(s, 'c5;x', 'uname -a');
    expect((await runOnce(s, null, env)).calls.filter(c => c.startsWith('docker'))).toEqual([]);
  });

  describe('watch stub and process group cleanup', () => {
    const leakedPids = new Set<number>();
    const tempDirs: string[] = [];

    afterEach(() => {
      for (const pid of leakedPids) killProcessGroup(pid);
      leakedPids.clear();
      for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    });

    function readHoldPids(file: string): { dockerPid: number; updaterPid: number } | null {
      if (!existsSync(file)) return null;
      const line = readFileSync(file, 'utf8');
      if (!line.includes('\n')) return null;
      const [dockerPid, updaterPid] = line.trim().split(/\s+/).map(Number);
      if (!dockerPid || !updaterPid) return null;
      return { dockerPid, updaterPid };
    }

    it('yields the processor between watch checks with fractional /bin/sleep', () => {
      expect(readFileSync(SLEEP_STUB, 'utf8')).toMatch(/(?:^|\s)\/bin\/sleep\s+0\.\d+/m);
    });

    it.each(['state', 'tmp'] as const)('exits the watch sleep stub when its %s directory disappears', async missing => {
      const root = mkdtempSync(join(tmpdir(), 'hh-sleep-stub-'));
      tempDirs.push(root);
      const stateDir = join(root, 'state');
      const tmpDir = join(root, 'tmp');
      mkdirSync(stateDir);
      mkdirSync(tmpDir);
      const child = spawn('/bin/sh', ['-c', 'printf "ready\\n"; exec "$1" 1', '--', SLEEP_STUB], {
        env: { PATH: '/usr/bin:/bin', STUB_WATCH: '1', STUB_STATE: stateDir, TMPDIR: tmpDir },
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      if (child.pid) leakedPids.add(child.pid);
      await once(child.stdout, 'data');
      rmSync(missing === 'state' ? stateDir : tmpDir, { recursive: true, force: true });
      await once(child, 'exit');
      expect(child.pid ? pidAlive(child.pid) : false).toBe(false);
    });

    it('exits the watch sleep stub when its parent process exits', async () => {
      const root = mkdtempSync(join(tmpdir(), 'hh-sleep-parent-'));
      tempDirs.push(root);
      const stateDir = join(root, 'state');
      const tmpDir = join(root, 'tmp');
      mkdirSync(stateDir);
      mkdirSync(tmpDir);
      const parent = spawn('/bin/sh', ['-c', '"$1" 1 & printf "%s\\n" "$!"; wait', '--', SLEEP_STUB], {
        env: { PATH: '/usr/bin:/bin', STUB_WATCH: '1', STUB_STATE: stateDir, TMPDIR: tmpDir },
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      if (parent.pid) leakedPids.add(parent.pid);
      const [chunk] = (await once(parent.stdout, 'data')) as [Buffer];
      const sleepPid = Number(chunk.toString('utf8').trim());
      leakedPids.add(sleepPid);
      expect(pidAlive(sleepPid)).toBe(true);
      parent.kill('SIGKILL');
      await once(parent, 'exit');
      await eventually(() => !pidAlive(sleepPid));
    });

    it('stops remaining processes of updater.sh when updater.sh exits mid-command', async () => {
      const s = stand();
      tempDirs.push(s.dir);
      const holdFile = join(s.dir, 'computer-hold');
      access(s, later());
      command(s, 'cabort', 'sleep 600', 600);
      const running = runOnce(s, null, { ...env, STUB_COMPUTER_HOLD: holdFile });
      void running.catch(() => {});
      let pids: { dockerPid: number; updaterPid: number } | null = null;
      await eventually(() => {
        pids = readHoldPids(holdFile);
        return pids !== null;
      });
      const { dockerPid, updaterPid } = pids!;
      const groupPids = [...new Set([dockerPid, ...treePids(updaterPid)])];
      for (const pid of groupPids) leakedPids.add(pid);
      process.kill(updaterPid, 'SIGKILL');
      await running;
      expect(groupPids.filter(pidAlive)).toEqual([]);
    });

    it.each(['afterEach', 'exit', 'sigterm'] as const)('stops the updater.sh process group when a test ends by %s', async mode => {
      const work = mkdtempSync(join(tmpdir(), 'hh-updater-abort-'));
      tempDirs.push(work);
      const recordFile = join(work, 'record.json');
      const holdFile = join(work, 'hold');
      if (mode === 'afterEach') {
        const probeConfig = join(work, 'vitest.probe.config.mjs');
        writeFileSync(
          probeConfig,
          `export default { root: ${JSON.stringify(REPO_ROOT)}, test: { pool: 'forks', testTimeout: 20000, reporters: ['default'], include: ['apps/server/test/updater-computer.test.ts'] } };\n`,
        );
        const runner = spawn(
          process.execPath,
          [join(REPO_ROOT, 'node_modules/vitest/vitest.mjs'), 'run', '--config', probeConfig, 'apps/server/test/updater-computer.test.ts', '-t', 'updater computer abort probe'],
          {
            cwd: REPO_ROOT,
            env: {
              ...process.env,
              VITEST: '',
              VITEST_WORKER_ID: '',
              VITEST_POOL_ID: '',
              HH_TEST_REPORT: '',
              HH_TEST_PART: '',
              HH_TEST_FILES: '',
              HH_UPDATER_ABORT_HOLD: holdFile,
              HH_UPDATER_ABORT_RECORD: recordFile,
            },
            stdio: 'ignore',
          },
        );
        await once(runner, 'exit');
        const observed = JSON.parse(readFileSync(recordFile, 'utf8')) as {
          dir: string; pids: number[]; aliveAfterEach: number[]; dirExistsAfterEach: boolean;
        };
        for (const pid of observed.pids) leakedPids.add(pid);
        tempDirs.push(observed.dir);
        expect(observed.aliveAfterEach).toEqual([]);
        expect(observed.dirExistsAfterEach).toBe(false);
        return;
      }
      const fixtureUrl = new URL('./updater-fixture.ts', import.meta.url).href;
      const eventuallyUrl = new URL('../../../test-support/eventually.mjs', import.meta.url).href;
      const script = [
        `import { spawnSync } from 'node:child_process';`,
        `import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';`,
        `import { join } from 'node:path';`,
        `import { eventually } from ${JSON.stringify(eventuallyUrl)};`,
        `import { APP, runOnce, stand, UPDATER_DIGESTS } from ${JSON.stringify(fixtureUrl)};`,
        `function tree(root) {`,
        `  const out = spawnSync('ps', ['-eo', 'pid=,ppid='], { encoding: 'utf8' }).stdout;`,
        `  const map = new Map();`,
        `  for (const l of out.split('\\n')) { const [p, pp] = l.trim().split(/\\s+/).map(Number); if (p && pp) map.set(pp, [...(map.get(pp) ?? []), p]); }`,
        `  const all = [root]; for (let i = 0; i < all.length; i++) for (const c of map.get(all[i]) ?? []) all.push(c); return all;`,
        `}`,
        `const s = stand();`,
        `const holdFile = ${JSON.stringify(holdFile)};`,
        `const untilSec = ${NOW_SEC + 3600};`,
        `writeFileSync(join(s.computerControl, 'computer.json'), JSON.stringify({ untilSec, until: new Date(untilSec * 1000).toISOString(), asked: null }));`,
        `mkdirSync(join(s.computerControl, 'computer'), { recursive: true });`,
        `writeFileSync(join(s.computerControl, 'computer', 'c1.json'), JSON.stringify({ id: 'c1', command: 'sleep 600', timeout: 600 }));`,
        `void runOnce(s, null, { HORNHOOF_COMPUTER_IMAGE: APP + '-updater@' + UPDATER_DIGESTS['0.4.0'], STUB_WATCH: '1', STUB_COMPUTER_NOW: '${CLOCK.STUB_COMPUTER_NOW}', STUB_COMPUTER_HOLD: holdFile }).catch(() => {});`,
        `await eventually(() => existsSync(holdFile) && readFileSync(holdFile, 'utf8').includes('\\n'));`,
        `const [dockerPid, updaterPid] = readFileSync(holdFile, 'utf8').trim().split(/\\s+/).map(Number);`,
        `const pids = [...new Set([dockerPid, ...tree(updaterPid)])];`,
        `writeFileSync(${JSON.stringify(recordFile)}, JSON.stringify({ dir: s.dir, pids }));`,
        mode === 'exit' ? 'process.exit(1);' : "process.kill(process.pid, 'SIGTERM');",
      ].join('\n');
      const runner = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { cwd: REPO_ROOT, stdio: 'ignore' });
      await once(runner, 'exit');
      const recorded = JSON.parse(readFileSync(recordFile, 'utf8')) as { dir: string; pids: number[] };
      for (const pid of recorded.pids) leakedPids.add(pid);
      tempDirs.push(recorded.dir);
      await eventually(() => recorded.pids.every(pid => !pidAlive(pid)));
      expect(existsSync(recorded.dir)).toBe(false);
    });
  });
});

const abortHold = process.env.HH_UPDATER_ABORT_HOLD;
const abortRecord = process.env.HH_UPDATER_ABORT_RECORD;
if (abortHold && abortRecord) {
  describe('updater computer abort probe', () => {
    const holdFile = abortHold;
    const recordFile = abortRecord;
    let saved = { dir: '', pids: [] as number[] };

    it('fails while updater.sh and its watch run', async () => {
      const s = stand();
      const untilSec = NOW_SEC + 3600;
      writeFileSync(join(s.computerControl, 'computer.json'), JSON.stringify({ untilSec, until: new Date(untilSec * 1000).toISOString(), asked: null }));
      mkdirSync(join(s.computerControl, 'computer'), { recursive: true });
      writeFileSync(join(s.computerControl, 'computer', 'c1.json'), JSON.stringify({ id: 'c1', command: 'sleep 600', timeout: 600 }));
      void runOnce(s, null, { ...CLOCK, HORNHOOF_COMPUTER_IMAGE: `${APP}-updater@${UPDATER_DIGESTS['0.4.0']}`, STUB_WATCH: '1', STUB_COMPUTER_HOLD: holdFile }).catch(() => {});
      await eventually(() => existsSync(holdFile) && readFileSync(holdFile, 'utf8').includes('\n'));
      const [dockerPid, updaterPid] = readFileSync(holdFile, 'utf8').trim().split(/\s+/).map(Number);
      const pids = [...new Set([dockerPid!, ...treePids(updaterPid!)])];
      saved = { dir: s.dir, pids };
      writeFileSync(recordFile, JSON.stringify({ ...saved, aliveAfterEach: pids, dirExistsAfterEach: true }));
      throw new Error('simulated failure');
    });

    it('observes cleanup right after afterEach in the same worker', () => {
      writeFileSync(
        recordFile,
        JSON.stringify({
          ...saved,
          aliveAfterEach: saved.pids.filter(pidAlive),
          dirExistsAfterEach: existsSync(saved.dir),
        }),
      );
      expect(saved.pids.length).toBeGreaterThan(1);
    });
  });
}
