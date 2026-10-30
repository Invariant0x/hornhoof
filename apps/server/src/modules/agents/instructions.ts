import { eq, inArray } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import { companies, departments, type agents } from '../../db/schema.js';
import { ORCHESTRATOR_INSTRUCTIONS } from '../conversation/prompt.js';
import { deptName } from '../departments/templates.js';
import { textHash, type Lang, type Templates } from '../templates/load.js';

/* One piece of an employee's instructions, as the card shows it. */
export type Part = { kind: 'header' | 'base' | 'skill'; id: string | null; title: Lang | null; text: string; overridden: boolean; templateChanged: boolean };

type AgentRow = typeof agents.$inferSelect;
type Place = { company: string; department: string; product: string | null };

/* Who the employee is and where it works. Always English; it answers in the language people write in. */
function header(agent: AgentRow, role: string, place: Place): string {
  const where = `the ${role} of the ${place.department} department at ${place.company}${place.product ? `, working on ${place.product}` : ''}`;
  return [
    `You are ${agent.name}, ${where}.`,
    'You work in Hornhoof, where people and AI agents work together. People talk to you through this conversation; each message starts with who wrote it, like "Ivan (CEO): ...". Hornhoof\'s tool "company" shows you the company as it is.',
    'Tasks for you arrive in a later version of Hornhoof. For now, answer questions about your work and help people think it through; do not claim to have done work you cannot do here.',
    'Answer in the language the person writes in. Keep answers short and plain.',
  ].join('\n\n');
}

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
      text: `<!-- hh:skill ${id} -->\n## ${skill?.title.en ?? id}\n\n${body}\n<!-- /hh:skill -->`,
      overridden: own !== undefined,
      templateChanged: skill ? moved(id, skill.hash) : false,
    });
  }

  const text = parts.map(p => p.text).join('\n\n');
  return { parts, text, hash: textHash(text) };
}

/* The longest instructions an employee may run with; the default roles stay under 19,000 characters. */
export const MAX_INSTRUCTIONS = 24_000;

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

/* What an agent runs with now: the orchestrator's standing role, or an employee's rendered instructions. */
export async function instructionsOf(ctx: Pick<Ctx, 'db' | 'templates'>, agent: AgentRow): Promise<{ parts: Part[]; text: string; hash: string }> {
  if (agent.kind === 'orchestrator') {
    const text = ORCHESTRATOR_INSTRUCTIONS;
    return { parts: [{ kind: 'base', id: null, title: null, text, overridden: false, templateChanged: false }], text, hash: textHash(text) };
  }
  return renderInstructions(ctx.templates, agent, await placeOf(ctx.db, agent));
}
