import { eq } from 'drizzle-orm';
import { parseServerMessage, type PhoneReadinessIssue, type PhoneReply, type PhoneServerMessage } from '@hornhoof/protocol';
import { agents, companies, departments, jobs, machines, nodes, people, sessions, subscriptions } from '../src/db/schema.js';
import { hashToken } from '../src/crypto/tokens.js';
import { createTask } from '../src/modules/tasks/engine.js';
import { as, connectNode, invitePerson, listen, setUpCompany, testApp, until } from './helpers.js';
import { prepareSharedDatabase } from './helpers-db.js';

await prepareSharedDatabase();

/* A company with a phone's computer and its node answering adb from records, two employees in two departments, Clara who
   adds the phone, Sam of the other department and Olaf of another company. */
export async function phoneCompany(readiness?: () => PhoneReadinessIssue[]) {
  const { app, db } = await testApp({ NODE_KEY: 'v'.repeat(40) });
  /* Lease expiry moves only when a scenario moves this injected clock. */
  app.ctx.clock = () => 1_700_000_000_000;
  const wsUrl = await listen(app);
  const ceoSession = await setUpCompany(app);
  const [acme] = await db.select().from(companies);
  const companyId = acme!.id;
  const [ceo] = await db.select().from(people).where(eq(people.isOwner, true));
  const [sub] = await db.select().from(subscriptions);
  const [mkt, sales] = await db.insert(departments).values([{ companyId, templateKey: 'marketing', roleCode: 'MKT', position: 1 }, { companyId, templateKey: 'sales', roleCode: 'SAL', position: 2 }]).returning();
  const [nora, sammy] = await db.insert(agents).values([
    { companyId, kind: 'worker', name: 'Nora', roleKey: 'MKT-SEO', departmentId: mkt!.id, model: '', subscriptionId: sub!.id },
    { companyId, kind: 'worker', name: 'Sammy', roleKey: 'SAL-AE', departmentId: sales!.id, model: '', subscriptionId: sub!.id },
  ]).returning();
  const claraSession = await invitePerson(app, ceoSession, { name: 'Clara', email: 'clara@acme.test', access: { departments: [mkt!.id] } });
  const samSession = await invitePerson(app, ceoSession, { name: 'Sam', email: 'sam@acme.test', access: { departments: [sales!.id] } });
  const [clara] = await db.select().from(people).where(eq(people.email, 'clara@acme.test'));
  const [other] = await db.insert(companies).values({ name: 'Other company', singleton: false }).returning();
  const [olaf] = await db.insert(people).values({ companyId: other!.id, name: 'Olaf', email: 'olaf@other.test', status: 'active', scopeKind: 'company', isOwner: false }).returning();
  const olafSession = 'olaf-session-token-0123456789abcdef';
  await db.insert(sessions).values({ tokenHash: hashToken(olafSession), personId: olaf!.id, expiresAt: new Date(Date.now() + 3_600_000) });
  const [otherAgent] = await db.insert(agents).values({ companyId: other!.id, kind: 'worker', name: 'Otto', roleKey: 'OPS-X', model: '' }).returning();
  const { task } = await createTask(app.ctx, { agentId: nora!.id }, { title: 'Post on the partner site', brief: 'Post', body: 'Post from the company phone.', departmentId: mkt!.id, assigneeAgentId: nora!.id, executor: true });
  let seq = 0;
  const startTurn = async (agentId: string, taskId: string | null = null) => {
    const token = `phone-tool-token-${++seq}-0123456789abcdef`;
    const [job] = await db.insert(jobs).values({ companyId, subscriptionId: sub!.id, agentId, kind: 'conversation', prompt: 'post', timeoutMs: 900_000, status: 'running', startedAt: new Date(), toolTokenHash: hashToken(token), taskId }).returning();
    return { token, job: job! };
  };

  const [machine] = await db.insert(machines).values({ companyId, personId: ceo!.id, machineKey: 'phone-machine-1079', hostname: 'Work computer', os: 'linux' }).returning();
  const key = 'phone-node-1079-key-012345678901234567890';
  const [executor] = await db.insert(nodes).values({ companyId, machineId: machine!.id, keyHash: hashToken(key), status: 'ready' }).returning();
  const node = await connectNode(wsUrl, key);
  const calls: PhoneServerMessage[] = [];
  let holdRevoke = false;
  const revokes: string[] = [];
  node.ws.on('message', data => {
    const m = parseServerMessage(data.toString());
    if (!m || !m.type.startsWith('phone.')) return;
    if (m.type === 'phone.probe' || m.type === 'phone.baseline' || m.type === 'phone.open' || m.type === 'phone.action' || m.type === 'phone.revoke') {
      calls.push(m);
      if (m.type === 'phone.revoke' && holdRevoke) { revokes.push(m.requestId); return; }
      const answer: PhoneReply = { type: 'phone.reply', requestId: m.requestId, status: 'ok' };
      if (m.type === 'phone.probe') answer.devices = [{ serial: m.endpoint, status: 'device', model: 'Pixel_8', hardwareKey: 'a'.repeat(64) }];
      if (m.type === 'phone.baseline' && readiness) answer.readiness = readiness();
      node.send(answer);
    }
  });
  const hello = () => node.send({ type: 'hello', version: '0.31.0', loggedIn: true, running: [], phones: true, ...(readiness ? { phoneBaseline: true } : {}) });
  hello();
  await until(async () => Boolean((await db.select().from(nodes).where(eq(nodes.id, executor!.id)))[0]?.lastSeenAt));
  const addPhone = (session = claraSession) => app.inject({ method: 'POST', url: '/api/phones', ...as(session), payload: { machineId: machine!.id, endpoint: '192.168.1.80:5555', name: 'Clara phone' } });
  return {
    app, db, companyId, ceoSession, clara: clara!, claraSession, samSession, olafSession, other: other!, otherAgent: otherAgent!, mkt: mkt!, nora: nora!, sammy: sammy!, task, startTurn,
    machine: machine!, executor: executor!, node, calls, addPhone, hello,
    holdRevokes: () => { holdRevoke = true; },
    acknowledgeRevokes: () => { for (const id of revokes.splice(0)) node.send({ type: 'phone.reply', requestId: id, status: 'ok' }); holdRevoke = false; },
  };
}
