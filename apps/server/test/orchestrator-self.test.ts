import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { agents } from '../src/db/schema.js';
import { serverLog } from '../src/modules/tools/logs.js';
import { company, nextOf } from './test-runs-company.js';

type Company = Awaited<ReturnType<typeof company>>;

/* The orchestrator's running turn, which no person's words started, and its tools. */
async function orchestrator(c: Company) {
  const [me] = await c.db.select().from(agents).where(eq(agents.kind, 'orchestrator'));
  return (await c.turn(me!, null)).call;
}

describe('the orchestrator looks at Hornhoof from outside', () => {
  it('searches and reads the source of the very build that runs, and its tool says which', async () => {
    const c = await company();
    const call = await orchestrator(c);
    const tool = JSON.parse((await call('find_tool', { name: 'source' })).text) as { description: string };
    expect(tool.description).toContain(c.app.ctx.config.version);
    expect(tool.description).toContain(c.app.ctx.config.commit);
    expect(tool.description).toMatch(/how or where/);

    const found = await call('source', { search: 'export const viaOrchestrator' });
    const [, line] = /^apps\/server\/src\/auth\/session\.ts:(\d+): export const viaOrchestrator/m.exec(found.text) ?? [];
    expect(line).toBeDefined();
    expect((await call('source', { path: 'apps/server/src/auth/session.ts', from: Number(line) })).text).toMatch(new RegExp(`^${line}: export const viaOrchestrator`));
    expect((await call('source', { path: 'docs/architecture' })).text).toContain('module-map.md');
    expect((await call('source', { path: 'apps/server/drizzle' })).text).toContain('0001_');
    expect((await call('source', { search: 'build_structure', path: 'templates/skills' })).text).toMatch(/^templates\/skills\/orch-company\.md:\d+: /);
    expect((await call('source', { path: '../../../etc/passwd' })).error).toBe(true);
  });

  it("reads the server's last lines of log", async () => {
    const c = await company();
    const call = await orchestrator(c);
    const marker = `Something to find ${randomUUID()}`;
    Fastify({ logger: { stream: serverLog } }).log.warn(marker);
    expect((await call('logs')).text).toContain(marker);
  });

  it("asks a node for its last lines of log and gives them with its machine's name", async () => {
    const c = await company();
    const box = await c.machine(c.ceo, 'dev-mac');
    const call = await orchestrator(c);
    const asked = call('logs', { node: box.nodeId });
    const ask = await nextOf(box.node, 'node.log.read');
    box.node.send({ type: 'node.log', requestId: ask.requestId, log: 'Node started at 2026-11-16T10:00:00.000Z.\nConnected.' });
    const read = await asked;
    expect(read.error).toBe(false);
    expect(read.text).toContain('dev-mac');
    expect(read.text).toContain('Connected.');
  });
});
