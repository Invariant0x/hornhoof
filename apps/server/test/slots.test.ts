import { describe, expect, it } from 'vitest';
import type { Sql } from '../src/modules/keeper/lease-store.js';
import { keepSize, SLOTS_EVERY_MS, sweepSlots, SYNC_SLOT_IDLE_MS } from '../src/modules/keeper/slots.js';

const GIB = 2 ** 30;
const A = `aaaaaaaaaaaaaaaa${'1'.repeat(48)}`;
const B = `bbbbbbbbbbbbbbbb${'2'.repeat(48)}`;
const slotOf = (id: string, attempt: number) => `copy_${id.slice(0, 16)}_${attempt}`;

/* copying: a walsender named after the slot runs, as one does while a table's first copy goes over; it holds no slot
   then, so Postgres lists the slot as read by nobody. */
type Slot = { name: string; active: boolean; pid: number | null; copying?: boolean };

/* The leader's Postgres as far as the sweep asks it: its slots, the machines that hold the data, and what was done. */
function server(slots: Slot[], copies: { networkId: string; copyName: string | null }[], stuck: string[] = []) {
  const did: string[] = [];
  const sql: Sql = {
    query: async <R>(text: string, params: unknown[] = []) => {
      if (text.includes('FROM pg_replication_slots')) return { rows: slots.map(slot => ({ copying: false, ...slot })) as R[] };
      if (text.includes('FROM public.machines')) return { rows: copies as R[] };
      if (text.includes('pg_terminate_backend')) {
        did.push(`end ${String(params[0])}`);
        const slot = slots.find(found => found.pid === params[0]);
        if (slot) Object.assign(slot, { active: false, pid: null });
        return { rows: [] };
      }
      if (text.includes('pg_drop_replication_slot')) {
        if (stuck.includes(String(params[0]))) throw new Error(`replication slot "${String(params[0])}" is active`);
        did.push(`drop ${String(params[0])}`);
        slots.splice(slots.findIndex(found => found.name === params[0]), 1);
        return { rows: [] };
      }
      throw new Error(`The fake does not know: ${text}`);
    },
  };
  return { sql, did, slots };
}

describe("the leader's slots", () => {
  it('keeps a quarter of the free disk for a copy that fell behind, 20 GB at most', () => {
    expect(keepSize(40 * GIB)).toBe(10_240);
    expect(keepSize(200 * GIB)).toBe(20_480);
    expect(keepSize(1000)).toBe(0);
    expect(SLOTS_EVERY_MS).toBe(60_000);
  });

  it('drops the slots nobody will read again', async () => {
    const s = server(
      [
        { name: slotOf(A, 1), active: true, pid: 11 },
        { name: slotOf(A, 2), active: true, pid: 12 },
        { name: slotOf(A, 3), active: false, pid: null },
        { name: 'copy_zzzzzzzzzzzzzzzz_1', active: false, pid: null },
        { name: 'copy_eeeeeeeeeeeeeeee_1', active: true, pid: 13 },
        { name: slotOf(B, 4), active: true, pid: 14 },
        { name: 'somebody_elses', active: false, pid: null },
      ],
      [{ networkId: A, copyName: slotOf(A, 2) }, { networkId: B.toUpperCase(), copyName: null }],
    );
    const lines: string[] = [];
    const dropped = await sweepSlots(s.sql, line => lines.push(line), new Map(), 0);
    /* The attempt A gave up, and the copy of a machine that holds no data any more: its reader is ended first. */
    expect(dropped).toEqual([slotOf(A, 1), 'copy_eeeeeeeeeeeeeeee_1']);
    expect(s.did).toEqual(['end 11', `drop ${slotOf(A, 1)}`, 'end 13', 'drop copy_eeeeeeeeeeeeeeee_1']);
    /* The attempt A named, a later one it has not reported yet, the slot of a machine that named none yet, a name that
       is no copy's and one that is nobody's business stay. */
    expect(s.slots.map(slot => slot.name)).toEqual([slotOf(A, 2), slotOf(A, 3), 'copy_zzzzzzzzzzzzzzzz_1', slotOf(B, 4), 'somebody_elses']);
    expect(lines).toEqual([]);
  });

  it("drops a slot of a table's first copy once nobody read it for ten minutes", async () => {
    const sync = 'pg_16384_sync_16500_7';
    const s = server([{ name: sync, active: true, pid: 21 }, { name: 'pg_16384_sync_16501_7', active: false, pid: null }], []);
    const since = new Map<string, number>();
    const at = (ms: number) => sweepSlots(s.sql, () => undefined, since, ms);
    expect(await at(0)).toEqual([]);
    /* Read now: whatever it waited before counts no more. */
    expect(since.has(sync)).toBe(false);
    s.slots[0]!.active = false;
    s.slots[0]!.pid = null;
    expect(await at(60_000)).toEqual([]);
    expect(await at(9 * 60_000)).toEqual([]);
    expect(await at(SYNC_SLOT_IDLE_MS)).toEqual(['pg_16384_sync_16501_7']);
    /* Read again in between, its ten minutes start over. */
    s.slots[0]!.active = true;
    expect(await at(SYNC_SLOT_IDLE_MS + 30_000)).toEqual([]);
    s.slots[0]!.active = false;
    expect(await at(SYNC_SLOT_IDLE_MS + 60_000)).toEqual([]);
    expect(await at(2 * SYNC_SLOT_IDLE_MS + 60_000)).toEqual([sync]);
    expect(since.size).toBe(0);
  });

  it("keeps a slot of a table's first copy for as long as that copy goes over, though Postgres lists it as read by nobody", async () => {
    const sync = 'pg_16384_sync_16500_7';
    const s = server([{ name: sync, active: false, pid: null, copying: true }], []);
    const since = new Map<string, number>();
    const at = (ms: number) => sweepSlots(s.sql, () => undefined, since, ms);
    /* A big table over a slow link: its rows go over for half an hour. */
    for (let ms = 0; ms <= 3 * SYNC_SLOT_IDLE_MS; ms += SLOTS_EVERY_MS) expect(await at(ms)).toEqual([]);
    expect(since.has(sync)).toBe(false);
    /* Its copy ended without getting through, as when the link was cut: its ten minutes start then. */
    s.slots[0]!.copying = false;
    expect(await at(3 * SYNC_SLOT_IDLE_MS + 60_000)).toEqual([]);
    expect(await at(4 * SYNC_SLOT_IDLE_MS + 60_000)).toEqual([sync]);
  });

  it("drops at its next sweep the slot of a table whose first copy broke off, as its copy named it, and keeps a table's slot that is read", async () => {
    const broken = 'pg_16384_sync_16500_7';
    const catching = 'pg_16384_sync_16501_7';
    const again = 'pg_16384_sync_16502_7';
    const read = 'pg_16384_sync_16503_7';
    const s = server(
      [
        { name: broken, active: false, pid: null },
        /* Its copy is through and it catches up between two starts of its worker: nobody reads it this minute, and its
           copy does not name it. */
        { name: catching, active: false, pid: null },
        /* Named in a report from before its copy started again: its rows go over now. */
        { name: again, active: false, pid: null, copying: true },
        { name: read, active: true, pid: 31 },
      ],
      [],
    );
    const named = [broken, again, read, 'copy_aaaaaaaaaaaaaaaa_1', 'pg_16384_sync_16599_7'];
    const since = new Map<string, number>();
    expect(await sweepSlots(s.sql, () => undefined, since, 0, named)).toEqual([broken]);
    expect(s.did).toEqual([`drop ${broken}`]);
    /* A slot nobody named still goes after its ten minutes, as before. */
    expect(await sweepSlots(s.sql, () => undefined, since, SYNC_SLOT_IDLE_MS - 1, [])).toEqual([]);
    expect(await sweepSlots(s.sql, () => undefined, since, SYNC_SLOT_IDLE_MS, [])).toEqual([catching]);
    expect(s.slots.map(slot => slot.name)).toEqual([again, read]);
  });

  it('says so when a slot will not go, and tries again with the next sweep', async () => {
    const s = server([{ name: slotOf(A, 1), active: true, pid: 11 }], [], [slotOf(A, 1)]);
    const lines: string[] = [];
    expect(await sweepSlots(s.sql, line => lines.push(line), new Map(), 0)).toEqual([]);
    expect(lines).toEqual([`Could not drop the slot ${slotOf(A, 1)} that no copy reads any more: replication slot "${slotOf(A, 1)}" is active`]);
  });
});
