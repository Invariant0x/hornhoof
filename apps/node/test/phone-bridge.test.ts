import { expect, it } from 'vitest';
import type { PhoneGrant } from '@hornhoof/protocol';
import { PhoneAdb, type AdbCall } from '../src/phones/adb.js';
import { UsbHost } from '../src/phones/usb-host.js';
import { createHash } from 'node:crypto';

const SERIAL = 'R58MIDENTITY';
const hardwareKey = createHash('sha256').update('android:samsung:R58MIDENTITY').digest('hex');
const grant = (): PhoneGrant => ({ sessionId: '11111111-1111-4111-8111-111111111111', generation: 3, expiresAt: new Date(Date.now() + 30_000).toISOString(), binding: { phoneId: '22222222-2222-4222-8222-222222222222', serial: SERIAL, hardwareKey, transport: 'usb', endpoint: null } });

function fixture(allow = true) {
  const calls: AdbCall[] = [];
  const authorization: unknown[] = [];
  const replies: unknown[] = [];
  const adb = new PhoneAdb(async call => {
    calls.push(call);
    return Buffer.from(call.args.at(-1) === 'ro.serialno' ? `${SERIAL}\n` : call.args.at(-1) === 'ro.product.manufacturer' ? 'Samsung\n' : '0\n');
  });
  const host = new UsbHost({ adb, authorize: async input => { authorization.push(input); return allow; }, send: reply => { replies.push(reply); } });
  return { host, calls, authorization, replies };
}

it('accepts only a bound allowlisted USB operation and passes the agent\'s text to adb', async () => {
  const f = fixture();
  await f.host.receive({ type: 'request', id: 'request-1', grant: grant(), operation: { kind: 'act', serial: SERIAL, action: { kind: 'text', text: 'BridgeMarker1079' } } });
  expect(f.calls.find(c => c.input)?.input).toBe("input text 'BridgeMarker1079'\n");
  expect(f.replies).toEqual([{ type: 'reply', id: 'request-1', status: 'ok', value: null }]);
  f.host.close();
});

it('rejects arbitrary shell, foreign serial, missing grant and server refusal before starting adb', async () => {
  const f = fixture();
  for (const operation of [{ kind: 'shell', command: 'id' }, { kind: 'act', serial: 'OTHER', action: { kind: 'tap', x: 1, y: 1 } }, { kind: 'tap', serial: SERIAL, x: 1, y: 1 }]) {
    await f.host.receive({ type: 'request', id: 'invalid', grant: grant(), operation });
  }
  await f.host.receive({ type: 'request', id: 'missing-grant', grant: null, operation: { kind: 'act', serial: SERIAL, action: { kind: 'tap', x: 1, y: 1 } } });
  expect(f.replies.at(-1)).toMatchObject({ status: 'denied' });
  expect(f.calls).toHaveLength(0);
  f.host.close();
  const g = fixture(false);
  await g.host.receive({ type: 'request', id: 'denied', grant: grant(), operation: { kind: 'act', serial: SERIAL, action: { kind: 'tap', x: 1, y: 1 } } });
  expect(g.replies.at(-1)).toMatchObject({ status: 'denied' });
  expect(g.calls).toHaveLength(0); g.host.close();
});

it('acknowledges cancel and a Stop barrier only after the old input has drained', async () => {
  let started: () => void = () => {};
  const running = new Promise<void>(resolve => { started = resolve; });
  let finish: () => void = () => {};
  const drained = new Promise<void>(resolve => { finish = resolve; });
  let inputSignal: AbortSignal | null = null;
  const replies: unknown[] = [];
  const host = new UsbHost({ adb: new PhoneAdb(async call => {
    if (call.input) { inputSignal = call.signal; started(); await drained; return Buffer.alloc(0); }
    return Buffer.from(call.args.at(-1) === 'ro.serialno' ? `${SERIAL}\n` : call.args.at(-1) === 'ro.product.manufacturer' ? 'Samsung\n' : '0\n');
  }), authorize: async () => true, send: reply => replies.push(reply) });
  const work = host.receive({ type: 'request', id: 'input', grant: grant(), operation: { kind: 'act', serial: SERIAL, action: { kind: 'text', text: 'Marker1079' } } });
  await running;
  const cancel = host.receive({ type: 'cancel', id: 'input' });
  const barrier = host.receive({ type: 'request', id: 'stop', grant: { ...grant(), generation: 4 }, operation: { kind: 'drain', serial: SERIAL } });
  expect(inputSignal!.aborted).toBe(true);
  expect(replies).toHaveLength(0);
  finish(); await Promise.all([work, cancel, barrier]);
  expect(replies).toEqual([{ type: 'reply', id: 'input', status: 'cancelled', value: null }, { type: 'reply', id: 'stop', status: 'ok', value: null }]);
  host.close(); await host.drained();
});
