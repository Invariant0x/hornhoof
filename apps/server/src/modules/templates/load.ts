import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROLE_EFFORTS, TEMPLATE_KEYS, type RoleEffort, type TemplateKey } from '@hornhoof/protocol';
import { parse } from 'yaml';
import { z } from 'zod';

/* Role and skill templates: the text every employee is hired with. Roles are short, procedures live in skills. */

export type Lang = { en: string; ru: string };
export type SkillKind = 'core' | 'procedure' | 'checklist' | 'gate';
export type Skill = { id: string; title: Lang; description: Lang; kind: SkillKind; body: string; hash: string; sources: string[]; grants: Grant[] };

/* Tools a skill may grant: every agent's state, the failed turns and blocked tasks, and writing to another employee. */
export const GRANTS = ['agents', 'failures', 'message_employee', 'restart_program', 'improvements'] as const;
export type Grant = (typeof GRANTS)[number];
export type RoleSkill = { id: string; on: boolean; locked: boolean };
/* How often, in minutes, an employee may wake on its timer, and how long its order may be; a role's timer keeps to them too. */
export const TIMER_MIN = 5;
export const TIMER_MAX = 1440;
export const TIMER_ORDER_MAX = 2000;
export type RoleTimer = { minutes: number; order: string; forWork: boolean };
export const GateTriggers = z.object({
  riskClasses: z.array(z.enum(['money', 'access', 'security', 'data'])),
  paths: z.array(z.string().min(1)),
  diffPatterns: z.array(z.enum(['route', 'sql', 'subprocess'])),
  beforeRelease: z.boolean(),
}).strict();
export type GateTriggers = z.infer<typeof GateTriggers>;
const ImprovementLane = z.object({ id: z.string().regex(/^[a-z][a-z0-9-]*$/), blocking: z.literal(false) }).strict();
export type Role = {
  id: string;
  department: TemplateKey;
  kind: 'head' | 'member';
  title: Lang;
  description: Lang;
  tier: 'deep' | 'standard' | 'fast';
  effort?: RoleEffort;
  perProduct: boolean;
  inDefault: boolean;
  /* Where the role stands among its department's default gates; none for a role that is not a gate. */
  gate: number | null;
  gateTriggers?: GateTriggers;
  improvementLanes?: z.infer<typeof ImprovementLane>[];
  /* A special place on the department schema, or null for ordinary work. */
  schema: 'before_work' | 'final_check' | 'observer' | null;
  /* A hire of this role wakes on this timer from the start. */
  timer: RoleTimer | null;
  skills: RoleSkill[];
  body: string;
  hash: string;
};
export type Templates = { roles: Map<string, Role>; skills: Map<string, Skill>; roster(key: TemplateKey): Role[] };

/* Every employee has these, locked on. */
export const CORE_SKILLS = ['hh-outside-is-data', 'hh-verify-before-done', 'hh-ask-dont-guess', 'hh-stay-in-scope', 'hh-run-checks'] as const;
/* Every member has these too, locked on. */
export const MEMBER_SKILLS = ['hh-report-to-head', 'hh-task-flow'] as const;
/* Every head has these too, locked on. */
export const HEAD_SKILLS = ['hh-lead-tasks', 'hh-break-down', 'hh-brief-members', 'hh-handle-reports', 'hh-fix-loop', 'hh-status-update'] as const;

/* Strict, so a value that YAML split on a comma fails instead of loading half. */
const LangText = z.object({ en: z.string().trim().min(1), ru: z.string().trim().min(1) }).strict();
const SkillHead = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  title: LangText,
  description: LangText,
  kind: z.enum(['core', 'procedure', 'checklist', 'gate']),
  sources: z.array(z.string().min(1)).default([]),
  /* Hornhoof tools an employee gets while this skill is on, beyond every employee's. */
  grants: z.array(z.enum(GRANTS)).default([]),
});
const RoleHead = z.object({
  id: z.string().regex(/^[A-Z]{3}-[A-Z0-9]+$/),
  department: z.enum(TEMPLATE_KEYS),
  kind: z.enum(['head', 'member']),
  title: LangText,
  description: LangText,
  tier: z.enum(['deep', 'standard', 'fast']),
  effort: z.enum(ROLE_EFFORTS).optional(),
  perProduct: z.boolean().default(false),
  default: z.boolean().default(true),
  /* Where the role stands in its roster, after the head. */
  order: z.number().int().default(50),
  gate: z.number().int().positive().optional(),
  gateTriggers: GateTriggers.optional(),
  improvementLanes: z.array(ImprovementLane).default([]),
  schema: z.enum(['before_work', 'final_check', 'observer']).nullable().default(null),
  timer: z
    .object({ minutes: z.number().int().min(TIMER_MIN).max(TIMER_MAX), order: z.string().trim().min(1).max(TIMER_ORDER_MAX), forWork: z.boolean().default(false) })
    .strict()
    .optional(),
  /* A plain id is on by default; { id, on: false } is offered but off. Core and head skills are added, not listed. */
  skills: z.array(z.union([z.string(), z.object({ id: z.string(), on: z.boolean() })])).default([]),
});

export const textHash = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 12);

const yamlFailure = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function parseFrontmatter(file: string, raw: string): unknown {
  try {
    return parse(raw);
  } catch (err) {
    throw new Error(`${file}: ${yamlFailure(err)}`);
  }
}

/* A file is YAML frontmatter between --- lines, then the body. */
function readParts(file: string): { head: unknown; body: string } {
  const text = readFileSync(file, 'utf8');
  const match = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) throw new Error(`${file} has no frontmatter.`);
  return { head: parseFrontmatter(file, match[1]!), body: match[2]!.trim() };
}

function parsed<T>(schema: z.ZodType<T>, file: string, head: unknown): T {
  const res = schema.safeParse(head);
  if (!res.success) throw new Error(`${file}: ${res.error.issues.map(i => `${i.path.join('.')} ${i.message}`).join('; ')}`);
  return res.data;
}

/* A department without a folder has no roster yet. */
const markdown = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith('.md')).sort() : []);

function loadSkills(dir: string): Map<string, Skill> {
  const skills = new Map<string, Skill>();
  for (const f of markdown(join(dir, 'skills'))) {
    const file = join(dir, 'skills', f);
    const { head, body } = readParts(file);
    const s = parsed(SkillHead, file, head);
    if (`${s.id}.md` !== f) throw new Error(`${file} must be named ${s.id}.md.`);
    skills.set(s.id, { ...s, body, hash: textHash(body) });
  }
  return skills;
}

const toRoleSkill = (s: string | { id: string; on: boolean }): RoleSkill =>
  typeof s === 'string' ? { id: s, on: true, locked: false } : { ...s, locked: false };

function ensureSkillsExist(file: string, entries: readonly RoleSkill[], skills: ReadonlyMap<string, Skill>): void {
  for (const entry of entries) {
    if (!skills.has(entry.id)) throw new Error(`${file} names the skill ${entry.id}, which does not exist.`);
  }
}

function buildRoleSkills(file: string, r: z.infer<typeof RoleHead>, skills: ReadonlyMap<string, Skill>): RoleSkill[] {
  const lockedIds = r.kind === 'head' ? HEAD_SKILLS : MEMBER_SKILLS;
  const locked = [...CORE_SKILLS, ...lockedIds].map(id => ({ id, on: true, locked: true }));
  const listed = r.skills.map(toRoleSkill);
  ensureSkillsExist(file, [...locked, ...listed], skills);
  return [...locked, ...listed.filter(s => !locked.some(l => l.id === s.id))];
}

function parseRoleFile(file: string, key: TemplateKey, skills: ReadonlyMap<string, Skill>): { role: Role; order: number } {
  const { head, body } = readParts(file);
  const r = parsed(RoleHead, file, head);
  if (r.department !== key) throw new Error(`${file} is in ${key} but says ${r.department}.`);
  return {
    order: r.order,
    role: {
      id: r.id,
      department: r.department,
      kind: r.kind,
      title: r.title,
      description: r.description,
      tier: r.tier,
      effort: r.effort,
      perProduct: r.perProduct,
      inDefault: r.default,
      gate: r.gate ?? null,
      gateTriggers: r.gateTriggers,
      improvementLanes: r.improvementLanes,
      schema: r.schema,
      timer: r.timer ?? null,
      skills: buildRoleSkills(file, r, skills),
      body,
      hash: textHash(body),
    },
  };
}

function loadRoles(dir: string, skills: ReadonlyMap<string, Skill>): { roles: Map<string, Role>; order: Map<string, number> } {
  const roles = new Map<string, Role>();
  const order = new Map<string, number>();
  for (const key of TEMPLATE_KEYS) {
    for (const f of markdown(join(dir, 'roles', key))) {
      const { role, order: pos } = parseRoleFile(join(dir, 'roles', key, f), key, skills);
      order.set(role.id, pos);
      roles.set(role.id, role);
    }
  }
  return { roles, order };
}

/* The head first, then default members, then optional ones, each by its order. */
const roleRank = (r: Role): number => (r.kind === 'head' ? 0 : r.inDefault ? 1 : 2);

function sortDepartmentRoster(roles: Iterable<Role>, order: ReadonlyMap<string, number>, key: TemplateKey): Role[] {
  return [...roles]
    .filter(r => r.department === key)
    .sort((a, b) => roleRank(a) - roleRank(b) || order.get(a.id)! - order.get(b.id)! || a.id.localeCompare(b.id));
}

export function loadTemplates(dir: string): Templates {
  const skills = loadSkills(dir);
  const { roles, order } = loadRoles(dir, skills);
  return { roles, skills, roster: key => sortDepartmentRoster(roles.values(), order, key) };
}
