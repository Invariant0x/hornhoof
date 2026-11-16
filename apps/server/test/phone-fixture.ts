import { eq } from 'drizzle-orm';
import { parseServerMessage, type PhoneReply, type PhoneServerMessage } from '@hornhoof/protocol';
import { machines, nodes } from '../src/db/schema.js';
import { hashToken } from '../src/crypto/tokens.js';
import { as, connectNode, until } from './helpers.js';
import { vaultCompany } from './vault-fixture.js';

export async function phoneCompany() {
  const c = await vaultCompany();
  const [machine] = await c.db.insert(machines).values({ companyId: c.companyId, personId: c.ceo.id, machineKey: 'phone-machine-1079', hostname: 'Work computer', os: 'linux' }).returning();
  const key = 'phone-node-1079-key-012345678901234567890';
  const [executor] = await c.db.insert(nodes).values({ companyId: c.companyId, machineId: machine!.id, keyHash: hashToken(key), status: 'ready' }).returning();
  const node = await connectNode(c.wsUrl, key);
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
      if (m.type === 'phone.probe') answer.devices = [{ serial: m.endpoint ?? 'R58MIDENTITY', status: 'device', model: 'Pixel_8', hardwareKey: 'a'.repeat(64) }];
      node.send(answer);
    }
  });
  node.send({ type: 'hello', version: '0.31.0', loggedIn: true, running: [], phones: true });
  await until(async () => Boolean((await c.db.select().from(nodes).where(eq(nodes.id, executor!.id)))[0]?.lastSeenAt));
  const addPhone = (session = c.claraSession) => c.app.inject({ method: 'POST', url: '/api/phones', ...as(session), payload: { machineId: machine!.id, serial: '192.168.1.80:5555', transport: 'network', endpoint: '192.168.1.80:5555', name: 'Clara phone' } });
  return { ...c, machine: machine!, executor: executor!, node, calls, addPhone, holdRevokes: () => { holdRevoke = true; }, acknowledgeRevokes: () => { for (const id of revokes.splice(0)) node.send({ type: 'phone.reply', requestId: id, status: 'ok' }); holdRevoke = false; } };
}
