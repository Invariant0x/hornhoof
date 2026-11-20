import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { until } from './helpers-basic.js';
import { JQ, runUpdaterStep, stand, startLoop, type Stand } from './updater-fixture.js';

/* A compose run that was cut short, as one whose command on the computer was stopped halfway, leaves containers it made
   and never started, and the machine stands without them: a node finds no front, and nothing would ever start them.
   The updater starts those of its own project again, as compose made them, once they stood so for five minutes with no
   update and no command under way. Made-up project and services. */
const NOW = 1_795_000_000;
const ENV = 'COMPOSE_PROJECT_NAME=acme-team\nHORNHOOF_ROLE=data\nCOMPOSE_PROFILES=data,builtin\n';
/* The containers of the project as docker ps says them: service and state. */
const HALF_MADE = 'db=created keeper=created front=created app=running node=running updater=running migrate=exited';
const START = 'docker compose up -d --no-build --no-deps --no-recreate db front keeper';
const LOOK = `docker ps -a --filter label=com.docker.compose.project=acme-team --format {{.Label "com.docker.compose.service"}} {{.State}}`;

const calls = (s: Stand) => readFileSync(s.log, 'utf8').split('\n').filter(Boolean);
const seen = (s: Stand) => readFileSync(join(s.control, 'unstarted'), 'utf8').trim();
const sawAt = (s: Stand, at: number, services: string) => writeFileSync(join(s.control, 'unstarted'), `${at} ${services}\n`);
const step = (s: Stand, env: Record<string, string> = {}) => runUpdaterStep(s, 'start_unstarted', { STUB_COMPUTER_NOW: String(NOW), STUB_PROJECT_STATES: HALF_MADE, STUB_LOG_ROLE: '1', ...env });

describe('the updater, for containers that were made and never started', () => {
  beforeAll(() => {
    if (!JQ) throw new Error('The updater tests need jq. Install it (brew install jq on a Mac, apt install jq on Debian or Ubuntu), then run them again.');
  });

  it('notes them the first time it sees them and starts nothing yet', async () => {
    const s = stand(ENV);
    const r = await step(s);
    expect(r.code).toBe(0);
    expect(calls(s)).toEqual([LOOK]);
    expect(seen(s)).toBe(`${NOW} db front keeper`);
  });

  it('starts them once they stood so for five minutes, each said, as compose made them and under the role of its settings', async () => {
    const s = stand(ENV);
    sawAt(s, NOW - 300, 'db front keeper');
    const r = await step(s, { HORNHOOF_ROLE: 'worker' });
    expect(r.code).toBe(0);
    expect(calls(s)).toEqual([LOOK, START, 'up as HORNHOOF_ROLE=data']);
    expect(r.out).toContain('Starting db, whose container was made and never started.');
    expect(r.out).toContain('Starting front, whose container was made and never started.');
    expect(r.out).toContain('Starting keeper, whose container was made and never started.');
    /* Started, they are noted no more. */
    const again = await step(s, { STUB_PROJECT_STATES: 'db=running keeper=running front=running updater=running' });
    expect(again.code).toBe(0);
    expect(calls(s).filter(c => c.startsWith('docker compose up'))).toEqual([START]);
    expect(() => seen(s)).toThrow();
  });

  it('says so when they do not start, and tries again five minutes later', async () => {
    const s = stand(ENV);
    sawAt(s, NOW - 301, 'db front keeper');
    const r = await step(s, { STUB_NO_RECREATE_UP: 'fail' });
    expect(r.code).toBe(0);
    expect(r.out).toContain('Could not start db front keeper.');
    expect(seen(s)).toBe(`${NOW} db front keeper`);
  });

  it('waits for five minutes of the same ones, so a compose run under way finishes first', async () => {
    const s = stand(ENV);
    sawAt(s, NOW - 299, 'db front keeper');
    await step(s);
    expect(calls(s)).toEqual([LOOK]);
    /* Another set is seen anew. */
    sawAt(s, NOW - 3600, 'db');
    await step(s);
    expect(calls(s).filter(c => c.startsWith('docker compose up'))).toEqual([]);
    expect(seen(s)).toBe(`${NOW} db front keeper`);
  });

  it('starts none whose service runs already, nor the updater, which its own swap starts', async () => {
    const s = stand(ENV);
    sawAt(s, NOW - 600, 'keeper');
    await step(s, { STUB_PROJECT_STATES: 'front=created front=running updater=created keeper=created db=running' });
    expect(calls(s)).toEqual([LOOK, 'docker compose up -d --no-build --no-deps --no-recreate keeper', 'up as HORNHOOF_ROLE=data']);
  });

  /* The migrations of a build, and the app that needs them, start by an update, which saves the database first: on the
     machine whose database the company writes, neither starts here. On a copy, whose schema is the leader's, the app
     starts as the rest; migrate, which runs nothing there, is left to the next update. */
  it('starts no migrate, and on the machine that leads no app', async () => {
    const states = 'db=created keeper=created front=created app=created migrate=created updater=running';
    const lead = stand(ENV);
    sawAt(lead, NOW - 600, 'db front keeper');
    await step(lead, { STUB_PROJECT_STATES: states });
    expect(calls(lead)).toEqual([LOOK, START, 'up as HORNHOOF_ROLE=data']);
    const copy = stand(ENV);
    writeFileSync(join(copy.control, 'replica.json'), '{}');
    sawAt(copy, NOW - 600, 'app db front keeper');
    await step(copy, { STUB_PROJECT_STATES: states });
    expect(calls(copy)).toEqual([LOOK, 'docker compose up -d --no-build --no-deps --no-recreate app db front keeper', 'up as HORNHOOF_ROLE=data']);
  });

  it('looks at nothing while an update or a command on the computer is under way, and forgets what it saw', async () => {
    for (const busy of ['update', 'note', 'command'] as const) {
      const s = stand(ENV);
      sawAt(s, NOW - 600, 'db front keeper');
      if (busy === 'update') writeFileSync(join(s.control, 'status.json'), JSON.stringify({ id: 'u1', state: 'running', step: 'install' }));
      if (busy === 'note') {
        mkdirSync(join(s.server, 'backups'));
        writeFileSync(join(s.server, 'backups', 'update.json'), '{}');
      }
      if (busy === 'command') {
        mkdirSync(join(s.computerControl, 'computer'));
        writeFileSync(join(s.computerControl, 'computer', 'c1.started'), '');
      }
      const r = await step(s);
      expect(r.code, busy).toBe(0);
      expect(calls(s), busy).toEqual([]);
      expect(() => seen(s), busy).toThrow();
    }
  });

  it('runs in the updater that watches, round after round', async () => {
    const s = stand(ENV);
    sawAt(s, NOW - 600, 'db front keeper');
    const loop = startLoop(s, { STUB_COMPUTER_NOW: String(NOW), STUB_PROJECT_STATES: HALF_MADE });
    await until(() => loop.calls().includes(START));
  });
});
