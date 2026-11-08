import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LIVE_CHECK_REFUSALS, type LiveCheckReason, type LiveCheckVerdict } from '@hornhoof/protocol/live-check';
import { describe, expect, it, vi } from 'vitest';
import { LIVE_CHECK_UNREAD } from '../src/modules/updates/live-check.js';
import { testApp } from './helpers.js';
import { CODE, IMAGE, SCRIPT, SERVER, indexOf, install } from './install-script-helpers.js';

describe('install.sh a server serves', () => {
  const COMMIT = 'c'.repeat(40);
  const DIGEST = `sha256:${'d'.repeat(64)}`;
  const BY_DIGEST = `ghcr.io/invariant0x/hornhoof-node@${DIGEST}`;
  const BY_TAG = `ghcr.io/invariant0x/hornhoof-node:${COMMIT}`;
  const NODE = 'hornhoof-claude-1c07dac4';
  const ON_MACHINE = { STUB_CONTAINERS: `${NODE}=${SERVER}` };
  const LOCAL_NOTE = 'no node image published for it';
  const NOT_PUBLISHED = 'may not be published yet';

  /* The script GET /install.sh answers on a server of this commit, whose registry knows this digest of the node image and
     says this of the build's live check. */
  async function fromServer(digest: string, commit = COMMIT, own: LiveCheckVerdict | Error = { ok: true }, env: Record<string, string> = {}): Promise<string> {
    const { app } = await testApp({ HORNHOOF_VERSION: '0.7.3', HORNHOOF_COMMIT: commit, ...env });
    vi.spyOn(app.ctx.updates, 'siblings').mockResolvedValue({ node: digest, updater: '' });
    vi.spyOn(app.ctx.updates, 'ownLiveCheck').mockImplementation(async () => { if (own instanceof Error) throw own; return own; });
    const file = join(mkdtempSync(join(tmpdir(), 'hh-served-')), 'install.sh');
    writeFileSync(file, (await app.inject({ url: '/install.sh' })).body);
    return file;
  }

  it("starts a joining machine's nodes on the digest of the server's build", async () => {
    const r = install({ script: await fromServer(DIGEST) });
    expect(r.code).toBe(0);
    expect(r.calls).toContain(`docker pull ${BY_DIGEST}`);
    const runs = r.calls.filter(c => c.startsWith('docker run'));
    /* The key of each of the two plans goes in, then its node starts. */
    expect(runs).toHaveLength(4);
    for (const run of runs) expect(run).toContain(BY_DIGEST);
    expect(r.calls.join('\n')).not.toContain(':latest');
    expect(r.out).not.toContain(LOCAL_NOTE);
  });

  it('moves the nodes on this machine to that digest, also one too old to record why it stops', async () => {
    const r = install({ script: await fromServer(DIGEST), args: [], env: { ...ON_MACHINE, STUB_STOP_INTENT: 'unsupported' } });
    expect(r.code).toBe(0);
    expect(r.calls).toContain(`docker stop --time 5 ${NODE}`);
    expect(r.calls.find(c => c.startsWith('docker run -d'))!.endsWith(BY_DIGEST)).toBe(true);
    expect(r.calls.join('\n')).not.toContain(':latest');
  });

  it("goes by the commit's tag when the server has no digest yet, and starts on it once it can be downloaded", async () => {
    const r = install({ script: await fromServer('') });
    expect(r.code).toBe(0);
    expect(r.calls).toContain(`docker pull ${BY_TAG}`);
    expect(r.calls.filter(c => c.startsWith('docker run -d')).every(c => c.endsWith(BY_TAG))).toBe(true);
    expect(r.calls.join('\n')).not.toContain(':latest');
  });

  it("stops before the join and leaves the machine's nodes alone when the image of the server's build cannot be downloaded", async () => {
    const r = install({ script: await fromServer(''), env: { ...ON_MACHINE, STUB_PULL: 'fail' } });
    expect(r.code).toBe(1);
    expect(r.out).toContain(`Could not download ${BY_TAG}`);
    expect(r.out).toContain(NOT_PUBLISHED);
    /* Naming another image is no way out: that is how an unchecked build would reach a machine. */
    expect(r.out).not.toContain('HORNHOOF_NODE_IMAGE');
    /* The command's code stays good, so the same command works once the image is out. */
    expect(r.calls.some(c => c.includes('/api/nodes/join'))).toBe(false);
    expect(r.calls.some(c => /^docker (run|rm|stop)/.test(c))).toBe(false);
    expect(r.calls.join('\n')).not.toContain(':latest');
  });

  it("uses that image from this computer when it cannot be downloaded but is here", async () => {
    const r = install({ script: await fromServer(''), env: { STUB_PULL: 'fail', STUB_IMAGE_LOCAL: '1' } });
    expect(r.code).toBe(0);
    expect(r.out).toContain('Using the local image.');
    expect(r.calls.filter(c => c.startsWith('docker run -d')).every(c => c.endsWith(BY_TAG))).toBe(true);
  });

  it('takes the latest image for a server CI did not build, and says so', async () => {
    const r = install({ script: await fromServer(DIGEST, 'local') });
    expect(r.code).toBe(0);
    expect(r.out).toContain(LOCAL_NOTE);
    expect(r.calls).toContain(`docker pull ${IMAGE}`);
    expect(r.calls.filter(c => c.startsWith('docker run -d')).every(c => c.endsWith(IMAGE))).toBe(true);
  });

  it('says nothing about the node image where it starts no nodes', async () => {
    const script = await fromServer(DIGEST, 'local');
    const gone = install({ script, args: ['--uninstall'], tty: 'n\n', env: ON_MACHINE });
    expect(gone.code).toBe(0);
    expect(gone.out).not.toContain(LOCAL_NOTE);
    const dir = mkdtempSync(join(tmpdir(), 'hh-server-'));
    const server = install({ script, args: ['server'], tty: '', env: { HORNHOOF_SERVER_DIR: dir } });
    expect(server.code).toBe(0);
    expect(server.out).not.toContain(LOCAL_NOTE);
  });

  it("leaves a server's own install to the build it picks", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hh-server-'));
    const r = install({ script: await fromServer(DIGEST), args: ['server'], tty: '', env: { HORNHOOF_SERVER_DIR: dir } });
    expect(r.code).toBe(0);
    expect(readFileSync(join(dir, '.env'), 'utf8')).toMatch(/^HORNHOOF_NODE_REF=ghcr\.io\/invariant0x\/hornhoof-node:latest$/m);
    expect(r.calls.join('\n')).not.toContain(DIGEST);
  });

  it('takes the image a person names on a server CI did not build, without a word about either', async () => {
    const own = 'registry.acme.test/node:own';
    const script = await fromServer(DIGEST, 'local');
    const r = install({ script, env: { HORNHOOF_NODE_IMAGE: own } });
    expect(r.code).toBe(0);
    expect(r.calls).toContain(`docker pull ${own}`);
    expect(r.calls.filter(c => c.startsWith('docker run -d')).every(c => c.endsWith(own))).toBe(true);
    expect(r.out).not.toContain(LOCAL_NOTE);
    const failed = install({ script, env: { HORNHOOF_NODE_IMAGE: own, STUB_PULL: 'fail' } });
    expect(failed.code).toBe(1);
    expect(failed.out).toContain(`Could not download ${own}. Check the internet connection, then run this command again.`);
    expect(failed.out).not.toContain(NOT_PUBLISHED);
  });

  describe('without the live check of its build', () => {
    const REASONS: LiveCheckReason[] = ['missing', 'invalid', 'foreign', 'partial', 'stale'];
    const nothingHappened = (r: ReturnType<typeof install>) => {
      expect(r.code).toBe(1);
      expect(r.calls.some(c => c.includes('/api/nodes/join'))).toBe(false);
      expect(r.calls.some(c => /^docker (pull|run|rm|stop)/.test(c))).toBe(false);
    };

    it.each(REASONS)('stops a joining machine before its command is used up, for a live check that is %s', async reason => {
      const r = install({ script: await fromServer(DIGEST, COMMIT, { ok: false, reason }) });
      nothingHappened(r);
      expect(r.out).toContain(LIVE_CHECK_REFUSALS[reason]);
    });

    it.each([[['--urgent']], [[]]])('leaves the nodes on this machine as they are with the arguments %j', async args => {
      const r = install({ script: await fromServer(DIGEST, COMMIT, { ok: false, reason: 'missing' }), args, env: ON_MACHINE });
      nothingHappened(r);
      expect(r.out).toContain('stay as they are');
    });

    it('goes by what the registry can say, and says so when it cannot', async () => {
      const r = install({ script: await fromServer(DIGEST, COMMIT, new Error('The registry answered 503.')) });
      nothingHappened(r);
      expect(r.out).toContain('Could not read the live check of this build');
      expect(r.out).not.toContain('503');
    });

    it('still takes the nodes off a machine', async () => {
      const script = await fromServer(DIGEST, COMMIT, { ok: false, reason: 'missing' });
      const gone = install({ script, args: ['--uninstall'], tty: 'y\n', env: ON_MACHINE });
      expect(gone.code).toBe(0);
      expect(gone.calls).toContain(`docker rm -f ${NODE}`);
    });

    it('lets no one name another image instead, whatever that server has', async () => {
      const own = 'ghcr.io/invariant0x/hornhoof-node:unchecked';
      for (const script of [await fromServer(DIGEST, COMMIT, { ok: false, reason: 'missing' }), await fromServer(DIGEST), SCRIPT]) {
        const r = install({ script, env: { ...ON_MACHINE, HORNHOOF_NODE_IMAGE: own } });
        nothingHappened(r);
        expect(r.calls.join('\n')).not.toContain(own);
      }
    });

    /* No server's build stands for the latest image, so that tag answers for itself. Today it is 0.7.0. */
    describe('where the latest image is what a machine would get', () => {
      const LATE = { STUB_IMAGE_VERSION: '0.7.0', STUB_IMAGE_COMMIT: COMMIT };
      const nothingOfItHappened = (r: ReturnType<typeof install>) => {
        expect(r.code).toBe(1);
        expect(r.out).toContain('stay as they are');
        expect(r.calls.some(c => c.includes('/api/nodes/join'))).toBe(false);
        expect(r.calls).not.toContain(`docker pull ${IMAGE}`);
        expect(r.calls.some(c => /^docker (run -d|rm|stop)/.test(c))).toBe(false);
      };

      it.each([[['--join', CODE]], [['--urgent']], [[]]])('leaves a machine as it is for a script from the repository, with the arguments %j', args => {
        for (const answer of ['no', 'no answer']) nothingOfItHappened(install({ args, env: { ...ON_MACHINE, ...LATE, STUB_LIVE_CHECK: answer } }));
      });

      it('leaves a machine as it is on a server CI did not build', async () => {
        nothingOfItHappened(install({ script: await fromServer(DIGEST, 'local'), env: { ...LATE, STUB_LIVE_CHECK: 'no' } }));
      });

      it('asks the latest app image, by the same tag, and starts the nodes once it says yes', () => {
        const r = install({ env: LATE });
        expect(r.code).toBe(0);
        expect(r.calls).toContain(`docker run --rm --entrypoint node ghcr.io/invariant0x/hornhoof:latest apps/server/dist/live-check-gate.js --image ghcr.io/invariant0x/hornhoof --commit ${COMMIT} --tag latest`);
        expect(indexOf(r.calls, 'docker run --rm --entrypoint node')).toBeLessThan(r.calls.indexOf(`docker pull ${IMAGE}`));
      });

      it('takes a latest image from before live checks, which has none to show', () => {
        const r = install({ env: { STUB_IMAGE_VERSION: '0.6.1', STUB_LIVE_CHECK: 'no' } });
        expect(r.code).toBe(0);
        expect(r.calls.some(c => c.includes('live-check-gate'))).toBe(false);
      });

      it('asks nothing of the image of a build its server says it may give', async () => {
        const r = install({ script: await fromServer(DIGEST), env: { STUB_LIVE_CHECK: 'no' } });
        expect(r.code).toBe(0);
        expect(r.calls.some(c => c.includes('live-check-gate'))).toBe(false);
      });
    });

    it('asks the registry rarely, as anyone may read install.sh', async () => {
      const { app } = await testApp({ HORNHOOF_VERSION: '0.7.3', HORNHOOF_COMMIT: COMMIT });
      vi.spyOn(app.ctx.updates, 'siblings').mockResolvedValue({ node: DIGEST, updater: '' });
      const asked = vi.spyOn(app.ctx.updates, 'ownLiveCheck').mockResolvedValue({ ok: false, reason: 'missing' });
      for (let i = 0; i < 3; i++) expect((await app.inject({ url: '/install.sh' })).body).toContain(LIVE_CHECK_REFUSALS.missing);
      expect(asked).toHaveBeenCalledTimes(1);
      /* Once the check is out it stays out, so nobody asks again. */
      const { app: proven } = await testApp({ HORNHOOF_VERSION: '0.7.3', HORNHOOF_COMMIT: COMMIT });
      vi.spyOn(proven.ctx.updates, 'siblings').mockResolvedValue({ node: DIGEST, updater: '' });
      const once = vi.spyOn(proven.ctx.updates, 'ownLiveCheck').mockResolvedValue({ ok: true });
      for (let i = 0; i < 2; i++) expect((await proven.inject({ url: '/install.sh' })).body).toContain('NO_NODE=""');
      expect(once).toHaveBeenCalledTimes(1);
    });

    it('gives the nodes of its own build on a server that says it is a live check stand, and no other image', async () => {
      const script = await fromServer(DIGEST, COMMIT, { ok: false, reason: 'missing' }, { HORNHOOF_LIVE_CHECK_STAND: '1' });
      const r = install({ script });
      expect(r.code).toBe(0);
      expect(r.calls).toContain(`docker pull ${BY_DIGEST}`);
      expect(r.calls.filter(c => c.startsWith('docker run -d')).every(c => c.endsWith(BY_DIGEST))).toBe(true);
      expect(install({ script, env: { HORNHOOF_NODE_IMAGE: 'registry.acme.test/node:own' } }).code).toBe(1);
    });

    it('starts the nodes of a candidate on a stand from the image on this computer, with nothing of it published', async () => {
      const script = await fromServer('', COMMIT, new Error('The registry has never heard of it.'), { HORNHOOF_LIVE_CHECK_STAND: '1' });
      const r = install({ script, env: { STUB_PULL: 'fail', STUB_IMAGE_LOCAL: '1' } });
      expect(r.code).toBe(0);
      expect(r.out).toContain('Using the local image.');
      expect(r.calls.filter(c => c.startsWith('docker run -d')).every(c => c.endsWith(BY_TAG))).toBe(true);
    });

    it('takes nothing for a stand but what the server was told', async () => {
      for (const flag of ['', '0', 'true']) {
        const r = install({ script: await fromServer(DIGEST, COMMIT, { ok: false, reason: 'missing' }, { HORNHOOF_LIVE_CHECK_STAND: flag }) });
        expect(r.code).toBe(1);
      }
    });
  });

  /* The check of a release gives a node of the build a turn, one node at a time and before any proof exists, and puts that node
     back if the turn fails. That alone goes past the door. */
  describe('one node for the live check of its build', () => {
    const KIMI = 'hornhoof-kimi-1c07dac4';
    const CODEX = 'hornhoof-codex-9f1e2d3c';
    const MACHINE = 'hornhoof-machine-77777777';
    const ANOTHER_KIMI = 'hornhoof-kimi-55555555';
    const ELSEWHERE = 'hornhoof-kimi-99999999';
    const HERE = { STUB_CONTAINERS: `${KIMI}=${SERVER} ${CODEX}=${SERVER} ${MACHINE}=${SERVER} ${ANOTHER_KIMI}=${SERVER} ${ELSEWHERE}=https://another.example.test` };
    const BACK = 'ghcr.io/invariant0x/hornhoof-node@sha256:81d4bb316b6dd568ddd42fa2d6ef877ddc80b3604b75d291492d361debd5645f';
    const check = (node = KIMI, commit = COMMIT) => ['check-node', node, commit];
    const changes = (r: ReturnType<typeof install>) => r.calls.filter(c => /^docker (stop|rm|run -d)/.test(c));
    const nothingHappened = (r: ReturnType<typeof install>) => {
      expect(r.code).toBe(1);
      expect(changes(r)).toEqual([]);
      expect(r.calls.some(c => c.includes('/api/nodes/join'))).toBe(false);
    };

    it('moves the one node it names to the node image of that commit, and no other', () => {
      const r = install({ args: check(), env: HERE });
      expect(r.code).toBe(0);
      expect(r.calls).toContain(`docker pull ${BY_TAG}`);
      expect(changes(r)).toEqual([`docker stop --time 5 ${KIMI}`, `docker rm -f ${KIMI}`, expect.stringMatching(new RegExp(`^docker run -d --name ${KIMI} .*-v ${KIMI}:/data .*${BY_TAG}$`))]);
      expect(r.out).toContain(`${KIMI} runs ${BY_TAG}`);
    });

    it('asks no door, on a script of a server that gives no node of its build or from the repository', async () => {
      for (const script of [await fromServer(DIGEST, COMMIT, { ok: false, reason: 'missing' }), SCRIPT]) {
        const r = install({ script, args: check(), env: { ...HERE, STUB_LIVE_CHECK: 'no' } });
        expect(r.code).toBe(0);
        expect(r.calls.some(c => c.includes('live-check-gate'))).toBe(false);
        expect(r.calls.find(c => c.startsWith('docker run -d'))!.endsWith(BY_TAG)).toBe(true);
      }
    });

    it('says nothing about the latest image on a server CI did not build, which it does not take', async () => {
      const r = install({ script: await fromServer(DIGEST, 'local'), args: check(), env: HERE });
      expect(r.code).toBe(0);
      expect(r.out).not.toContain(LOCAL_NOTE);
      expect(r.calls.find(c => c.startsWith('docker run -d'))!.endsWith(BY_TAG)).toBe(true);
    });

    it('gets the way back before it touches the node, and leaves the node as it is when it cannot', () => {
      const r = install({ args: check(), env: HERE });
      expect(indexOf(r.calls, `docker pull ${BACK}`)).toBeGreaterThanOrEqual(0);
      expect(indexOf(r.calls, `docker pull ${BACK}`)).toBeLessThan(indexOf(r.calls, 'docker stop'));
      const stuck = install({ args: check(), env: { ...HERE, STUB_PULL: 'digest' } });
      nothingHappened(stuck);
      expect(stuck.out).toContain(`Could not download ${BACK}`);
    });

    it('takes only the published image of that commit, not a copy of that name built on this computer', () => {
      const r = install({ args: check(), env: { ...HERE, STUB_PULL: 'node', STUB_IMAGE_LOCAL: '1' } });
      nothingHappened(r);
      expect(r.out).toContain(`Could not download ${BY_TAG}`);
    });

    it('lets the work of the node end first, and leaves it as it is when it cannot learn when', () => {
      const r = install({ args: check(), env: HERE });
      expect(indexOf(r.calls, 'docker run --rm --cap-drop ALL')).toBeLessThan(indexOf(r.calls, 'docker stop'));
      expect(r.calls.find(c => c.includes('wait-update'))).toContain(BY_TAG);
      const left = install({ args: check(), env: { ...HERE, STUB_WAIT_UPDATE: '1' } });
      nothingHappened(left);
      expect(left.out).toContain('Nothing changed');
      expect(left.out).not.toContain('--urgent');
      const old = install({ args: check(), env: { ...HERE, STUB_WAIT_UPDATE: '3' } });
      nothingHappened(old);
      expect(old.out).toContain('from before nodes wait');
    });

    it('says by its digest which image the node runs, as a tag can move', () => {
      expect(install({ args: check(), env: HERE }).out).toContain('ghcr.io/invariant0x/hornhoof-node@sha256:feed');
    });

    it('stops with the way back in its words when the new container does not start', () => {
      const r = install({ args: check(), env: { ...HERE, STUB_RUN: 'fail' } });
      expect(r.code).toBe(1);
      expect(r.out).toContain(`back-node ${KIMI}`);
    });

    it.each(['latest', '0.7.1', COMMIT.slice(0, 12), COMMIT.toUpperCase(), `${COMMIT}0`, `x${COMMIT.slice(1)}`, 'ghcr.io/invariant0x/hornhoof-node:latest', ''])('takes only a whole commit, not %j', commit => {
      const r = install({ args: check(KIMI, commit), env: HERE });
      nothingHappened(r);
      expect(r.calls.filter(c => c.startsWith('docker pull'))).toEqual([]);
    });

    it.each([['no node of that name', 'hornhoof-kimi-00000000'], ['a node of another server', ELSEWHERE], ['the node of a machine with no plan', MACHINE], ['more than a name', `${KIMI} ${CODEX}`], ['nothing', '']])('takes %s', (_what, node) => {
      nothingHappened(install({ args: check(node), env: HERE }));
    });

    it('takes no second node of a plan, as one is what its check needs', () => {
      const r = install({ args: check(), env: { ...HERE, STUB_NODE_IMAGES: `${ANOTHER_KIMI}=${BY_TAG}` } });
      nothingHappened(r);
      expect(r.out).toContain(ANOTHER_KIMI);
      expect(install({ args: check(), env: { ...HERE, STUB_NODE_IMAGES: `${CODEX}=${BY_TAG}` } }).code).toBe(0);
      expect(install({ args: check(), env: { ...HERE, STUB_NODE_IMAGES: `${ANOTHER_KIMI}=${BY_DIGEST}` } }).code).toBe(0);
    });

    it.each([[[...check(), '--urgent']], [['--urgent', ...check()]], [[...check(), '--join', CODE]], [[...check(), CODEX]], [['server', ...check()]], [[...check(), 'server']], [[...check(), '--uninstall']], [['check-node', KIMI]], [['check-node']]])('takes nothing more than its node and commit: %j', args => {
      nothingHappened(install({ args, env: HERE }));
    });

    it('takes no image a person names', () => {
      const own = 'ghcr.io/invariant0x/hornhoof-node:unchecked';
      for (const args of [check(), ['back-node', KIMI]]) {
        const r = install({ args, env: { ...HERE, HORNHOOF_NODE_IMAGE: own } });
        nothingHappened(r);
        expect(r.calls.join('\n')).not.toContain(own);
      }
    });

    it('opens nothing else: the same script still gives no machine that build', async () => {
      const script = await fromServer(DIGEST, COMMIT, { ok: false, reason: 'missing' });
      expect(install({ script, args: check(), env: HERE }).code).toBe(0);
      for (const args of [[], ['--urgent'], ['--join', CODE]]) nothingHappened(install({ script, args, env: HERE }));
    });

    it('stops when no server is known, where it would see the nodes of every server', () => {
      nothingHappened(install({ args: check(), env: { ...HERE, HORNHOOF_SERVER: '' } }));
    });

    describe('and back', () => {
      const back = (node = KIMI) => ['back-node', node];

      it('puts the node it names back at once on that version by digest, and no other', () => {
        const r = install({ args: back(), env: { ...HERE, STUB_WAIT_UPDATE: '1' } });
        expect(r.code).toBe(0);
        expect(r.calls.some(c => c.includes('wait-update'))).toBe(false);
        expect(changes(r)).toEqual([`docker stop --time 5 ${KIMI}`, `docker rm -f ${KIMI}`, expect.stringMatching(new RegExp(`^docker run -d --name ${KIMI} .*-v ${KIMI}:/data .*${BACK}$`))]);
        expect(r.out).toContain(`${KIMI} runs ${BACK}`);
      });

      it('goes from the image on this computer without asking the registry, which may be what stopped working', () => {
        const r = install({ args: back(), env: { ...HERE, STUB_IMAGE_LOCAL: '1' } });
        expect(r.code).toBe(0);
        expect(r.calls.filter(c => c.startsWith('docker pull'))).toEqual([]);
        expect(r.calls.find(c => c.startsWith('docker run -d'))!.endsWith(BACK)).toBe(true);
      });

      it('downloads the way back when this computer does not have it, and leaves the node as it is when it cannot', () => {
        expect(install({ args: back(), env: HERE }).calls).toContain(`docker pull ${BACK}`);
        nothingHappened(install({ args: back(), env: { ...HERE, STUB_PULL: 'node' } }));
      });

      it('asks no door and goes on a script of a server that gives no node of its build', async () => {
        const r = install({ script: await fromServer(DIGEST, COMMIT, { ok: false, reason: 'missing' }), args: back(), env: { ...HERE, STUB_LIVE_CHECK: 'no' } });
        expect(r.code).toBe(0);
        expect(r.calls.some(c => c.includes('live-check-gate'))).toBe(false);
      });

      it.each([['no node of that name', ['back-node', 'hornhoof-kimi-00000000']], ['a node of another server', back(ELSEWHERE)], ['the node of a machine with no plan', back(MACHINE)], ['no node', ['back-node']], ['two nodes', [...back(), CODEX]], ['--urgent', [...back(), '--urgent']], ['server', ['server', ...back()]]])('takes %s', (_what, args) => {
        nothingHappened(install({ args, env: HERE }));
      });

      it('says it worked once the node reached its server, not because its folder reads ready, and still has it running', () => {
        const r = install({ args: back(), env: { ...HERE, STUB_NODE_LOGS: 'Starting.', HORNHOOF_NODE_ANSWER_WAIT: '1' } });
        expect(r.code).toBe(1);
        expect(r.out).toContain(`docker logs ${KIMI}`);
        expect(r.out).not.toContain('reached Hornhoof');
        expect(r.calls.some(c => c.startsWith('docker run -d'))).toBe(true);
        expect(install({ args: back(), env: HERE }).out).toContain(`${KIMI} runs ${BACK} and reached Hornhoof`);
      });

      describe('when a start that failed took the container and left the volume', () => {
        const ID = '1c07dac4-aaaa-4bbb-8ccc-dddddddddddd';
        const GONE = { STUB_CONTAINERS: `${CODEX}=${SERVER}` };

        it('finds the node by what its volume says', () => {
          const r = install({ args: back(), env: { ...GONE, STUB_VOLUMES: `${KIMI}=${SERVER}=${ID}` } });
          expect(r.code).toBe(0);
          const started = r.calls.find(c => c.startsWith('docker run -d'))!;
          expect(started).toContain(`--name ${KIMI} --label hornhoof.subscription=${ID} `);
          expect(started.endsWith(BACK)).toBe(true);
        });

        it.each([['another server', `${KIMI}=https://another.example.test=${ID}`], ['another node', `${KIMI}=${SERVER}=ffffffff-aaaa-4bbb-8ccc-dddddddddddd`], ['an id no server gives', `${KIMI}=${SERVER}=${ID};x`], ['no id', `${KIMI}=${SERVER}=`]])('takes no volume that says it is of %s', (_of, STUB_VOLUMES) => {
          nothingHappened(install({ args: back(), env: { ...GONE, STUB_VOLUMES } }));
        });

        it('takes from the volume who the node is and never its key, as Docker keeps what a container prints in its logs', () => {
          const read = install({ args: back(), env: { ...GONE, STUB_VOLUMES: `${KIMI}=${SERVER}=${ID}` } }).calls.find(c => c.includes('/data/node.json'))!;
          expect(read).toContain('--entrypoint /bin/sed');
          const settings = JSON.stringify({ server: SERVER, subscriptionId: ID, provider: 'kimi', key: 'the-key-of-the-node' }, null, 2);
          const shown = execFileSync('sed', ['-n', '-E', /-n -E (.+) \/data\/node\.json$/.exec(read)![1]!], { input: settings, encoding: 'utf8' });
          expect(shown).toContain(SERVER);
          expect(shown).toContain(ID);
          expect(shown).not.toContain('the-key-of-the-node');
        });

        it('reads nothing when there is no such volume, as docker run would make an empty one', () => {
          const r = install({ args: back(), env: GONE });
          nothingHappened(r);
          expect(r.calls.some(c => c.includes('/data/node.json'))).toBe(false);
        });

        it('takes no name that is not the shape of a node, as -v would take it for a folder', () => {
          const r = install({ args: ['back-node', '/etc'], env: { ...GONE, STUB_VOLUMES: `/etc=${SERVER}=${ID}` } });
          nothingHappened(r);
          expect(r.calls.some(c => c.includes('docker volume') || c.includes('/data/node.json'))).toBe(false);
        });

        it('does this on the way back alone', () => {
          nothingHappened(install({ args: check(), env: { ...GONE, STUB_VOLUMES: `${KIMI}=${SERVER}=${ID}` } }));
        });
      });
    });
  });

  it('writes what a refusal says into the script as plain words', () => {
    for (const words of [...Object.values(LIVE_CHECK_REFUSALS), LIVE_CHECK_UNREAD]) expect(words).not.toMatch(/["$`\\]/);
  });

  it('works as before when it comes from the repository and not from a server', () => {
    const r = install();
    expect(r.code).toBe(0);
    expect(r.calls).toContain(`docker pull ${IMAGE}`);
    expect(r.calls.filter(c => c.startsWith('docker run -d')).every(c => c.endsWith(IMAGE))).toBe(true);
    expect(r.out).not.toContain(LOCAL_NOTE);
    const failed = install({ env: { STUB_PULL: 'node' } });
    expect(failed.code).toBe(1);
    expect(failed.out).toContain(`Could not download ${IMAGE}. Check the internet connection, then run this command again.`);
    expect(failed.out).not.toContain(NOT_PUBLISHED);
  });
});
