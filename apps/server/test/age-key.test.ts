import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AGE_KEY_FILE, ageKey } from '../src/modules/keeper/age-key.js';

describe("a machine's age key", () => {
  it('is made once and kept, for its keeper alone', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hh-age-'));
    const first = await ageKey(dir);
    expect(first.identity).toMatch(/^AGE-SECRET-KEY-1/);
    expect(first.recipient).toMatch(/^age1/);
    expect(statSync(join(dir, AGE_KEY_FILE)).mode & 0o777).toBe(0o600);
    expect(await ageKey(dir)).toEqual(first);
    expect(readFileSync(join(dir, AGE_KEY_FILE), 'utf8').trim()).toBe(first.identity);
  });

  it('replaces a key that does not decode whole, and says nothing of it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hh-age-'));
    const said = [vi.spyOn(console, 'error'), vi.spyOn(console, 'log'), vi.spyOn(console, 'warn')];
    const first = await ageKey(dir);
    writeFileSync(join(dir, AGE_KEY_FILE), 'garbage\n');
    const second = await ageKey(dir);
    expect(second.identity).not.toBe(first.identity);
    /* One character of it changed: its checksum no longer holds. */
    const broken = second.identity.slice(0, 30) + (second.identity[30] === 'Q' ? 'P' : 'Q') + second.identity.slice(31);
    writeFileSync(join(dir, AGE_KEY_FILE), `${broken}\n`, { mode: 0o644 });
    const third = await ageKey(dir);
    expect([first.identity, second.identity, broken]).not.toContain(third.identity);
    expect(statSync(join(dir, AGE_KEY_FILE)).mode & 0o777).toBe(0o600);
    for (const spy of said) expect(spy).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});
