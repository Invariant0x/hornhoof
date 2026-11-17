import { describe, expect, it, onTestFinished } from 'vitest';
import { nodeIdentity } from '../src/modules/nodes/hub.js';
import { BUILTIN } from './builtin.js';
import { as, connectNode, listen, setUpCompany, testApp, until } from './helpers.js';

const NODE_KEY = 'k'.repeat(40);
const hello = { type: 'hello' as const, version: '0.5.0', loggedIn: true, running: [] };

describe('program snapshots on node sockets', () => {
  it.each(['personal', 'builtin'] as const)('keeps only live snapshots for a %s node and accepts older messages', async kind => {
    const { app } = await testApp({ NODE_KEY });
    const url = await listen(app);
    const ceo = await setUpCompany(app);
    let key = NODE_KEY;
    let id = BUILTIN;
    if (kind === 'personal') {
      const connected = await app.inject({ method: 'POST', url: '/api/subscriptions/connect', payload: { providers: ['claude'] }, ...as(ceo) });
      const joined = await app.inject({ method: 'POST', url: '/api/nodes/join', payload: {
        code: connected.json().command.split('--join ')[1], machineId: 'managed-programs', hostname: 'program-host', os: 'linux', arch: 'x86_64',
      } });
      expect(joined.statusCode).toBe(200);
      key = joined.json().nodes[0].key;
      id = nodeIdentity(joined.json().nodes[0].nodeId);
    }
    const node = await connectNode(url, key);
    onTestFinished(() => node.close());
    const before = [{ id: 'claude' as const, version: '1.0.0', updating: false, failed: false }];
    node.send({ ...hello, programs: before });
    await until(() => app.ctx.hub.isReady(id));
    expect(app.ctx.hub.programsOf(id)).toEqual(before);
    const pending = [{ ...before[0]!, updating: true }];
    node.send({ type: 'status', loggedIn: true, limits: null, programs: pending });
    await until(() => app.ctx.hub.programsOf(id)?.[0]?.updating === true);
    const after = [{ ...before[0]!, version: '2.0.0', failed: true }];
    node.send({ type: 'status', loggedIn: true, limits: null, programs: after });
    await until(() => app.ctx.hub.programsOf(id)?.[0]?.version === '2.0.0');
    expect(app.ctx.hub.programsOf(id)).toEqual(after);
    const reason = 'Check group 4242 has not stopped. New checks wait until its processes are gone.';
    node.send({ type: 'status', loggedIn: true, limits: null, noRuns: reason });
    await until(() => app.ctx.hub.checkErrorOf(id) === reason);
    const blocked = await app.inject({ method: 'GET', url: '/api/machines', ...as(ceo) });
    const view = kind === 'builtin' ? blocked.json().builtin : blocked.json().machines.find((machine: { hostname: string }) => machine.hostname === 'program-host');
    expect(view.checkError).toBe(reason);
    node.send({ type: 'status', loggedIn: true, limits: null, noRuns: null });
    await until(() => app.ctx.hub.checkErrorOf(id) === null);
    const recovered = await app.inject({ method: 'GET', url: '/api/machines', ...as(ceo) });
    const ready = kind === 'builtin' ? recovered.json().builtin : recovered.json().machines.find((machine: { hostname: string }) => machine.hostname === 'program-host');
    expect(ready.checkError).toBeNull();

    node.send({ type: 'status', loggedIn: true, limits: null });
    node.send({ type: 'load', cpus: 2, load: 0.123, memTotal: 100, memFree: 50, tests: 0, jobs: 0 });
    await until(() => app.ctx.hub.loadOf(id)?.load === 0.123);
    expect(app.ctx.hub.programsOf(id)).toEqual(after);
    node.close();
    await node.closed;
    await until(() => !app.ctx.hub.isOnline(id));
    expect(app.ctx.hub.programsOf(id)).toBeNull();
    const older = await connectNode(url, key);
    onTestFinished(() => older.close());
    older.send(hello);
    await until(() => app.ctx.hub.isReady(id));
    expect(app.ctx.hub.programsOf(id)).toBeNull();
    older.send({ type: 'status', loggedIn: true, limits: null, programs: [] });
    await until(() => app.ctx.hub.programsOf(id) !== null);
    expect(app.ctx.hub.programsOf(id)).toEqual([]);
  });
});
