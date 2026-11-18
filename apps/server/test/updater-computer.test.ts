import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { eventually } from '../../../test-support/eventually.mjs';
import { APP, killProcessGroup, pidAlive, runOnce, type Stand, stand, UPDATER_DIGESTS } from './updater-fixture.js';

const SLEEP_STUB = fileURLToPath(new URL('./updater-stubs/sleep', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

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
  const env = { HORNHOOF_COMPUTER_IMAGE: HELPER, STUB_WATCH: '1' };
  function access(s: Stand, untilSec: number) {
    writeFileSync(join(s.control, 'computer.json'), JSON.stringify({ untilSec, until: new Date(untilSec * 1000).toISOString(), asked: null }));
  }
  function command(s: Stand, id: string, run: string, timeout = 60) {
    mkdirSync(join(s.control, 'computer'), { recursive: true });
    writeFileSync(join(s.control, 'computer', `${id}.json`), JSON.stringify({ id, command: run, timeout }));
  }
  const answer = (s: Stand, id: string) => {
    const file = join(s.control, 'computer', `${id}.out.json`);
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
  };
  const later = () => Math.floor(Date.now() / 1000) + 3600;

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
    expect(existsSync(join(s.control, 'computer', 'c1.started'))).toBe(false);
    /* An answered command does not run again: the stub's log keeps the first run only. */
    expect((await runOnce(s, null, env)).calls.filter(c => c.startsWith('docker start'))).toHaveLength(1);
  });

  it('runs nothing while access is closed or over, and says so', async () => {
    const s = stand();
    access(s, Math.floor(Date.now() / 1000) - 1);
    command(s, 'c2', 'rm -rf /host/etc');
    const r = await runOnce(s, null, env);
    expect(r.calls.filter(c => c.startsWith('docker'))).toEqual([]);
    expect(answer(s, 'c2')).toEqual({ id: 'c2', exit: 126, output: 'Access to the computer is closed.\n' });
    /* Closed while its container was being made: it never starts. */
    const u = stand();
    access(u, later());
    command(u, 'c8', 'rm -rf /host/var/lib/docker');
    const raced = await runOnce(u, null, { ...env, STUB_CLOSE_ON_CREATE: '1' });
    expect(raced.calls).toContain('docker rm -f hornhoof-computer-c8');
    expect(raced.calls.filter(c => c.startsWith('docker start'))).toEqual([]);
    expect(answer(u, 'c8')).toMatchObject({ exit: 125, output: expect.stringContaining('Stopped: access to the computer was closed.') });
    const t = stand();
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
    const close = 'if [ -f "$HORNHOOF_CONTROL_DIR/computer/c6.started" ]; then echo "{}" > "$HORNHOOF_CONTROL_DIR/computer.json"; fi';
    const r = await runOnce(s, null, { ...env, STUB_COMPUTER_RUNS: '1', STUB_DURING_SLEEP: close });
    expect(r.calls).toContain('docker rm -f hornhoof-computer-c6');
    expect(answer(s, 'c6')).toMatchObject({ id: 'c6', exit: 125, output: expect.stringContaining('Stopped: access to the computer was closed.') });
  });

  it('stops a command the keeper takes back even while computer access is open again', async () => {
    const s = stand();
    access(s, later());
    command(s, 'c8', 'recorded sample', 4);
    const forget = 'if [ -f "$HORNHOOF_CONTROL_DIR/computer/c8.started" ]; then echo "computer watch" >> "$STUB_LOG"; rm -f "$HORNHOOF_CONTROL_DIR/computer/c8.json"; fi';
    const r = await runOnce(s, null, { ...env, STUB_COMPUTER_RUNS: '1', STUB_DURING_SLEEP: forget });
    expect(r.calls.filter(line => line === 'computer watch')).toEqual(['computer watch']);
    expect(r.calls).toContain('docker rm -f hornhoof-computer-c8');
    expect(answer(s, 'c8')).toBeNull();
  });

  it('runs no command a second time after it restarted, and stops what still runs of it', async () => {
    const s = stand();
    access(s, later());
    command(s, 'c7', 'apt-get upgrade -y');
    writeFileSync(join(s.control, 'computer', 'c7.started'), '');
    const r = await runOnce(s, null, env);
    expect(r.calls).toEqual(['docker rm -f hornhoof-computer-c7']);
    expect(answer(s, 'c7')).toMatchObject({ id: 'c7', exit: 125, output: expect.stringContaining('The updater restarted while this command ran') });
    expect(existsSync(join(s.control, 'computer', 'c7.started'))).toBe(false);
  });

  it('stops a command it started whose request the app took back', async () => {
    const s = stand();
    mkdirSync(join(s.control, 'computer'));
    writeFileSync(join(s.control, 'computer', 'c9.started'), '');
    expect((await runOnce(s, null, env)).calls).toEqual(['docker rm -f hornhoof-computer-c9']);
    expect(readdirSync(join(s.control, 'computer'))).toEqual([]);
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
        `const untilSec = Math.floor(Date.now() / 1000) + 3600;`,
        `writeFileSync(join(s.control, 'computer.json'), JSON.stringify({ untilSec, until: new Date(untilSec * 1000).toISOString(), asked: null }));`,
        `mkdirSync(join(s.control, 'computer'), { recursive: true });`,
        `writeFileSync(join(s.control, 'computer', 'c1.json'), JSON.stringify({ id: 'c1', command: 'sleep 600', timeout: 600 }));`,
        `void runOnce(s, null, { HORNHOOF_COMPUTER_IMAGE: APP + '-updater@' + UPDATER_DIGESTS['0.4.0'], STUB_WATCH: '1', STUB_COMPUTER_HOLD: holdFile }).catch(() => {});`,
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
      const untilSec = Math.floor(Date.now() / 1000) + 3600;
      writeFileSync(join(s.control, 'computer.json'), JSON.stringify({ untilSec, until: new Date(untilSec * 1000).toISOString(), asked: null }));
      mkdirSync(join(s.control, 'computer'), { recursive: true });
      writeFileSync(join(s.control, 'computer', 'c1.json'), JSON.stringify({ id: 'c1', command: 'sleep 600', timeout: 600 }));
      void runOnce(s, null, { HORNHOOF_COMPUTER_IMAGE: `${APP}-updater@${UPDATER_DIGESTS['0.4.0']}`, STUB_WATCH: '1', STUB_COMPUTER_HOLD: holdFile }).catch(() => {});
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
