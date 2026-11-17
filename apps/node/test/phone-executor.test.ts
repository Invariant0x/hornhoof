import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PhoneFrame, PhoneGrant, PhoneReply } from '@hornhoof/protocol';
import { PhoneAdb, type AdbCall } from '../src/phones/adb.js';
import { PhoneExecutor } from '../src/phones/executor.js';

const SERIAL = '192.168.1.80:5555';
const SESSION = '22222222-2222-4222-8222-222222222222';
const id = (n: number) => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
const HARDWARE = createHash('sha256').update('android:samsung:R58MIDENTITY').digest('hex');
// A recorded screencap header and UIAutomator tree; the phone itself shows the typed password as dots.
const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a0000000d49484452000004380000096008060000', 'hex'), Buffer.from('recorded pixels')]);
const tree = (clock: string) => `<?xml version="1.0" encoding="UTF-8"?><hierarchy rotation="0"><node text="${clock}" content-desc="" resource-id="clock" class="android.widget.TextView" package="com.linkedin.android" password="false" focused="false" bounds="[0,0][1080,80]"/><node text="••••••••" content-desc="" resource-id="password" class="android.widget.EditText" package="com.linkedin.android" password="true" focused="true" bounds="[40,900][1040,1000]"/></hierarchy>`;

/* A fake adb: answers from records and keeps every call our code made. */
function phone(png = PNG) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-16T12:00:00Z'));
  const calls: AdbCall[] = [];
  let ticks = 0;
  const adb = new PhoneAdb(async call => {
    calls.push(call);
    const a = call.args.join(' ');
    if (a === `connect ${SERIAL}`) return Buffer.from(`connected to ${SERIAL}\n`);
    if (a === 'devices -l') return Buffer.from(`List of devices attached\n${SERIAL} device model:Pixel_8 transport_id:1\n`);
    if (a.endsWith('getprop ro.serialno')) return Buffer.from('R58MIDENTITY\n');
    if (a.endsWith('getprop ro.product.manufacturer')) return Buffer.from('Samsung\n');
    if (a.endsWith('getprop ro.kernel.qemu')) return Buffer.from('0\n');
    if (a.endsWith('uiautomator dump /dev/tty')) return Buffer.from(tree(`12:0${ticks++}`));
    if (a.endsWith('screencap -p')) return png;
    return Buffer.alloc(0);
  });
  const out: (PhoneReply | PhoneFrame)[] = [];
  const phones = new PhoneExecutor({ adb, send: m => out.push(m) });
  const grant: PhoneGrant = { sessionId: SESSION, generation: 1, binding: { phoneId: id(3), serial: SERIAL, hardwareKey: HARDWARE }, expiresAt: '2026-11-16T12:00:30Z' };
  const act = (n: number, operation: Extract<Parameters<PhoneExecutor['handle']>[0], { type: 'phone.action' }>['operation']) =>
    phones.handle({ type: 'phone.action', requestId: id(n), sessionId: SESSION, generation: 1, operation });
  const reply = (n: number) => out.find((m): m is PhoneReply => m.type === 'phone.reply' && m.requestId === id(n));
  const shells = () => calls.filter(c => c.args.join(' ') === `-s ${SERIAL} shell`).map(c => c.input);
  return { phones, calls, grant, act, reply, shells, open: () => phones.handle({ type: 'phone.open', requestId: id(5), grant }) };
}

afterEach(() => { vi.useRealTimers(); });

describe('phone messages on the execution node', () => {
  it('probes the registered network phone without opening a session', async () => {
    const p = phone();
    await p.phones.handle({ type: 'phone.probe', requestId: id(1), endpoint: SERIAL });
    expect(p.reply(1)).toEqual({ type: 'phone.reply', requestId: id(1), status: 'ok', devices: [{ serial: SERIAL, status: 'device', model: 'Pixel_8', hardwareKey: HARDWARE }] });
  });

  it('sends the agent\'s tap and its text, a login and password too, to adb as the agent gave them', async () => {
    const p = phone();
    await p.open();
    await p.act(6, { kind: 'tap', x: 540, y: 950 });
    await p.act(7, { kind: 'text', text: 'nora@acme.test' });
    await p.act(8, { kind: 'text', text: 'Pass word 1079!' });
    expect(p.shells()).toEqual(['input tap 540 950\n', "input text 'nora@acme.test'\n", "input text 'Pass%sword%s1079!'\n"]);
    expect([p.reply(6)?.status, p.reply(7)?.status, p.reply(8)?.status]).toEqual(['ok', 'ok', 'ok']);
    p.phones.close();
  });

  it('shows the agent the screen as the phone shows it, also while it changes', async () => {
    const p = phone();
    await p.open();
    await p.act(6, { kind: 'capture' });
    const capture = p.reply(6)?.capture;
    expect(capture?.png).toBe(PNG.toString('base64'));
    expect([capture?.width, capture?.height]).toEqual([1080, 2400]);
    expect(capture?.elements[1]).toMatchObject({ text: '••••••••', password: true, focused: true, bounds: [40, 900, 1040, 1000] });
    p.phones.close();
  });

  it('shows the agent a whole 1080x2400 screen of a photo, which is about 10 MB as a PNG', async () => {
    const photo = Buffer.concat([PNG, Buffer.alloc(10 * 1024 * 1024)]);
    const p = phone(photo);
    await p.open();
    await p.act(6, { kind: 'capture' });
    expect(p.reply(6)?.capture?.png).toBe(photo.toString('base64'));
    p.phones.close();
  });

  it('gives the agent the screen\'s elements when its picture is larger than a whole screen can be', async () => {
    const p = phone(Buffer.concat([PNG, Buffer.alloc(13 * 1024 * 1024)]));
    await p.open();
    await p.act(6, { kind: 'capture' });
    const capture = p.reply(6)?.capture;
    expect(capture?.png).toBeNull();
    expect(capture?.elements.map(e => e.resource)).toEqual(['clock', 'password']);
    p.phones.close();
  });

  it('runs nothing more on the phone after the session is revoked', async () => {
    const p = phone();
    await p.open();
    await p.phones.handle({ type: 'phone.revoke', requestId: id(6), sessionId: SESSION, generation: 2, binding: p.grant.binding });
    expect(p.reply(6)?.status).toBe('ok');
    await p.act(7, { kind: 'tap', x: 1, y: 2 });
    expect(p.reply(7)?.status).toBe('session_gone');
    expect(p.shells()).toEqual([]);
  });
});
