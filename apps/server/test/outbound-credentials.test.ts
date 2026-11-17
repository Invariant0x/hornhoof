import { Writable } from 'node:stream';
import { eq, sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { outboundAccounts } from '../src/db/schema.js';
import { outboundRound } from '../src/modules/outbound/dispatcher.js';
import { smtpAdapter } from '../src/modules/outbound/smtp.js';
import { as } from './helpers.js';
import { FROM, SIGNING_KEY, EVENT_KEY, closeKept, hookWay, keep, liveSenders, smtpSettings, smtpWay, submitByTool } from './outbound-live-world.js';
import { CERT, PASSWORD, USERNAME, hookReceiver, smtpReceiver, type HookRequest } from './outbound-receivers.js';
import { QUIET, world, type World } from './outbound-world.js';

/* A known synthetic secret, really used against control receivers, and then looked for in everything an author can reach. */
afterEach(closeKept);

const SECRETS = [PASSWORD, SIGNING_KEY, EVENT_KEY];
const expectNoSecretIn = (seen: string) => {
  for (const secret of SECRETS) expect(seen).not.toContain(secret);
};
const takes = (request: HookRequest) => ({ status: 200, body: JSON.stringify({ attemptId: JSON.parse(request.body).attemptId, receipt: 'receipt-41' }) });

function logged() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, done) {
      lines.push(String(chunk));
      done();
    },
  });
  return { logger: { level: 'trace', stream }, lines };
}

/* Every table of the database as it stands, whoever could or could not read it. */
async function wholeDatabase(w: World): Promise<string> {
  const rowsOf = async (query: Parameters<typeof w.c.db.execute>[0]) => ((await w.c.db.execute(query)) as unknown as { rows: Record<string, unknown>[] }).rows;
  const tables = await rowsOf(sql`select table_name from information_schema.tables where table_schema = 'public'`);
  const dump: string[] = [];
  for (const { table_name } of tables) dump.push(JSON.stringify(await rowsOf(sql.raw(`select * from "${String(table_name)}"`))));
  return dump.join('\n');
}

type Tool = { content: { text: string }[]; isError?: boolean };
const text = (answer: unknown) => JSON.stringify(answer as Tool);

async function usedOnMail() {
  const log = logged();
  const w = await world(QUIET, {}, log.logger);
  const server = keep(await smtpReceiver({ secure: true }));
  const smtp = await smtpWay(w, server.port);
  const mail = await submitByTool(w, smtp.input());
  await outboundRound(w.ctx, new Date(), liveSenders());
  return { w, log, server, smtp, mail };
}

/* The lines of the printed route tree under /api/outbound, which is a route itself: its children print without its name. */
function outboundBranch(lines: string[]): string[] {
  const depth = (line: string) => line.search(/[^│├└─ ]/);
  const top = lines.findIndex(line => line.includes('outbound'));
  const next = lines.findIndex((line, at) => at > top && depth(line) <= depth(lines[top]!));
  return lines.slice(top, next < 0 ? undefined : next);
}

describe('the settings of a sending account', () => {
  it('really sign in, and nothing an author can reach ever holds them', async () => {
    const { w, log, server, smtp, mail } = await usedOnMail();
    expect(server.seen.logins).toEqual([USERNAME]);
    expect(server.seen.messages).toHaveLength(1);
    expect(log.lines.join('')).toContain('outbound account changed');

    const tools = await w.c.tools(w.c.worker);
    const listed = await tools.listTools();
    const seen = [
      text(listed),
      text(await tools.callTool({ name: 'outbound_options', arguments: {} })),
      text(await tools.callTool({ name: 'outbound_status', arguments: { messageId: mail.messageId } })),
      text(await tools.callTool({ name: 'tasks', arguments: {} })),
      text(await tools.callTool({ name: 'task', arguments: { task: w.c.task.number } })),
      text(await tools.callTool({ name: 'company', arguments: {} })),
      (await w.c.app.inject({ method: 'GET', url: `/api/outbound/channels/${w.channel.id}/accounts`, ...as(w.c.ceoToken) })).body,
      (await w.c.app.inject({ method: 'GET', url: `/api/departments/${w.c.dev.id}`, ...as(w.c.ceoToken) })).body,
      log.lines.join(''),
      await wholeDatabase(w),
    ];
    for (const place of seen) expectNoSecretIn(place);
    expect((await w.c.db.select().from(outboundAccounts).where(eq(outboundAccounts.id, smtp.accountId)))[0]!.configEnc).toMatch(/^v1\./);
  });

  it('do not reach a tool as a field either: no tool takes or names a host, a key or a password, and only a new account its own sender address', async () => {
    const { w } = await usedOnMail();
    const tools = await w.c.tools(w.c.orchestrator);
    const { tools: all } = await tools.listTools();
    const outbound = all.filter(tool => tool.name.startsWith('outbound_'));
    expect(outbound.length).toBeGreaterThan(3);
    for (const tool of outbound) {
      const fields = Object.keys((tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {});
      const own = tool.name === 'outbound_account_add' ? ['from'] : [];
      expect(fields.filter(field => !own.includes(field) && /^(host|port|password|username|signingKey|eventKey|endpoint|config|from|recipient|url|headers?)$/i.test(field)), tool.name).toEqual([]);
    }
  });

  it('reach the orchestrator\'s database tool only sealed, as it reads everything, and never in plain words', async () => {
    const { w } = await usedOnMail();
    const tools = await w.c.tools(w.c.orchestrator, w.c.ids.ceo);
    const answer = await tools.callTool({ name: 'database', arguments: { sql: 'SELECT config_enc FROM outbound_accounts' } }) as Tool;
    expect(answer.isError ?? false).toBe(false);
    expect(JSON.stringify(answer)).toContain('config_enc');
    expectNoSecretIn(JSON.stringify(answer));
  });

  it('never come out of a failing transport, in what is kept or what is logged', async () => {
    const log = logged();
    const w = await world(QUIET, {}, log.logger);
    const server = keep(await smtpReceiver({ secure: true }));
    const { input } = await smtpWay(w, server.port);
    const { messageId } = await submitByTool(w, input());
    const blurts = { smtp: { send: async () => { throw new Error(`could not sign in with ${PASSWORD}`); }, reconcile: async () => { throw new Error(`still ${PASSWORD}`); } } };
    await outboundRound(w.ctx, new Date(), liveSenders(blurts));
    await outboundRound(w.ctx, new Date(Date.now() + 6 * 60_000), liveSenders(blurts));
    const tools = await w.c.tools(w.c.worker);
    const status = await tools.callTool({ name: 'outbound_status', arguments: { messageId } });
    expect(JSON.stringify(status)).toContain('unknown');
    for (const place of [JSON.stringify(status), log.lines.join(''), await wholeDatabase(w)]) expectNoSecretIn(place);
  });

  it('are the only way in: the control server lets nobody send without them', async () => {
    const server = keep(await smtpReceiver({ secure: true }));
    const wrong = { host: 'localhost', port: server.port, security: 'tls' as const, username: USERNAME, password: 'a-guess', from: FROM, ca: CERT };
    const outcome = await smtpAdapter().send({ attemptId: 'attempt-1', sealedPayload: { recipient: 'ann@shop.example', subject: 'Hello', text: 'Words.\n' }, configuredAccount: wrong });
    expect(outcome).toEqual({ kind: 'definitely_not_accepted', safeCode: 'auth_refused' });
    expect(server.seen.messages).toEqual([]);
  });

  it('are signed with on the HTTPS channel without ever being sent', async () => {
    const log = logged();
    const w = await world(QUIET, {}, log.logger);
    const hook = keep(await hookReceiver(takes));
    const { input } = await hookWay(w, hook.url);
    await submitByTool(w, input());
    await outboundRound(w.ctx, new Date(), liveSenders());
    expect(hook.seen).toHaveLength(1);
    expectNoSecretIn(JSON.stringify(hook.seen));
    for (const place of [log.lines.join(''), await wholeDatabase(w)]) expectNoSecretIn(place);
  });

  it('have no route of their own that sends: nothing over HTTP reaches a transport', async () => {
    const { w } = await usedOnMail();
    const routes = outboundBranch(w.c.app.printRoutes({ commonPrefix: false }).split('\n'));
    expect(routes.length).toBeGreaterThan(5);
    expect(routes.filter(line => /send|dispatch|smtp|webhook|transport|deliver/i.test(line))).toEqual([]);
  });

  it('come back to nobody who sets them again: a change of settings answers with its generation only', async () => {
    const { w, smtp, server } = await usedOnMail();
    const changed = await w.c.app.inject({ method: 'POST', url: `/api/outbound/accounts/${smtp.accountId}/rotate`, payload: { config: smtpSettings(server.port) }, ...as(w.c.ceoToken) });
    expect(changed.statusCode).toBe(200);
    expectNoSecretIn(changed.body);
    expect(changed.json()).toMatchObject({ configGeneration: 2 });
  });
});
