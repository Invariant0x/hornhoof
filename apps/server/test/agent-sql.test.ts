import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { inOneTransaction, openAgentSql, PRE_COMMIT } from '../src/db/agent-sql.js';
import { FakePgClient } from './fake-pg-client.js';

describe("an agent's call", () => {
  const TEXT = 'UPDATE agents SET name = name';

  it('checks the lease after the text and before the commit, in a write', async () => {
    const client = new FakePgClient();
    await inOneTransaction(client.asPg, TEXT, 'write');
    expect(client.sent).toEqual(['BEGIN', TEXT, PRE_COMMIT, 'COMMIT']);
  });

  it('only reads, with nothing of the fence, in a read', async () => {
    const client = new FakePgClient();
    await inOneTransaction(client.asPg, TEXT, 'read');
    expect(client.sent).toEqual(['BEGIN READ ONLY', TEXT, 'COMMIT']);
  });

  it('commits nothing when the text fails', async () => {
    const client = new FakePgClient();
    const failure = new Error('permission denied');
    const answer = inOneTransaction(client.asPg, TEXT, 'write');
    client.answer = { error: failure };
    await expect(answer).rejects.toBe(failure);
    expect(client.sent).toEqual(['BEGIN', TEXT]);
  });

  /* One statement comes back as one result and several as a list, and only what changes rows counts as changed. */
  it("answers each statement's rows and what it changed", async () => {
    const answered = async (result: unknown) => {
      const client = new FakePgClient();
      const answer = inOneTransaction(client.asPg, TEXT, 'read');
      client.answer = { result };
      return answer;
    };
    await expect(answered({ command: 'SELECT', rows: [{ n: 1 }], rowCount: 1 })).resolves.toEqual([{ rows: [{ n: 1 }], changed: 0 }]);
    await expect(answered([{ command: 'SET', rows: [], rowCount: null }, { command: 'UPDATE', rows: [], rowCount: 2 }, { command: 'DELETE', rowCount: null }])).resolves.toEqual([
      { rows: [], changed: 0 },
      { rows: [], changed: 2 },
      { rows: [], changed: 0 },
    ]);
  });
});

describe('openAgentSql', () => {
  it('answers null with a warning when it cannot reach the database, so that the company runs without the tool', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    onTestFinished(() => warn.mockRestore());
    await expect(openAgentSql('postgres://hornhoof@127.0.0.1:1/hornhoof')).resolves.toBeNull();
    expect(warn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('Agents get no database access'));
  });
});
