import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { APP, runOnce, type Stand, stand, UPDATER_DIGESTS } from './updater-fixture.js';

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

  it('stops a running command when the CEO closes access', async () => {
    const s = stand();
    access(s, later());
    command(s, 'c6', 'apt-get upgrade -y', 60);
    const r = await runOnce(s, null, { ...env, STUB_COMPUTER_RUNS: '1', STUB_COMPUTER_CLOSES: '1' });
    expect(r.calls).toContain('docker rm -f hornhoof-computer-c6');
    expect(answer(s, 'c6')).toMatchObject({ id: 'c6', exit: 125, output: expect.stringContaining('Stopped: access to the computer was closed.') });
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
});
