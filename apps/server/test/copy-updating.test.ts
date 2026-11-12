import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { CopyUpdating, PROMISE_FILE, readWord } from '../src/modules/keeper/updating.js';
import { createTestSql, ownDatabases } from './helpers.js';

/* These tests write the maintenance row of a database, which a truncate does not undo. */
ownDatabases();

const A = 'a0'.repeat(16);
const C = 'c0'.repeat(16);
const START = 1_000_000;
const MINUTES = 60_000;

/* The keeper of a machine that keeps a copy, whose link names A as the leader. */
async function copy() {
  const controlDir = mkdtempSync(join(tmpdir(), 'hh-copy-updating-'));
  onTestFinished(() => rmSync(controlDir, { recursive: true, force: true }));
  const { sql } = await createTestSql();
  await sql.query('DELETE FROM net_local.maintenance');
  const said = { leader: A as string | null, now: START, enabled: true };
  const did: string[] = [];
  const lines: string[] = [];
  const maintenance = async () =>
    (await sql.query<{ version: string; until: number }>('SELECT version, (extract(epoch FROM until) * 1000)::float8 AS until FROM net_local.maintenance')).rows;
  const make = () =>
    new CopyUpdating({
      controlDir, sql, leader: () => said.leader, now: () => said.now, log: line => lines.push(line),
      subscription: {
        enabled: async () => said.enabled,
        /* What is written down by the time the subscription stops. */
        disable: async () => void ((said.enabled = false), did.push(`disable, written ${String(readWord(controlDir)?.stopped)}`)),
      },
    });
  const it = make();
  const ask = async (from: string, body: unknown) => {
    const answer = await it.handle(from, body);
    return [answer.status, answer.body];
  };
  const promise = (until = START + 15 * MINUTES) => ({ version: '0.19.0', until, migrations: 2 });
  return { controlDir, sql, it, make, said, did, lines, ask, promise, maintenance, word: () => readWord(controlDir) };
}

describe('a copy during an update of the machine that leads', () => {
  it('promises before it answers', async () => {
    const c = await copy();
    expect([c.it.holds(), c.it.stopped()]).toEqual([false, false]);
    /* Only the machine its link names as the leader is promised anything. */
    expect(await c.ask(C, c.promise())).toEqual([403, { ok: false }]);
    expect([c.word(), await c.maintenance()]).toEqual([null, []]);
    for (const body of [{ version: '0.19.0' }, { until: 5 }, 'x', null, { version: 'a b;c', until: START, migrations: 2 }]) expect((await c.ask(A, body))[0]).toBe(400);
    expect(c.word()).toBeNull();
    /* By the time it answers, the word and the maintenance of its own database are written. */
    const until = START + 15 * MINUTES;
    expect(await c.ask(A, c.promise())).toEqual([200, { ok: true }]);
    expect(c.word()).toEqual({ leader: A, version: '0.19.0', until, migrations: 2, stopped: false, at: START });
    expect(statSync(join(c.controlDir, PROMISE_FILE)).mode & 0o777).toBe(0o600);
    expect(await c.maintenance()).toEqual([{ version: '0.19.0', until }]);
    expect([c.it.holds(), c.it.stopped(), c.lines]).toEqual([true, false, ['The company server is updating to 0.19.0; this copy waits.']]);
    /* A count of migrations that cannot be told is taken as it is. */
    expect((await c.ask(A, { version: '0.19.0', until, migrations: null }))[0]).toBe(200);
    expect(c.word()).toMatchObject({ migrations: null });
  });

  it('stops and ends', async () => {
    const c = await copy();
    /* With no word there is nothing to stop, and nothing to end. */
    expect(await c.ask(A, { stop: true })).toEqual([409, { ok: false }]);
    expect(await c.ask(A, { ended: true })).toEqual([200, { ok: true }]);
    await c.ask(A, c.promise());
    expect(await c.ask(A, { stop: true })).toEqual([200, { ok: true }]);
    expect([c.did, c.word()?.stopped, c.it.stopped()]).toEqual([['disable, written true'], true, true]);
    /* The same word again changes nothing. */
    expect(await c.ask(A, { stop: true })).toEqual([200, { ok: true }]);
    expect(c.did).toHaveLength(1);
    expect(await c.ask(A, { ended: true })).toEqual([200, { ok: true }]);
    expect([c.word(), await c.maintenance(), c.it.holds(), c.it.stopped()]).toEqual([null, [], false, false]);
    expect(c.lines.at(-1)).toBe("The company server's update ended.");
  });

  it('hears the leader that promised', async () => {
    const c = await copy();
    await c.ask(A, c.promise());
    /* The leader is in maintenance, and its hello says it leads no more. */
    c.said.leader = null;
    c.said.now += 5 * MINUTES;
    const later = START + 20 * MINUTES;
    expect(await c.ask(C, c.promise(later))).toEqual([403, { ok: false }]);
    expect(await c.ask(A, c.promise(later))).toEqual([200, { ok: true }]);
    expect([c.word()?.until, (await c.maintenance())[0]?.until, c.lines]).toEqual([later, later, ['The company server is updating to 0.19.0; this copy waits.']]);
    for (const body of [{ stop: true }, { ended: true }]) expect((await c.ask(C, body))[0]).toBe(403);
    expect((await c.ask(A, { stop: true }))[0]).toBe(200);
    /* A renewal keeps the stop. */
    expect((await c.ask(A, c.promise(later + MINUTES)))[0]).toBe(200);
    expect(c.word()).toMatchObject({ stopped: true, until: later + MINUTES });
    expect((await c.ask(A, { ended: true }))[0]).toBe(200);
    expect(c.word()).toBeNull();
    /* With the word gone, a machine its link does not name is promised nothing again. */
    expect((await c.ask(A, c.promise(later)))[0]).toBe(403);
  });

  it('finishes a stop a restart cut', async () => {
    const c = await copy();
    writeFileSync(join(c.controlDir, PROMISE_FILE), JSON.stringify({ leader: A, version: '0.19.0', until: START + 15 * MINUTES, migrations: 2, stopped: true, at: START }));
    const again = c.make();
    expect([again.holds(), again.stopped()]).toEqual([true, true]);
    await again.tick();
    expect(c.did).toEqual(['disable, written true']);
    await again.tick();
    expect(c.did).toHaveLength(1);
    /* A word that was not stopped leaves the subscription alone. */
    const plain = await copy();
    await plain.ask(A, plain.promise());
    await plain.it.tick();
    expect(plain.did).toEqual([]);
  });

  it('lets a promise run out', async () => {
    const c = await copy();
    await c.ask(A, c.promise());
    await c.ask(A, { stop: true });
    c.said.now = START + 15 * MINUTES - 1;
    await c.it.tick();
    expect([c.it.holds(), c.word() === null]).toEqual([true, false]);
    c.said.now += 1;
    expect([c.it.holds(), c.it.stopped()]).toEqual([false, false]);
    await c.it.tick();
    expect([c.word(), await c.maintenance(), existsSync(join(c.controlDir, PROMISE_FILE))]).toEqual([null, [], false]);
    expect(c.lines.at(-1)).toBe("The company server's update promise ran out.");
    /* A file that cannot be read is no word. */
    writeFileSync(join(c.controlDir, PROMISE_FILE), '{');
    expect([readWord(c.controlDir), c.make().holds()]).toEqual([null, false]);
    expect(readFileSync(join(c.controlDir, PROMISE_FILE), 'utf8')).toBe('{');
  });
});
