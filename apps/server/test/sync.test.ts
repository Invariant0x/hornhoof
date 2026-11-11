import { describe, expect, it } from 'vitest';
import { Relay } from '../src/modules/link/relay.js';
import { PACE_FOR_MS } from '../src/modules/keeper/sync-step.js';
import { SyncController, type SyncCatalog } from '../src/modules/keeper/sync.js';
import { fakeRelay } from './fake-relay.js';

const CLIENT = 'acme-ab12cd34-link';
const C = { machine: 'c', networkId: 'c0c0c0c0'.repeat(8), number: 2, copyName: 'copy_c0c0c0c0c0c0c0c0_1', ready: true };

/* The leader's Postgres as far as the controller asks it, as a test sets it, with what was done to it, in order. */
function catalogOf() {
  const state = {
    machines: [C] as { machine: string; networkId: string; number: number | null; copyName: string | null; ready: boolean }[],
    replication: [{ name: C.copyName, confirmed: '0/3000000', pid: 41 as number | null, replyTime: 't0' as string | null, syncState: 'async' as string | null }],
    setting: null as string | null,
    position: '0/3000000',
    oldestWaitMs: null as number | null,
    did: [] as string[],
    pulses: 0,
  };
  const catalog: SyncCatalog = {
    machines: async () => state.machines,
    replication: async () => (state.did.push('look'), state.replication.map(row => ({ ...row }))),
    setting: async () => state.setting,
    position: async () => (state.did.push('position'), state.position),
    oldestWaitMs: async () => state.oldestWaitMs,
    set: async name => {
      state.did.push(`set ${name}`);
      state.setting = name;
    },
    clear: async () => {
      state.did.push('clear');
      state.setting = null;
    },
    checkpoint: async () => void state.did.push('checkpoint'),
    pulse: async () => void (state.pulses += 1),
  };
  return { state, catalog };
}

async function stand(over: { leads?: boolean } = {}) {
  const relay = await fakeRelay();
  relay.bindings.set('acme', { key: 'k'.repeat(32) });
  relay.register('acme', CLIENT);
  const { state, catalog } = catalogOf();
  const clock = { now: 0 };
  const lines: string[] = [];
  const controller = new SyncController({
    catalog,
    relay: new Relay(relay.url),
    link: async () => ({ name: 'acme', key: 'k'.repeat(32), client: CLIENT }),
    dbBytes: () => 0,
    leads: () => over.leads ?? true,
    log: line => lines.push(line),
    now: () => clock.now,
    routeEveryMs: 0,
  });
  /* One look after the clock moved on, with the copy's answer new each time unless the test stops it. */
  const state2 = { answers: true };
  let reply = 0;
  const look = async (ms = 250) => {
    clock.now += ms;
    if (state2.answers) for (const row of state.replication) row.replyTime = `t${++reply}`;
    await controller.look();
  };
  const looks = async (count: number, ms = 250) => {
    for (let n = 0; n < count; n++) await look(ms);
  };
  const record = () => relay.syncs.get('acme') ?? null;
  return { relay, state, controller, clock, lines, look, looks, record, answering: (now: boolean) => void (state2.answers = now) };
}

describe('the sync controller', () => {
  it('leads alone where no other machine holds the data, and asks the relay once', async () => {
    const s = await stand();
    s.state.machines = [];
    await s.looks(4);
    expect(s.controller.flag()).toBe('alone');
    expect(s.controller.renew()).toBe(true);
    expect(s.controller.listed()).toBe(0);
    expect(s.state.did).toEqual([]);
    expect(s.state.pulses).toBe(0);
    expect(s.relay.calls.filter(call => call.includes('/route'))).toHaveLength(1);
    expect(s.relay.calls.some(call => call.includes('/sync'))).toBe(false);
  });

  it('names the copy, then says so at the relay', async () => {
    const s = await stand();
    /* A copy is listed and the relay knows nothing of this generation yet: off is stored first. */
    await s.look();
    expect(s.record()).toMatchObject({ state: 'off', copy: null, epoch: 1 });
    expect(s.controller.flag()).toBeNull();
    await s.look();
    expect(s.controller.flag()).toBe('relay_off');
    /* It must keep pace for half a minute before commits wait for it. */
    await s.looks(Math.ceil(PACE_FOR_MS / 1000) + 3, 1000);
    expect(s.state.setting).toBe(C.copyName);
    expect(s.state.did).toContain(`set ${C.copyName}`);
    expect(s.record()).toMatchObject({ state: 'off' });
    /* The setting holds once Postgres says the copy is the one commits wait for, and a checkpoint ended after that. */
    await s.looks(2);
    expect(s.state.did).not.toContain('checkpoint');
    s.state.replication[0]!.syncState = 'sync';
    s.state.position = '0/5000000';
    await s.looks(2);
    expect(s.controller.flag()).toBe('copy');
    /* The copy does not hold yet what the leader had written then: nothing is said. */
    await s.looks(2);
    expect(s.record()).toMatchObject({ state: 'off' });
    s.state.replication[0]!.confirmed = '0/5000000';
    await s.look();
    expect(s.record()).toMatchObject({ state: 'on', copy: C.networkId, epoch: 2 });
    expect(s.controller.copies()).toEqual([{ name: C.copyName, state: 'sync' }]);
    expect(s.lines).toEqual([]);
    /* It beat the pulse meanwhile, about once a second, and never faster. */
    expect(s.state.pulses).toBeGreaterThan(30);
    expect(s.state.pulses).toBeLessThan(45);
  });

  it('runs the barrier before W', async () => {
    const s = await stand();
    await s.looks(2);
    await s.looks(Math.ceil(PACE_FOR_MS / 1000) + 3, 1000);
    s.state.replication[0]!.syncState = 'sync';
    const from = s.state.did.indexOf(`set ${C.copyName}`);
    await s.looks(3);
    const after = s.state.did.slice(from).filter(what => what !== 'look' || true);
    const checkpoint = after.indexOf('checkpoint');
    const lastPosition = after.lastIndexOf('position');
    /* The setting, a look that shows it holds, the checkpoint, and only then the position that becomes W. */
    expect(after[0]).toBe(`set ${C.copyName}`);
    expect(after.slice(1, checkpoint)).toContain('look');
    expect(checkpoint).toBeGreaterThan(0);
    expect(lastPosition).toBeGreaterThan(checkpoint);
    expect(after.filter(what => what === 'checkpoint')).toHaveLength(1);
  });

  it('never clears before off is stored', async () => {
    const s = await stand();
    await s.looks(2);
    await s.looks(Math.ceil(PACE_FOR_MS / 1000) + 3, 1000);
    s.state.replication[0]!.syncState = 'sync';
    await s.looks(4);
    expect(s.record()).toMatchObject({ state: 'on' });
    /* The copy falls silent, and the relay does not answer. */
    s.answering(false);
    s.relay.down = true;
    await s.looks(12);
    expect(s.state.setting).toBe(C.copyName);
    expect(s.state.did).not.toContain('clear');
    expect(s.controller.flag()).toBe('copy');
    expect(s.lines.filter(line => line.startsWith('Could not tell hornhoof.org'))).toHaveLength(1);
    /* It answers again: off is stored, and only then the setting goes. */
    s.relay.down = false;
    await s.looks(2);
    expect(s.record()).toMatchObject({ state: 'off', epoch: 3 });
    expect(s.state.did.at(-1) === 'clear' || s.state.did.includes('clear')).toBe(true);
    expect(s.state.setting).toBeNull();
    expect(s.controller.flag()).toBe('relay_off');
    expect(s.controller.copies()).toEqual([{ name: C.copyName, state: 'silent' }]);
  });

  it('stops renewing while a commit waits on a copy that cannot be dropped', async () => {
    const s = await stand();
    await s.looks(2);
    await s.looks(Math.ceil(PACE_FOR_MS / 1000) + 3, 1000);
    s.state.replication[0]!.syncState = 'sync';
    await s.looks(4);
    s.answering(false);
    s.relay.down = true;
    s.state.oldestWaitMs = 9_000;
    await s.looks(10);
    expect(s.controller.renew()).toBe(true);
    s.state.oldestWaitMs = 10_000;
    await s.look();
    expect(s.controller.renew()).toBe(false);
    /* The lease ended and took the waiting sessions with it: still not. */
    s.state.oldestWaitMs = null;
    await s.looks(3);
    expect(s.controller.renew()).toBe(false);
    s.relay.down = false;
    await s.looks(2);
    expect(s.controller.renew()).toBe(true);
  });

  it('starts from what it finds', async () => {
    const s = await stand();
    /* A keeper that starts with the copy named and the relay told so. */
    s.state.setting = C.copyName;
    s.state.replication[0]!.syncState = 'sync';
    s.relay.syncs.set('acme', { state: 'on', copy: C.networkId, epoch: 4, generation: 1, at: 100 });
    await s.looks(6);
    /* The barrier ran again, nothing was cleared, and nothing was posted: the relay holds what is true. */
    expect(s.state.did).not.toContain('clear');
    expect(s.state.did.filter(what => what === 'checkpoint')).toHaveLength(1);
    expect(s.state.did.lastIndexOf('position')).toBeGreaterThan(s.state.did.indexOf('checkpoint'));
    expect(s.record()).toMatchObject({ state: 'on', copy: C.networkId, epoch: 4 });
    expect(s.relay.calls.some(call => call.includes('/sync'))).toBe(false);
    expect(s.controller.flag()).toBe('copy');
    /* A copy that has not caught up with where the leader was when the setting took hold is still no reason to clear. */
    const behind = await stand();
    behind.state.setting = C.copyName;
    behind.state.replication[0]!.syncState = 'sync';
    behind.state.replication[0]!.confirmed = '0/1000000';
    behind.relay.syncs.set('acme', { state: 'on', copy: C.networkId, epoch: 4, generation: 1, at: 100 });
    await behind.looks(6);
    expect(behind.state.did).not.toContain('clear');
    expect(behind.controller.flag()).toBe('copy');
  });

  it('times a reply by its own clock', async () => {
    const s = await stand();
    await s.looks(2);
    await s.looks(Math.ceil(PACE_FOR_MS / 1000) + 3, 1000);
    s.state.replication[0]!.syncState = 'sync';
    await s.looks(4);
    expect(s.record()).toMatchObject({ state: 'on' });
    /* The copy's clock is five seconds behind, then five ahead: its answers change each look, and that is all that counts. */
    s.answering(false);
    for (const answer of ['1999-01-01 00:00:00+00', '2099-01-01 00:00:00+00', '1999-01-01 00:00:01+00', '2099-01-01 00:00:01+00']) {
      s.state.replication[0]!.replyTime = answer;
      await s.look(1000);
      expect(s.record()).toMatchObject({ state: 'on' });
    }
    /* The same answer for over two seconds: silent. */
    await s.look(1000);
    expect(s.record()).toMatchObject({ state: 'on' });
    await s.look(1100);
    expect(s.record()).toMatchObject({ state: 'off' });
    /* A new connection starts its clock again: it is not silent for what the old one did not say. */
    s.state.replication[0]!.pid = 42;
    await s.look();
    expect(s.controller.copies()[0]!.state).not.toBe('silent');
  });

  it('writes no pulse where it does not lead', async () => {
    const s = await stand({ leads: false });
    await s.looks(8, 1000);
    expect(s.state.pulses).toBe(0);
  });
});
