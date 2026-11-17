import { describe, expect, it } from 'vitest';
import { PhoneEndpoint, PhoneOperation } from '../src/phones.js';

describe('the company phone protocol', () => {
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
});
