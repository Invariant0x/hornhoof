import { describe, expect, it } from 'vitest';
import { selectPlannedVitestSpecs } from './planned-vitest-sequencer.js';

const root = '/fixture root';
const specs = [
  { moduleId: root + '/tests/slow.test.ts', project: 'node' },
  { moduleId: root + '/tests/fast.test.ts', project: 'node' },
  { moduleId: root + '/tests/fast.test.ts', project: 'other-project' },
  { moduleId: root + '/tests/name with spaces.test.ts', project: 'node' },
];

describe('planned Vitest selection', () => {
  it('keeps the assigned slow file intact instead of applying a second count split', () => {
    expect(selectPlannedVitestSpecs(specs, ['./tests/slow.test.ts'], root)).toEqual([specs[0]]);
  });
  it('retains every project variant of an assigned file', () => {
    expect(selectPlannedVitestSpecs(specs, ['tests/fast.test.ts'], root)).toEqual([specs[1], specs[2]]);
  });
  it('preserves a file with spaces and the collected specification objects', () => {
    const selected = selectPlannedVitestSpecs(specs, ['./tests/name with spaces.test.ts'], root);
    expect(selected).toEqual([specs[3]]); expect(selected[0]).toBe(specs[3]);
  });
  it('refuses a selected file which the framework did not collect', () => {
    expect(() => selectPlannedVitestSpecs(specs, ['tests/not-collected.test.ts'], root)).toThrow(/not collected/);
  });
  it.each([undefined, null, {}, [], [''], [7], ['tests/a\0b'], ['/outside.test.ts'], ['../outside.test.ts'], ['C:\\outside.test.ts'], ['tests/slow.test.ts', './tests/slow.test.ts']].map(selected => ({ selected })))('refuses an invalid or duplicate selection: $selected', ({ selected }) => {
    expect(() => selectPlannedVitestSpecs(specs, selected, root)).toThrow(/selection/);
  });
});
