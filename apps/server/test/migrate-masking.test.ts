import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/db/client.js', () => ({
  migrateDb: async () => {
    throw new Error('Failed query', { cause: new Error('could not connect to postgres://hornhoof:s3cret@db:5432/hornhoof') });
  },
}));

describe('the migrate entry point when the driver repeats the database address', () => {
  it('says the reason and keeps the password out of the line', async () => {
    const { runMigrate } = await import('../src/migrate.js');
    const lines: string[] = [];
    const code = await runMigrate({ DATABASE_URL: 'postgres://hornhoof:s3cret@db:5432/hornhoof' }, line => lines.push(line));
    expect(code).toBe(1);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('could not connect to postgres://hornhoof:***@db');
    expect(lines[0]).not.toContain('s3cret');
  });
});
