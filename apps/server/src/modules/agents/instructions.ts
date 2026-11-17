import { MAX_INSTRUCTIONS, OLD_NODE_INSTRUCTIONS, type SkillFile } from '@hornhoof/protocol';
import { eq, inArray } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { Ctx } from '../../app.js';
import { assistants, companies, departments, people, type agents } from '../../db/schema.js';
import { only } from '../../db/selections.js';
import { ORCHESTRATOR_INSTRUCTIONS } from '../conversation/prompt.js';
import { type Book, companyBook, departmentBook, listNotes } from '../notebook/book.js';
import { deptName } from '../departments/templates.js';
import { CORE_SKILLS, HEAD_SKILLS, MEMBER_SKILLS, textHash, type Lang, type Role, type Skill, type Templates } from '../templates/load.js';

/* One piece of an employee's instructions, as the card shows it. */
export type Part = { kind: 'header' | 'base' | 'assignment' | 'skill' | 'notebook'; id: string | null; title: Lang | null; text: string; overridden: boolean; templateChanged: boolean };
/* The card's parts and its raw text with every skill whole; what the program is told, with its hash; the skills the node
   writes as files, which the program reads when it needs them; and whole, what a node that writes no skill files is told. */
export type Rendered = { parts: Part[]; raw: string; text: string; hash: string; skills: SkillFile[]; whole: string };

type AgentRow = typeof agents.$inferSelect;
type Place = { company: string; department: string; product: string | null };

/* Who the employee is and where it works: the one line of its instructions that is no skill. Everything else it knows,
   down to working in Hornhoof, comes in skills its card holds. Always English; it answers in the language people write in. */
function header(agent: AgentRow, role: string, place: Place): string {
  const where = `the ${role} of the ${place.department} department at ${place.company}${place.product ? `, working on ${place.product}` : ''}`;
  return `You are ${agent.name}, ${where}.`;
}

/* A skill as instructions carry it, between markers the card finds it by. */
const skillBlock = (id: string, title: string, body: string) => `<!-- hh:skill ${id} -->\n## ${title}\n\n${body}\n<!-- /hh:skill -->`;

/* Core skills are rules for every step and stay in the instructions; the others are files the program reads when a step
   needs one. */
const inline = (skill: Skill | undefined) => skill?.kind === 'core';

const skillFile = (id: string, skill: Skill | undefined, body: string): SkillFile => {
  const title = skill?.title.en ?? id;
  return { name: id, description: skill?.description.en ? `${title}. ${skill.description.en}` : title, body: `# ${title}\n\n${body}` };
};

/* The list of skill files, as the instructions name them. */
function skillList(files: SkillFile[]): string {
  return [
    '## Skills',
    'Your skills are self-contained abilities, stored in your folder: .claude/skills/<name>/SKILL.md when you run in Claude Code, .agents/skills/<name>/SKILL.md in the other programs, which list them for you too. Read the whole file before using an ability. Your assignment and the task determine which work and checks you own.',
    files.map(f => `- ${f.name}: ${f.description}`).join('\n'),
  ].join('\n\n');
}

/* What the program is told: the parts it keeps whole, then the list of the skill files. */
function told(kept: string[], files: SkillFile[]): string {
  return [...kept, ...(files.length ? [skillList(files)] : [])].join('\n\n');
}

/* Every skill in the text, as a node that writes no skill files gets them. A turn longer than such a node takes does not
   go out. */
const whole = (texts: string[]) => texts.join('\n\n');

/* Skills whose text is the template's for everyone, with no text of an employee's own: how checks run, how heads lead,
   and how Operations end a turn that stands with no person asked. */
const CANONICAL_SKILLS: ReadonlySet<string> = new Set(['hh-run-checks', 'hh-lead-tasks', 'ops-program-operator']);

const movedSinceHire = (hired: Record<string, string>, id: string, hash: string): boolean => hired[id] !== undefined && hired[id] !== hash;

function lockedSkillIds(role: Role | undefined, agent: AgentRow): readonly string[] {
  const head = role ? role.kind === 'head' : agent.kind === 'head';
  return head ? HEAD_SKILLS : MEMBER_SKILLS;
}

/* What the role locks on reaches everyone in it with every turn, those hired before it was in the role too. */
const roleLockedIds = (role: Role | undefined): string[] => (role ? role.skills.filter(s => s.locked).map(s => s.id) : []);

function effectiveSkillIds(t: Templates, role: Role | undefined, agent: AgentRow): string[] {
  const required = [...CORE_SKILLS, ...lockedSkillIds(role, agent), ...roleLockedIds(role)].filter(id => t.skills.has(id));
  return [...new Set([...required, ...agent.skills])];
}

function basePart(role: Role | undefined, agent: AgentRow): Part | null {
  if (!role) return null;
  return { kind: 'base', id: role.id, title: role.title, text: role.body, overridden: false, templateChanged: movedSinceHire(agent.templateHashes, role.id, role.hash) };
}

/* Existing personal base text is an assignment, never a replacement for role identity. */
function assignmentPart(body: string | undefined): Part {
  return {
    kind: 'assignment', id: null, title: { en: 'Assignment', ru: 'Назначение' },
    text: `<!-- hh:assignment -->\n## Assignment\n\n${body ?? ''}\n<!-- /hh:assignment -->`,
    overridden: body !== undefined, templateChanged: false,
  };
}

function resolveSkillBody(
  skill: Skill | undefined,
  overrides: Record<string, string> | undefined,
  id: string,
): { body: string | undefined; overridden: boolean } {
  if (skill && CANONICAL_SKILLS.has(id)) return { body: skill.body, overridden: false };
  const own = overrides?.[id];
  return { body: own ?? skill?.body, overridden: own !== undefined };
}

function buildSkillPart(id: string, skill: Skill | undefined, body: string, overridden: boolean, hired: Record<string, string>): Part {
  const meta = skill
    ? { title: skill.title, text: skillBlock(id, skill.title.en, body), templateChanged: movedSinceHire(hired, id, skill.hash) }
    : { title: null, text: skillBlock(id, id, body), templateChanged: false };
  return { kind: 'skill', id, ...meta, overridden };
}

function renderSkillEntry(t: Templates, agent: AgentRow, id: string): { part: Part; kept?: string; file?: SkillFile } | null {
  const skill = t.skills.get(id);
  const { body, overridden } = resolveSkillBody(skill, agent.overrides.skills, id);
  /* A skill that left the templates and was never rewritten has nothing to say. */
  if (body === undefined) return null;
  const part = buildSkillPart(id, skill, body, overridden, agent.templateHashes);
  return inline(skill) ? { part, kept: part.text } : { part, file: skillFile(id, skill, body) };
}

function collectSkills(t: Templates, role: Role | undefined, agent: AgentRow): { parts: Part[]; kept: string[]; files: SkillFile[] } {
  const parts: Part[] = [];
  const kept: string[] = [];
  const files: SkillFile[] = [];
  for (const id of effectiveSkillIds(t, role, agent)) {
    const entry = renderSkillEntry(t, agent, id);
    if (!entry) continue;
    parts.push(entry.part);
    if (entry.kept !== undefined) kept.push(entry.kept);
    if (entry.file) files.push(entry.file);
  }
  return { parts, kept, files };
}

/* Identity and assignment stay separate; only a skill's own text can replace its template. */
export function renderInstructions(t: Templates, agent: AgentRow, place: Place): Rendered {
  const role = agent.roleKey ? t.roles.get(agent.roleKey) : undefined;
  const said = header(agent, role?.title.en ?? 'employee', place);
  const parts: Part[] = [{ kind: 'header', id: null, title: null, text: said, overridden: false, templateChanged: false }];
  const base = basePart(role, agent);
  if (base) parts.push(base);
  parts.push(assignmentPart(agent.overrides.base));
  const initialKept = parts.map(p => p.text);

  const collected = collectSkills(t, role, agent);
  parts.push(...collected.parts);

  const text = told([...initialKept, ...collected.kept], collected.files);
  return { parts, raw: parts.map(p => p.text).join('\n\n'), text, hash: textHash(text), skills: collected.files, whole: whole(parts.map(p => p.text)) };
}

/* The names an employee's header uses: its company, department and product. */
export async function placeOf(db: Ctx['db'], agent: AgentRow): Promise<Place> {
  const [company] = await db.select(only(companies, 'name')).from(companies).where(eq(companies.id, agent.companyId));
  const ids = [agent.departmentId, agent.productId].filter((id): id is string => Boolean(id));
  const depts = ids.length ? await db.select().from(departments).where(inArray(departments.id, ids)) : [];
  const nameOf = (id: string | null) => {
    const d = depts.find(x => x.id === id);
    return d ? deptName(d) : null;
  };
  return { company: company?.name ?? '', department: nameOf(agent.departmentId) ?? '', product: nameOf(agent.productId) };
}

/* The orchestrator's skills, always on after his standing role: working in Hornhoof as everyone does, leading as every
   head does, then what only he does, and development's own way of leading for when he needs it. */
export const ORCHESTRATOR_SKILLS = [
  'hh-hornhoof', 'orch-outside-is-data', 'orch-company', 'orch-staff', 'orch-people', 'orch-resources', 'hh-lead-tasks', 'hh-notebook', 'hh-run-checks', 'hh-tables',
  'orch-interview', 'orch-plan-turn', 'orch-trouble', 'dev-lead', 'hh-one-shot-calls',
] as const;

/* An assistant's own agent's skills: it works in no department and leads nobody, so none of an employee's. */
const ASSISTANT_SKILLS = ['hh-assistant'] as const;

/* The orchestrator's instructions apart from the notebook: his standing role, then his skills as an employee's go. */
export function orchestratorSteady(t: Templates, assignment?: string): { parts: Part[]; text: string; skills: SkillFile[]; whole: string } {
  return steadyOf(t, ORCHESTRATOR_INSTRUCTIONS, ORCHESTRATOR_SKILLS, assignment);
}

/* A standing role, the assignment, then fixed skills as an employee's go. */
function steadyOf(t: Templates, base: string, ids: readonly string[], assignment?: string): { parts: Part[]; text: string; skills: SkillFile[]; whole: string } {
  const parts: Part[] = [{ kind: 'base', id: null, title: null, text: base, overridden: false, templateChanged: false }, assignmentPart(assignment)];
  const kept = parts.map(p => p.text);
  const skills: SkillFile[] = [];
  for (const id of ids) {
    const skill = t.skills.get(id);
    if (!skill) continue;
    const text = skillBlock(id, skill.title.en, skill.body);
    parts.push({ kind: 'skill', id, title: skill.title, text, overridden: false, templateChanged: false });
    if (inline(skill)) kept.push(text);
    else skills.push(skillFile(id, skill, skill.body));
  }
  return { parts, text: told(kept, skills), skills, whole: whole(parts.map(p => p.text)) };
}

const CUT = '\n\nThe rest of the notebook did not fit here. Read it whole with the notebook tool.';

/* A notebook as its agent reads it, each note with its number: the company's for the orchestrator, a department's for
   its head. In less room it is cut after a whole note, with where to read the rest; none when not even that fits. */
export async function notebookPart(db: Ctx['db'], book: Book, room = Infinity): Promise<string> {
  const notes = await listNotes(db, book);
  const head = book.departmentId
    ? `## Department notebook\n\nWhat you and the people who run your department keep across conversations. Change it with remember, rewrite_note and forget.\n\n`
    : `## Company notebook\n\nWhat you and the people who run the company keep across conversations. Change it with remember, rewrite_note and forget.\n\n`;
  const lines = notes.map(n => `[#${n.number}] ${n.text}`);
  const whole = head + (lines.length ? lines.join('\n') : 'The notebook is empty.');
  if (whole.length <= room) return whole;
  let kept = head.trimEnd();
  for (let i = 0; i < lines.length; i++) {
    const next = i ? `${kept}\n${lines[i]}` : `${head}${lines[i]}`;
    if (next.length + CUT.length > room) break;
    kept = next;
  }
  return kept.length + CUT.length <= room ? kept + CUT : '';
}

const notebookOf = (text: string): Part => ({ kind: 'notebook', id: null, title: null, text, overridden: false, templateChanged: false });

/* A turn carries what its node takes at most, the notebook included. */
const notebookRoom = (said: string, files: boolean): number => (files ? MAX_INSTRUCTIONS : OLD_NODE_INSTRUCTIONS) - said.length - 2;

const forNode = (shown: Rendered, files: boolean): Rendered =>
  files ? shown : { ...shown, text: shown.whole, hash: textHash(shown.whole), skills: [] };

async function orchestratorInstructionsOf(ctx: Pick<Ctx, 'db' | 'templates'>, agent: AgentRow, files: boolean): Promise<Rendered> {
  const steady = orchestratorSteady(ctx.templates, agent.overrides.base);
  const said = files ? steady.text : steady.whole;
  const skills = files ? steady.skills : [];
  const notebook = await notebookPart(ctx.db, companyBook(agent.companyId), notebookRoom(said, files));
  const parts = [...steady.parts, notebookOf(notebook)];
  return { parts, raw: parts.map(p => p.text).join('\n\n'), text: `${said}\n\n${notebook}`, hash: textHash(said), skills, whole: steady.whole };
}

/* What an assistant's own agent is told of its program's skills: how to run them while its assistant has a skills address,
   and otherwise that it has none to run, so it promises none. Its instructions differ between the two, so setting or
   clearing the address starts its program anew, with the tools it has then. */
const ASSISTANT_WITH_SKILLS =
  "Your assistant's program has skills of its own, such as reminders, files or search: run one with persona_call, by the skill's name and with its arguments, as the message lists them. " +
  "Its answer says whether it worked; tell your owner what came of it. A file a skill takes goes to Hornhoof first with hh-attach --chat FILE, which prints the file's id: " +
  "give that id in the skill's arguments, and the program downloads the file by it.";
export const ASSISTANT_WITHOUT_SKILLS = "You have no tool for the program's own skills now: never promise to run one, and never ask your owner to set anything up for them.";
const skillsLine = (assistant: { skillsUrl: string | null } | undefined) => (assistant?.skillsUrl ? ASSISTANT_WITH_SKILLS : ASSISTANT_WITHOUT_SKILLS);

/* An assistant's own agent: whose assistant it is and where, what it may do of its program's skills, then the assistant's
   skills. */
async function assistantInstructionsOf(ctx: Pick<Ctx, 'db' | 'templates'>, agent: AgentRow, files: boolean): Promise<Rendered> {
  const owners = alias(people, 'owners');
  const [who] = await ctx.db
    .select({ name: people.name, owner: owners.name, company: companies.name, skillsUrl: assistants.skillsUrl })
    .from(assistants)
    .innerJoin(people, eq(people.id, assistants.personId))
    .innerJoin(owners, eq(owners.id, people.assistantOf))
    .innerJoin(companies, eq(companies.id, assistants.companyId))
    .where(eq(assistants.agentId, agent.id));
  const base = `You are ${who?.name ?? agent.name}, the personal assistant of ${who?.owner ?? 'your owner'} at ${who?.company ?? 'the company'}.\n\n${skillsLine(who)}`;
  const steady = steadyOf(ctx.templates, base, ASSISTANT_SKILLS, agent.overrides.base);
  const said = files ? steady.text : steady.whole;
  return { parts: steady.parts, raw: steady.parts.map(p => p.text).join('\n\n'), text: said, hash: textHash(said), skills: files ? steady.skills : [], whole: steady.whole };
}

async function headDepartment(db: Ctx['db'], agent: AgentRow): Promise<typeof departments.$inferSelect | undefined> {
  if (agent.kind !== 'head' || !agent.departmentId) return undefined;
  const [dept] = await db.select().from(departments).where(eq(departments.id, agent.departmentId));
  return dept;
}

async function appendDepartmentNotebook(
  db: Ctx['db'],
  rendered: Rendered,
  dept: typeof departments.$inferSelect,
  files: boolean,
): Promise<Rendered> {
  const notebook = await notebookPart(db, departmentBook(dept), notebookRoom(rendered.text, files));
  if (!notebook) return rendered;
  return { ...rendered, parts: [...rendered.parts, notebookOf(notebook)], text: `${rendered.text}\n\n${notebook}` };
}

/* What an agent runs with now: the orchestrator's standing role with the company notebook, or an employee's rendered
   instructions, a head's with its department's notebook. The hash leaves a notebook out: a new note reaches the program
   as it starts again in the same session, or as it reads the notebook with its tool. So it does a skill's body, which
   the program reads from its file. files: the agent's node writes skill files; one that does not is told every skill in
   the text, which the hash covers then. */
export async function instructionsOf(ctx: Pick<Ctx, 'db' | 'templates'>, agent: AgentRow, files = true): Promise<Rendered> {
  if (agent.kind === 'orchestrator') return orchestratorInstructionsOf(ctx, agent, files);
  if (agent.kind === 'assistant') return assistantInstructionsOf(ctx, agent, files);
  const rendered = forNode(renderInstructions(ctx.templates, agent, await placeOf(ctx.db, agent)), files);
  const dept = await headDepartment(ctx.db, agent);
  return dept ? appendDepartmentNotebook(ctx.db, rendered, dept, files) : rendered;
}
