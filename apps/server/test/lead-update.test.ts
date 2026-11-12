import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { LEAD_UPDATE, LeadUpdate, type LeadUpdateOptions } from '../src/modules/keeper/lead-update.js';
import { PROMISE_AGAIN_MS, PROMISE_MS, W_WAIT_MS, type UpdateMemory } from '../src/modules/keeper/update-steps.js';
import { DROPPED_FILE, PROMISED_FILE, SETTLED_FILE } from '../src/modules/updates/control.js';
import { createTestSql, ownDatabases } from './helpers.js';

/* These tests write the maintenance row of a database, which a truncate does not undo. */
ownDatabases();

const C = 'c0'.repeat(16);
const D = 'd0'.repeat(16);
const C_SLOT = 'copy_c0c0c0c0c0c0c0c0_1';
const D_SLOT = 'copy_d0d0d0d0d0d0d0d0_2';
const W = '0/3000000';
const START = 1_000_000;
const HOSTS: Record<string, string> = { [C]: 'laptop', [D]: 'studio' };

function folder(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hh-lead-update-'));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/* The keeper of the machine that leads, with the copies C and D in step, and its updater's status as a test writes it. */
async function leading(over: { memory?: Partial<UpdateMemory>; copies?: string[] } = {}) {
  const [dir, controlDir] = [folder(), folder()];
  const { sql } = await createTestSql();
  await sql.query('DELETE FROM net_local.maintenance');
  const said = {
    now: START, leads: false, maintenance: false, held: false,
    copies: (over.copies ?? [C, D]).map(networkId => ({ name: networkId === C ? C_SLOT : D_SLOT, networkId, state: 'pace' as const })),
    slots: [{ name: C_SLOT, read: true, atW: false }, { name: D_SLOT, read: true, atW: false }],
    /* What each copy answers; none: it says nothing. */
    answers: { [C]: 200, [D]: 200 } as Record<string, number | null>,
  };
  const did: string[] = [];
  const sent: [string, unknown][] = [];
  const lines: string[] = [];
  const opts: LeadUpdateOptions = {
    dir, controlDir, sql,
    sync: { copies: () => said.copies, hold: on => void did.push(`hold ${on}`), held: () => said.held },
    peer: networkId => ({
      request: async (_method, path, body) => {
        expect(path).toBe('/peer/updating');
        sent.push([networkId, body]);
        const status = said.answers[networkId];
        return status == null ? null : { status, body: { ok: status === 200 } };
      },
    }),
    hostname: async networkId => HOSTS[networkId] ?? '',
    leads: () => said.leads, maintenance: () => said.maintenance,
    wal: { position: async () => W, slots: async () => said.slots },
    dropSlots: async () => (did.push('drop slots'), [C_SLOT, D_SLOT]),
    now: () => said.now, log: line => lines.push(line),
  };
  if (over.memory) {
    writeFileSync(join(dir, LEAD_UPDATE), JSON.stringify({
      id: 'u1', version: '0.19.0', migrations: 2, promised: [C, D], promisedAt: START, answered: true, w: null, wAt: null, stopped: false, stopAcks: [], settled: false, dropped: false, ...over.memory,
    }));
  }
  const it = new LeadUpdate(opts);
  const status = (step: string, more: object = {}) =>
    writeFileSync(join(controlDir, 'status.json'), JSON.stringify({ id: 'u1', version: '0.19.0', state: 'running', step, log: '', at: 'now', migrations: 2, restore: false, ...more }));
  const look = async (ms = 250) => {
    said.now += ms;
    await it.look();
  };
  const looks = async (count: number, ms = 250) => {
    for (let n = 0; n < count; n++) await look(ms);
  };
  const file = (name: string) => (existsSync(join(controlDir, name)) ? (JSON.parse(readFileSync(join(controlDir, name), 'utf8')) as unknown) : null);
  const memory = () => (existsSync(join(dir, LEAD_UPDATE)) ? (JSON.parse(readFileSync(join(dir, LEAD_UPDATE), 'utf8')) as UpdateMemory) : null);
  const maintenance = async () => (await sql.query<{ version: string; left: number }>(`SELECT version, round(extract(epoch FROM until - since))::int AS left FROM net_local.maintenance`)).rows;
  const atW = (...names: string[]) => void (said.slots = said.slots.map(slot => ({ ...slot, atW: names.includes(slot.name) })));
  return { dir, controlDir, sql, it, said, did, sent, lines, status, look, looks, file, memory, maintenance, atW };
}

describe('the keeper of the machine that leads during an update', () => {
  it('promises and answers', async () => {
    const u = await leading();
    expect(u.it.busy()).toBe(false);
    await u.looks(2);
    expect(u.sent).toEqual([]);
    u.status('promise');
    expect(u.it.busy()).toBe(true);
    await u.look();
    /* Each copy is told until when the company updates, and how many migrations come. */
    const until = START + 750 + PROMISE_MS;
    expect(u.sent).toEqual([[C, { version: '0.19.0', until, migrations: 2 }], [D, { version: '0.19.0', until, migrations: 2 }]]);
    expect(u.memory()).toMatchObject({ id: 'u1', promised: [C, D], promisedAt: START + 750, answered: false });
    await u.look();
    expect(u.file(PROMISED_FILE)).toEqual({ id: 'u1', ok: true });
    expect(u.memory()).toMatchObject({ answered: true });
    await u.looks(4);
    expect(u.sent).toHaveLength(2);

    /* A copy that says nothing, or does not promise, ends the update before anything changed. */
    const silent = await leading();
    silent.said.answers[D] = null;
    silent.status('promise');
    await silent.looks(2);
    expect(silent.file(PROMISED_FILE)).toEqual({ id: 'u1', ok: false, why: 'studio did not answer' });
    const refused = await leading();
    refused.said.answers[C] = 409;
    refused.status('promise');
    await refused.looks(2);
    expect(refused.file(PROMISED_FILE)).toEqual({ id: 'u1', ok: false, why: 'laptop did not promise to wait' });
    /* With no copy the answer is yes at once. */
    const alone = await leading({ copies: [] });
    alone.status('promise');
    await alone.looks(2);
    expect([alone.sent, alone.file(PROMISED_FILE)]).toEqual([[], { id: 'u1', ok: true }]);
  });

  it('waits for the copies at W, then stops them for migrations', async () => {
    const u = await leading({ memory: {} });
    u.status('backup');
    await u.looks(2);
    /* Not before the lease is in maintenance, and so the app's sessions ended, is W read. */
    expect([u.memory()?.w, await u.maintenance()]).toEqual([null, []]);
    u.said.maintenance = true;
    await u.look();
    expect(u.memory()).toMatchObject({ w: W, wAt: START + 750 });
    expect(await u.maintenance()).toEqual([{ version: '0.19.0', left: PROMISE_MS / 1000 }]);
    /* While a copy does not hold W the updater hears nothing. */
    u.atW(C_SLOT);
    await u.looks(4);
    expect([u.file(SETTLED_FILE), u.sent, u.did]).toEqual([null, [], []]);
    /* Both at W: they are told to stop, and commits wait for none from here on. */
    u.atW(C_SLOT, D_SLOT);
    u.said.answers[D] = null;
    await u.look();
    expect(u.sent).toEqual([[C, { stop: true }], [D, { stop: true }]]);
    expect([u.did, u.memory()?.stopped, u.memory()?.stopAcks]).toEqual([['hold true'], true, [C]]);
    /* One copy did not answer the stop: it is sent again, to that one alone. */
    await u.look();
    expect(u.sent.slice(2)).toEqual([[D, { stop: true }]]);
    expect(u.file(SETTLED_FILE)).toBeNull();
    u.said.answers[D] = 200;
    await u.look();
    expect(u.memory()?.stopAcks).toEqual([C, D]);
    /* Both stopped, and the relay has not stored yet that commits wait for none. */
    await u.looks(2);
    expect(u.file(SETTLED_FILE)).toBeNull();
    u.said.held = true;
    await u.look();
    expect(u.file(SETTLED_FILE)).toEqual({ id: 'u1', ok: true });
    expect(u.memory()).toMatchObject({ settled: true });

    /* With no migration to run nobody is stopped. */
    const plain = await leading({ memory: { migrations: 0 } });
    plain.status('backup', { migrations: 0 });
    plain.said.maintenance = true;
    plain.atW(C_SLOT, D_SLOT);
    await plain.looks(2);
    expect([plain.file(SETTLED_FILE), plain.sent, plain.did]).toEqual([{ id: 'u1', ok: true }, [], []]);
  });

  it('refuses the dump when a copy stays behind', async () => {
    const u = await leading({ memory: {} });
    u.status('backup');
    u.said.maintenance = true;
    await u.look();
    u.atW(C_SLOT);
    u.said.now += W_WAIT_MS - 1000;
    await u.it.look();
    expect(u.file(SETTLED_FILE)).toBeNull();
    await u.look(1000);
    expect(u.file(SETTLED_FILE)).toEqual({ id: 'u1', ok: false, why: 'The copies did not confirm the last changes' });
    /* The same when the relay stays silent after the copies stopped. */
    const quiet = await leading({ memory: {} });
    quiet.status('backup');
    quiet.said.maintenance = true;
    quiet.atW(C_SLOT, D_SLOT);
    await quiet.looks(3);
    expect([quiet.memory()?.stopAcks, quiet.file(SETTLED_FILE)]).toEqual([[C, D], null]);
    await quiet.look(W_WAIT_MS);
    expect(quiet.file(SETTLED_FILE)).toEqual({ id: 'u1', ok: false, why: 'The copies did not confirm the last changes' });
  });

  it('drops the slots before a restore', async () => {
    const u = await leading({ memory: { w: W, wAt: START, stopped: true, stopAcks: [C, D], settled: true } });
    /* A keeper that starts in the middle of an update holds sync off before anything else. */
    expect(u.did).toEqual(['hold true']);
    u.status('rollback');
    await u.looks(2);
    expect([u.file(DROPPED_FILE), u.sent]).toEqual([null, []]);
    u.status('rollback', { restore: true });
    await u.look();
    expect(u.sent).toEqual([[C, { stop: true }], [D, { stop: true }]]);
    expect(u.did).toEqual(['hold true', 'hold true', 'drop slots']);
    expect(u.file(DROPPED_FILE)).toEqual({ id: 'u1', ok: true });
    expect(u.memory()).toMatchObject({ dropped: true });
    await u.looks(3);
    expect(u.did.filter(one => one === 'drop slots')).toHaveLength(1);
  });

  it('ends only once it leads', async () => {
    const u = await leading({ memory: { w: W, wAt: START, stopped: true, stopAcks: [C, D], settled: true } });
    await u.sql.query(`INSERT INTO net_local.maintenance (version, since, until) VALUES ('0.19.0', now(), now() + interval '15 minutes')`);
    for (const name of [PROMISED_FILE, SETTLED_FILE, DROPPED_FILE]) writeFileSync(join(u.controlDir, name), JSON.stringify({ id: 'u1', ok: true }));
    u.status('finished', { state: 'rolled_back' });
    await u.looks(3);
    expect([await u.maintenance(), u.sent, u.it.busy()]).toEqual([[{ version: '0.19.0', left: 900 }], [], true]);
    u.said.leads = true;
    await u.look();
    expect(await u.maintenance()).toEqual([]);
    expect(u.sent).toEqual([[C, { ended: true }], [D, { ended: true }]]);
    expect(u.did).toEqual(['hold true', 'hold false']);
    expect([u.memory(), u.file(PROMISED_FILE), u.file(SETTLED_FILE), u.file(DROPPED_FILE), u.it.busy()]).toEqual([null, null, null, null, false]);
    /* The files of another update are not this one's to remove. */
    const other = await leading({ memory: {} });
    writeFileSync(join(other.controlDir, PROMISED_FILE), JSON.stringify({ id: 'u2', ok: true }));
    other.said.leads = true;
    await other.look();
    expect([other.memory(), other.file(PROMISED_FILE)]).toEqual([null, { id: 'u2', ok: true }]);
  });

  it('promises again while the update runs', async () => {
    const u = await leading({ memory: { w: W, wAt: START, settled: true } });
    await u.sql.query(`INSERT INTO net_local.maintenance (version, since, until) VALUES ('0.19.0', to_timestamp(${START / 1000}), to_timestamp(${(START + PROMISE_MS) / 1000}))`);
    u.status('install');
    u.said.answers[D] = null;
    await u.looks(4);
    expect(u.sent).toEqual([]);
    u.said.now = START + PROMISE_AGAIN_MS - 250;
    await u.look();
    const until = START + PROMISE_AGAIN_MS + PROMISE_MS;
    expect(u.sent).toEqual([[C, { version: '0.19.0', until, migrations: 2 }], [D, { version: '0.19.0', until, migrations: 2 }]]);
    expect(u.memory()).toMatchObject({ promisedAt: START + PROMISE_AGAIN_MS });
    /* The maintenance is told to last as long, and a copy that did not answer is named, nothing more. */
    expect((await u.sql.query<{ until: number }>('SELECT (extract(epoch FROM until) * 1000)::float8 AS until FROM net_local.maintenance')).rows).toEqual([{ until }]);
    expect(u.lines).toEqual(['studio did not answer that it waits for the update.']);
    await u.looks(4);
    expect(u.sent).toHaveLength(2);
  });

  it('goes on after a restart', async () => {
    /* At the dump, with W read: it reads no new W, and settles once the slots reach it. */
    const dumping = await leading({ memory: { w: '0/2000000', wAt: START, migrations: 0 } });
    dumping.status('backup', { migrations: 0 });
    dumping.said.maintenance = true;
    await dumping.looks(2);
    expect([dumping.memory()?.w, dumping.file(SETTLED_FILE)]).toEqual(['0/2000000', null]);
    dumping.atW(C_SLOT, D_SLOT);
    await dumping.look();
    expect(dumping.file(SETTLED_FILE)).toEqual({ id: 'u1', ok: true });
    /* While asking, with nothing answered: the same copies are asked again. */
    const asking = await leading({ memory: { answered: false, promised: [D] } });
    asking.status('promise');
    await asking.looks(2);
    expect([asking.sent.map(([to]) => to), asking.file(PROMISED_FILE)]).toEqual([[D], { id: 'u1', ok: true }]);
    /* Stopped: sync is held off before its first look. */
    const stopped = await leading({ memory: { w: W, wAt: START, stopped: true } });
    expect(stopped.did).toEqual(['hold true']);
  });
});
