import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { companies, departments } from '../src/db/schema.js';
import { as, invitePerson, setUpCompany, testApp } from './helpers.js';

/* Where each person put the blocks of the company map: their own arrangement, kept on the server so it follows them to
   another device, and nobody else's map moves with it. */

async function company() {
  const { app, db } = await testApp();
  const ceo = await setUpCompany(app);
  const [acme] = await db.select().from(companies);
  const [dev] = await db.insert(departments).values({ companyId: acme!.id, templateKey: 'development', roleCode: 'DEV', position: 1 }).returning();
  const ann = await invitePerson(app, ceo, { name: 'Ann', email: 'ann@acme.com', access: { departments: [dev!.id] } });
  const layout = (token: string) => app.inject({ url: '/api/map/layout', ...as(token) });
  const place = (token: string, blocks: Record<string, unknown>) => app.inject({ method: 'PATCH', url: '/api/map/layout', payload: { blocks }, ...as(token) });
  const bend = (token: string, anchors: Record<string, unknown>) => app.inject({ method: 'PATCH', url: '/api/map/layout', payload: { anchors }, ...as(token) });
  const reset = (token: string) => app.inject({ method: 'DELETE', url: '/api/map/layout', ...as(token) });
  return { app, ceo, ann, dev: dev!, layout, place, bend, reset };
}

describe('the arrangement of the company map', () => {
  it('starts empty, keeps where a person put each block, and gives it back', async () => {
    const c = await company();
    expect((await c.layout(c.ceo)).json()).toEqual({ blocks: {}, anchors: {} });
    const dept = `dept:${c.dev.id}`;
    const placed = await c.place(c.ceo, { hub: { x: 480, y: 300 }, [dept]: { x: -40.5, y: 720 } });
    expect(placed.statusCode).toBe(200);
    expect(placed.json()).toEqual({ blocks: { hub: { x: 480, y: 300 }, [dept]: { x: -40.5, y: 720 } }, anchors: {} });
    expect((await c.layout(c.ceo)).json()).toEqual(placed.json());
  });

  it('changes only the blocks it is given, and takes one back to its own place with null', async () => {
    const c = await company();
    const person = `person:${randomUUID()}`;
    await c.place(c.ceo, { hub: { x: 480, y: 300 }, [person]: { x: 10, y: 20 } });
    await c.place(c.ceo, { [person]: { x: 30, y: 40 } });
    expect((await c.layout(c.ceo)).json()).toEqual({ blocks: { hub: { x: 480, y: 300 }, [person]: { x: 30, y: 40 } }, anchors: {} });
    expect((await c.place(c.ceo, { hub: null })).json()).toEqual({ blocks: { [person]: { x: 30, y: 40 } }, anchors: {} });
  });

  it('lets anyone who sees the map arrange their own, and moves nobody else\'s', async () => {
    const c = await company();
    expect((await c.place(c.ann, { hub: { x: 100, y: 100 } })).statusCode).toBe(200);
    expect((await c.layout(c.ceo)).json()).toEqual({ blocks: {}, anchors: {} });
    await c.place(c.ceo, { hub: { x: 900, y: 50 } });
    expect((await c.layout(c.ann)).json()).toEqual({ blocks: { hub: { x: 100, y: 100 } }, anchors: {} });
  });

  it('puts everything back as it was', async () => {
    const c = await company();
    await c.place(c.ann, { hub: { x: 100, y: 100 } });
    await c.place(c.ceo, { hub: { x: 900, y: 50 } });
    expect((await c.reset(c.ann)).statusCode).toBe(204);
    expect((await c.layout(c.ann)).json()).toEqual({ blocks: {}, anchors: {} });
    expect((await c.layout(c.ceo)).json()).toEqual({ blocks: { hub: { x: 900, y: 50 } }, anchors: {} });
    expect((await c.reset(c.ann)).statusCode).toBe(204);
  });

  it('takes only blocks of the map at a place on it', async () => {
    const c = await company();
    for (const blocks of [
      { 'agent:x': { x: 1, y: 1 } },
      { 'dept:not-an-id': { x: 1, y: 1 } },
      { hub: { x: 'far', y: 1 } },
      { hub: { x: 1 } },
      { hub: { x: 1e9, y: 1 } },
      Object.fromEntries(Array.from({ length: 501 }, () => [`person:${randomUUID()}`, { x: 1, y: 1 }])),
    ]) expect((await c.place(c.ceo, blocks)).statusCode, JSON.stringify(blocks).slice(0, 80)).toBe(400);
    expect((await c.app.inject({ method: 'PATCH', url: '/api/map/layout', payload: {}, ...as(c.ceo) })).statusCode).toBe(400);
    expect((await c.layout(c.ceo)).json()).toEqual({ blocks: {}, anchors: {} });
  });

  it('keeps no more blocks than a map can have, counting what is there already', async () => {
    const c = await company();
    const many = (n: number) => Object.fromEntries(Array.from({ length: n }, () => [`person:${randomUUID()}`, { x: 1, y: 1 }]));
    expect((await c.place(c.ceo, many(500))).statusCode).toBe(200);
    expect((await c.place(c.ceo, many(1))).statusCode).toBe(400);
    expect(Object.keys((await c.layout(c.ceo)).json().blocks)).toHaveLength(500);
  });

  it('keeps the bends a person put on the lines of the map, a line at a time, apart from the blocks', async () => {
    const c = await company();
    const trace = `dept:${c.dev.id}`, own = `person:${randomUUID()}:dept:${c.dev.id}`;
    const bent = await c.bend(c.ceo, { [trace]: [[684, 300], [700.5, 250]], people: [[600, 200]] });
    expect(bent.statusCode).toBe(200);
    expect(bent.json()).toEqual({ blocks: {}, anchors: { [trace]: [[684, 300], [700.5, 250]], people: [[600, 200]] } });
    /* A line's bends come whole, and null takes all of them away. */
    await c.bend(c.ceo, { [own]: [[10, 20]], people: null, [trace]: [[684, 320]] });
    await c.place(c.ceo, { hub: { x: 480, y: 300 } });
    expect((await c.layout(c.ceo)).json()).toEqual({ blocks: { hub: { x: 480, y: 300 } }, anchors: { [trace]: [[684, 320]], [own]: [[10, 20]] } });
    expect((await c.layout(c.ann)).json()).toEqual({ blocks: {}, anchors: {} });
  });

  it('puts the bends back with the blocks', async () => {
    const c = await company();
    await c.bend(c.ann, { people: [[600, 200]] });
    await c.bend(c.ceo, { people: [[610, 210]] });
    expect((await c.reset(c.ann)).statusCode).toBe(204);
    expect((await c.layout(c.ann)).json()).toEqual({ blocks: {}, anchors: {} });
    expect((await c.layout(c.ceo)).json()).toEqual({ blocks: {}, anchors: { people: [[610, 210]] } });
  });

  it('takes only bends of the lines of the map, at places on it, and not too many', async () => {
    const c = await company();
    const id = randomUUID();
    for (const anchors of [
      { hub: [[1, 1]] },
      { 'dept:not-an-id': [[1, 1]] },
      { [`dept:${id}:person:${id}`]: [[1, 1]] },
      { people: [] },
      { people: [[1]] },
      { people: [{ x: 1, y: 1 }] },
      { people: [[1e9, 1]] },
      { people: Array.from({ length: 21 }, (_, i) => [i, i]) },
      Object.fromEntries(Array.from({ length: 501 }, () => [`dept:${randomUUID()}`, [[1, 1]]])),
    ]) expect((await c.bend(c.ceo, anchors)).statusCode, JSON.stringify(anchors).slice(0, 80)).toBe(400);
    expect((await c.layout(c.ceo)).json()).toEqual({ blocks: {}, anchors: {} });
  });

  it('keeps no more bent lines than a map can have, counting what is there already', async () => {
    const c = await company();
    const many = (n: number) => Object.fromEntries(Array.from({ length: n }, () => [`dept:${randomUUID()}`, [[1, 1]]]));
    expect((await c.bend(c.ceo, many(500))).statusCode).toBe(200);
    expect((await c.bend(c.ceo, many(1))).statusCode).toBe(400);
    expect(Object.keys((await c.layout(c.ceo)).json().anchors)).toHaveLength(500);
  });

  it('asks who it is', async () => {
    const c = await company();
    expect((await c.app.inject({ url: '/api/map/layout' })).statusCode).toBe(401);
    expect((await c.app.inject({ method: 'PATCH', url: '/api/map/layout', payload: { blocks: {} } })).statusCode).toBe(401);
    expect((await c.app.inject({ method: 'DELETE', url: '/api/map/layout' })).statusCode).toBe(401);
  });
});
