import { readFileSync } from 'node:fs';
import { APPROVAL_MODES } from '@hornhoof/protocol';
import { describe, expect, it } from 'vitest';

const guide = (name: string) => readFileSync(new URL(`../../../guide/${name}.md`, import.meta.url), 'utf8');
const modes = { every: 'Every one to me', new_kinds: 'Only new kinds', within_limits: 'No approval within limits', none: 'No approval' };

describe('the approval and release guides', () => {
  it('lists each approval mode and explains what happens on an unset channel', () => {
    const section = guide('departments-and-employees').split("## Who owns a department's approvals?")[1]!.split('## ')[0]!;
    const listed = [...section.matchAll(/^- \*\*(.+?)\*\*:/gm)].map(match => match[1]);
    expect(listed).toEqual(APPROVAL_MODES.map(mode => modes[mode]));
    expect(section).toMatch(/A channel with no rule needs no approval/);
  });

  it('follows the department commit rule while keeping exact-commit proof for release', () => {
    const section = guide('tasks-and-turns').split('## Who approves what reaches the main branch?')[1]!;
    expect(section).toMatch(/commit rule says whether.*approval/);
    expect(section).toMatch(/orchestrator acting for the owner/);
    expect(section).toMatch(/repository's own CI must be green on the exact commit/);
    expect(section).toMatch(/head acting for its people/);
  });
});
