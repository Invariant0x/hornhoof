import { describe, expect, it } from 'vitest';
import { PhoneServerMessage, type PhoneReply } from '@hornhoof/protocol';
import { PhoneAdb, type AdbCall } from '../src/phones/adb.js';
import { PhoneExecutor } from '../src/phones/executor.js';

const CABLE = 'ZY22CABLE01';
const NETWORK = '192.168.1.80:5555';
const OTHER = 'D6OTHER0001';
const id = (n: number) => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;

/* What `adb devices -l` printed on a machine with a phone on a cable, one by wireless debugging and someone else's phone. */
const RECORDED = {
  present: `List of devices attached\n${CABLE}            device usb:1-1 product:fogos_g model:moto_g35_5G device:fogos transport_id:3\n${NETWORK}      device product:husky model:Pixel_8 device:husky transport_id:4\n${OTHER}            device usb:1-2 product:ELS model:ELS_NX9 device:HWELS transport_id:2\n\n`,
  missing: `List of devices attached\n${OTHER}            device usb:1-2 product:ELS model:ELS_NX9 device:HWELS transport_id:2\n\n`,
  unauthorized: `List of devices attached\n${CABLE}            unauthorized usb:1-1 transport_id:5\n${OTHER}            device usb:1-2 product:ELS model:ELS_NX9 device:HWELS transport_id:2\n\n`,
  offline: `List of devices attached\n${CABLE}            offline usb:1-1 transport_id:5\n${NETWORK}      offline transport_id:4\n\n`,
};

/* A node whose adb prints what the test set last, and keeps every call our code made. */
function node() {
  const calls: AdbCall[] = [];
  let printed = RECORDED.present;
  const adb = new PhoneAdb(async call => {
    calls.push(call);
    return Buffer.from(call.args.join(' ') === 'devices -l' ? printed : '');
  });
  const out: PhoneReply[] = [];
  const phones = new PhoneExecutor({ adb, send: m => { if (m.type === 'phone.reply') out.push(m); } });
  let n = 0;
  const list = async (serials = [CABLE, NETWORK]) => {
    const requestId = id(++n % 10);
    await phones.handle({ type: 'phone.list', requestId, serials });
    return out.findLast(m => m.requestId === requestId);
  };
  return { calls, list, prints: (output: string) => { printed = output; } };
}

describe('the phones the node\'s adb lists now', () => {
  it('takes a list request from the server', () => {
    expect(PhoneServerMessage.safeParse({ type: 'phone.list', requestId: id(1), serials: [CABLE, NETWORK] }).success).toBe(true);
    expect(PhoneServerMessage.safeParse({ type: 'phone.list', requestId: id(1), serials: ['not a serial'] }).success).toBe(false);
  });

  it('tells which of the asked phones adb lists and in what state: there, gone, unauthorized, offline and back again', async () => {
    const n = node();
    expect(await n.list()).toEqual({ type: 'phone.reply', requestId: id(1), status: 'ok', devices: [
      { serial: NETWORK, status: 'device', model: 'Pixel_8' }, { serial: CABLE, status: 'device', model: 'moto_g35_5G' },
    ] });
    n.prints(RECORDED.missing);
    expect(await n.list()).toMatchObject({ status: 'ok', devices: [] });
    n.prints(RECORDED.unauthorized);
    expect(await n.list()).toMatchObject({ status: 'ok', devices: [{ serial: CABLE, status: 'unauthorized', model: null }] });
    n.prints(RECORDED.offline);
    expect(await n.list()).toMatchObject({ status: 'ok', devices: [{ serial: NETWORK, status: 'offline' }, { serial: CABLE, status: 'offline' }] });
    n.prints(RECORDED.present);
    expect(await n.list()).toMatchObject({ status: 'ok', devices: [{ serial: NETWORK, status: 'device' }, { serial: CABLE, status: 'device' }] });
  });

  it('names no phone the server did not ask about', async () => {
    const n = node();
    expect(JSON.stringify(await n.list([CABLE]))).not.toContain(OTHER);
    expect(JSON.stringify(await n.list([CABLE]))).not.toContain(NETWORK);
  });

  it('only reads the list: it connects to no address and asks no phone anything', async () => {
    const n = node();
    await n.list();
    n.prints(RECORDED.missing);
    await n.list();
    expect(n.calls.map(c => c.args.join(' '))).toEqual(['devices -l', 'devices -l']);
  });

  it('answers failed when adb itself cannot list', async () => {
    const phones = new PhoneExecutor({ adb: new PhoneAdb(async () => { throw new Error('adb is not installed'); }), send: m => out.push(m as PhoneReply) });
    const out: PhoneReply[] = [];
    await phones.handle({ type: 'phone.list', requestId: id(7), serials: [CABLE] });
    expect(out).toEqual([{ type: 'phone.reply', requestId: id(7), status: 'failed' }]);
  });
});
