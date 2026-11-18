import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { orchestratorHeaders } from '../src/auth/internal.js';
import { people, proposals, requests } from '../src/db/schema.js';
import { as } from './helpers.js';
import { everyKind, staffed, registerAnswerCases } from './decisions-company.js';

describe('who may answer, by decision rights', () => {
  registerAnswerCases(['devPlain', 'mktQuestion']);
it("takes the orchestrator's own call, with no turn of a person in it, as the owner's answer", async () => {
    const c = await everyKind();
    const res = await c.app.inject({ method: 'POST', url: `/api/requests/${c.salesQuestion.request.id}`, payload: { pick: 0 }, headers: orchestratorHeaders(c.ids.ivan, c.orchestrator.id) });
    expect(res.statusCode, res.body).toBe(200);
    const [row] = await c.db.select().from(requests).where(eq(requests.id, c.salesQuestion.request.id));
    expect(row).toMatchObject({ status: 'answered', picked: 0 });
  });

it('shows standing access to people of the whole company and keeps its switch with the owner', async () => {
  const c = await staffed();
  const inside = { headers: orchestratorHeaders(c.ids.ivan, c.orchestrator.id) };
  for (const who of [as(c.tokens.zed), as(c.tokens.delegate), inside]) {
    expect((await c.app.inject({ url: '/api/computer', ...who })).json()).toMatchObject({ open: true, canAnswer: false });
    expect((await c.app.inject({ method: 'POST', url: '/api/computer/close', ...who })).statusCode).toBe(403);
  }
  expect((await c.app.inject({ url: '/api/computer', ...as(c.tokens.dan) })).statusCode).toBe(403);
  expect((await c.app.inject({ method: 'POST', url: '/api/computer/close', ...as(c.tokens.ceo) })).json()).toMatchObject({ open: false });
});

it('lets only the CEO and the delegate apply the structure card, and the people of a department its staff, with or without the card', async () => {
    const c = await staffed();
    for (const token of [c.tokens.zed, c.tokens.dan]) {
      for (const payload of [{ proposalId: c.structure.id, items: [] }, { items: [] }]) {
        const res = await c.app.inject({ method: 'POST', url: '/api/departments/build', payload, ...as(token) });
        expect(res.statusCode).toBe(403);
      }
    }
    /* Dan, given Development, staffs it: an empty list is refused for what it says, not for who sends it. */
    for (const [token, refused] of [[c.tokens.zed, true], [c.tokens.dan, false]] as const) {
      for (const payload of [{ proposalId: c.staff.id, people: [] }, { people: [] }]) {
        const res = await c.app.inject({ method: 'POST', url: `/api/departments/${c.dev.id}/staff`, payload, ...as(token) });
        if (refused) expect([403, 404]).toContain(res.statusCode);
        else expect([403, 404]).not.toContain(res.statusCode);
      }
    }
    const zedsTry = await c.app.inject({ method: 'POST', url: '/api/departments/build', payload: { proposalId: c.structure.id, items: [] }, ...as(c.tokens.zed) });
    expect(zedsTry.json().error.reason).toBe('decision_not_allowed');
    const [still] = await c.db.select().from(proposals).where(eq(proposals.id, c.structure.id));
    expect(still!.status).toBe('pending');
    const byDelegate = await c.app.inject({ method: 'POST', url: '/api/departments/build', payload: { proposalId: c.structure.id, items: [{ template: 'support', checked: true, note: 'Answers customers.' }] }, ...as(c.tokens.delegate) });
    expect(byDelegate.statusCode).toBe(201);
    const [applied] = await c.db.select().from(proposals).where(eq(proposals.id, c.structure.id));
    const [dave] = await c.db.select().from(people).where(eq(people.name, 'Dave'));
    expect(applied).toMatchObject({ status: 'applied', appliedBy: dave!.id });
  });
});
