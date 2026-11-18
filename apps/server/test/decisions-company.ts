import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { agents, companies, departments, people, proposals, requests, subscriptions, teams } from '../src/db/schema.js';
import { ask, createTask } from '../src/modules/tasks/engine.js';
import { as, invitePerson, setUpCompany, testApp } from './helpers.js';
import { SERVER_MACHINE_ENV, serverMachine } from './helpers-computer.js';

type DecidedBy = { kind: 'ceo_and_delegate' | 'department_and_ceo' | 'machine_owner'; department: { id: string; name: string } | null };

type View = {
  requests: { id: string; ownerPersonId: string; canAnswer: boolean; decidedBy: DecidedBy; explained: string | null; task: { number: number } }[];
  proposals: { id: string; kind: string; ownerPersonId: string; canAnswer: boolean; decidedBy: DecidedBy; brief: string; department: { id: string } | null }[];
  addressed: { id: string; canAnswer: boolean; ownerPersonId: string }[];
  machineAccess: { kind: string; id: string; ownerPersonId: string; canAnswer: boolean; decidedBy: DecidedBy; view: { asked: { reason: string } | null } }[];
  counts: { byPerson: Record<string, number>; byAgent: Record<string, number>; total: number };
};

/* Acme with Development, where Dan is the only person; Sales, which Sara and Olga share; Marketing without anyone; Zed,
   who sees the whole company; and Tia, who reaches one team of Development. */
export async function company() {
  const control = mkdtempSync(join(tmpdir(), 'hh-control-'));
  const { app, db } = await testApp({ HORNHOOF_CONTROL_DIR: control, ...SERVER_MACHINE_ENV });
  const ceo = await setUpCompany(app);
  const ctx = app.ctx;
  /* The machine the server runs on, which the CEO owns. */
  const machine = await serverMachine(app);
  const [acme] = await db.select().from(companies);
  const [sub] = await db.select().from(subscriptions);
  const [orchestrator] = await db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
  const dept = async (templateKey: 'development' | 'sales' | 'marketing', position: number) =>
    (await db.insert(departments).values({ companyId: acme!.id, templateKey, roleCode: templateKey.slice(0, 3).toUpperCase(), position }).returning())[0]!;
  const [dev, sales, mkt] = [await dept('development', 0), await dept('sales', 1), await dept('marketing', 2)];
  const [devTeam] = await db.insert(teams).values({ companyId: acme!.id, departmentId: dev.id, name: 'Web' }).returning();
  const hire = async (name: string, kind: 'head' | 'worker', departmentId: string) =>
    (await db.insert(agents).values({ companyId: acme!.id, kind, name, roleKey: kind === 'head' ? 'DEV-HEAD' : 'DEV-BE', departmentId, model: '', subscriptionId: sub!.id }).returning())[0]!;
  const heads = { dev: await hire('Hana', 'head', dev.id), sales: await hire('Sven', 'head', sales.id), mkt: await hire('Mila', 'head', mkt.id) };
  const workers = { dev: await hire('Bruno', 'worker', dev.id), sales: await hire('Sam', 'worker', sales.id), mkt: await hire('Mo', 'worker', mkt.id) };
  const tokens = {
    ceo,
    dan: await invitePerson(app, ceo, { name: 'Dan', email: 'dan@acme.com', access: { departments: [dev.id], teams: [] } }),
    sara: await invitePerson(app, ceo, { name: 'Sara', email: 'sara@acme.com', access: { departments: [sales.id], teams: [] } }),
    olga: await invitePerson(app, ceo, { name: 'Olga', email: 'olga@acme.com', access: { departments: [sales.id], teams: [] } }),
    zed: await invitePerson(app, ceo, { name: 'Zed', email: 'zed@acme.com', access: { whole: true } }),
    tia: await invitePerson(app, ceo, { name: 'Tia', email: 'tia@acme.com', access: { departments: [], teams: [devTeam!.id] } }),
  };
  const ids = Object.fromEntries((await db.select().from(people)).map(p => [p.name.toLowerCase(), p.id])) as Record<'ivan' | 'dan' | 'sara' | 'olga' | 'zed' | 'tia', string>;
  /* Each question on a task of its own, held by the asking employee. */
  const asking = async (where: keyof typeof workers, q: Parameters<typeof ask>[3]) => {
    const deptId = { dev: dev.id, sales: sales.id, mkt: mkt.id }[where];
    const { task } = await createTask(ctx, { agentId: heads[where].id }, { title: `About ${q.text}`, brief: '', body: '', departmentId: deptId, assigneeAgentId: workers[where].id, executor: true });
    return { task, request: (await ask(ctx, workers[where].id, task.id, q)).request };
  };
  const view = async (token: string, query = ''): Promise<View> => (await app.inject({ url: `/api/requests${query}`, ...as(token) })).json();
  return { app, db, ctx, control, machine, acme: acme!, sub: sub!, orchestrator: orchestrator!, dev, sales, mkt, devTeam: devTeam!, heads, workers, tokens, ids, asking, view };
}

/* Every kind of decision at once: a department question with its own person, an approval there, a question on a topic
   only the CEO decides, a question without a topic, a shared department's question, an unstaffed department's question,
   and both of the orchestrator's cards. */
export async function everyKind() {
  const c = await company();
  const devQuestion = await c.asking('dev', { kind: 'question', text: 'Which cards do we take?', topic: 'task' });
  const devApproval = await c.asking('dev', { kind: 'approval', text: 'Merge the checkout?', commit: 'a'.repeat(40), topic: 'task' });
  const devPeople = await c.asking('dev', { kind: 'question', text: 'Hire a designer?', topic: 'people' });
  const devPlain = await c.asking('dev', { kind: 'question', text: 'An older kind of question' });
  const salesQuestion = await c.asking('sales', { kind: 'choice', text: 'Which price?', options: [{ label: '9', image: null }, { label: '12', image: null }], topic: 'task' });
  const mktQuestion = await c.asking('mkt', { kind: 'question', text: 'Which channel?', topic: 'employee' });
  /* The cards a second apart, structure first: two written in the same millisecond would be put in order by their
     random ids. */
  const at = Date.now();
  const [structure] = await c.db.insert(proposals).values({ companyId: c.acme.id, agentId: c.orchestrator.id, brief: 'Add Support.', items: [], createdAt: new Date(at) }).returning();
  const [staff] = await c.db.insert(proposals).values({ companyId: c.acme.id, agentId: c.orchestrator.id, kind: 'staff', departmentId: c.dev.id, brief: 'Hire a reviewer.', items: [], createdAt: new Date(at + 1000) }).returning();
  return { ...c, devQuestion, devApproval, devPeople, devPlain, salesQuestion, mktQuestion, structure: structure!, staff: staff! };
}

export const ownersOf = (v: View) => Object.fromEntries(v.requests.map(r => [r.id, r.ownerPersonId]));

/* Each decision with whom it lets take it (200), whom it refuses while they see it (403) and from whom it stays out of
   sight (404). Each answer goes to a fresh company, as an answer closes its request. */
type Who = 'ceo' | 'delegate' | 'zed' | 'dan' | 'eve' | 'sara' | 'olga' | 'tia';

type Kind = 'devQuestion' | 'devApproval' | 'devPeople' | 'devPlain' | 'salesQuestion' | 'mktQuestion';

const answers: Record<Kind, object> = {
  devQuestion: { answer: 'Visa.' },
  devApproval: { approve: true },
  devPeople: { answer: 'Not yet.' },
  devPlain: { answer: 'Yes.' },
  salesQuestion: { pick: 0 },
  mktQuestion: { answer: 'Email.' },
};

const matrix: Record<Kind, Partial<Record<Who, 200 | 403 | 404>>> = {
  devQuestion: { ceo: 200, delegate: 200, zed: 403, dan: 200, eve: 200, sara: 403, tia: 403 },
  devApproval: { ceo: 200, delegate: 200, zed: 403, dan: 200, eve: 200, sara: 403, tia: 403 },
  devPeople: { ceo: 200, delegate: 200, zed: 403, dan: 403, sara: 403 },
  devPlain: { ceo: 200, delegate: 200, zed: 403, dan: 403, sara: 403 },
  salesQuestion: { ceo: 200, delegate: 200, zed: 403, sara: 200, olga: 200, dan: 403 },
  mktQuestion: { ceo: 200, delegate: 200, zed: 403, dan: 403, sara: 403 },
};

export async function staffed() {
  const c = await everyKind();
  const delegate = await invitePerson(c.app, c.tokens.ceo, { name: 'Dave', email: 'dave@acme.com', access: { whole: true } });
  const [dave] = await c.db.select().from(people).where(eq(people.name, 'Dave'));
  await c.app.inject({ method: 'PUT', url: `/api/people/${dave!.id}/ceo-delegate`, payload: { isCeoDelegate: true }, ...as(c.tokens.ceo) });
  /* A second person of Development, so its questions go to the CEO's count; both of them still take them. */
  const eve = await invitePerson(c.app, c.tokens.ceo, { name: 'Eve', email: 'eve@acme.com', access: { departments: [c.dev.id], teams: [] } });
  const tokens: Record<Who, string> = { ...c.tokens, delegate, eve };
  return { ...c, tokens };
}

export function registerAnswerCases(kinds: readonly Kind[]) {
  for (const kind of kinds) {
    const whom = matrix[kind];
    for (const [who, status] of Object.entries(whom) as [Who, number][]) {
      it(`${kind}: ${who} gets ${status}`, async () => {
        const c = await staffed();
        const id = c[kind].request.id;
        const res = await c.app.inject({ method: 'POST', url: `/api/requests/${id}`, payload: answers[kind], ...as(c.tokens[who]) });
        expect(res.statusCode).toBe(status);
        if (status === 403) expect(res.json().error.reason).toBe('decision_not_allowed');
        const [row] = await c.db.select().from(requests).where(eq(requests.id, id));
        expect(row!.status === 'open').toBe(status !== 200);
        if (status !== 200) expect(row).toMatchObject({ answeredBy: null, answer: null, picked: null });
        /* What is not theirs to take does not show at all, unless its agent is one they see: everyone given Development sees
           every agent of it, and reads a decision only the CEO takes without the right to answer it. */
        const seen = await c.view(c.tokens[who]);
        const shown = [...seen.requests, ...seen.addressed].find(r => r.id === id);
        if (status === 403 && kind.startsWith('dev') && (who === 'dan' || who === 'eve')) expect(shown).toMatchObject({ canAnswer: false });
        else if (status === 403) expect(shown).toBeUndefined();
      });
    }
  }
}
