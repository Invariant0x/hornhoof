import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { companies, machineOnline, machines, people } from '../src/db/schema.js';
import { hashToken } from '../src/crypto/tokens.js';
import { pickHolders, refreshHolders, sameHome } from '../src/modules/backups/holders.js';
import { bundleRow, recordBundle, type BackupRow } from '../src/modules/backups/records.js';
import { invitePerson, setUpCompany, testApp } from './helpers.js';

const GIB = 1024 ** 3;
const SIZE = GIB;
const NOW = new Date();
const DAY_MS = 86_400_000;
const WEEK = Array.from({ length: 8 }, (_, back) => new Date(NOW.getTime() - back * DAY_MS).toISOString().slice(0, 10));

/* A company whose server is at home on 192.0.2.10, and workers the test places where it wants them. */
async function company() {
  const { app, db } = await testApp();
  const ceo = await setUpCompany(app);
  const [acme] = await db.select().from(companies);
  const [owner] = await db.select().from(people).where(eq(people.isOwner, true));
  const born = new Date(NOW.getTime() - 30 * DAY_MS);
  await db.insert(machines).values({ companyId: acme!.id, personId: owner!.id, machineKey: 'server:x', networkId: hashToken('server'), role: 'data', addresses: ['192.0.2.10'], reportAt: NOW, diskFree: 500 * GIB, createdAt: born });
  let made = 0;
  /* online: the share of each of the last days it was on. Eight days are written and a week is counted, so a share stays
     apart from another only well under the whole. */
  const worker = async (name: string, over: Partial<typeof machines.$inferInsert> & { online?: number } = {}) => {
    const { online = 0.9, ...row } = over;
    const [machine] = await db.insert(machines).values({
      companyId: acme!.id, personId: owner!.id, machineKey: `${name}-${++made}`, hostname: name, networkId: hashToken(`${name}-${made}`), role: 'worker',
      addresses: ['192.0.2.20'], reportAt: NOW, diskFree: 100 * GIB, createdAt: born, ...row,
    }).returning();
    await db.insert(machineOnline).values(WEEK.map(day => ({ machineId: machine!.id, day, seconds: Math.round(86_400 * online) })));
    return machine!.id;
  };
  const pick = (keep: string[] = [], size = SIZE) => pickHolders(db, { size, keep, now: NOW });
  return { app, db, ceo, acme: acme!, owner: owner!, worker, pick };
}

describe('the machines that keep a bundle', () => {
  it('knows which machines share a home', () => {
    expect(sameHome(['192.0.2.10', '10.0.0.4'], ['192.0.2.200'])).toBe(true);
    expect(sameHome(['192.0.2.10'], ['192.0.3.10', '198.51.100.7'])).toBe(false);
    expect(sameHome([], ['192.0.2.10'])).toBe(false);
    expect(sameHome(['not an address'], ['not an address'])).toBe(false);
  });

  it('picks holders at home first, then by online share and disk', async () => {
    const c = await company();
    const home = await c.worker('home', { online: 0.5 });
    const best = await c.worker('best', { addresses: ['198.51.100.7'], online: 0.8 });
    const good = await c.worker('good', { addresses: ['198.51.100.8'], online: 0.7 });
    await c.worker('fourth', { addresses: ['198.51.100.9'], online: 0.4 });
    expect(await c.pick()).toEqual([home, best, good]);
  });

  it('never picks a machine that may not or cannot keep one', async () => {
    const c = await company();
    const fine = await c.worker('fine');
    await c.worker('unticked', { keepsBackups: false });
    await c.worker('silent', { reportAt: new Date(NOW.getTime() - 3 * 60_000) });
    await c.worker('full', { diskFree: Math.floor(2.9 * SIZE) });
    await c.worker('gone', { revokedAt: NOW });
    await c.worker('no-core', { networkId: null, role: null });
    const token = await invitePerson(c.app, c.ceo, { name: 'Dana', email: 'dana@acme.com', access: { whole: true } });
    void token;
    const [dana] = await c.db.select().from(people).where(eq(people.name, 'Dana'));
    await c.worker('of-a-disabled-owner', { personId: dana!.id });
    await c.db.update(people).set({ status: 'disabled' }).where(eq(people.id, dana!.id));
    expect(await c.pick()).toEqual([fine]);
  });

  it('keeps a holder that still qualifies over a better newcomer, and replaces one that fell silent', async () => {
    const c = await company();
    const old = await c.worker('old', { online: 0.3, diskFree: 2 * GIB });
    const [a, b, d] = [await c.worker('a', { online: 0.8 }), await c.worker('b', { online: 0.7 }), await c.worker('d', { online: 0.6 })];
    /* It has too little room for a new bundle and was last heard from an hour ago: it keeps the one it has. */
    await c.db.update(machines).set({ reportAt: new Date(NOW.getTime() - 3_600_000) }).where(eq(machines.id, old));
    expect(await c.pick([old])).toEqual([old, a, b]);
    expect(await c.pick()).toEqual([a, b, d]);

    /* The newest bundles are looked at again: a holder silent for a day gives its place up. */
    const row: BackupRow = {
      v: 1, id: randomUUID(), company: c.acme.id, dumpedAt: NOW.toISOString(), madeAt: NOW.toISOString(), reason: 'timer', size: SIZE, sha256: 'a'.repeat(64),
      recipients: ['age1x'], recovery: 'age1recovery', recoveryLink: null, migrations: 106, signer: randomUUID(), serial: 'ab', head: '', holders: [old, a, b],
    };
    const { v: _v, head: _head, holders, ...manifest } = row;
    void _v;
    void _head;
    await recordBundle(c.db, { ...row, head: JSON.stringify({ manifest: JSON.stringify({ v: 1, ...manifest }), signature: 'x', certPem: 'x' }), holders });
    await refreshHolders(c.db, NOW);
    expect((await bundleRow(c.db, row.id))!.holders).toEqual([old, a, b]);
    await c.db.update(machines).set({ reportAt: new Date(NOW.getTime() - DAY_MS - 60_000) }).where(eq(machines.id, old));
    await refreshHolders(c.db, NOW);
    expect((await bundleRow(c.db, row.id))!.holders).toEqual([a, b, d]);
  });

  it('keeps one place off site', async () => {
    const c = await company();
    const [h1, h2, h3] = [await c.worker('h1', { online: 0.8 }), await c.worker('h2', { online: 0.7 }), await c.worker('h3', { online: 0.6 })];
    /* With nobody off site, all three are at home. */
    expect(await c.pick()).toEqual([h1, h2, h3]);
    const away = await c.worker('away', { addresses: ['198.51.100.7'], online: 0.4 });
    expect(await c.pick()).toEqual([h1, h2, away]);
    /* The three at home hold it already: two of them stay, and the one off site takes the third place. */
    expect(await c.pick([h1, h2, h3])).toEqual([h1, h2, away]);
    /* A holder off site that still qualifies stays over a newcomer off site. */
    const newcomer = await c.worker('newcomer', { addresses: ['203.0.113.9'], online: 0.8 });
    expect(await c.pick([h1, h2, away])).toEqual([h1, h2, away]);
    expect(await c.pick()).toEqual([h1, h2, newcomer]);
  });
});
