import { createPrivateKey, generateKeyPairSync } from 'node:crypto';
import { lstatSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { machineKey } from '../src/modules/keeper/machine-keys.js';

const KEY_FILE = 'machine.key';
const folders: string[] = [];

function tempFolder(): string {
  const folder = mkdtempSync(join(tmpdir(), 'hh-machine-key-'));
  folders.push(folder);
  return folder;
}

const modeOf = (path: string): number => statSync(path).mode & 0o777;

afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

describe('machineKey', () => {
  it("makes the machine's key once and keeps it", () => {
    const dir = tempFolder();
    const first = machineKey(dir);
    const second = machineKey(dir);
    expect(modeOf(join(dir, KEY_FILE))).toBe(0o600);
    expect(second.publicPem === first.publicPem).toBe(true);
    expect(second.privatePem === first.privatePem).toBe(true);
    expect(createPrivateKey(first.privatePem).asymmetricKeyType).toBe('ed25519');
  });

  it('stores the private half alone, under its own name', () => {
    const dir = tempFolder();
    machineKey(dir);
    expect(readdirSync(dir)).toEqual([KEY_FILE]);
  });

  it('replaces a file of garbage with a new key', () => {
    const dir = tempFolder();
    const path = join(dir, KEY_FILE);
    writeFileSync(path, 'not a key', { mode: 0o644 });
    const key = machineKey(dir);
    expect(createPrivateKey(key.privatePem).asymmetricKeyType).toBe('ed25519');
    expect(modeOf(path)).toBe(0o600);
    expect(machineKey(dir).publicPem === key.publicPem).toBe(true);
  });

  it('replaces a private key of another kind with a new Ed25519 key', () => {
    const dir = tempFolder();
    const { privateKey } = generateKeyPairSync('ec', {
      namedCurve: 'prime256v1',
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    writeFileSync(join(dir, KEY_FILE), privateKey, { mode: 0o600 });
    expect(createPrivateKey(machineKey(dir).privatePem).asymmetricKeyType).toBe('ed25519');
  });

  it('throws when its folder cannot be written, so that the keeper tries again', () => {
    const notAFolder = join(tempFolder(), 'a-file');
    writeFileSync(notAFolder, '');
    expect(() => machineKey(notAFolder)).toThrow();
  });

  // A link to itself fails to read for every user, root too, and a rename would still replace it.
  it('throws rather than replaces a key file it cannot read', () => {
    const dir = tempFolder();
    symlinkSync(KEY_FILE, join(dir, KEY_FILE));
    expect(() => machineKey(dir)).toThrow(/ELOOP/);
    expect(lstatSync(join(dir, KEY_FILE)).isSymbolicLink()).toBe(true);
  });
});
