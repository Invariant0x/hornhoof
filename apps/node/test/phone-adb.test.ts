import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { PhoneAdb, privateAdbEnvironment, type AdbCall } from '../src/phones/adb.js';

describe('the phone adb boundary', () => {
  it('keeps the adb server off TCP and its keys and trace out of agent users', () => {
    const env = privateAdbEnvironment('/data/phone-adb');
    expect(env.ADB_SERVER_SOCKET).toMatch(/^localfilesystem:\/tmp\/hornhoof-adb-[a-f0-9]+\/server$/);
    expect(env.ANDROID_USER_HOME).toBe('/data/phone-adb');
    expect(env.ADB_TRACE).toBe('');
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
    await adb.act('R58M123', { kind: 'text', text: "SECRET_%s_$(echo bad)' end" }, new AbortController().signal);
    expect(calls[0]!.args).toEqual(['-s', 'R58M123', 'shell']);
    expect(calls[0]!.input).toBe("input text 'SECRET_'\ninput text '%'\ninput text 's_$(echo%sbad)'\\''%send'\n");
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
    await expect(adb.act('R58M123', { kind: 'text', text: 'a\nb' }, signal)).rejects.toThrow();
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
