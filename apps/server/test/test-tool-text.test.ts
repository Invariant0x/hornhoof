import { describe, expect, it } from 'vitest';
import { registerTestTools } from '../src/modules/testruns/tools.js';

function descriptions(): Map<string, string> {
  const found = new Map<string, string>();
  const server = { registerTool: (name: string, config: { description: string }) => { found.set(name, config.description); } };
  registerTestTools(server as unknown as Parameters<typeof registerTestTools>[0], {} as Parameters<typeof registerTestTools>[1], {} as Parameters<typeof registerTestTools>[2]);
  return found;
}

describe('test tool guidance', () => {
  it('says in three sentences where it runs, what each run of a release runs, and what it leaves', () => {
    const text = descriptions().get('run_tests')!;
    expect(text.split('. ')).toHaveLength(3);
    expect(text).toMatch(/only on main, a turn's branch turn-<number> or a release-<name> branch: on any other branch it starts nothing[^.]*local tests of what it touched/i);
    expect(text).toMatch(/first run of a release runs every test file; each later run of the same release runs only what failed or changed/i);
    for (const fact of ['hornhoof/tests', 'pins the commit', 'wakes you', '{part}', '{parts}']) expect(text).toContain(fact);
    expect(text).not.toMatch(/profile|candidate|tests_not_release|full_run_early|every so many turns/i);
  });
});
