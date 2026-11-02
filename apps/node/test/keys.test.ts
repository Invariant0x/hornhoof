import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { nodeIdentity, seal, unseal } from '../src/keys.js';

const dir = () => mkdtempSync(join(tmpdir(), 'hh-keys-'));
const bytes = new TextEncoder().encode('sk-ant-oat01-secret');

describe("a node's key", () => {
  it('is made once and kept readable by the node alone', async () => {
    const d = dir();
    const first = await nodeIdentity(d);
    const again = await nodeIdentity(d);
    expect(again.recipient).toBe(first.recipient);
    expect(first.recipient).toMatch(/^age1[0-9a-z]{58}$/);
    expect(first.identity).toMatch(/^AGE-SECRET-KEY-1/);
    expect(statSync(join(d, 'node-key')).mode & 0o777).toBe(0o600);
  });

  it('opens what was sealed to it and nothing sealed to another node', async () => {
    const one = await nodeIdentity(dir());
    const two = await nodeIdentity(dir());
    const sealed = await seal(bytes, [one.recipient]);
    expect(sealed).toMatch(/^-----BEGIN AGE ENCRYPTED FILE-----/);
    expect(await unseal(sealed, one.identity)).toEqual(bytes);
    await expect(unseal(sealed, two.identity)).rejects.toThrow();
  });

  it('seals one file that each of several nodes opens', async () => {
    const one = await nodeIdentity(dir());
    const two = await nodeIdentity(dir());
    const sealed = await seal(bytes, [one.recipient, two.recipient]);
    expect(await unseal(sealed, one.identity)).toEqual(bytes);
    expect(await unseal(sealed, two.identity)).toEqual(bytes);
  });
});
