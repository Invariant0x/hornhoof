import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { isLocaleId, ROLE_EFFORTS, SOURCE_LOCALE, TEMPLATE_KEYS, type RoleEffort, type TemplateKey, type Texts } from '@hornhoof/protocol';
import { ECHELON_STAGES, type EchelonOneShot, type EchelonStage } from '@hornhoof/protocol/echelons';
import { parse } from 'yaml';
import { z } from 'zod';
import type { Checker } from '../../checker.js';

/* Role and skill templates: the text every employee is hired with. Roles are short, procedures live in skills. */

/* A name or a description in every language that has it, English always: they are written in the locale files, one per language. */
export type Lang = Texts;
export type SkillKind = 'core' | 'procedure' | 'checklist' | 'gate';
export type Skill = { id: string; title: Lang; description: Lang; kind: SkillKind; body: string; hash: string; sources: string[]; grants: Grant[] };

/* Tools a skill may grant: every agent's state, the list of turns suspected to hang, the failed turns and blocked tasks, restarting a program, putting what to improve under Improvements, writing to employees of other departments, keeping the department's goals, pipelines and task texts in the tracker, and settling tasks: reading whether a task's commit is released and closing the cases the server proves done. */
export const GRANTS = ['agents', 'hangs', 'failures', 'message_employee', 'restart_program', 'improvements', 'tracker', 'settle'] as const;
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
/* oneShot: its owner runs the stage as one-shot calls, so many at once and a judge. */
export type StageRoute = { department: TemplateKey; stages: { stage: EchelonStage; ability: string | null; oneShot?: EchelonOneShot }[] };
/* parent: the earlier stage this one hands over from, by name; none puts it under the stage before it, so a pipeline is a chain unless a stage names a parent and forks. */
export type CatalogStage = { name: string; ownerRole: string; parent?: string; brief?: string; echelon?: EchelonStage; oneShot?: EchelonOneShot; handoffTo?: TemplateKey[] };
export type CatalogPipeline = { key: string; name: string; why: string; stages: CatalogStage[] };
export type PipelineCatalog = { department: TemplateKey; default: string; pipelines: CatalogPipeline[] };

export type Templates = {
  roles: Map<string, Role>; skills: Map<string, Skill>; teams: Map<string, TeamTemplate>; echelons: Map<TemplateKey, StageRoute>;
  catalogs: Map<TemplateKey, PipelineCatalog>;
  roster(key: TemplateKey): Role[]; teamsOf(key: TemplateKey): TeamTemplate[];
  /* A department made from no template works as Development does. */
  stagesOf(key: TemplateKey | null): StageRoute;
};

/* Every employee has these, locked on: what working in Hornhoof takes, whatever the department. */
export const CORE_SKILLS = ['hh-hornhoof', 'hh-tasks', 'hh-outside-is-data', 'hh-verify-before-done', 'hh-ask-dont-guess', 'hh-questions', 'hh-stay-in-scope', 'hh-run-checks', 'hh-web-pages', 'hh-tables', 'hh-one-shot-calls'] as const;
/* Every member has these too, locked on. */
export const MEMBER_SKILLS = ['hh-report-to-head', 'hh-task-flow'] as const;
/* Every head has these too, locked on; what a department knows comes with its own skills. */
export const HEAD_SKILLS = ['hh-lead-tasks', 'hh-head', 'hh-notebook', 'hh-break-down', 'hh-brief-members', 'hh-handle-reports', 'hh-fix-loop'] as const;

const SkillHead = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  kind: z.enum(['core', 'procedure', 'checklist', 'gate']),
  sources: z.array(z.string().min(1)).default([]),
  /* Hornhoof tools an employee gets while this skill is on, beyond every employee's. */
  grants: z.array(z.enum(GRANTS)).default([]),
});
const RoleHead = z.object({
  id: z.string().regex(/^[A-Z]{3}-[A-Z0-9]+$/),
  department: z.enum(TEMPLATE_KEYS),
  kind: z.enum(['head', 'member']),
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

/* What a person reads of each template, a locale file per language: locales/en.yaml is the source, locales/ru.yaml and the
   rest translate it. A language is a file named by its id in the registry; a text it lacks reads in English. */
const TextEntry = z.object({ title: z.string().trim().min(1), description: z.string().trim().min(1) }).strict();
const TextsFile = z.object({ roles: z.record(z.string(), TextEntry).default({}), skills: z.record(z.string(), TextEntry).default({}), teams: z.record(z.string(), TextEntry).default({}) }).strict();
export type TemplateKind = 'roles' | 'skills' | 'teams';
type TextsOf = Record<TemplateKind, Map<string, { title: Record<string, string>; description: Record<string, string> }>>;

function loadTexts(dir: string): TextsOf {
  const texts: TextsOf = { roles: new Map(), skills: new Map(), teams: new Map() };
  const folder = join(dir, 'locales');
  const files = existsSync(folder) ? readdirSync(folder).filter(f => f.endsWith('.yaml')).sort() : [];
  for (const f of files) {
    const file = join(folder, f);
    const language = basename(f, '.yaml');
    if (!isLocaleId(language)) throw new Error(`${file} is a language the registry of languages does not list.`);
    const given = parsed(TextsFile, file, parseFrontmatter(file, readFileSync(file, 'utf8')));
    for (const kind of ['roles', 'skills', 'teams'] as const) {
      for (const [id, entry] of Object.entries(given[kind])) {
        const slot = texts[kind].get(id) ?? { title: {}, description: {} };
        slot.title[language] = entry.title;
        slot.description[language] = entry.description;
        texts[kind].set(id, slot);
      }
    }
  }
  return texts;
}

/* A template's words in each language; English is required, as it is what every other language falls back to. */
function wordsOf(texts: TextsOf, kind: TemplateKind, id: string, file: string): { title: Lang; description: Lang } {
  const found = texts[kind].get(id);
  if (!found?.title[SOURCE_LOCALE] || !found.description[SOURCE_LOCALE]) throw new Error(`${file}: ${id} has no ${SOURCE_LOCALE} name and description in templates/locales/${SOURCE_LOCALE}.yaml.`);
  return { title: found.title as Lang, description: found.description as Lang };
}

/* A text of a locale file whose template does not exist is a typo, or a template removed that left its words behind. */
function noOrphans(dir: string, texts: TextsOf, known: Record<TemplateKind, ReadonlyMap<string, unknown>>): void {
  for (const kind of ['roles', 'skills', 'teams'] as const) {
    for (const id of texts[kind].keys()) if (!known[kind].has(id)) throw new Error(`${join(dir, 'locales')} has words for the ${kind.slice(0, -1)} ${id}, which does not exist.`);
  }
}

/* A department without a folder has no roster yet. */
const markdown = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith('.md')).sort() : []);

function loadSkills(dir: string, texts: TextsOf): Map<string, Skill> {
  const skills = new Map<string, Skill>();
  for (const f of markdown(join(dir, 'skills'))) {
    const file = join(dir, 'skills', f);
    const { head, body } = readParts(file);
    const s = parsed(SkillHead, file, head);
    if (`${s.id}.md` !== f) throw new Error(`${file} must be named ${s.id}.md.`);
    skills.set(s.id, { ...s, ...wordsOf(texts, 'skills', s.id, file), body, hash: textHash(body) });
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

function parseRoleFile(file: string, key: TemplateKey, skills: ReadonlyMap<string, Skill>, texts: TextsOf): { role: Role; order: number } {
  const { head, body } = readParts(file);
  const r = parsed(RoleHead, file, head);
  if (r.department !== key) throw new Error(`${file} is in ${key} but says ${r.department}.`);
  return {
    order: r.order,
    role: {
      id: r.id,
      department: r.department,
      kind: r.kind,
      ...wordsOf(texts, 'roles', r.id, file),
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

function loadRoles(dir: string, skills: ReadonlyMap<string, Skill>, texts: TextsOf): { roles: Map<string, Role>; order: Map<string, number> } {
  const roles = new Map<string, Role>();
  const order = new Map<string, number>();
  for (const key of TEMPLATE_KEYS) {
    for (const f of markdown(join(dir, 'roles', key))) {
      const { role, order: pos } = parseRoleFile(join(dir, 'roles', key, f), key, skills, texts);
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
    turnkey: z.boolean().default(false),
    urgentOnly: z.boolean().default(false),
    members: z.array(z.object({ role: z.string(), count: z.number().int().min(1).max(5).default(1) }).strict()).min(1).max(10),
    skills: z.array(z.string()).default([]),
  })
  .strict();

/* A team's members are members of its own department, and its id is no role's. */
function parseTeamFile(file: string, key: TemplateKey, roles: ReadonlyMap<string, Role>, skills: ReadonlyMap<string, Skill>, texts: TextsOf): TeamTemplate {
  const team = parsed(TeamHead, file, readParts(file).head);
  if (team.department !== key) throw new Error(`${file} is in ${key} but says ${team.department}.`);
  if (roles.has(team.id)) throw new Error(`${file}: ${team.id} is the id of a role.`);
  for (const { role } of team.members) {
    const known = roles.get(role);
    if (!known || known.department !== key || known.kind !== 'member') throw new Error(`${file}: ${role} is not a member role of ${key}.`);
  }
  for (const id of team.skills) if (!skills.has(id)) throw new Error(`${file} names the skill ${id}, which does not exist.`);
  return { ...team, ...wordsOf(texts, 'teams', team.id, file) };
}

function loadTeams(dir: string, roles: ReadonlyMap<string, Role>, skills: ReadonlyMap<string, Skill>, texts: TextsOf): Map<string, TeamTemplate> {
  const teams = new Map<string, TeamTemplate>();
  for (const key of TEMPLATE_KEYS) {
    for (const f of markdown(join(dir, 'teams', key))) {
      const team = parseTeamFile(join(dir, 'teams', key, f), key, roles, skills, texts);
      teams.set(team.id, team);
    }
  }
  return teams;
}

const OneShot = z.object({ fanOut: z.number().int().min(1), judge: z.string().trim().min(1).optional() }).strict()
  .transform(({ fanOut, judge }) => ({ fanOut, judge: judge ?? null }));
const RouteHead = z
  .object({
    department: z.enum(TEMPLATE_KEYS),
    stages: z
      .array(
        z
          .object({
            stage: z.enum(ECHELON_STAGES),
            ability: z.string().optional(),
            oneShot: OneShot.optional(),
          })
          .strict(),
      )
      .min(1),
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
  return {
    department: key,
    stages: route.stages.map(step => ({ stage: step.stage, ability: step.ability ?? null, ...(step.oneShot ? { oneShot: step.oneShot } : {}) })),
  };
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

const CatalogKey = z.string().regex(/^[a-z][a-z0-9-]*$/);
const CatalogHead = z.strictObject({
  department: z.enum(TEMPLATE_KEYS),
  default: CatalogKey,
  pipelines: z.array(z.strictObject({
    key: CatalogKey,
    name: z.string().trim().min(1),
    why: z.string().trim().min(1),
    stages: z.array(z.strictObject({
      name: z.string().trim().min(1),
      ownerRole: z.string(),
      parent: z.string().trim().min(1).optional(),
      brief: z.string().trim().min(1).optional(),
      echelon: z.enum(ECHELON_STAGES).optional(),
      handoffTo: z.array(z.enum(TEMPLATE_KEYS)).optional(),
      oneShot: OneShot.optional(),
    })).min(1),
  })).min(1),
});

/* One stage of a ready pipeline: owned by a role of the department, a one-shot stage with the echelon it runs in, each echelon
   once in a pipeline, and a parent that is a stage before it. */
function checkCatalogStage(file: string, department: TemplateKey, pipeline: CatalogPipeline, step: CatalogStage, roles: ReadonlyMap<string, Role>, seen: { names: Set<string>; echelons: Set<EchelonStage> }): void {
  if (step.parent !== undefined && !seen.names.has(step.parent)) throw new Error(`${file}: ${step.name} names ${step.parent} as its parent, which is no stage before it.`);
  seen.names.add(step.name);
  if (roles.get(step.ownerRole)?.department !== department) throw new Error(`${file}: ${step.ownerRole} is not a role of ${department}.`);
  if (step.oneShot && !step.echelon) throw new Error(`${file}: ${step.name} needs an echelon for its one-shot calls.`);
  if (!step.echelon) return;
  if (seen.echelons.has(step.echelon)) throw new Error(`${file}: ${pipeline.key} maps ${step.echelon} twice.`);
  seen.echelons.add(step.echelon);
}

function parseCatalogFile(file: string, roles: ReadonlyMap<string, Role>): PipelineCatalog {
  const catalog = parsed(CatalogHead, file, readParts(file).head);
  const keys = new Set(catalog.pipelines.map(p => p.key));
  if (keys.size !== catalog.pipelines.length || !keys.has(catalog.default)) throw new Error(`${file}: pipeline keys must be unique and include the default.`);
  for (const pipeline of catalog.pipelines) {
    if (new Set(pipeline.stages.map(stage => stage.name)).size !== pipeline.stages.length) throw new Error(`${file}: ${pipeline.key} repeats a stage name.`);
    const seen = { names: new Set<string>(), echelons: new Set<EchelonStage>() };
    for (const step of pipeline.stages) checkCatalogStage(file, catalog.department, pipeline, step, roles, seen);
  }
  return catalog;
}

function loadCatalogs(dir: string, roles: ReadonlyMap<string, Role>): Map<TemplateKey, PipelineCatalog> {
  const catalogs = new Map<TemplateKey, PipelineCatalog>();
  for (const f of markdown(join(dir, 'pipelines'))) {
    const file = join(dir, 'pipelines', f);
    const catalog = parseCatalogFile(file, roles);
    if (f !== `${catalog.department}.md`) throw new Error(`${file} must be named ${catalog.department}.md.`);
    catalogs.set(catalog.department, catalog);
  }
  return catalogs;
}

/* Keep the department's executable checks. A ready pipeline can set up one-shot work at the echelons it maps. */
export function catalogRoute(templates: Templates, key: TemplateKey | null, catalogKey: string | null): StageRoute {
  const route = templates.stagesOf(key);
  const catalog = key ? templates.catalogs.get(key) : undefined;
  if (!catalog) return route;
  const pipeline = catalog.pipelines.find(p => p.key === catalogKey);
  if (!pipeline) return route;
  const mapped = new Map(pipeline.stages.map(stage => [stage.echelon, stage.oneShot]));
  return { ...route, stages: route.stages.map(({ oneShot: inherited, ...step }) => {
    const oneShot = mapped.get(step.stage) ?? (catalogKey === catalog.default ? inherited : undefined);
    return { ...step, ...(oneShot ? { oneShot } : {}) };
  }) };
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

function templatesOf(roles: Map<string, Role>, skills: Map<string, Skill>, teams: Map<string, TeamTemplate>, echelons: Map<TemplateKey, StageRoute>, catalogs: Map<TemplateKey, PipelineCatalog>, order: ReadonlyMap<string, number>): Templates {
  const templates: Templates = {
    roles, skills, teams, echelons, catalogs,
    roster: key => sortDepartmentRoster(roles.values(), order, key),
    teamsOf: key => [...teams.values()].filter(team => team.department === key),
    stagesOf: key => (key && echelons.get(key)) || echelons.get('development')!,
  };
  orders.set(templates, order);
  return templates;
}

export function loadTemplates(dir: string): Templates {
  const texts = loadTexts(dir);
  const skills = loadSkills(dir, texts);
  const { roles, order } = loadRoles(dir, skills, texts);
  const teams = loadTeams(dir, roles, skills, texts);
  noOrphans(dir, texts, { roles, skills, teams });
  return templatesOf(roles, skills, teams, loadRoutes(dir, skills), loadCatalogs(dir, roles), order);
}

/* Loaded templates again without reading their files: what the copy's holder changes in its roles and skills the
   templates it came from do not see. A test file reads the templates once for all the servers it builds. */
export function copyTemplates(templates: Templates): Templates {
  return templatesOf(structuredClone(templates.roles), structuredClone(templates.skills), structuredClone(templates.teams), structuredClone(templates.echelons), structuredClone(templates.catalogs), orders.get(templates)!);
}
