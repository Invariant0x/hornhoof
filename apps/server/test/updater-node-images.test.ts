import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { APP, ask, at, DIGESTS, JQ, NODE_DIGESTS, refs, runOnce, stand } from './updater-fixture.js';

describe('updater', () => {
  beforeAll(() => {
    if (!JQ) throw new Error('The updater tests need jq. Install it (brew install jq on a Mac, apt install jq on Debian or Ubuntu), then run them again.');
  });

  describe('nodes on another image than the build names', () => {
    const KEY = 'the-built-in-node-key';
    const builtOn041 = `HORNHOOF_SECRET=s\nNODE_KEY=${KEY}\nHORNHOOF_VERSION=0.4.1\n${refs('0.4.1').replace(/ /g, '\n')}\n`;
    /* What an update from before this leaves behind: the new app and its .env, and the node on the old image. */
    const behind = () => stand(builtOn041);
    const running041 = { STUB_RUNNING_IMAGES: `app=${APP}@${DIGESTS['0.4.1']} node=${APP}-node@${NODE_DIGESTS['0.4.0']}`, STUB_COMMITS: '0.4.0=aaa 0.4.1=bbb' };
    const installs = (calls: string[]) => calls.filter(c => c.startsWith('installer server'));
    const asked = (calls: string[], method: string) => calls.filter(c => c.startsWith('curl') && c.includes('/api/nodes/update') && c.includes(`-X ${method}`));

    it('changes nothing while their work runs, and keeps the key off the command line', async () => {
      const s = behind();
      const r = await runOnce(s, null, { ...running041, STUB_NODES: 'waiting' });
      expect(r.code).toBe(0);
      expect(asked(r.calls, 'POST')).toHaveLength(1);
      expect(asked(r.calls, 'POST')[0]).toContain('http://app:8080/api/nodes/update');
      expect(asked(r.calls, 'POST')[0]).toContain('{"scope":"server","nodes":["builtin"]}');
      expect(installs(r.calls)).toEqual([]);
      expect(r.calls.join('\n')).not.toContain(KEY);
      expect(readFileSync(join(s.dir, 'curl-config'), 'utf8')).toBe(`header = "Authorization: Bearer ${KEY}"\n`);
      expect(asked(r.calls, 'DELETE')).toEqual([]);
    });

    it('finishes the step from 0.6.1: the new updater replaces them through that build\'s installer once they are free, and lets go of them', async () => {
      const s = behind();
      const r = await runOnce(s, null, { ...running041, STUB_NODES: 'ready' });
      expect(r.code).toBe(0);
      expect(r.calls).toContain('installer told the nodes are free');
      expect(at(r.calls, `docker create ${APP}@${DIGESTS['0.4.1']}`)).toBeGreaterThanOrEqual(0);
      const [install] = installs(r.calls) as [string];
      expect(install).toContain(`HORNHOOF_VERSION=0.4.1 HORNHOOF_FROM_UPDATER=1`);
      expect(install).toContain(refs('0.4.1'));
      expect(at(r.calls, 'curl')).toBeLessThan(r.calls.indexOf('installer told the nodes are free'));
      expect(r.calls.indexOf(asked(r.calls, 'DELETE')[0]!)).toBeGreaterThan(r.calls.indexOf(install));
      expect(r.status).toBeNull();
    });

    it('lets go of them when the installer fails, and stays up', async () => {
      const s = behind();
      const r = await runOnce(s, null, { ...running041, STUB_NODES: 'ready', STUB_INSTALLER_FAILS: '1' });
      expect(r.code).toBe(0);
      expect(asked(r.calls, 'DELETE')).toHaveLength(1);
      expect(r.out).toContain('Could not replace the nodes');
    });

    it('asks nothing when the built-in node runs the image the build names', async () => {
      const s = behind();
      const r = await runOnce(s, null, { STUB_RUNNING_IMAGES: `node=${APP}-node@${NODE_DIGESTS['0.4.1']}` });
      expect(asked(r.calls, 'POST')).toEqual([]);
      expect(installs(r.calls)).toEqual([]);
    });

    it('asks nothing when no built-in node runs', async () => {
      const r = await runOnce(behind(), null, { STUB_NO_NODE: '1' });
      expect(asked(r.calls, 'POST')).toEqual([]);
    });

    it('asks nothing for a server that install.sh did not set up, or whose .env names no node image', async () => {
      expect(asked((await runOnce(stand(), null, running041)).calls, 'POST')).toEqual([]);
    });

    it('leaves them and their turns on a server from before this wait, and says why', async () => {
      const r = await runOnce(behind(), null, { ...running041, STUB_NODES: 'old' });
      expect(r.code).toBe(0);
      expect(installs(r.calls)).toEqual([]);
      expect(r.out).toContain('This server is from before nodes wait for their work');
    });

    it("takes a 404 that is not a Hornhoof server's own for a server away, not for one from before", async () => {
      const r = await runOnce(behind(), null, { ...running041, STUB_NODES: 'lost' });
      expect(r.code).toBe(0);
      expect(installs(r.calls)).toEqual([]);
      expect(r.out).not.toContain('from before nodes wait');
    });

    it.each(['down', 'refused'])('leaves them and their turns when the server is %s, and stays up', async state => {
      const r = await runOnce(behind(), null, { ...running041, STUB_NODES: state });
      expect(r.code).toBe(0);
      expect(installs(r.calls)).toEqual([]);
    });

    it('never starts an image that is not its own from what .env names', async () => {
      const s = stand(builtOn041.replace(`${APP}@`, 'ghcr.io/acme/other@'));
      const r = await runOnce(s, null, { ...running041, STUB_NODES: 'ready' });
      expect(r.code).toBe(0);
      expect(asked(r.calls, 'POST')).toEqual([]);
      expect(installs(r.calls)).toEqual([]);
    });

    describe('each by itself', () => {
      const OLD = `${APP}-node@${NODE_DIGESTS['0.4.0']}`;
      const NEW = `${APP}-node@${NODE_DIGESTS['0.4.1']}`;
      const CLAUDE = '11111111-1111-4111-8111-111111111111';
      const GOOGLE = '22222222-2222-4222-8222-222222222222';
      const onNew = { STUB_RUNNING_IMAGES: `app=${APP}@${DIGESTS['0.4.1']} node=${NEW}` };
      const plans = (claude: string, google: string) => ({ STUB_PLAN_NODES: `hornhoof-claude-1=${CLAUDE}=${claude} hornhoof-antigravity-2=${GOOGLE}=${google}` });
      const only = (calls: string[]) => calls.filter(c => c.startsWith('installer told only'));
      const body = (names: string[]) => JSON.stringify({ scope: 'server', nodes: names });

      it('replaces the free ones at once and leaves the one with a long turn to its wait, asking of each', async () => {
        const r = await runOnce(behind(), null, { ...running041, ...plans(OLD, OLD), STUB_NODES: 'each', STUB_FREE: `builtin ${CLAUDE}` });
        expect(r.code).toBe(0);
        expect(asked(r.calls, 'POST')[0]).toContain(body(['builtin', CLAUDE, GOOGLE]));
        expect(only(r.calls)).toEqual([`installer told only builtin ${CLAUDE}`]);
        expect(installs(r.calls)).toHaveLength(1);
        expect(installs(r.calls)[0]).toContain(refs('0.4.1'));
      });

      it('lets go only of those it replaced, so the one that waits keeps its deadline', async () => {
        const r = await runOnce(behind(), null, { ...running041, ...plans(OLD, OLD), STUB_NODES: 'each', STUB_FREE: `builtin ${CLAUDE}` });
        expect(asked(r.calls, 'DELETE')).toHaveLength(1);
        expect(asked(r.calls, 'DELETE')[0]).toContain(body(['builtin', CLAUDE]));
        expect(r.calls.indexOf(asked(r.calls, 'DELETE')[0]!)).toBeGreaterThan(r.calls.indexOf(installs(r.calls)[0]!));
      });

      it('asks on about the one that waits and no more about those on the new image, which take work again', async () => {
        const r = await runOnce(behind(), null, { ...onNew, ...plans(NEW, OLD), STUB_NODES: 'each', STUB_FREE: '' });
        expect(asked(r.calls, 'POST')[0]).toContain(body([GOOGLE]));
        expect(installs(r.calls)).toEqual([]);
        expect(asked(r.calls, 'DELETE')).toEqual([]);
      });

      it('replaces a node behind though the built-in node runs the new image', async () => {
        const r = await runOnce(behind(), null, { ...onNew, ...plans(NEW, OLD), STUB_NODES: 'each', STUB_FREE: GOOGLE });
        expect(only(r.calls)).toEqual([`installer told only ${GOOGLE}`]);
      });

      it('asks nothing when every node runs the image the build names', async () => {
        const r = await runOnce(behind(), null, { ...onNew, ...plans(NEW, NEW), STUB_NODES: 'each' });
        expect(asked(r.calls, 'POST')).toEqual([]);
      });

      it('replaces only what it found behind itself, whatever the server names', async () => {
        const r = await runOnce(behind(), null, { ...onNew, ...plans(OLD, NEW), STUB_NODES: 'each', STUB_FREE: `${CLAUDE} ${GOOGLE} builtin a-plan-of-another-server ;reboot` });
        expect(only(r.calls)).toEqual([`installer told only ${CLAUDE}`]);
        expect(asked(r.calls, 'DELETE')[0]).toContain(body([CLAUDE]));
      });

      it('installs nothing and lets go of nothing when the server names none, as for nodes that are not its own', async () => {
        const r = await runOnce(behind(), null, { ...onNew, ...plans(OLD, OLD), STUB_NODES: 'each', STUB_FREE: '' });
        expect(r.code).toBe(0);
        expect(installs(r.calls)).toEqual([]);
        expect(asked(r.calls, 'DELETE')).toEqual([]);
      });

      it('never asks about a label that is not a plain id', async () => {
        const r = await runOnce(behind(), null, { ...onNew, STUB_PLAN_NODES: `hornhoof-odd-1=a;reboot=${OLD} hornhoof-claude-1=${CLAUDE}=${OLD}`, STUB_NODES: 'each', STUB_FREE: CLAUDE });
        expect(asked(r.calls, 'POST')[0]).toContain(body([CLAUDE]));
        expect(r.calls.join('\n')).not.toContain('reboot');
      });

      it('lets go of those it tried when the installer fails, stays up, and leaves the others to their wait', async () => {
        const r = await runOnce(behind(), null, { ...running041, ...plans(OLD, OLD), STUB_NODES: 'each', STUB_FREE: 'builtin', STUB_INSTALLER_FAILS: '1' });
        expect(r.code).toBe(0);
        expect(asked(r.calls, 'DELETE')).toHaveLength(1);
        expect(asked(r.calls, 'DELETE')[0]).toContain(body(['builtin']));
        expect(r.out).toContain('Could not replace the nodes');
      });

      it('replaces them all together on a server from before this, which says only that all are free', async () => {
        const r = await runOnce(behind(), null, { ...running041, ...plans(OLD, OLD), STUB_NODES: 'ready' });
        expect(r.calls).toContain('installer told the nodes are free');
        expect(only(r.calls)).toEqual([]);
        expect(asked(r.calls, 'DELETE')[0]).toContain('{"scope":"server"}');
      });

      it.each(['ready', 'waiting'])('lets go of them on a server from before this that says %s when the built-in node is on the new image: its installer would move none', async state => {
        const r = await runOnce(behind(), null, { ...onNew, ...plans(OLD, OLD), STUB_NODES: state });
        expect(r.code).toBe(0);
        expect(installs(r.calls)).toEqual([]);
        expect(asked(r.calls, 'DELETE')).toHaveLength(1);
        expect(asked(r.calls, 'DELETE')[0]).toContain('{"scope":"server"}');
      });
    });
  });

  describe('the nodes during an update', () => {
    const told = 'installer told the nodes are free';

    it('leaves them to the wait in a planned update', async () => {
      const r = await runOnce(stand(), ask('p1'));
      expect(r.status).toMatchObject({ state: 'done' });
      expect(r.calls).not.toContain(told);
    });

    it.each([['urgent', { urgent: true }], ['confirmed', { immediate: true }]])('replaces them with the app in an %s update', async (_name, flag) => {
      const r = await runOnce(stand(), { ...ask('n1'), ...flag });
      expect(r.status).toMatchObject({ state: 'done' });
      expect(r.calls.indexOf(told)).toBeGreaterThanOrEqual(0);
      expect(r.calls.indexOf(told)).toBeLessThan(at(r.calls, 'installer server'));
    });

    it('still replaces them when it goes on with such an update after being stopped', async () => {
      const s = stand();
      await runOnce(s, { ...ask('n2'), urgent: true }, { STUB_STOP_IN: '0.4.1' });
      writeFileSync(s.log, '');
      const r = await runOnce(s, null);
      expect(r.status).toMatchObject({ id: 'n2', state: 'done' });
      expect(r.calls).toContain(told);
    });

    it('puts the nodes from before back too when such an update goes back', async () => {
      const r = await runOnce(stand(), { ...ask('n3'), urgent: true }, { STUB_BROKEN: '0.4.1' });
      expect(r.status).toMatchObject({ state: 'rolled_back' });
      expect(r.calls.filter(c => c === told)).toHaveLength(2);
    });

    it('does not carry that over to a later planned update', async () => {
      const s = stand();
      await runOnce(s, { ...ask('n4'), urgent: true });
      writeFileSync(s.log, '');
      const r = await runOnce(s, { ...ask('n5') });
      expect(r.status).toMatchObject({ id: 'n5', state: 'done' });
      expect(r.calls).not.toContain(told);
    });
  });
});
