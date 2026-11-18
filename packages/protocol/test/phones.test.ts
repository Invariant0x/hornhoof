import { describe, expect, it } from 'vitest';
import { PhoneEndpoint, PhoneOperation, PhonePairing, PhoneReply, PhoneServerMessage } from '../src/phones.js';

describe('the company phone protocol', () => {
  it('checks the phone binding and carries only known readiness issues', () => {
    const id = '00000000-0000-4000-8000-000000000001';
    const binding = { phoneId: id, serial: 'ZF525LRDQS', hardwareKey: 'a'.repeat(64) };
    expect(PhoneServerMessage.safeParse({ type: 'phone.baseline', requestId: id, binding }).success).toBe(true);
    expect(PhoneServerMessage.safeParse({ type: 'phone.baseline', requestId: id, binding, shell: 'id' }).success).toBe(false);
    expect(PhoneReply.safeParse({ type: 'phone.reply', requestId: id, status: 'ok', readiness: ['lock'] }).success).toBe(true);
    expect(PhoneReply.safeParse({ type: 'phone.reply', requestId: id, status: 'ok', readiness: ['raw adb output'] }).success).toBe(false);
  });
  it('accepts a bounded tap and refuses extra commands at the network boundary', () => {
    expect(PhoneOperation.safeParse({ kind: 'tap', x: 120, y: 240 }).success).toBe(true);
    expect(PhoneOperation.safeParse({ kind: 'tap', x: 120, y: 240, command: 'id' }).success).toBe(false);
    expect(PhoneOperation.safeParse({ kind: 'shell', command: 'id' }).success).toBe(false);
    expect(PhoneOperation.safeParse({ kind: 'swipe', x: 0, y: 0, toX: 0, toY: 100, ms: 60_000 }).success).toBe(false);
  });

  it('presses Back and Home as plain keys and no other key', () => {
    for (const key of ['back', 'home']) expect(PhoneOperation.safeParse({ kind: 'key', key }).success, key).toBe(true);
    expect(PhoneOperation.safeParse({ kind: 'key', key: 'power' }).success).toBe(false);
  });

  it('lets an agent type any text a person types, Russian, emoji and new lines too', () => {
    for (const text of ['Привет, мир 👋', 'Строка один\nстрока два', 'nora@acme.test']) expect(PhoneOperation.safeParse({ kind: 'text', text }).success, text).toBe(true);
    expect(PhoneOperation.safeParse({ kind: 'text', text: '' }).success).toBe(false);
  });
});

describe('a phone address', () => {
  it('is an address on the network as Wireless debugging shows it, never the machine itself or a name inside it', () => {
    for (const ok of ['192.168.1.80:37123', '10.0.0.7:5555', '[2001:db8::5]:5555']) expect(PhoneEndpoint.safeParse(ok).success, ok).toBe(true);
    for (const local of ['127.0.0.1:43117', '127.8.0.1:5555', '0.0.0.0:5555', 'localhost:5555', '[::1]:5555', '[::]:5555', '[::ffff:127.0.0.1]:5555', 'hornhoof-app:3000', 'host.docker.internal:5555', '300.1.1.1:5555', '192.168.1.80:0']) {
      expect(PhoneEndpoint.safeParse(local).success, local).toBe(false);
    }
  });

  it('is also the serial number of a phone plugged by cable into the machine, which adb reaches without connecting anywhere', () => {
    for (const serial of ['ZF525LRDQS', 'R58M123ABC', '0123456789ABCDEF']) expect(PhoneEndpoint.safeParse(serial).success, serial).toBe(true);
    for (const bad of ['', '-s', 'ZF5 25', 'a/b', 'ZF525:5555']) expect(PhoneEndpoint.safeParse(bad).success, bad).toBe(false);
    expect(PhonePairing.safeParse({ endpoint: 'ZF525LRDQS', code: '123456' }).success).toBe(false);
  });
});
