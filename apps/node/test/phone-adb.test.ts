import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PhoneAdb, privateAdb, privateAdbEnvironment, type AdbCall } from '../src/phones/adb.js';
import { phoneTextSteps } from '../src/phones/text.js';

describe('the phone adb boundary', () => {
  it('keeps the adb server off TCP and its keys and trace out of agent users', () => {
    const env = privateAdbEnvironment('/data/phone-adb');
    expect(env.ADB_SERVER_SOCKET).toMatch(/^localfilesystem:\/tmp\/hornhoof-adb-[a-f0-9]+\/server$/);
    expect(env.ANDROID_USER_HOME).toBe('/data/phone-adb');
    expect(env.ADB_TRACE).toBe('');
  });
  it('uses the adb server of the machine a phone is plugged into once that machine puts its socket into the node\'s folder', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'phone-adb-'));
    const adb = join(dir, 'adb');
    writeFileSync(adb, '#!/bin/sh\nprintf %s "$ADB_SERVER_SOCKET"\n', { mode: 0o755 });
    const run = privateAdb(adb, join(dir, 'keys'));
    const server = async () => (await run({ args: ['devices'], signal: new AbortController().signal })).toString();
    expect(await server()).toMatch(/^localfilesystem:\/tmp\/hornhoof-adb-[a-f0-9]+\/server$/);
    writeFileSync(join(dir, 'keys', 'host.sock'), '');
    expect(await server()).toBe(`localfilesystem:${join(dir, 'keys', 'host.sock')}`);
  });

  it('pairs with the Android screen code through stdin, never argv or a returned message', async () => {
    const calls: AdbCall[] = [];
    const adb = new PhoneAdb(async call => { calls.push(call); return Buffer.from('Enter pairing code: Successfully paired to 192.168.1.80:37123 [guid=recorded]\n'); });
    await expect(adb.pair('192.168.1.80:37123', '246810', new AbortController().signal)).resolves.toBe('paired');
    expect(calls[0]!.args).toEqual(['pair', '192.168.1.80:37123']);
    expect(calls[0]!.input).toBe('246810\n');
  });

  it('identifies the real device behind its network address without returning its hardware serial', async () => {
    const adb = new PhoneAdb(async call => Buffer.from(call.args.at(-1) === 'ro.serialno' ? 'R58MIDENTITY\n' : call.args.at(-1) === 'ro.product.manufacturer' ? 'Samsung\n' : '0\n'));
    const expected = createHash('sha256').update('android:samsung:R58MIDENTITY').digest('hex');
    await expect(adb.identity('192.168.1.80:5555', new AbortController().signal)).resolves.toBe(expected);
    await expect(adb.identity('emulator-5554', new AbortController().signal)).resolves.toBeNull();
  });
  it('connects only the network endpoint the person registered', async () => {
    const calls: AdbCall[] = [];
    const adb = new PhoneAdb(async call => {
      calls.push(call);
      return Buffer.from('connected to 192.168.1.80:5555\n');
    });
    const signal = new AbortController().signal;
    await expect(adb.connect('192.168.1.80:5555', signal)).resolves.toBe('connected');
    expect(calls.map(({ args }) => args)).toEqual([['connect', '192.168.1.80:5555']]);
    expect(calls[0]!.signal).toBe(signal);
  });

  it('quotes remote shell syntax in the text an agent types and keeps a literal %s', async () => {
    const calls: AdbCall[] = [];
    const adb = new PhoneAdb(async call => { calls.push(call); return Buffer.alloc(0); });
    expect(await adb.type('R58M123', "SECRET_%s_$(echo bad)' end", new AbortController().signal)).toEqual({ next: 26 });
    expect(calls[0]!.args).toEqual(['-s', 'R58M123', 'shell']);
    expect(calls[0]!.input).toBe("set -e\ninput text 'SECRET_%'\ninput text 's_$(echo%sbad)'\\''%send'\nsleep 0.06\n");
  });

  it('types Russian, emoji and new lines through the keyboard app, put on the phone once, and gives the phone its own keyboard back', async () => {
    const calls: AdbCall[] = [];
    let installed = false;
    const own = 'com.huawei.ohos.inputmethod/com.android.inputmethod.HwLatinIME';
    const adb = new PhoneAdb(async call => {
      calls.push(call);
      const a = call.args.join(' ');
      if (a === '-s R58M123 shell pm path com.android.adbkeyboard') return Buffer.from(installed ? 'package:/data/app/adbkeyboard/base.apk\n' : '');
      if (a === '-s R58M123 install -r /keys/adbkeyboard.apk') { installed = true; return Buffer.from('Performing Streamed Install\nSuccess\n'); }
      if (a === '-s R58M123 shell settings get secure default_input_method') return Buffer.from(`${own}\n`);
      return Buffer.alloc(0);
    }, async () => '/keys/adbkeyboard.apk');
    const signal = new AbortController().signal;
    expect(await adb.type('R58M123', 'Привет, мир 👋\nВторая строка', signal)).toEqual({ next: 27 });
    await adb.type('R58M123', 'Еще раз', signal);
    const read = 'settings get secure default_input_method';
    expect(calls.map(c => c.args.join(' '))).toEqual([
      '-s R58M123 shell pm path com.android.adbkeyboard', '-s R58M123 install -r /keys/adbkeyboard.apk', `-s R58M123 shell ${read}`, '-s R58M123 shell', '-s R58M123 shell', '-s R58M123 shell',
      '-s R58M123 shell pm path com.android.adbkeyboard', `-s R58M123 shell ${read}`, '-s R58M123 shell', '-s R58M123 shell', '-s R58M123 shell',
    ]);
    expect(calls[3]!.input).toBe('set -e\nime enable com.android.adbkeyboard/.AdbIME >/dev/null\nime set com.android.adbkeyboard/.AdbIME >/dev/null\nsleep 1\n');
    const first = Buffer.from('Привет, мир 👋').toString('base64');
    const second = Buffer.from('Вторая строка').toString('base64');
    expect(calls[4]!.input).toBe(`set -e\nam broadcast -a ADB_INPUT_B64 --es msg '${first}' >/dev/null\nsleep 0.06\ninput keyevent KEYCODE_ENTER\nsleep 0.06\nam broadcast -a ADB_INPUT_B64 --es msg '${second}' >/dev/null\nsleep 0.06\n`);
    expect(calls[5]!.input).toBe(`ime set '${own}' >/dev/null 2>&1 || ime reset >/dev/null\n`);
  });

  it('gives the phone its own keyboard back after a failed or cancelled typing call, and resets one it cannot name', async () => {
    const calls: AdbCall[] = [];
    const stop = new AbortController();
    const adb = new PhoneAdb(async call => {
      calls.push(call);
      const a = call.args.join(' ');
      if (a.endsWith('pm path com.android.adbkeyboard')) return Buffer.from('package:/data/app/adbkeyboard/base.apk\n');
      if (a.endsWith('settings get secure default_input_method')) return Buffer.from('null\n');
      if (call.input?.includes('ADB_INPUT_B64')) { stop.abort(); throw new Error('adb echoed Привет'); }
      return Buffer.alloc(0);
    });
    expect(await adb.type('R58M123', 'Привет', stop.signal)).toEqual({ next: 0, failure: 'phone_adb_failed' });
    expect(calls.at(-1)!.input).toBe('ime reset >/dev/null\n');
    expect(calls.at(-1)!.signal.aborted).toBe(false);
  });

  it('types a line break, a blank line and CRLF with Enter and never splits an emoji between chunks', async () => {
    const calls: AdbCall[] = [];
    const adb = new PhoneAdb(async call => {
      calls.push(call);
      return Buffer.from(call.args.includes('pm') ? 'package:/data/app/adbkeyboard/base.apk\n' : '');
    });
    const text = '  ' + 'x'.repeat(45) + '👋🏽' + " Привет %s $(echo 'sample')  \r\n\n  last  \n";
    expect(await adb.type('R58M123', text, new AbortController().signal)).toEqual({ next: [...text].length });
    const typing = calls.filter(c => c.input?.includes('ADB_INPUT_B64') || c.input?.includes('KEYCODE_ENTER')).map(c => c.input!).join('');
    const chunks = [...typing.matchAll(/ADB_INPUT_B64 --es msg '([^']+)'/g)].map(match => Buffer.from(match[1]!, 'base64').toString());
    expect(chunks[0]).toBe('  ' + 'x'.repeat(45));
    expect(chunks[1]!.startsWith('👋🏽 Привет')).toBe(true);
    expect(chunks.every(chunk => [...chunk].length <= 48)).toBe(true);
    expect(typing.match(/KEYCODE_ENTER/g)).toHaveLength(3);
    expect(typing).toMatch(/input keyevent KEYCODE_ENTER KEYCODE_ENTER\nsleep 0\.06\nam broadcast/);
  });

  it('types a few steps per call and starts no new call once the time is used, stopping after a whole step', async () => {
    vi.useFakeTimers({ now: 0 });
    onTestFinished(() => { vi.useRealTimers(); });
    const calls: AdbCall[] = [];
    let batchMs = 4_000;
    const adb = new PhoneAdb(async call => {
      calls.push(call);
      vi.setSystemTime(Date.now() + batchMs);
      return Buffer.alloc(0);
    });
    const text = 'a\nb\n\nc\r\nd\ne';
    expect(await adb.type('R58M123', text, new AbortController().signal, 13_000)).toEqual({ next: 10 });
    expect(calls.map(call => call.timeoutMs)).toEqual([6000, 6000]);
    expect(calls.map(c => c.input)).toEqual([
      "set -e\ninput text 'a'\nsleep 0.06\ninput keyevent KEYCODE_ENTER\nsleep 0.06\ninput text 'b'\nsleep 0.06\ninput keyevent KEYCODE_ENTER KEYCODE_ENTER\nsleep 0.06\n",
      "set -e\ninput text 'c'\nsleep 0.06\ninput keyevent KEYCODE_ENTER\nsleep 0.06\ninput text 'd'\nsleep 0.06\ninput keyevent KEYCODE_ENTER\nsleep 0.06\n",
    ]);
    expect([...text].slice(10).join('')).toBe('e');
    batchMs = 1000;
    // 2.5 seconds hold one step of 1.5 seconds: the first call types only 'a'.
    expect(await adb.type('R58M123', text, new AbortController().signal, Date.now() + 2500)).toEqual({ next: 1 });
    expect(calls.at(-1)?.timeoutMs).toBe(2500);
    expect(calls.at(-1)?.input).toBe("set -e\ninput text 'a'\nsleep 0.06\n");
    expect([...text].slice(1).join('')).toBe('\nb\n\nc\r\nd\ne');
    calls.length = 0;
    expect(await adb.type('R58M123', 'a\nb\n', new AbortController().signal)).toEqual({ next: 4 });
    expect(calls).toHaveLength(1);
  });

  it('gives every step of the first call 1.5 seconds and types nothing when not one step fits', async () => {
    vi.useFakeTimers({ now: 0 });
    onTestFinished(() => { vi.useRealTimers(); });
    const calls: AdbCall[] = [];
    const adb = new PhoneAdb(async call => { calls.push(call); return Buffer.alloc(0); });
    expect(await adb.type('R58M123', 'a\nb\n\nc', new AbortController().signal, 3_100)).toEqual({ next: 2 });
    expect(calls.map(call => [call.input, call.timeoutMs])).toEqual([["set -e\ninput text 'a'\nsleep 0.06\ninput keyevent KEYCODE_ENTER\nsleep 0.06\n", 3100]]);
    calls.length = 0;
    expect(await adb.type('R58M123', 'a\nb', new AbortController().signal, 1_400)).toEqual({ next: 0, failure: 'phone_adb_failed' });
    expect(calls).toEqual([]);
  });

  it('leaves a whole step after the keyboard setup and gives the phone its keyboard back by the reply deadline', async () => {
    vi.useFakeTimers({ now: 0 });
    onTestFinished(() => { vi.useRealTimers(); });
    const calls: AdbCall[] = [];
    const adb = new PhoneAdb(async call => {
      calls.push(call);
      if (call.args.includes('pm')) return Buffer.from('package:/data/app/adbkeyboard/base.apk\n');
      if (call.args.includes('settings')) return Buffer.from('com.example.keys/.Ime\n');
      return Buffer.alloc(0);
    });
    // Typing ends by 5 s: the keyboard keeps 1.5 s of it, and the setup leaves one 1.5 s step before that.
    expect(await adb.type('R58M123', 'Привет', new AbortController().signal, 5_000, 9_000)).toEqual({ next: 6 });
    expect(calls.map(call => [call.args.slice(2).join(' '), call.timeoutMs])).toEqual([
      ['shell pm path com.android.adbkeyboard', 2000],
      ['shell settings get secure default_input_method', 2000],
      ['shell', 2000],
      ['shell', 3500],
      ['shell', 9000],
    ]);
    expect(calls.at(-1)?.input).toBe("ime set 'com.example.keys/.Ime' >/dev/null 2>&1 || ime reset >/dev/null\n");
  });

  it('says the keyboard app is unavailable when the phone lacks it and the node has none to install', async () => {
    const calls: AdbCall[] = [];
    const adb = new PhoneAdb(async call => { calls.push(call); return Buffer.alloc(0); });
    expect(await adb.type('R58M123', 'Привет', new AbortController().signal)).toEqual({ next: 0, failure: 'phone_keyboard_unavailable' });
    expect(calls.map(c => c.args.join(' '))).toEqual(['-s R58M123 shell pm path com.android.adbkeyboard']);
  });

  it('reports where the rest starts when a typing call fails midway', async () => {
    const calls: AdbCall[] = [];
    const adb = new PhoneAdb(async call => {
      calls.push(call);
      if (call.input?.includes("'c'")) throw new Error('adb echoed c');
      return Buffer.alloc(0);
    });
    expect(await adb.type('R58M123', 'a\nb\n\nc\r\nd\ne', new AbortController().signal)).toEqual({ next: 5, failure: 'phone_adb_failed' });
    expect(calls).toHaveLength(2);
  });

  it('counts the positions of a text in code points of the text as sent', () => {
    expect(phoneTextSteps('ab\r\n\r\n👋🏽c\rd').map(step => step.end)).toEqual([2, 6, 9, 10, 11]);
    expect(phoneTextSteps('\n'.repeat(48) + 'x'.repeat(48) + '\n' + 'y'.repeat(49))).toEqual([
      { kind: 'enter', count: 48, end: 48 },
      { kind: 'text', text: 'x'.repeat(48), end: 96 },
      { kind: 'enter', count: 1, end: 97 },
      { kind: 'text', text: 'y'.repeat(48), end: 145 },
      { kind: 'text', text: 'y', end: 146 },
    ]);
  });

  it('presses Back and Home as Android key events, as the phone\'s own buttons do', async () => {
    const calls: AdbCall[] = [];
    const adb = new PhoneAdb(async call => { calls.push(call); return Buffer.alloc(0); });
    await adb.act('R58M123', { kind: 'key', key: 'back' }, new AbortController().signal);
    await adb.act('R58M123', { kind: 'key', key: 'home' }, new AbortController().signal);
    expect(calls.map(c => c.input)).toEqual(['input keyevent KEYCODE_BACK\n', 'input keyevent KEYCODE_HOME\n']);
  });

  it('never returns another program\'s error or its echoed output', async () => {
    const adb = new PhoneAdb(async () => { throw new Error('adb echoed SECRET_UNIQUE_MARKER'); });
    await expect(adb.act('R58M123', { kind: 'tap', x: 1, y: 2 }, new AbortController().signal)).rejects.toThrow(/^phone_adb_failed$/);
    await expect(adb.connect('192.168.1.80:5555', new AbortController().signal)).rejects.toThrow(/^phone_adb_failed$/);
  });

  it('rejects arbitrary operations, serial options and unsafe addresses before running adb', async () => {
    const calls: AdbCall[] = [];
    const adb = new PhoneAdb(async call => { calls.push(call); return Buffer.alloc(0); });
    const signal = new AbortController().signal;
    await expect(adb.act('R58M123', { kind: 'shell', command: 'id' }, signal)).rejects.toThrow();
    await expect(adb.act('-s other', { kind: 'tap', x: 1, y: 2 }, signal)).rejects.toThrow();
    await expect(adb.act('R58M123', { kind: 'url', url: 'javascript:alert(1)' }, signal)).rejects.toThrow();
    await expect(adb.connect('phone:5555;id', signal)).rejects.toThrow();
    await expect(adb.type('R58M123', '', signal)).rejects.toThrow();
    await expect(adb.type('-s other', 'text', signal)).rejects.toThrow();
    await expect(adb.act('R58M123', { kind: 'text', text: 'typed by type' }, signal)).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  it('parses a recorded device listing in a stable order and keeps authorization states', async () => {
    const adb = new PhoneAdb(async () => Buffer.from('List of devices attached\nZ88 device product:z model:Pixel_8 device:husky transport_id:1\n192.168.1.80:5555 unauthorized\nA33 offline\n'));
    expect(await adb.devices(new AbortController().signal)).toEqual([
      { serial: '192.168.1.80:5555', status: 'unauthorized', model: null },
      { serial: 'A33', status: 'offline', model: null },
      { serial: 'Z88', status: 'device', model: 'Pixel_8' },
    ]);
  });

  it('passes only validated actions and retains the caller\'s cancellation signal', async () => {
    const calls: AdbCall[] = [];
    const adb = new PhoneAdb(async call => { calls.push(call); return Buffer.alloc(0); });
    const signal = new AbortController().signal;
    await adb.act('R58M123', { kind: 'tap', x: 120, y: 310 }, signal);
    await adb.act('R58M123', { kind: 'swipe', x: 10, y: 400, toX: 20, toY: 50, ms: 300 }, signal);
    await adb.act('R58M123', { kind: 'url', url: 'https://example.com/a?q=one&b=two' }, signal);
    expect(calls.map(c => c.input)).toEqual([
      'input tap 120 310\n', 'input swipe 10 400 20 50 300\n', "am start -a android.intent.action.VIEW -d 'https://example.com/a?q=one&b=two' -p com.android.chrome\n",
    ]);
    expect(calls.every(c => c.signal === signal)).toBe(true);
  });
});
