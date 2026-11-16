import { describe, expect, it } from 'vitest';
import { registerTestTools } from '../src/modules/testruns/tools.js';

function descriptions(): Map<string, string> {
  const found = new Map<string, string>();
  const server = { registerTool: (name: string, config: { description: string }) => { found.set(name, config.description); } };
  registerTestTools(server as unknown as Parameters<typeof registerTestTools>[0], {} as Parameters<typeof registerTestTools>[1], {} as Parameters<typeof registerTestTools>[2]);
  return found;
}

describe('test tool guidance', () => {
  it('leads with whole suites, and says the release branches it runs on as the server refuses the rest', () => {
    const text = descriptions().get('run_tests')!;
    expect(text.split('.')[0]).toMatch(/whole test suite[\s\S]*declared profile[\s\S]*groups[\s\S]*free machines/i);
    expect(text).toMatch(/only on a release branch[^.]*main[^.]*turn-<number>[^.]*release-<name>[^.]*tests_not_release/i);
    expect(text).not.toMatch(/contributors|intermediate gates|never call run_tests|every so many turns/i);
    for (const fact of ['fingerprint', 'main branch', 'returns at once', 'fresh folder', 'woken on the task', 'full log', '{part}', '{parts}', 'hornhoof/tests']) expect(text).toContain(fact);
  });

  /* A release once shipped on a run of the default profile, which left out the database and the browser. */
  it('names the run that checks a release, and that a run without profile checks only the default one', () => {
    const text = descriptions().get('run_tests')!;
    expect(text).toMatch(/without profile[^.]*default profile[^.]*leave suites out/i);
    expect(text).toMatch(/check of a release[^.]*execution\.fullRun\.profile[^.]*no suite and no candidate/i);
    expect(text).toMatch(/every suite and every test file anew/i);
    expect(text).toMatch(/only once the profile it replaces passed on the same pinned commit[^.]*full_run_early/i);
    expect(text).not.toMatch(/run a release's check on the turn's branch/i);
  });
});
