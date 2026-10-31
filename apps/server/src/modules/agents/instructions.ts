import { eq, inArray } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { companies, departments, type agents } from '../../db/schema.js';
import { ORCHESTRATOR_INSTRUCTIONS } from '../conversation/prompt.js';
import { type Book, companyBook, departmentBook, listNotes } from '../notebook/book.js';
import { deptName } from '../departments/templates.js';
import { textHash, type Lang, type Templates } from '../templates/load.js';

/* One piece of an employee's instructions, as the card shows it. */
export type Part = { kind: 'header' | 'base' | 'skill' | 'notebook'; id: string | null; title: Lang | null; text: string; overridden: boolean; templateChanged: boolean };

type AgentRow = typeof agents.$inferSelect;
type Place = { company: string; department: string; product: string | null };

/* Who the employee is and where it works. Always English; it answers in the language people write in. */
function header(agent: AgentRow, role: string, place: Place): string {
  const where = `the ${role} of the ${place.department} department at ${place.company}${place.product ? `, working on ${place.product}` : ''}`;
  return [
    `You are ${agent.name}, ${where}.`,
    'You work in Hornhoof, where people and AI agents work together. People talk to you through this conversation; each message starts with who wrote it, like "Ivan (CEO): ...". Hornhoof\'s tool "company" shows you the company as it is.',
    'Work comes to you as tasks: Hornhoof wakes you with a task\'s number and why, and its tools "tasks" and "task" show what you hold. People may also write to you; answer questions about your work, and never claim work that is not done.',
    agent.kind === 'head'
      ? 'When your conversation was compacted and you see a summary instead of it, read "tasks", the task you were on with "task" and your department notebook again with "notebook" before you go on.'
      : 'When your conversation was compacted and you see a summary instead of it, read "tasks" and the task you were on with "task" before you go on.',
    'Answer in the language the person writes in. Keep answers short and plain.',
  ].join('\n\n');
}

/* A skill as instructions carry it, between markers the card finds it by. */
const skillBlock = (id: string, title: string, body: string) => `<!-- hh:skill ${id} -->\n## ${title}\n\n${body}\n<!-- /hh:skill -->`;

/* The header, the role's text and each enabled skill between markers; the employee's own text replaces a template's. */
export function renderInstructions(t: Templates, agent: AgentRow, place: Place): { parts: Part[]; text: string; hash: string } {
  const role = agent.roleKey ? t.roles.get(agent.roleKey) : undefined;
  const hired = agent.templateHashes;
  const moved = (id: string, hash: string) => hired[id] !== undefined && hired[id] !== hash;
  const parts: Part[] = [{ kind: 'header', id: null, title: null, text: header(agent, role?.title.en ?? 'employee', place), overridden: false, templateChanged: false }];

  const base = agent.overrides.base ?? role?.body;
  if (base !== undefined) {
    parts.push({
      kind: 'base',
      id: role?.id ?? null,
      title: role?.title ?? null,
      text: base,
      overridden: agent.overrides.base !== undefined,
      templateChanged: role ? moved(role.id, role.hash) : false,
    });
  }

  for (const id of agent.skills) {
    const skill = t.skills.get(id);
    const own = agent.overrides.skills?.[id];
    const body = own ?? skill?.body;
    /* A skill that left the templates and was never rewritten has nothing to say. */
    if (body === undefined) continue;
    parts.push({
      kind: 'skill',
      id,
      title: skill?.title ?? null,
      text: skillBlock(id, skill?.title.en ?? id, body),
      overridden: own !== undefined,
      templateChanged: skill ? moved(id, skill.hash) : false,
    });
  }

  const text = parts.map(p => p.text).join('\n\n');
  return { parts, text, hash: textHash(text) };
}

/* The names an employee's header uses: its company, department and product. */
export async function placeOf(db: Ctx['db'], agent: AgentRow): Promise<Place> {
  const [company] = await db.select({ name: companies.name }).from(companies).where(eq(companies.id, agent.companyId));
  const ids = [agent.departmentId, agent.productId].filter((id): id is string => Boolean(id));
  const depts = ids.length ? await db.select().from(departments).where(inArray(departments.id, ids)) : [];
  const nameOf = (id: string | null) => {
    const d = depts.find(x => x.id === id);
    return d ? deptName(d) : null;
  };
  return { company: company?.name ?? '', department: nameOf(agent.departmentId) ?? '', product: nameOf(agent.productId) };
}

/* The orchestrator's own skills, always on after his standing role. */
export const ORCHESTRATOR_SKILLS = ['orch-interview', 'orch-plan-turn', 'orch-verify', 'orch-trouble'] as const;

/* The orchestrator's instructions apart from the notebook: his standing role and his skills. */
export function orchestratorSteady(t: Templates): string {
  const skills = ORCHESTRATOR_SKILLS.flatMap(id => {
    const skill = t.skills.get(id);
    return skill ? [skillBlock(id, skill.title.en, skill.body)] : [];
  });
  return [ORCHESTRATOR_INSTRUCTIONS, ...skills].join('\n\n');
}

/* A notebook as its agent reads it, each note with its number: the company's for the orchestrator, a department's for
   its head. */
export async function notebookPart(db: Ctx['db'], book: Book): Promise<string> {
  const notes = await listNotes(db, book);
  const lines = notes.length ? notes.map(n => `[#${n.number}] ${n.text}`).join('\n') : 'The notebook is empty.';
  return book.departmentId
    ? `## Department notebook\n\nWhat you and the people who run your department keep across conversations. Change it with remember, rewrite_note and forget.\n\n${lines}`
    : `## Company notebook\n\nWhat you and the people who run the company keep across conversations. Change it with remember, rewrite_note and forget.\n\n${lines}`;
}

const notebookOf = (text: string): Part => ({ kind: 'notebook', id: null, title: null, text, overridden: false, templateChanged: false });

/* What an agent runs with now: the orchestrator's standing role with the company notebook, or an employee's rendered
   instructions, a head's with its department's notebook. The hash leaves a notebook out: a new note reaches the program
   as it starts again in the same session, or as it reads the notebook with its tool. */
export async function instructionsOf(ctx: Pick<Ctx, 'db' | 'templates'>, agent: AgentRow): Promise<{ parts: Part[]; text: string; hash: string }> {
  if (agent.kind === 'orchestrator') {
    const steady = orchestratorSteady(ctx.templates);
    const notebook = await notebookPart(ctx.db, companyBook(agent.companyId));
    const skills = ORCHESTRATOR_SKILLS.flatMap(id => {
      const skill = ctx.templates.skills.get(id);
      return skill ? [{ kind: 'skill' as const, id, title: skill.title, text: skillBlock(id, skill.title.en, skill.body), overridden: false, templateChanged: false }] : [];
    });
    const parts: Part[] = [
      { kind: 'base', id: null, title: null, text: ORCHESTRATOR_INSTRUCTIONS, overridden: false, templateChanged: false },
      ...skills,
      notebookOf(notebook),
    ];
    return { parts, text: `${steady}\n\n${notebook}`, hash: textHash(steady) };
  }
  const rendered = renderInstructions(ctx.templates, agent, await placeOf(ctx.db, agent));
  const [dept] = agent.kind === 'head' && agent.departmentId ? await ctx.db.select().from(departments).where(eq(departments.id, agent.departmentId)) : [];
  if (!dept) return rendered;
  const notebook = await notebookPart(ctx.db, departmentBook(dept));
  return { parts: [...rendered.parts, notebookOf(notebook)], text: `${rendered.text}\n\n${notebook}`, hash: rendered.hash };
}
