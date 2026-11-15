import { describe, expect, it } from 'vitest';
import type { Ctx } from '../src/app.js';
import { grantingSkillOn } from '../src/modules/tools/staff.js';

/* Which skill on a hiring card shows the whole company: one a line turns on beyond its role's own whose template grants
   tools. Only people who see the whole company give one. */

const skill = (id: string, grants: string[] = []) => [id, { id, grants }] as const;
const templates = {
  roles: new Map([
    ['WATCHER', { skills: [{ id: 'watch', on: true }, { id: 'notes', on: true }, { id: 'review', on: false }] }],
    ['WRITER', { skills: [{ id: 'notes', on: true }] }],
  ]),
  skills: new Map([skill('watch', ['agents']), skill('notes'), skill('review', ['failures', 'agents']), skill('reach', ['message_employee'])]),
} as unknown as Ctx['templates'];

describe('a skill on a hiring card that shows the whole company', () => {
  it("is none while every line keeps to its role's own skills, a granting one among them", () => {
    expect(grantingSkillOn(templates, [{ role: 'WATCHER', skills: ['watch', 'notes'] }, { role: 'WRITER', skills: { on: ['notes'], off: [] } }])).toBeNull();
    expect(grantingSkillOn(templates, [])).toBeNull();
  });

  it('is one a line turns on beyond its role, in either form of the line', () => {
    expect(grantingSkillOn(templates, [{ role: 'WATCHER', skills: ['watch', 'review'] }])).toBe('review');
    expect(grantingSkillOn(templates, [{ role: 'WRITER', skills: { on: ['notes', 'watch'], off: [] } }])).toBe('watch');
  });

  it('leaves out skills that grant nothing and skills no template has', () => {
    expect(grantingSkillOn(templates, [{ role: 'WRITER', skills: ['notes', 'missing'] }])).toBeNull();
  });

  it('names the first of them, line by line, and counts every skill of a role it does not know', () => {
    expect(grantingSkillOn(templates, [{ role: 'WRITER', skills: ['notes'] }, { role: 'WRITER', skills: ['reach', 'watch'] }])).toBe('reach');
    expect(grantingSkillOn(templates, [{ role: 'NOBODY', skills: ['notes', 'watch'] }])).toBe('watch');
  });
});
