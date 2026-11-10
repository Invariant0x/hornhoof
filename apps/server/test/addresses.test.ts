import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { ADDRESSES_FILE, isPrivate, ownAddresses } from '../src/modules/keeper/addresses.js';

function control(found?: { at: number; addresses: unknown }): string {
  const dir = mkdtempSync(join(tmpdir(), 'hh-addresses-'));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  if (found) writeFileSync(join(dir, ADDRESSES_FILE), JSON.stringify(found));
  return dir;
}

const NOW = new Date('2031-03-10T12:00:00Z');
const seconds = (at: Date) => Math.floor(at.getTime() / 1000);

describe("a machine's own addresses", () => {
  it('tells a private address from any other', () => {
    for (const address of ['10.0.0.4', '172.16.0.1', '172.31.255.254', '192.168.1.5', '192.0.2.7', '198.51.100.9', '203.0.113.1']) expect(isPrivate(address), address).toBe(true);
    for (const address of ['8.8.8.8', '172.15.0.1', '172.32.0.1', '127.0.0.1', '192.169.0.1', 'fe80::1', '10.0.0', '10.0.0.256', 'localhost', '']) expect(isPrivate(address), address).toBe(false);
  });

  it("takes what the updater found, then the installer's, then what the server saw, each once", () => {
    const dir = control({ at: seconds(NOW) - 60, addresses: ['192.168.1.5', '10.0.0.4'] });
    expect(ownAddresses({ controlDir: dir, env: ['192.168.1.5', '192.168.1.6'], seen: ['172.16.3.2', '10.0.0.4'], now: NOW })).toEqual(['192.168.1.5', '10.0.0.4', '192.168.1.6', '172.16.3.2']);
  });

  it('drops a list that is old, and one it cannot read', () => {
    const old = control({ at: seconds(NOW) - 6 * 60, addresses: ['192.168.1.5'] });
    expect(ownAddresses({ controlDir: old, env: ['10.0.0.9'], seen: [], now: NOW })).toEqual(['10.0.0.9']);
    expect(ownAddresses({ controlDir: control({ at: seconds(NOW), addresses: 'none' }), env: [], seen: ['10.0.0.9'], now: NOW })).toEqual(['10.0.0.9']);
    expect(ownAddresses({ controlDir: control(), env: [], seen: [], now: NOW })).toEqual([]);
  });

  it('keeps private addresses only, never its loopback, and eight at most', () => {
    const dir = control({ at: seconds(NOW), addresses: ['127.0.0.1', '8.8.8.8', 'fe80::1', '192.168.1.5'] });
    expect(ownAddresses({ controlDir: dir, env: ['127.0.0.1', ' 192.168.1.5 ', ''], seen: ['203.0.113.80'], now: NOW })).toEqual(['192.168.1.5', '203.0.113.80']);
    const many = Array.from({ length: 12 }, (_, i) => `10.0.0.${i + 1}`);
    expect(ownAddresses({ controlDir: control(), env: many, seen: [], now: NOW })).toEqual(many.slice(0, 8));
  });
});
