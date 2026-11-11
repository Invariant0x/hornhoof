import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { migrateOrFollow, migrateWhenAlone, runMigrate } from '../src/migrate.js';

async function migrateWith(env: NodeJS.ProcessEnv) {
  const lines: string[] = [];
  const code = await runMigrate(env, line => lines.push(line));
  return { code, lines };
}

describe('the migrate entry point', () => {
  it('says what is missing without a database address', async () => {
    const { code, lines } = await migrateWith({});
    expect(code).toBe(1);
    expect(lines).toEqual(['DATABASE_URL is not set.']);
  });

  it('fails plainly when the database does not answer, and hides the password', async () => {
    const { code, lines } = await migrateWith({ DATABASE_URL: 'postgres://hornhoof:s3cret@127.0.0.1:1/hornhoof' });
    expect(code).toBe(1);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^Could not bring the database up to this build:/);
    expect(lines[0]).not.toContain('s3cret');
    expect(lines[0]).toContain('ECONNREFUSED');
  });

  it('gives the error code when the driver has no message, as with localhost on two addresses', async () => {
    const { code, lines } = await migrateWith({ DATABASE_URL: 'postgres://hornhoof@localhost:1/hornhoof' });
    expect(code).toBe(1);
    expect(lines[0]).toContain('ECONNREFUSED');
  });
});

describe('the migrate service on a machine that keeps a copy', () => {
  function control(): string {
    const dir = mkdtempSync(join(tmpdir(), 'hh-migrate-'));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
  }

  it("leaves a copy's schema alone", async () => {
    const dir = control();
    const lines: string[] = [];
    let ran = 0;
    const run = async () => void (ran += 1);
    expect(await migrateOrFollow({ HORNHOOF_CONTROL_DIR: dir }, run, line => lines.push(line))).toBe('migrated');
    expect([ran, lines]).toEqual([1, []]);
    writeFileSync(join(dir, 'replica.json'), JSON.stringify({ since: new Date().toISOString() }));
    expect(await migrateOrFollow({ HORNHOOF_CONTROL_DIR: dir }, run, line => lines.push(line))).toBe('follows');
    expect([ran, lines]).toEqual([1, ['This machine keeps a copy; its schema comes from the company server.']]);
  });

  it('ends well without touching the database of a copy', async () => {
    const dir = control();
    writeFileSync(join(dir, 'replica.json'), '{}');
    /* An address nothing answers at: a migration tried there would fail. */
    const { code, lines } = await migrateWith({ DATABASE_URL: 'postgres://hornhoof:s3cret@127.0.0.1:1/hornhoof', HORNHOOF_CONTROL_DIR: dir });
    expect(code).toBe(0);
    expect(lines).toEqual(['This machine keeps a copy; its schema comes from the company server.']);
  });
});

describe('an app that starts with no keeper beside it', () => {
  it('brings the database up itself, and leaves that to the migrate service where a keeper runs', async () => {
    const asked: string[] = [];
    const migrate = async (url: string) => asked.push(url);
    await migrateWhenAlone({ keeper: true }, 'postgres://db/kept', migrate);
    expect(asked).toEqual([]);
    await migrateWhenAlone({ keeper: false }, 'postgres://db/alone', migrate);
    expect(asked).toEqual(['postgres://db/alone']);
  });
});
