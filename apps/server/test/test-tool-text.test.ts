import { describe, expect, it } from 'vitest';
import { registerTestTools } from '../src/modules/testruns/tools.js';

function descriptions(): Map<string, string> {
  const found = new Map<string, string>();
  const server = { registerTool: (name: string, config: { description: string }) => { found.set(name, config.description); } };
  registerTestTools(server as unknown as Parameters<typeof registerTestTools>[0], {} as Parameters<typeof registerTestTools>[1], {} as Parameters<typeof registerTestTools>[2]);
  return found;
}

describe('test tool guidance', () => {
  it('leads with whole suites and keeps checks of a change in the owner workspace', () => {
    const text = descriptions().get('run_tests')!;
    expect(text.split('.')[0]).toMatch(/whole test suite[\s\S]*declared profile[\s\S]*groups[\s\S]*free machines/i);
    expect(text).toMatch(/own change[\s\S]*own workspace[\s\S]*need no run_tests/i);
    for (const fact of ['fingerprint', 'main branch', 'returns at once', 'fresh folder', 'woken on the task', 'full log', '{part}', '{parts}', 'hornhoof/tests']) expect(text).toContain(fact);
  });
});
