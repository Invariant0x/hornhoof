import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
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

const editableField = (value: string) => tree('12:00').replace('••••••••', value).replace('password="true"', 'password="false"');
/* A promise to settle from outside, since Promise.withResolvers is newer than the language level the tests compile to. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>(settle => { resolve = settle; });
  return { promise, resolve };
}

/* A fake adb: answers from records and keeps every call our code made. */
function phone(png = SCREEN, serial = SERIAL, baseline: string | ((script: string) => string) = '', input: { firstRead?: () => Promise<void>; readMs?: number[]; fields?: string[]; failure?: boolean; failOn?: string; typingMs?: number; revokeOnType?: boolean; unplugOnType?: boolean } = {}) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-16T12:00:00Z'));
  const calls: AdbCall[] = [];
  let ticks = 0;
  let readStarted = false;
  let reads = 0;
  let unplugged = false;
  const adb = new PhoneAdb(async call => {
    calls.push(call);
    const a = call.args.join(' ');
    if (a === `connect ${serial}`) return Buffer.from(`connected to ${serial}\n`);
    if (a === 'devices -l') return Buffer.from(`List of devices attached\n${unplugged ? '' : `${serial} device model:Pixel_8 transport_id:1\n`}`);
    if (a.endsWith('getprop ro.serialno')) return Buffer.from('R58MIDENTITY\n');
    if (a.endsWith('getprop ro.product.manufacturer')) return Buffer.from('Samsung\n');
    if (a.endsWith('getprop ro.kernel.qemu')) return Buffer.from('0\n');
    if (a.endsWith('uiautomator dump /dev/tty')) {
      if (!readStarted) { readStarted = true; await input.firstRead?.(); }
      // Each field read takes the phone this long on the test's own clock.
      vi.setSystemTime(Date.now() + (input.readMs?.[reads++] ?? 0));
      return Buffer.from(input.fields?.shift() ?? tree(`12:0${ticks++}`));
    }
    if (input.failure && call.input?.includes('input text')) throw new Error('ADB echoed a private value');
    if (input.failOn && call.input?.includes(input.failOn)) throw new Error('ADB echoed a private value');
    if (input.revokeOnType && call.input?.includes('input text')) void phones.handle({ type: 'phone.revoke', requestId: id(9), sessionId: SESSION, generation: 1, binding: grant.binding });
    if (input.unplugOnType && call.input?.includes('input text')) { unplugged = true; throw new Error('device not found'); }
    // Each typing call takes the phone this long on the test's own clock.
    if (input.typingMs && /input text|KEYCODE_ENTER/.test(call.input ?? '')) vi.setSystemTime(Date.now() + input.typingMs);
    if (a.endsWith('screencap -p')) return png;
    if (a.endsWith('pm path com.android.adbkeyboard')) return Buffer.from('package:/data/app/adbkeyboard/base.apk\n');
    if (a.endsWith('shell sh')) return Buffer.from(typeof baseline === 'function' ? baseline(call.input ?? '') : baseline);
    return Buffer.alloc(0);
  });
  const out: (PhoneReply | PhoneFrame)[] = [];
  const phones = new PhoneExecutor({ adb, send: m => out.push(m) });
  const grant: PhoneGrant = { sessionId: SESSION, generation: 1, binding: { phoneId: id(3), serial, hardwareKey: HARDWARE }, expiresAt: '2026-11-16T12:00:30Z' };
  const act = (n: number, operation: Extract<Parameters<PhoneExecutor['handle']>[0], { type: 'phone.action' }>['operation']) =>
    phones.handle({ type: 'phone.action', requestId: id(n), sessionId: SESSION, generation: 1, operation });
  const reply = (n: number) => out.findLast((m): m is PhoneReply => m.type === 'phone.reply' && m.requestId === id(n));
  const shells = () => calls.filter(c => c.args.join(' ') === `-s ${serial} shell`).map(c => c.input);
  return { phones, calls, grant, act, reply, shells, open: () => phones.handle({ type: 'phone.open', requestId: id(5), grant }) };
}

/* Run our readiness script against recorded-style Android answers without a device. */
const brightnessCommands = String.raw`
exec 3>&1
settings() {
  if [ "$1" = --user ]; then shift 2; fi
  case "$1:$3" in
    get:screen_brightness) echo "$HH_TEST_BRIGHTNESS" ;;
    get:screen_brightness_mode) echo "$HH_TEST_BRIGHTNESS_MODE" ;;
    put:screen_brightness) echo "brightness write: $4" >&3; [ "$HH_TEST_REJECT_BRIGHTNESS" = 1 ] || HH_TEST_BRIGHTNESS=$4 ;;
    put:screen_brightness_mode) echo "brightness mode write: $4" >&3; HH_TEST_BRIGHTNESS_MODE=$4 ;;
    get:stay_on_while_plugged_in) echo 7 ;;
    get:screen_off_timeout) echo 2147483647 ;;
    get:sleep_timeout|get:attentive_timeout) echo -1 ;;
    *) echo 0 ;;
  esac
}
dumpsys() {
  case "$1:$2" in
    power:) printf 'mWakefulness=Awake\nadaptive=false\n%s\n' "$HH_TEST_POWER_LIMIT" ;;
    window:) echo 'mCurrentFocus=example.test/.Main' ;;
    deviceidle:whitelist) echo 'system,example.test' ;;
    deviceidle:enabled) echo 0 ;;
    *) return 1 ;;
  esac
}
cmd() {
  case "$*" in
    'overlay lookup android android:integer/config_screenBrightnessSettingMaximum') echo "$HH_TEST_OVERLAY_LIMIT" ;;
    'package query-activities --components --user current -a android.intent.action.MAIN -c android.intent.category.LAUNCHER') echo 'example.test/.Main' ;;
    *) return 1 ;;
  esac
}
locksettings() { echo true; }
pm() { return 1; }
wm() { :; }
`;

afterEach(() => { vi.useRealTimers(); });

describe('phone messages on the execution node', () => {
  it('sets and reads back readiness only on the registered phone and reports what needs attention', async () => {
    const p = phone(SCREEN, SERIAL, 'lock\nbrightness\nready-check-complete\n');
    await p.phones.handle({ type: 'phone.baseline', requestId: id(1), binding: p.grant.binding });
    const check = p.calls.find(c => c.args.join(' ') === `-s ${SERIAL} shell sh`);
    expect(check?.input).toContain('stay_on_while_plugged_in 7');
    expect(check?.input).toContain('screen_off_timeout 2147483647');
    expect(check?.input).toContain('screen_brightness_mode 0');
    expect(check?.input).not.toContain('screen_brightness 0 brightness');
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

  it.each([
    { scenario: 'raises 40 to 102 on a 255 range', max: '255', current: '40', writes: ['brightness write: 102'] },
    { scenario: 'rounds 40% of a 4095 range to 1638', max: '4095', current: '500', writes: ['brightness write: 1638'] },
    { scenario: 'rounds a fractional target up', max: '4097', current: '500', writes: ['brightness write: 1639'] },
    { scenario: 'keeps a higher manual brightness', max: '255', current: '110', writes: [] },
    { scenario: 'keeps brightness at the floor', max: '255', current: '102', writes: [] },
    { scenario: 'keeps manual mode even above the floor', max: '255', current: '180', mode: '1', writes: ['brightness mode write: 0'] },
    { scenario: 'reads the integer Android resource when the power dump has a float', max: '1.0', overlay: '255', current: '30', writes: ['brightness write: 102'] },
    { scenario: 'leaves brightness and mode alone when the maximum is unreadable', max: '1.0', current: '60', mode: '1', writes: [], issues: ['brightness'] },
    { scenario: 'leaves an unreadable current brightness alone', max: '255', current: 'null', writes: [], issues: ['brightness'] },
    { scenario: 'reports a raise the phone did not apply', max: '255', current: '40', reject: true, writes: ['brightness write: 102'], issues: ['brightness'] },
  ])('$scenario', async ({ max, overlay, current, mode, reject, writes, issues }) => {
    let output = '';
    const p = phone(SCREEN, SERIAL, script => {
      const result = spawnSync('sh', [], {
        input: brightnessCommands + script,
        encoding: 'utf8',
        env: {
          ...process.env,
          HH_TEST_POWER_LIMIT: max === '1.0' ? '  mScreenBrightnessMaximum=1.0' : `  mScreenBrightnessSettingMaximum=${max}`,
          HH_TEST_OVERLAY_LIMIT: overlay ?? '',
          HH_TEST_BRIGHTNESS: current,
          HH_TEST_BRIGHTNESS_MODE: mode ?? '0',
          HH_TEST_REJECT_BRIGHTNESS: reject ? '1' : '0',
        },
      });
      expect(result.status, result.stderr).toBe(0);
      output = result.stdout;
      return output;
    });
    await p.phones.handle({ type: 'phone.baseline', requestId: id(1), binding: p.grant.binding });
    expect(output.split('\n').filter(line => /^brightness (mode )?write:/.test(line))).toEqual(writes);
    expect(p.reply(1)).toMatchObject({ status: 'ok', readiness: issues ?? [] });
  });

  it('leaves the phone alone while an agent holds a session', async () => {
    const p = phone();
    await p.open();
    await p.phones.handle({ type: 'phone.baseline', requestId: id(1), binding: p.grant.binding });
    expect(p.reply(1)?.status).toBe('busy');
    expect(p.calls.some(c => c.args.join(' ').endsWith('shell sh'))).toBe(false);
    p.phones.close();
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
    expect(p.shells()).toEqual(['input tap 827 1454\n', "set -e\ninput text 'nora@acme.test'\nsleep 0.06\n", "set -e\ninput text 'Pass%sword%s1079!'\nsleep 0.06\n"]);
    expect(p.reply(6)?.status).toBe('ok');
    // The password went in; the field shows only dots, so the reply says it was not verified without calling it a failure.
    expect(p.reply(8)).toMatchObject({ status: 'ok', typing: { kind: 'typing_unverified' } });
    p.phones.close();
  });

  it('reports input failure without echoing adb output and continues to use the session', async () => {
    const p = phone(Buffer.alloc(0), SERIAL, '', { failure: true });
    await p.open();
    await p.act(6, { kind: 'text', text: 'a private value' });
    expect(p.reply(6)).toMatchObject({ status: 'failed', typing: { kind: 'typing_failed', reason: 'phone_adb_failed', next: 0 } });
    expect(JSON.stringify(p.reply(6))).not.toContain('a private value');
    await p.act(7, { kind: 'capture' });
    expect(p.reply(7)?.status).toBe('ok');
    p.phones.close();
  });

  it.each([
    ['existing ', 'existing one&#10;&#10;two', 'one\r\n\ntwo'],
    ['aba', 'ababa', 'ab'],
  ])('verifies the typed insertion in an existing field', async (before, after, text) => {
    const p = phone(Buffer.alloc(0), SERIAL, '', { fields: [editableField(before), editableField(after)] });
    await p.open();
    await p.act(6, { kind: 'text', text });
    expect(p.reply(6)).toMatchObject({ status: 'ok' });
    expect(p.reply(6)?.typing).toBeUndefined();
    p.phones.close();
  });

  it.each([
    ['What do you want to talk about?', 'Is it?', 'Is it?', undefined],
    ['Write a comment', 'Wow', 'Wow', undefined],
    ['Search', 'Searching', 'Searching', undefined],
    ['What do you want to talk about?', 'Is t?', 'Is it?', [{ start: 3, count: 1 }]],
  ])('compares the whole field with the typed text when an empty field showed its hint "%s"', async (hint, after, text, missing) => {
    const p = phone(Buffer.alloc(0), SERIAL, '', { fields: [editableField(hint), editableField(after)] });
    await p.open();
    await p.act(6, { kind: 'text', text });
    if (missing) expect(p.reply(6)).toMatchObject({ status: 'failed', typing: { kind: 'typing_dropped', missing } });
    else expect(p.reply(6)).toMatchObject({ status: 'ok' });
    if (!missing) expect(p.reply(6)?.typing).toBeUndefined();
    p.phones.close();
  });

  it.each([
    ['', 'typing_unverified', 'ok'],
    ['unexpected', 'typing_mismatch', 'failed'],
  ])('reports the outcome when the readback is "%s"', async (after, kind, status) => {
    const p = phone(Buffer.alloc(0), SERIAL, '', { fields: [editableField(''), editableField(after)] });
    await p.open();
    await p.act(6, { kind: 'text', text: 'intended' });
    expect(p.reply(6)).toMatchObject({ status, typing: { kind } });
    p.phones.close();
  });

  const lines = Array.from({ length: 8 }, (_, n) => `line ${n}`).join('\n');
  const field = (text: string) => editableField(text.replaceAll('\n', '&#10;'));

  it('starts no new typing call once the time is used and says where the rest starts, keeping the session', async () => {
    const p = phone(Buffer.alloc(0), SERIAL, '', { fields: [field(''), field('line 0\nline 1\nline 2\nline 3\n')], typingMs: 5000 });
    await p.open();
    await p.act(6, { kind: 'text', text: lines });
    // Two calls use 10 seconds. A third full batch would consume the time reserved for readback.
    expect(p.reply(6)).toMatchObject({ status: 'partial', typing: { kind: 'typing_partial', next: 28 } });
    expect(p.reply(6)?.typing).toEqual({ kind: 'typing_partial', next: 28 });
    expect(p.shells()).toHaveLength(2);
    expect(lines.slice(28)).toBe('line 4\nline 5\nline 6\nline 7');
    await p.act(7, { kind: 'capture' });
    expect(p.reply(7)?.status).toBe('ok');
    p.phones.close();
  });

  it('ends the capture after a text early enough to make its picture before the reply deadline', async () => {
    const p = phone(SCREEN, SERIAL, '', { fields: [field(''), field('hi')], readMs: [0, 10_000] });
    await p.open();
    await p.act(6, { kind: 'text', text: 'hi' });
    expect(p.reply(6)?.status).toBe('ok');
    expect(p.reply(6)?.capture).toBeTruthy();
    // The read back ends 10 s after receipt; the screenshot must end by 18 - 1.5 s, leaving the picture its time.
    const screenshot = p.calls.findLast(c => c.args.join(' ').endsWith('screencap -p'));
    expect(screenshot?.timeoutMs).toBe(6_500);
    p.phones.close();
  });

  it('answers that typing failed at position 0 before the deadline when an earlier action holds the queue, and never types later', async () => {
    const entered = deferred();
    const blocker = deferred();
    const p = phone(Buffer.alloc(0), SERIAL, '', { firstRead: () => { entered.resolve(); return blocker.promise; } });
    await p.open();
    const capture = p.act(6, { kind: 'capture' });
    await entered.promise;
    const text = p.act(7, { kind: 'text', text: 'still queued' });
    await vi.advanceTimersByTimeAsync(8000);
    await text;
    expect(p.reply(7)).toMatchObject({ status: 'failed', typing: { kind: 'typing_failed', next: 0 } });
    blocker.resolve();
    await capture;
    await vi.advanceTimersByTimeAsync(0);
    expect(p.shells()).toEqual([]);
    expect(p.reply(6)?.status).toBe('ok');
    p.phones.close();
  });

  it('reads the field back after a typing call fails midway and reports where the rest starts', async () => {
    const p = phone(Buffer.alloc(0), SERIAL, '', { fields: [field(''), field('line 0\nline 1\nline 2\n')], failOn: 'line%s2' });
    await p.open();
    await p.act(6, { kind: 'text', text: lines });
    expect(p.reply(6)).toMatchObject({ status: 'failed', typing: { kind: 'typing_failed', reason: 'phone_adb_failed', next: 14, check: { kind: 'typing_mismatch' } } });
    await p.act(7, { kind: 'capture' });
    expect(p.reply(7)?.status).toBe('ok');
    p.phones.close();
  });

  it.each([
    ['the owner takes the phone back', { revokeOnType: true }],
    ['the phone is unplugged', { unplugOnType: true }],
  ])('ends a text action with session_gone when %s while it types', async (_, ending) => {
    const p = phone(Buffer.alloc(0), SERIAL, '', ending);
    await p.open();
    await p.act(6, { kind: 'text', text: 'hello' });
    expect(p.reply(6)).toEqual({ type: 'phone.reply', requestId: id(6), status: 'session_gone' });
    p.phones.close();
  });

  it('reports the offsets of dropped Unicode characters without echoing them', async () => {
    const p = phone(Buffer.alloc(0), SERIAL, '', { fields: [editableField('Prefix: '), editableField('Prefix: a&#10;c')] });
    await p.open();
    await p.act(6, { kind: 'text', text: 'a👋\r\nbc' });
    // Positions count code points of the text as sent, so the b after \r\n is at 4.
    expect(p.reply(6)).toMatchObject({ status: 'failed', typing: { kind: 'typing_dropped', missing: [{ start: 1, count: 1 }, { start: 4, count: 1 }] } });
    const typing = p.reply(6)?.typing;
    expect(JSON.stringify(typing)).not.toContain('👋');
    await p.act(6, { kind: 'text', text: 'a👋\r\nbc' });
    expect(p.reply(6)?.typing).toEqual(typing);
    // Keyboard on, one typing call, the phone's own keyboard back: the repeated request typed nothing again.
    expect(p.shells()).toHaveLength(3);
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
