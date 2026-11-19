import { describe, expect, it } from 'vitest';
import { registerTestTools } from '../src/modules/testruns/tools.js';

type Config = { description: string; inputSchema?: Record<string, unknown> };

function configs(): Map<string, Config> {
  const found = new Map<string, Config>();
  const server = { registerTool: (name: string, config: Config) => { found.set(name, config); } };
  registerTestTools(server as unknown as Parameters<typeof registerTestTools>[0], {} as Parameters<typeof registerTestTools>[1], {} as Parameters<typeof registerTestTools>[2]);
  return found;
}

describe('test tool guidance', () => {
  it('says where it runs, that a change is checked by local tests, what a later run of a release reuses and what it leaves', () => {
    const { description: text, inputSchema } = configs().get('run_tests')!;
    expect(text).toMatch(/^Runs release checks on main, the repository’s configured main line, a turn branch or a release branch\. Use selected local tests to check a change during a task\./);
    expect(text).toMatch(/A full release run can reuse passing results from the same release with matching reusable evidence\./);
    for (const fact of ['hornhoof/tests', 'pins the commit', 'wakes you', '{part}', '{parts}']) expect(text).toContain(fact);
    expect(text).not.toMatch(/candidate|tests_not_release|full_run_early|every so many turns/i);
    /* The server chooses what a run runs: the caller names no profile and no candidate. */
    expect(Object.keys(inputSchema ?? {}).sort()).toEqual(['branch', 'command', 'minutes', 'parts', 'suite', 'task']);
  });
});
