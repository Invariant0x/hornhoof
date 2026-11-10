import { describe, expect, it } from 'vitest';
import { migrateWhenAlone, runMigrate } from '../src/migrate.js';

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
