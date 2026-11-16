import { describe, expect, it } from 'vitest';
import { PhoneOperation } from '../src/phones.js';

describe('the company phone protocol', () => {
  it('accepts a bounded tap and refuses extra commands at the network boundary', () => {
    expect(PhoneOperation.safeParse({ kind: 'tap', x: 120, y: 240 }).success).toBe(true);
    expect(PhoneOperation.safeParse({ kind: 'tap', x: 120, y: 240, command: 'id' }).success).toBe(false);
    expect(PhoneOperation.safeParse({ kind: 'shell', command: 'id' }).success).toBe(false);
    expect(PhoneOperation.safeParse({ kind: 'swipe', x: 0, y: 0, toX: 0, toY: 100, ms: 60_000 }).success).toBe(false);
  });
});
