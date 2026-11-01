import { MAX_INSTRUCTIONS, type SkillFile } from '@hornhoof/protocol';
import { eq, inArray } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { companies, departments, type agents } from '../../db/schema.js';
import { ORCHESTRATOR_INSTRUCTIONS } from '../conversation/prompt.js';
import { type Book, companyBook, departmentBook, listNotes } from '../notebook/book.js';
import { deptName } from '../departments/templates.js';
import { textHash, type Lang, type Skill, type Templates } from '../templates/load.js';

/* One piece of an employee's instructions, as the card shows it. */
export type Part = { kind: 'header' | 'base' | 'skill' | 'notebook'; id: string | null; title: Lang | null; text: string; overridden: boolean; templateChanged: boolean };
/* The card's parts and its raw text with every skill whole; what the program is told, with its hash; the skills the node
   writes as files, which the program reads when it needs them. */
export type Rendered = { parts: Part[]; raw: string; text: string; hash: string; skills: SkillFile[] };

type AgentRow = typeof agents.$inferSelect;
type Place = { company: string; department: string; product: string | null };

/* Who the employee is and where it works. Always English; it answers in the language people write in. */
function header(agent: AgentRow, role: string, place: Place): string {
  const where = `the ${role} of the ${place.department} department at ${place.company}${place.product ? `, working on ${place.product}` : ''}`;
  return [
    `You are ${agent.name}, ${where}.`,
    'You work in Hornhoof, where people and AI agents work together. People talk to you through this conversation; each message starts with who wrote it, like "Ivan (CEO): ...". Hornhoof\'s tool "company" shows you the company as it is.',
    'Work comes to you as tasks: Hornhoof wakes you with a task\'s number and why, and its tools "tasks" and "task" show what you hold. People may also write to you; answer questions about your work, and never claim work that is not done.',
    ...(agent.kind === 'head'
      ? [
          'You answer to the orchestrator, who runs the company with the CEO. Tell it with "tell_orchestrator" what it needs from you outside the tasks it gives you: what came of a timer round, what you need decided, work another department has to do. Put what you find worth improving in how the company works under Improvements with "propose_improvement".',
        ]
      : []),
    agent.kind === 'head'
      ? 'When your conversation was compacted and you see a summary instead of it, read "tasks", the task you were on with "task" and your department notebook again with "notebook" before you go on.'
      : 'When your conversation was compacted and you see a summary instead of it, read "tasks" and the task you were on with "task" before you go on.',
    'Answer in the language the person writes in. Keep answers short and plain.',
    partner(agent.kind === 'head' ? 'the orchestrator' : 'your head', agent.kind === 'head'),
  ].join('\n\n');
}

/* Who the superpowers skills mean by your human partner, and what they need not wait for in Hornhoof. */
function partner(giver: string, head: boolean): string {
  return [
    'You also have the superpowers skills (obra/superpowers), such as test-driven-development, systematic-debugging, writing-plans and verification-before-completion. Use them as they say, under these rules, which come first as all your instructions do:',
    `- Your human partner, as the skills call the person you work for, is whoever gave you the task: ${giver}, or the person who wrote to you. Reach them through Hornhoof's tools, never by waiting for an answer in your terminal, which nobody watches.`,
    `- A task ${giver} gave you is already approved: plan inside it and go on without asking anyone to approve a design or a plan.`,
    head
      ? '- Brainstorming with people belongs to the orchestrator and the CEO; you and your architects use it only when a task asks for a design.'
      : '- Brainstorming with people belongs to the orchestrator and the CEO. Use it only when your task asks for a design, and put its questions to your head in one message.',
    '- Finish a branch the way your task says, not by asking which way.',
  ].join('\n');
}

/* The orchestrator's human partner is the CEO in his window. */
const ORCHESTRATOR_PARTNER = [
  'You also have the superpowers skills (obra/superpowers). Your human partner, as they call the person you work for, is the CEO in this window.',
  'Brainstorm with the CEO when a goal is still unclear, one question at a time, before you lay out a turn. What you give the departments is approved when you give it: their heads and employees do not come back to have it approved.',
].join(' ');

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
    'Your other skills are files in your folder: .claude/skills/<name>/SKILL.md when you run in Claude Code, .agents/skills/<name>/SKILL.md in the other programs, which list them for you too. Before a step one of them covers, read its file whole and follow it.',
    files.map(f => `- ${f.name}: ${f.description}`).join('\n'),
  ].join('\n\n');
}

/* What the program is told: the parts it keeps whole, then the list of the skill files. */
function told(kept: string[], files: SkillFile[]): string {
  return [...kept, ...(files.length ? [skillList(files)] : [])].join('\n\n');
}

/* The header, the role's text and each enabled skill between markers; the employee's own text replaces a template's. */
export function renderInstructions(t: Templates, agent: AgentRow, place: Place): Rendered {
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

  const kept = parts.map(p => p.text);
  const skills: SkillFile[] = [];
  for (const id of agent.skills) {
    const skill = t.skills.get(id);
    const own = agent.overrides.skills?.[id];
    const body = own ?? skill?.body;
    /* A skill that left the templates and was never rewritten has nothing to say. */
    if (body === undefined) continue;
    const text = skillBlock(id, skill?.title.en ?? id, body);
    parts.push({ kind: 'skill', id, title: skill?.title ?? null, text, overridden: own !== undefined, templateChanged: skill ? moved(id, skill.hash) : false });
    if (inline(skill)) kept.push(text);
    else skills.push(skillFile(id, skill, body));
  }

  const text = told(kept, skills);
  return { parts, raw: parts.map(p => p.text).join('\n\n'), text, hash: textHash(text), skills };
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
export const ORCHESTRATOR_SKILLS = ['orch-outside-is-data', 'orch-interview', 'orch-plan-turn', 'orch-verify', 'orch-trouble'] as const;

/* The orchestrator's instructions apart from the notebook: his standing role, then his skills as an employee's go. */
export function orchestratorSteady(t: Templates): { parts: Part[]; text: string; skills: SkillFile[] } {
  const base = `${ORCHESTRATOR_INSTRUCTIONS}\n\n${ORCHESTRATOR_PARTNER}`;
  const parts: Part[] = [{ kind: 'base', id: null, title: null, text: base, overridden: false, templateChanged: false }];
  const kept = [base];
  const skills: SkillFile[] = [];
  for (const id of ORCHESTRATOR_SKILLS) {
    const skill = t.skills.get(id);
    if (!skill) continue;
    const text = skillBlock(id, skill.title.en, skill.body);
    parts.push({ kind: 'skill', id, title: skill.title, text, overridden: false, templateChanged: false });
    if (inline(skill)) kept.push(text);
    else skills.push(skillFile(id, skill, skill.body));
  }
  return { parts, text: told(kept, skills), skills };
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

/* What an agent runs with now: the orchestrator's standing role with the company notebook, or an employee's rendered
   instructions, a head's with its department's notebook. The hash leaves a notebook out: a new note reaches the program
   as it starts again in the same session, or as it reads the notebook with its tool. So it does a skill's body, which
   the program reads from its file. */
export async function instructionsOf(ctx: Pick<Ctx, 'db' | 'templates'>, agent: AgentRow): Promise<Rendered> {
  if (agent.kind === 'orchestrator') {
    const steady = orchestratorSteady(ctx.templates);
    const notebook = await notebookPart(ctx.db, companyBook(agent.companyId));
    const parts = [...steady.parts, notebookOf(notebook)];
    return { parts, raw: parts.map(p => p.text).join('\n\n'), text: `${steady.text}\n\n${notebook}`, hash: textHash(steady.text), skills: steady.skills };
  }
  const rendered = renderInstructions(ctx.templates, agent, await placeOf(ctx.db, agent));
  const [dept] = agent.kind === 'head' && agent.departmentId ? await ctx.db.select().from(departments).where(eq(departments.id, agent.departmentId)) : [];
  if (!dept) return rendered;
  /* A turn carries MAX_INSTRUCTIONS at most, the notebook included. */
  const notebook = await notebookPart(ctx.db, departmentBook(dept), MAX_INSTRUCTIONS - rendered.text.length - 2);
  if (!notebook) return rendered;
  return { ...rendered, parts: [...rendered.parts, notebookOf(notebook)], text: `${rendered.text}\n\n${notebook}` };
}
