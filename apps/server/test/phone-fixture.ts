import { eq } from 'drizzle-orm';
import { parseServerMessage, type PhoneReply, type PhoneServerMessage } from '@hornhoof/protocol';
import { agents, companies, departments, jobs, machines, nodes, people, sessions, subscriptions } from '../src/db/schema.js';
import { hashToken } from '../src/crypto/tokens.js';
import { createTask } from '../src/modules/tasks/engine.js';
import { as, connectNode, invitePerson, listen, setUpCompany, testApp, until } from './helpers.js';

const NODE_KEY = 'p'.repeat(40);

/* A company with two departments, an employee in each, an assistant, a person of each department and a person and an agent
   of another company, with one machine whose node answers phone messages from recorded replies. */
export async function phoneCompany() {
  const { app, db } = await testApp({ NODE_KEY });
  const wsUrl = await listen(app);
  const ceoSession = await setUpCompany(app);
  const [acme] = await db.select().from(companies);
  const companyId = acme!.id;
  const [ceo] = await db.select().from(people).where(eq(people.isOwner, true));
  const [sub] = await db.select().from(subscriptions);
  const [mkt, sales] = await db.insert(departments).values([
    { companyId, templateKey: 'marketing', roleCode: 'MKT', position: 1 },
    { companyId, templateKey: 'sales', roleCode: 'SAL', position: 2 },
  ]).returning();
  const [nora, sammy, aide] = await db.insert(agents).values([
    { companyId, kind: 'worker', name: 'Nora', roleKey: 'MKT-SEO', departmentId: mkt!.id, model: '', subscriptionId: sub!.id },
    { companyId, kind: 'worker', name: 'Sammy', roleKey: 'SAL-AE', departmentId: sales!.id, model: '', subscriptionId: sub!.id },
    { companyId, kind: 'assistant', name: 'Aide', model: '', subscriptionId: sub!.id },
  ]).returning();
  const claraSession = await invitePerson(app, ceoSession, { name: 'Clara', email: 'clara@acme.test', access: { departments: [mkt!.id] } });
  const samSession = await invitePerson(app, ceoSession, { name: 'Sam', email: 'sam@acme.test', access: { departments: [sales!.id] } });
  const [clara] = await db.select().from(people).where(eq(people.email, 'clara@acme.test'));
  const [other] = await db.insert(companies).values({ name: 'Other company', singleton: false }).returning();
  const [olaf] = await db.insert(people).values({ companyId: other!.id, name: 'Olaf', email: 'olaf@other.test', status: 'active', scopeKind: 'company', isOwner: false }).returning();
  const olafSession = 'olaf-session-token-0123456789abcdef';
  await db.insert(sessions).values({ tokenHash: hashToken(olafSession), personId: olaf!.id, expiresAt: new Date(Date.now() + 3_600_000) });
  const [otherAgent] = await db.insert(agents).values({ companyId: other!.id, kind: 'worker', name: 'Otto', roleKey: 'OPS-X', model: '' }).returning();
  const task = (await createTask(app.ctx, { agentId: nora!.id }, { title: 'Comment on the partner post', brief: 'Comment', body: 'Comment from the company account.', departmentId: mkt!.id, assigneeAgentId: nora!.id, executor: true })).task;
  let seq = 0;
  const startTurn = async (agentId: string, taskId: string | null = null) => {
    const token = `phone-tool-token-${++seq}-0123456789abcdef`;
    const [job] = await db.insert(jobs).values({ companyId, subscriptionId: sub!.id, agentId, kind: 'conversation', prompt: 'use the phone', timeoutMs: 900_000, status: 'running', startedAt: new Date(), toolTokenHash: hashToken(token), taskId }).returning();
    return { token, job: job! };
  };

  const [machine] = await db.insert(machines).values({ companyId, personId: ceo!.id, machineKey: 'phone-machine-1079', hostname: 'Work computer', os: 'linux' }).returning();
  const nodeKey = 'phone-node-1079-key-012345678901234567890';
  const [executor] = await db.insert(nodes).values({ companyId, machineId: machine!.id, keyHash: hashToken(nodeKey), status: 'ready' }).returning();
  const node = await connectNode(wsUrl, nodeKey);
  const calls: PhoneServerMessage[] = [];
  let holdRevoke = false;
  const revokes: string[] = [];
  node.ws.on('message', data => {
    const m = parseServerMessage(data.toString());
    if (!m || !m.type.startsWith('phone.')) return;
    if (m.type === 'phone.probe' || m.type === 'phone.open' || m.type === 'phone.action' || m.type === 'phone.revoke') {
      calls.push(m);
      if (m.type === 'phone.revoke' && holdRevoke) { revokes.push(m.requestId); return; }
      const answer: PhoneReply = { type: 'phone.reply', requestId: m.requestId, status: 'ok' };
      if (m.type === 'phone.probe') answer.devices = [{ serial: m.endpoint ?? 'R58MIDENTITY', status: 'device', model: 'Pixel_8', hardwareKey: (m.endpoint ?? 'usb').startsWith('192.168.1.90') ? 'b'.repeat(64) : 'a'.repeat(64) }];
      node.send(answer);
    }
  });
  node.send({ type: 'hello', version: '0.31.0', loggedIn: true, running: [], phones: true });
  await until(async () => Boolean((await db.select().from(nodes).where(eq(nodes.id, executor!.id)))[0]?.lastSeenAt));
  const addPhone = (session = claraSession, endpoint = '192.168.1.80:5555', name = 'Clara phone') => app.inject({ method: 'POST', url: '/api/phones', ...as(session), payload: { machineId: machine!.id, serial: endpoint, transport: 'network', endpoint, name } });
  return {
    app, db, wsUrl, companyId, ceo: ceo!, ceoSession, clara: clara!, claraSession, samSession, olaf: olaf!, olafSession, other: other!, otherAgent: otherAgent!, mkt: mkt!, sales: sales!, nora: nora!, sammy: sammy!, aide: aide!, task, startTurn,
    machine: machine!, executor: executor!, nodeKey, node, calls, addPhone,
    holdRevokes: () => { holdRevoke = true; },
    acknowledgeRevokes: () => { for (const id of revokes.splice(0)) node.send({ type: 'phone.reply', requestId: id, status: 'ok' }); holdRevoke = false; },
  };
}
