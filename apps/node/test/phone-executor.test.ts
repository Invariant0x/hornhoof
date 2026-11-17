import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PhoneFrame, PhoneGrant, PhoneReply } from '@hornhoof/protocol';
import { PhoneAdb, type AdbCall } from '../src/phones/adb.js';
import { PhoneExecutor } from '../src/phones/executor.js';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';

const SERIAL = '192.168.1.80:5555';
const SESSION = '22222222-2222-4222-8222-222222222222';
const id = (n: number) => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
const HARDWARE = createHash('sha256').update('android:samsung:R58MIDENTITY').digest('hex');
// A 1080x2400 screencap, plain or a photo's noise, and a UIAutomator tree; the phone itself shows the typed password as dots.
const screencap = (noise: boolean) => {
  const screen = new PNG({ width: 1080, height: 2400 });
  for (let i = 0; i < screen.data.length; i++) screen.data[i] = noise ? Math.imul(i, 2654435761) >>> 24 : 255;
  return PNG.sync.write(screen);
};
const SCREEN = screencap(false);
const PHOTO = screencap(true);
const tree = (clock: string) => `<?xml version="1.0" encoding="UTF-8"?><hierarchy rotation="0"><node text="${clock}" content-desc="" resource-id="clock" class="android.widget.TextView" package="com.linkedin.android" password="false" focused="false" bounds="[0,0][1080,80]"/><node text="••••••••" content-desc="" resource-id="password" class="android.widget.EditText" package="com.linkedin.android" password="true" focused="true" bounds="[40,900][1040,1000]"/></hierarchy>`;

/* A fake adb: answers from records and keeps every call our code made. */
function phone(png = SCREEN, serial = SERIAL, baseline = '') {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-16T12:00:00Z'));
  const calls: AdbCall[] = [];
  let ticks = 0;
  const adb = new PhoneAdb(async call => {
    calls.push(call);
    const a = call.args.join(' ');
    if (a === `connect ${serial}`) return Buffer.from(`connected to ${serial}\n`);
    if (a === 'devices -l') return Buffer.from(`List of devices attached\n${serial} device model:Pixel_8 transport_id:1\n`);
    if (a.endsWith('getprop ro.serialno')) return Buffer.from('R58MIDENTITY\n');
    if (a.endsWith('getprop ro.product.manufacturer')) return Buffer.from('Samsung\n');
    if (a.endsWith('getprop ro.kernel.qemu')) return Buffer.from('0\n');
    if (a.endsWith('uiautomator dump /dev/tty')) return Buffer.from(tree(`12:0${ticks++}`));
    if (a.endsWith('screencap -p')) return png;
    if (a.endsWith('shell sh')) return Buffer.from(baseline);
    return Buffer.alloc(0);
  });
  const out: (PhoneReply | PhoneFrame)[] = [];
  const phones = new PhoneExecutor({ adb, send: m => out.push(m) });
  const grant: PhoneGrant = { sessionId: SESSION, generation: 1, binding: { phoneId: id(3), serial, hardwareKey: HARDWARE }, expiresAt: '2026-11-16T12:00:30Z' };
  const act = (n: number, operation: Extract<Parameters<PhoneExecutor['handle']>[0], { type: 'phone.action' }>['operation']) =>
    phones.handle({ type: 'phone.action', requestId: id(n), sessionId: SESSION, generation: 1, operation });
  const reply = (n: number) => out.find((m): m is PhoneReply => m.type === 'phone.reply' && m.requestId === id(n));
  const shells = () => calls.filter(c => c.args.join(' ') === `-s ${serial} shell`).map(c => c.input);
  return { phones, calls, grant, act, reply, shells, open: () => phones.handle({ type: 'phone.open', requestId: id(5), grant }) };
}

afterEach(() => { vi.useRealTimers(); });

describe('phone messages on the execution node', () => {
  it('sets and reads back readiness only on the registered phone and reports what needs attention', async () => {
    const p = phone(SCREEN, SERIAL, 'lock\nbrightness\nready-check-complete\n');
    await p.phones.handle({ type: 'phone.baseline', requestId: id(1), binding: p.grant.binding });
    const check = p.calls.find(c => c.args.join(' ') === `-s ${SERIAL} shell sh`);
    expect(check?.input).toContain('stay_on_while_plugged_in 7');
    expect(check?.input).toContain('screen_off_timeout 2147483647');
    expect(check?.input).toContain('screen_brightness_mode 0');
    expect(check?.input).toContain('settings --user current get');
    expect(check?.input).toContain('locksettings get-disabled');
    expect(check?.input).toContain('locksettings set-disabled true');
    expect(check?.input).toContain('dumpsys deviceidle disable');
    expect(check?.input).toContain('dumpsys deviceidle enabled deep');
    expect(check?.input).toContain('dumpsys deviceidle whitelist');
    expect(check?.input).toContain('cmd power set-mode 0');
    expect(check?.input).toContain('adaptive_battery_management_enabled 0');
    expect(check?.input).toContain('app_standby_enabled 0');
    expect(check?.input).toContain('adb_allowed_connection_time 0');
    expect(p.reply(1)).toMatchObject({ status: 'ok', readiness: ['lock', 'brightness'] });
    await p.phones.handle({ type: 'phone.baseline', requestId: id(2), binding: { ...p.grant.binding, hardwareKey: 'b'.repeat(64) } });
    expect(p.reply(2)?.status).toBe('needs_person');
    expect(p.calls.filter(c => c.args.join(' ').endsWith('shell sh'))).toHaveLength(1);
  });

  it('reports a failed check when adb returns no complete readback after the restart', async () => {
    const p = phone(SCREEN, 'ZF525LRDQS', 'lock\n');
    const binding = { ...p.grant.binding };
    await p.phones.handle({ type: 'phone.baseline', requestId: id(1), binding });
    expect(p.reply(1)).toMatchObject({ status: 'ok', readiness: ['check'] });
    expect(p.calls.some(c => c.args[0] === 'connect')).toBe(false);
  });

  it('probes the registered network phone without opening a session', async () => {
    const p = phone();
    await p.phones.handle({ type: 'phone.probe', requestId: id(1), endpoint: SERIAL });
    expect(p.reply(1)).toEqual({ type: 'phone.reply', requestId: id(1), status: 'ok', devices: [{ serial: SERIAL, status: 'device', model: 'Pixel_8', hardwareKey: HARDWARE }] });
  });

  it('reaches a phone plugged by cable into the machine by its serial number, with no address to connect to', async () => {
    const p = phone(SCREEN, 'ZF525LRDQS');
    await p.phones.handle({ type: 'phone.probe', requestId: id(1), endpoint: 'ZF525LRDQS' });
    expect(p.reply(1)).toMatchObject({ status: 'ok', devices: [{ serial: 'ZF525LRDQS', status: 'device', hardwareKey: HARDWARE }] });
    await p.open();
    await p.act(6, { kind: 'key', key: 'home' });
    expect(p.reply(6)?.status).toBe('ok');
    expect(p.shells()).toEqual(['input keyevent KEYCODE_HOME\n']);
    expect(p.calls.some(c => c.args[0] === 'connect')).toBe(false);
    p.phones.close();
  });

  it('sends the agent\'s tap in the phone\'s own pixels and its text, a login and password too, as the agent gave them', async () => {
    const p = phone();
    await p.open();
    await p.act(6, { kind: 'tap', x: 540, y: 950 });
    await p.act(7, { kind: 'text', text: 'nora@acme.test' });
    await p.act(8, { kind: 'text', text: 'Pass word 1079!' });
    expect(p.shells()).toEqual(['input tap 827 1454\n', "input text 'nora@acme.test'\n", "input text 'Pass%sword%s1079!'\n"]);
    expect([p.reply(6)?.status, p.reply(7)?.status, p.reply(8)?.status]).toEqual(['ok', 'ok', 'ok']);
    p.phones.close();
  });

  it('shows the agent a whole screen of a photo as a JPEG of 1568 px on its long side, elements and taps in its pixels', async () => {
    const p = phone(PHOTO);
    await p.open();
    await p.act(6, { kind: 'capture' });
    const capture = p.reply(6)?.capture;
    const picture = jpeg.decode(Buffer.from(capture!.jpeg!, 'base64'));
    expect([picture.width, picture.height, capture?.width, capture?.height]).toEqual([706, 1568, 706, 1568]);
    expect(capture!.jpeg!.length).toBeLessThan(3 * 1024 * 1024);
    expect(capture?.elements[1]).toMatchObject({ text: '••••••••', password: true, focused: true, bounds: [26, 588, 679, 653] });
    await p.act(7, { kind: 'tap', x: 100, y: 200 });
    await p.act(8, { kind: 'swipe', x: 353, y: 1400, toX: 353, toY: 300, ms: 300 });
    expect(p.shells()).toEqual(['input tap 153 306\n', 'input swipe 540 2143 540 459 300\n']);
    p.phones.close();
  });

  it('gives the agent the screen\'s elements when its picture cannot be read', async () => {
    const p = phone(Buffer.from('not a picture'));
    await p.open();
    await p.act(6, { kind: 'capture' });
    const capture = p.reply(6)?.capture;
    expect(capture?.jpeg).toBeNull();
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
