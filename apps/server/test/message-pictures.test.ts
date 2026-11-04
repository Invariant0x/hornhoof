import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ServerMessage } from '@hornhoof/protocol';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { agentEvents, agents, attachments, departments, jobs, people } from '../src/db/schema.js';
import { dropOldFiles, PICTURE_BYTES } from '../src/modules/tasks/attachments.js';
import { as, connectNode, invitePerson, listen, setUpCompany, testApp, until, type FakeNode } from './helpers.js';

const NODE_KEY = 'k'.repeat(40);
const HH_FETCH = fileURLToPath(new URL('../../node/hh-fetch.cjs', import.meta.url));
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 2)]);

async function next<T extends ServerMessage['type']>(node: FakeNode, type: T): Promise<Extract<ServerMessage, { type: T }>> {
  for (;;) {
    const m = await node.next();
    if (m.type === type) return m as Extract<ServerMessage, { type: T }>;
  }
}

/* Acme: Bruno in Development and Sam in Sales run on one plan with the orchestrator. Maria has Development; Lisa is the CEO
   delegate. */
async function company() {
  const { app, db } = await testApp({ NODE_KEY });
  const url = await listen(app);
  const ceo = await setUpCompany(app);
  const builtin = await connectNode(url, NODE_KEY);
  builtin.send({ type: 'hello', version: '0.5.0', loggedIn: true, running: [], terminals: true });
  await until(async () => (await app.inject({ url: '/api/agents/orchestrator/events', ...as(ceo) })).json().state.ready);
  const [orchestrator] = await db.select().from(agents);
  const place = (name: string, roleCode: string) => db.insert(departments).values({ companyId: orchestrator!.companyId, name, roleCode }).returning();
  const [dev] = await place('Development', 'DEV');
  const [sales] = await place('Sales', 'SAL');
  const hire = (name: string, departmentId: string) => db.insert(agents).values({ companyId: orchestrator!.companyId, kind: 'worker', name, model: 'sonnet', departmentId, subscriptionId: orchestrator!.subscriptionId }).returning();
  const [bruno] = await hire('Bruno', dev!.id);
  const [sam] = await hire('Sam', sales!.id);
  const maria = await invitePerson(app, ceo, { name: 'Maria', email: 'maria@example.com', access: { departments: [dev!.id] } });
  const lisa = await invitePerson(app, ceo, { name: 'Lisa', email: 'lisa@example.com', access: { whole: true } });
  const everyone = await db.select().from(people);
  const idOf = (name: string) => everyone.find(p => p.name === name)!.id;
  await app.inject({ method: 'PUT', url: `/api/people/${idOf('Lisa')}/ceo-delegate`, payload: { isCeoDelegate: true }, ...as(ceo) });
  return { app, db, url, ceo, builtin, maria, lisa, idOf, orchestrator: orchestrator!, bruno: bruno!, sam: sam! };
}

const upload = (app: FastifyInstance, token: string, agent: string, bytes: Buffer, name = 'screen.png', type = 'application/octet-stream') =>
  app.inject({ method: 'POST', url: `/api/agents/${agent}/pictures?name=${encodeURIComponent(name)}`, payload: bytes, headers: { 'content-type': type }, ...as(token) });
const send = (app: FastifyInstance, token: string, agent: string, payload: Record<string, unknown>) => app.inject({ method: 'POST', url: `/api/agents/${agent}/messages`, payload, ...as(token) });
const uploaded = async (app: FastifyInstance, token: string, agent: string, bytes = PNG, name = 'screen.png') => {
  const res = await upload(app, token, agent, bytes, name);
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string; name: string };
};
const hhFetch = (args: string[], url: string, token: string, cwd: string) =>
  new Promise<{ code: number; out: string; err: string }>(resolve =>
    execFile(process.execPath, [HH_FETCH, ...args], { env: { PATH: process.env.PATH ?? '', HH_ATTACH_URL: `${url.replace('/api/nodes/socket', '').replace(/^ws/, 'http')}/api/attachments`, HH_ATTACH_PASS: token }, cwd }, (err, out, errOut) =>
      resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, out: String(out), err: String(errOut) }),
    ),
  );

describe('a picture a person sends an agent', () => {
  it('is kept for that agent by whoever may write to it', async () => {
    const { app, db, maria, idOf, bruno } = await company();
    const res = await upload(app, maria, bruno.id, PNG, '../shots/screen.png');
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ id: expect.any(String), name: 'screen.png' });
    const [row] = await db.select().from(attachments).where(eq(attachments.id, res.json().id));
    expect(row).toMatchObject({ agentId: bruno.id, personId: idOf('Maria'), jobId: null, taskId: null, requestId: null, name: 'screen.png', mediaType: 'image/png', size: PNG.length });
  });

  it('takes its name from what it is when it comes without one', async () => {
    const { app, ceo, bruno } = await company();
    const send = (bytes: Buffer, name: string) => app.inject({ method: 'POST', url: `/api/agents/${bruno.id}/pictures${name}`, payload: bytes, headers: { 'content-type': 'application/octet-stream' }, ...as(ceo) });
    expect((await send(PNG, '')).json().name).toBe('picture.png');
    expect((await send(JPEG, '')).json().name).toBe('picture.jpg');
    expect((await send(JPEG, '?name=..')).json().name).toBe('picture.jpg');
  });

  it('is judged by what it holds, not by its name or the type it says', async () => {
    const { app, db, ceo, bruno } = await company();
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    for (const [bytes, name, type] of [
      [svg, 'drawing.svg', 'image/svg+xml'],
      [svg, 'drawing.png', 'image/png'],
      [Buffer.from('Just some words in a file.'), 'words.png', 'application/octet-stream'],
      [Buffer.from('GIF89a'), 'moving.gif', 'image/gif'],
      [Buffer.alloc(0), 'empty.png', 'application/octet-stream'],
    ] as const) {
      const res = await upload(app, ceo, bruno.id, bytes, name, type);
      expect([name, res.statusCode, res.json().error.reason]).toEqual([name, 400, 'picture_invalid']);
    }
    expect(await db.select().from(attachments)).toEqual([]);
    const jpeg = await upload(app, ceo, bruno.id, JPEG, 'named-wrong.png', 'image/png');
    expect(jpeg.statusCode).toBe(201);
    expect((await db.select().from(attachments))[0]).toMatchObject({ mediaType: 'image/jpeg', name: 'named-wrong.png' });
  });

  it('is turned away above the limit, far above it too, and fits at the limit', async () => {
    const { app, ceo, bruno } = await company();
    const big = (size: number) => Buffer.concat([PNG, Buffer.alloc(size - PNG.length, 1)]);
    expect((await upload(app, ceo, bruno.id, big(PICTURE_BYTES))).statusCode).toBe(201);
    for (const size of [PICTURE_BYTES + 1, PICTURE_BYTES * 4]) {
      const res = await upload(app, ceo, bruno.id, big(size));
      expect([res.statusCode, res.json().error.reason]).toEqual([413, 'picture_too_big']);
      expect(res.json().error.message).toContain('3 MB');
    }
  });

  it('is turned away for someone who may not write to that agent, before its bytes are stored', async () => {
    const { app, db, maria, sam } = await company();
    for (const [agent, reason] of [[sam.id, 'not_your_department'], ['orchestrator', 'company_scope_only']] as const) {
      const res = await upload(app, maria, agent, PNG);
      expect([res.statusCode, res.json().error.reason]).toEqual([403, reason]);
    }
    expect(await db.select().from(attachments)).toEqual([]);
    expect((await app.inject({ method: 'POST', url: `/api/agents/${sam.id}/pictures`, payload: PNG, headers: { 'content-type': 'application/octet-stream' } })).statusCode).toBe(401);
  });

  it('leaves room for what the company keeps', async () => {
    const { app, ceo, bruno } = await company();
    app.ctx.config.taskFilesBytes = PNG.length;
    await uploaded(app, ceo, bruno.id);
    const res = await upload(app, ceo, bruno.id, PNG);
    expect([res.statusCode, res.json().error.reason]).toEqual([413, 'attachment_invalid']);
  });
});

describe('a message with pictures', () => {
  it('tells the agent each file and the command that downloads it, and the agent gets its bytes', async () => {
    const { app, url, ceo, builtin, bruno } = await company();
    const shot = await uploaded(app, ceo, bruno.id, PNG, 'screen.png');
    const photo = await uploaded(app, ceo, bruno.id, JPEG, 'photo.jpg');
    const said = await send(app, ceo, bruno.id, { text: 'What is wrong here?', pictures: [shot.id, photo.id] });
    expect(said.statusCode).toBe(202);
    const run = await next(builtin, 'job.run');
    expect(run.prompt).toContain('What is wrong here?');
    expect(run.prompt).toContain(`screen.png: hh-fetch message ${shot.id}`);
    expect(run.prompt).toContain(`photo.jpg: hh-fetch message ${photo.id}`);
    expect(run.prompt).toContain('Pictures came with this message');
    expect(run.prompt).not.toContain('iVBOR');
    const folder = mkdtempSync(join(tmpdir(), 'hh-pictures-'));
    const got = await hhFetch(['message', shot.id], url, run.toolToken!, folder);
    expect(got).toMatchObject({ code: 0, err: '' });
    expect(readFileSync(join(folder, got.out.trim()))).toEqual(PNG);
    expect(got.out.trim()).toBe(`${shot.id.slice(0, 8)}-screen.png`);
  });

  it('goes into the turn the agent runs with the same command', async () => {
    const { app, ceo, builtin, bruno } = await company();
    await send(app, ceo, bruno.id, { text: 'Start the work' });
    await next(builtin, 'job.run');
    const shot = await uploaded(app, ceo, bruno.id);
    const delivered = send(app, ceo, bruno.id, { text: 'Look at this', pictures: [shot.id] });
    const words = await next(builtin, 'agent.say');
    builtin.send({ type: 'agent.said', ref: words.ref, ok: true });
    expect((await delivered).statusCode).toBe(202);
    expect(words.text).toContain(`screen.png: hh-fetch message ${shot.id}`);
    expect(words.text).toContain('A picture came with this message');
  });

  it('shows in the conversation as words and pictures, with file names when nothing was written', async () => {
    const { app, ceo, bruno, db, builtin } = await company();
    const shot = await uploaded(app, ceo, bruno.id, PNG, 'screen.png');
    const said = await send(app, ceo, bruno.id, { pictures: [shot.id] });
    expect(said.statusCode).toBe(202);
    const [event] = await db.select().from(agentEvents).where(eq(agentEvents.jobId, said.json().jobId));
    expect(event).toMatchObject({ kind: 'message', data: { text: 'screen.png', pictures: [{ id: shot.id, name: 'screen.png' }] } });
    const shown = (await app.inject({ url: `/api/agents/${bruno.id}/events`, ...as(ceo) })).json().events.find((e: { kind: string }) => e.kind === 'message');
    expect(shown.data.pictures).toEqual([{ id: shot.id, name: 'screen.png' }]);
    expect((await next(builtin, 'job.run')).prompt).toContain('screen.png: hh-fetch message');
  });

  it('needs words or a picture, and takes at most 10 pictures', async () => {
    const { app, ceo, bruno } = await company();
    expect((await send(app, ceo, bruno.id, { text: '  ' })).statusCode).toBe(400);
    expect((await send(app, ceo, bruno.id, { pictures: [] })).statusCode).toBe(400);
    const shot = await uploaded(app, ceo, bruno.id);
    expect((await send(app, ceo, bruno.id, { pictures: Array.from({ length: 11 }, () => shot.id) })).statusCode).toBe(400);
  });

  it("takes only the person's own pictures for this agent", async () => {
    const { app, db, ceo, lisa, bruno, sam } = await company();
    const jobsBefore = (await db.select().from(jobs)).length;
    const forSam = await uploaded(app, ceo, sam.id);
    const lisas = await uploaded(app, lisa, bruno.id);
    for (const id of [forSam.id, lisas.id, '00000000-0000-4000-8000-000000000000']) {
      const res = await send(app, ceo, bruno.id, { text: 'Look', pictures: [id] });
      expect([res.statusCode, res.json().error.reason]).toEqual([404, 'attachment_unknown']);
    }
    expect(await db.select().from(jobs)).toHaveLength(jobsBefore);
  });

  it('is turned away for someone who may not write to the agent, whose picture it may be', async () => {
    const { app, db, maria, idOf, sam, bruno } = await company();
    const own = await uploaded(app, maria, bruno.id);
    await db.update(attachments).set({ agentId: sam.id }).where(eq(attachments.id, own.id));
    const res = await send(app, maria, sam.id, { text: 'Look', pictures: [own.id] });
    expect([res.statusCode, res.json().error.reason]).toEqual([403, 'not_your_department']);
    expect(await db.select().from(jobs).where(eq(jobs.createdBy, idOf('Maria')))).toEqual([]);
  });
});

describe("getting a message's picture", () => {
  it("is for the agent it was sent to: another agent's turn does not get it", async () => {
    const { app, url, ceo, builtin, bruno, sam } = await company();
    const shot = await uploaded(app, ceo, bruno.id);
    await send(app, ceo, sam.id, { text: 'Are you there?' });
    const run = await next(builtin, 'job.run');
    const folder = mkdtempSync(join(tmpdir(), 'hh-pictures-'));
    const got = await hhFetch(['message', shot.id], url, run.toolToken!, folder);
    expect(got.code).toBe(1);
    expect(got.err).toContain('no picture');
    expect((await hhFetch(['message', 'not-an-id'], url, run.toolToken!, folder)).code).toBe(1);
  });

  it('is for no agent as a file of a task, and a task file stays where it was', async () => {
    const { app, url, ceo, builtin, bruno } = await company();
    const shot = await uploaded(app, ceo, bruno.id);
    await send(app, ceo, bruno.id, { text: 'Are you there?' });
    const run = await next(builtin, 'job.run');
    const folder = mkdtempSync(join(tmpdir(), 'hh-pictures-'));
    expect((await hhFetch(['12', shot.id], url, run.toolToken!, folder)).code).toBe(1);
  });

  it('shows to people who reach the window, and no one else', async () => {
    const { app, ceo, maria, lisa, bruno } = await company();
    const shot = await uploaded(app, ceo, bruno.id);
    const toOrchestrator = await uploaded(app, ceo, 'orchestrator');
    const shown = (id: string, token: string) => app.inject({ url: `/api/attachments/${id}`, ...as(token) });
    for (const token of [ceo, maria, lisa]) {
      const res = await shown(shot.id, token);
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('image/png');
      expect(res.headers['content-security-policy']).toBe("default-src 'none'");
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.rawPayload).toEqual(PNG);
    }
    expect((await shown(toOrchestrator.id, lisa)).statusCode).toBe(200);
    expect((await shown(toOrchestrator.id, maria)).statusCode).toBe(404);
  });

  it('goes after 30 days, with what was never sent', async () => {
    const { app, db, ceo, bruno } = await company();
    const old = await uploaded(app, ceo, bruno.id);
    const fresh = await uploaded(app, ceo, bruno.id);
    await db.update(attachments).set({ createdAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000) }).where(eq(attachments.id, old.id));
    expect(await dropOldFiles(db, new Date())).toBe(1);
    expect((await db.select({ id: attachments.id }).from(attachments)).map(a => a.id)).toEqual([fresh.id]);
  });
});
