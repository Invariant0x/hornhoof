import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { TEST_DESCRIPTION_BYTES } from '@hornhoof/protocol';
import { describe, expect, it, onTestFinished } from 'vitest';
import { readPlannedVitestSelection, selectPlannedVitestSpecs } from './planned-vitest-sequencer.js';

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

async function selectionFile(bytes: string | Buffer): Promise<string> {
  const base = join(process.cwd(), '.metrics/run-planning/selection');
  await mkdir(base, { recursive: true });
  const folder = await mkdtemp(join(base, 'case-'));
  onTestFinished(async () => { await rm(folder, { recursive: true, force: true }); });
  const path = join(folder, 'files.json'); await writeFile(path, bytes); return path;
}

describe('node-written planned selection bytes', () => {
  it('reads the real UTF-8 JSON file without changing names with spaces', async () => {
    const path = await selectionFile('["./tests/name with spaces.test.ts"]');
    expect(await readPlannedVitestSelection(path)).toEqual(['./tests/name with spaces.test.ts']);
  });
  it('refuses an absent selection instead of selecting the whole project', async () => {
    await expect(readPlannedVitestSelection(undefined)).rejects.toThrow(/HH_TEST_FILES/);
  });
  it('refuses malformed JSON instead of treating it as an empty selection', async () => {
    const path = await selectionFile('[');
    await expect(readPlannedVitestSelection(path)).rejects.toThrow(SyntaxError);
  });
  it('refuses malformed UTF-8 instead of replacing invalid filename bytes', async () => {
    const path = await selectionFile(Buffer.from([0xff]));
    await expect(readPlannedVitestSelection(path)).rejects.toThrow(TypeError);
  });
  it('refuses oversized valid JSON before parsing its selection', async () => {
    const path = await selectionFile(' '.repeat(TEST_DESCRIPTION_BYTES) + '[]');
    await expect(readPlannedVitestSelection(path)).rejects.toThrow(/byte limit/);
  });
});
