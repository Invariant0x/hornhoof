import { describe, expect, it } from 'vitest';
import { registerTestTools } from '../src/modules/testruns/tools.js';

function descriptions(): Map<string, string> {
  const found = new Map<string, string>();
  const server = { registerTool: (name: string, config: { description: string }) => { found.set(name, config.description); } };
  registerTestTools(server as unknown as Parameters<typeof registerTestTools>[0], {} as Parameters<typeof registerTestTools>[1], {} as Parameters<typeof registerTestTools>[2]);
  return found;
}

describe('test tool guidance', () => {
  it('says where it runs, what a run of a release reuses, and what it leaves to local tests', () => {
    const text = descriptions().get('run_tests')!;
    expect(text).toMatch(/^Runs release checks on main, the repository.s configured main line, a turn branch or a release branch\. Use selected local tests to check a change during a task\./);
    expect(text).toMatch(/A full release run can reuse passing results from the same release with matching reusable evidence\. Without that evidence it runs the selected profile\./);
    for (const fact of ['hornhoof/tests', 'pins the commit', 'wakes you', '{part}', '{parts}']) expect(text).toContain(fact);
    expect(text).not.toMatch(/candidate|tests_not_release|full_run_early|every so many turns/i);
  });
});
