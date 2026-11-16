import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROLE_EFFORTS, TEMPLATE_KEYS, type RoleEffort, type TemplateKey } from '@hornhoof/protocol';
import { ECHELON_STAGES, type EchelonStage } from '@hornhoof/protocol/echelons';
import { parse } from 'yaml';
import { z } from 'zod';
import type { Checker } from '../../checker.js';

/* Role and skill templates: the text every employee is hired with. Roles are short, procedures live in skills. */

export type Lang = { en: string; ru: string };
export type SkillKind = 'core' | 'procedure' | 'checklist' | 'gate';
export type Skill = { id: string; title: Lang; description: Lang; kind: SkillKind; body: string; hash: string; sources: string[]; grants: Grant[] };

/* Tools a skill may grant: every agent's state, the failed turns and blocked tasks, restarting a program, putting what to improve under Improvements, and writing to employees of other departments. */
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
  /* How strong a model the role asks for. top: the strongest there is, for work nobody checks after and whose mistakes
     cost most. deep: a strong one, for whoever checks the work of others or leads. standard: the middle one, for work
     that is checked after. fast: the lightest, for simple work that comes in a stream. */
  tier: 'top' | 'deep' | 'standard' | 'fast';
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
/* A sub-unit a department's template brings with it: its members by role, whether each of them does a task whole, with
   no stage after it, and the skills each carries on top of its role's: whoever works alone does every check itself. */
export type TeamTemplate = { id: string; department: TemplateKey; title: Lang; description: Lang; turnkey: boolean; urgentOnly: boolean; members: { role: string; count: number }[]; skills: string[] };
/* The stages a department's work goes through in a turn run in echelons, in their order, and the skill whoever checks
   at a stage must carry. */
export type StageRoute = { department: TemplateKey; stages: { stage: EchelonStage; ability: string | null }[] };
export type Templates = {
  roles: Map<string, Role>; skills: Map<string, Skill>; teams: Map<string, TeamTemplate>; echelons: Map<TemplateKey, StageRoute>;
  roster(key: TemplateKey): Role[]; teamsOf(key: TemplateKey): TeamTemplate[];
  /* A department made from no template works as Development does. */
  stagesOf(key: TemplateKey | null): StageRoute;
};

/* Every employee has these, locked on: what working in Hornhoof takes, whatever the department. */
export const CORE_SKILLS = ['hh-hornhoof', 'hh-tasks', 'hh-outside-is-data', 'hh-verify-before-done', 'hh-ask-dont-guess', 'hh-questions', 'hh-stay-in-scope', 'hh-run-checks', 'hh-web-pages', 'hh-tables'] as const;
/* Every member has these too, locked on. */
export const MEMBER_SKILLS = ['hh-report-to-head', 'hh-task-flow'] as const;
/* Every head has these too, locked on; what a department knows comes with its own skills. */
export const HEAD_SKILLS = ['hh-lead-tasks', 'hh-head', 'hh-notebook', 'hh-break-down', 'hh-brief-members', 'hh-handle-reports', 'hh-fix-loop'] as const;

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
  tier: z.enum(['top', 'deep', 'standard', 'fast']),
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
  /* A plain id is on by default; { id, on: false } is offered but off; { id, locked: true } is on for everyone in the role,
     whatever was on when they were hired. Core and head skills are added, not listed. */
  skills: z.array(z.union([z.string(), z.object({ id: z.string(), on: z.boolean() }), z.object({ id: z.string(), locked: z.literal(true) })])).default([]),
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

function parsed<T>(schema: Checker<T>, file: string, head: unknown): T {
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

const listedSkill = (s: { id: string; on: boolean } | { id: string; locked: true }): RoleSkill =>
  'locked' in s ? { id: s.id, on: true, locked: true } : { ...s, locked: false };

const toRoleSkill = (s: string | { id: string; on: boolean } | { id: string; locked: true }): RoleSkill =>
  typeof s === 'string' ? { id: s, on: true, locked: false } : listedSkill(s);

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

const TeamHead = z
  .object({
    id: z.string().regex(/^[A-Z]{3}-[A-Z0-9]+$/),
    department: z.enum(TEMPLATE_KEYS),
    title: z.object({ en: z.string().min(1), ru: z.string().min(1) }).strict(),
    description: z.object({ en: z.string().min(1), ru: z.string().min(1) }).strict(),
    turnkey: z.boolean().default(false),
    urgentOnly: z.boolean().default(false),
    members: z.array(z.object({ role: z.string(), count: z.number().int().min(1).max(5).default(1) }).strict()).min(1).max(10),
    skills: z.array(z.string()).default([]),
  })
  .strict();

/* A team's members are members of its own department, and its id is no role's. */
function parseTeamFile(file: string, key: TemplateKey, roles: ReadonlyMap<string, Role>, skills: ReadonlyMap<string, Skill>): TeamTemplate {
  const team = parsed(TeamHead, file, readParts(file).head);
  if (team.department !== key) throw new Error(`${file} is in ${key} but says ${team.department}.`);
  if (roles.has(team.id)) throw new Error(`${file}: ${team.id} is the id of a role.`);
  for (const { role } of team.members) {
    const known = roles.get(role);
    if (!known || known.department !== key || known.kind !== 'member') throw new Error(`${file}: ${role} is not a member role of ${key}.`);
  }
  for (const id of team.skills) if (!skills.has(id)) throw new Error(`${file} names the skill ${id}, which does not exist.`);
  return team;
}

function loadTeams(dir: string, roles: ReadonlyMap<string, Role>, skills: ReadonlyMap<string, Skill>): Map<string, TeamTemplate> {
  const teams = new Map<string, TeamTemplate>();
  for (const key of TEMPLATE_KEYS) {
    for (const f of markdown(join(dir, 'teams', key))) {
      const team = parseTeamFile(join(dir, 'teams', key, f), key, roles, skills);
      teams.set(team.id, team);
    }
  }
  return teams;
}

const RouteHead = z
  .object({
    department: z.enum(TEMPLATE_KEYS),
    stages: z.array(z.object({ stage: z.enum(ECHELON_STAGES), ability: z.string().optional() }).strict()).min(1),
  })
  .strict();
/* Whoever works at these stages makes the result; at every other stage somebody else checks it. */
const MAKING: readonly EchelonStage[] = ['architecture', 'development'];

/* Stages keep the one order every route has. Work is always among them, and a checking stage names the skill of its checker. */
function parseRouteFile(file: string, key: TemplateKey, skills: ReadonlyMap<string, Skill>): StageRoute {
  const route = parsed(RouteHead, file, readParts(file).head);
  if (route.department !== key) throw new Error(`${file} is for ${key} but says ${route.department}.`);
  const places = route.stages.map(step => ECHELON_STAGES.indexOf(step.stage));
  if (places.some((place, i) => i > 0 && place <= places[i - 1]!)) throw new Error(`${file}: stages go in the order ${ECHELON_STAGES.join(', ')}, each once.`);
  if (!route.stages.some(step => step.stage === 'development')) throw new Error(`${file}: a route needs the development stage.`);
  for (const step of route.stages) {
    if (MAKING.includes(step.stage) ? step.ability !== undefined : !step.ability) throw new Error(`${file}: ${step.stage} ${MAKING.includes(step.stage) ? 'takes no ability' : 'needs the ability of its checker'}.`);
    if (step.ability && !skills.has(step.ability)) throw new Error(`${file} names the skill ${step.ability}, which does not exist.`);
  }
  return { department: key, stages: route.stages.map(step => ({ stage: step.stage, ability: step.ability ?? null })) };
}

function loadRoutes(dir: string, skills: ReadonlyMap<string, Skill>): Map<TemplateKey, StageRoute> {
  const routes = new Map<TemplateKey, StageRoute>();
  for (const f of markdown(join(dir, 'echelons'))) {
    const key = TEMPLATE_KEYS.find(k => `${k}.md` === f);
    if (!key) throw new Error(`${join(dir, 'echelons', f)} is named after no department template.`);
    routes.set(key, parseRouteFile(join(dir, 'echelons', f), key, skills));
  }
  if (!routes.has('development')) throw new Error(`${join(dir, 'echelons', 'development.md')} is missing: it is the route of every department without one of its own.`);
  return routes;
}

/* The head first, then default members, then optional ones, each by its order. */
const roleRank = (r: Role): number => (r.kind === 'head' ? 0 : r.inDefault ? 1 : 2);

function sortDepartmentRoster(roles: Iterable<Role>, order: ReadonlyMap<string, number>, key: TemplateKey): Role[] {
  return [...roles]
    .filter(r => r.department === key)
    .sort((a, b) => roleRank(a) - roleRank(b) || order.get(a.id)! - order.get(b.id)! || a.id.localeCompare(b.id));
}

/* The order of the roles of each roster as their files give it, kept for copies of the templates. */
const orders = new WeakMap<Templates, ReadonlyMap<string, number>>();

function templatesOf(roles: Map<string, Role>, skills: Map<string, Skill>, teams: Map<string, TeamTemplate>, echelons: Map<TemplateKey, StageRoute>, order: ReadonlyMap<string, number>): Templates {
  const templates: Templates = {
    roles, skills, teams, echelons,
    roster: key => sortDepartmentRoster(roles.values(), order, key),
    teamsOf: key => [...teams.values()].filter(team => team.department === key),
    stagesOf: key => (key && echelons.get(key)) || echelons.get('development')!,
  };
  orders.set(templates, order);
  return templates;
}

export function loadTemplates(dir: string): Templates {
  const skills = loadSkills(dir);
  const { roles, order } = loadRoles(dir, skills);
  return templatesOf(roles, skills, loadTeams(dir, roles, skills), loadRoutes(dir, skills), order);
}

/* Loaded templates again without reading their files: what the copy's holder changes in its roles and skills the
   templates it came from do not see. A test file reads the templates once for all the servers it builds. */
export function copyTemplates(templates: Templates): Templates {
  return templatesOf(structuredClone(templates.roles), structuredClone(templates.skills), structuredClone(templates.teams), structuredClone(templates.echelons), orders.get(templates)!);
}
