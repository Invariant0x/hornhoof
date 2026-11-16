import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CODE, IMAGE, SERVER, SUB_A, SUB_B, indexOf, install } from './install-script-helpers.js';

describe('install.sh', () => {

  it('starts one locked-down container per subscription and signs each in from the terminal', () => {
    const r = install({ tty: 'typed-answer\n', env: { STUB_STATUS: 'after_login' } });
    expect(r.code).toBe(0);
    expect(r.calls.find(c => c.startsWith('curl') && c.includes('/api/nodes/join'))).toContain('accept: text/plain');
    /* The code travels in a file, not on the command line where other users could see it. */
    const request = r.calls.find(c => c.startsWith('curl-data'))!;
    expect(r.calls.find(c => c.startsWith('curl ') && c.includes(CODE))).toBeUndefined();
    expect(request).toMatch(/"machineId":"[0-9a-f]{32}"/);
    expect(request).toContain(`"code":"${CODE}"`);
    expect(request).toContain('"os":"linux"');
    expect(request).toContain('"arch":"x86_64"');
    expect(request).toContain('"hostname":"test-box"');

    const runs = r.calls.filter(c => c.startsWith('docker run -d'));
    expect(runs).toHaveLength(2);
    for (const [name, id] of [['hornhoof-claude-1c07dac4', SUB_A], ['hornhoof-codex-9f1e2d3c', SUB_B]]) {
      const run = runs.find(c => c.includes(`--name ${name} `))!;
      expect(run).toContain(`--label hornhoof.subscription=${id}`);
      expect(run).toContain('--restart unless-stopped');
      expect(run).toContain('--cap-drop ALL');
      /* Root inside the container only, to run the agents as a user of their own and check which of them calls. */
      expect(run).toContain('--user 0:0');
      for (const cap of ['CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'KILL', 'SETGID', 'SETUID', 'SYS_PTRACE']) expect(run).toContain(`--cap-add ${cap}`);
      expect(run).toContain('--security-opt no-new-privileges');
      /* Docker's AppArmor profile on newer Linux, as Debian 13, keeps the node from seeing and stopping its agents' programs. */
      expect(run).toContain('--security-opt apparmor=unconfined');
      expect(run).toContain('--shm-size 2g');
      expect(run).toContain(`-v ${name}:/data`);
      expect(run.endsWith(IMAGE)).toBe(true);
      expect(run).not.toContain('node-key-');
    }
    expect(r.calls).toContain(`stdin ${SERVER} ${SUB_A} claude node-key-aaaaaaaaaaaaaaaa`);
    /* The key goes into a file only root reads, through a container that may write the node's folder and nothing more. */
    const keys = r.calls.filter(c => c.startsWith('docker run --rm -i') && c.endsWith('set-key'));
    expect(keys).toHaveLength(2);
    for (const key of keys) expect(key).toMatch(/--network none --user 0:0 --cap-drop ALL --cap-add DAC_OVERRIDE --security-opt no-new-privileges /);
    expect(r.calls.filter(c => c.startsWith('tty '))).toEqual(['tty typed-answer', 'tty typed-answer']);
    expect(r.out).toContain('You can also sign in once in Hornhoof under Subscriptions, for all your machines.');
    expect(r.calls.filter(c => c.startsWith('docker exec -it') && c.endsWith('login'))).toHaveLength(2);
    expect(r.out).toMatch(/Claude.*ready/);
    expect(r.out).toMatch(/Codex.*ready/);
    expect(existsSync(join(r.dir, 'home', '.hornhoof', 'machine'))).toBe(true);
  });

  it("skips the terminal sign-in on a joined node that got its plan's sign-in from Hornhoof", () => {
    /* The owner signed the plan in once in Hornhoof: it reaches a new node of the plan within seconds. */
    const r = install({ env: { HORNHOOF_SIGNIN_WAIT: '20' } });
    expect(r.code).toBe(0);
    expect(r.calls.filter(c => c.startsWith('docker exec -it'))).toEqual([]);
    expect(r.calls.filter(c => c.startsWith('tty '))).toEqual([]);
    expect(r.out).toContain('Claude on hornhoof-claude-1c07dac4 got its sign-in from Hornhoof.');
    expect(r.out).toMatch(/Claude: ready/);
    expect(r.out).toMatch(/Codex: ready/);
  });

  it('signs in nothing on a spare machine of a Codex plan, on the join and on an update', () => {
    const r = install({ env: { STUB_JOIN_BODY: `${SUB_B} codex node-key-bbbbbbbbbbbbbbbb\\n`, STUB_STATUS: 'spare', HORNHOOF_SIGNIN_WAIT: '20' } });
    expect(r.code).toBe(0);
    expect(r.calls.filter(c => c.startsWith('docker exec -it'))).toEqual([]);
    expect(r.out).toContain('Codex on hornhoof-codex-9f1e2d3c is a spare machine: Codex runs on another machine of this plan and moves here when that one is away.');
    expect(r.out).toMatch(/Codex: spare, Codex runs on another machine of this plan now/);
    const update = install({ args: [], env: { STUB_CONTAINERS: `hornhoof-codex-9f1e2d3c=${SERVER}`, STUB_STATUS: 'spare' } });
    expect(update.calls.filter(c => c.startsWith('docker exec -it'))).toEqual([]);
  });

  it('waits a little for the sign-in from Hornhoof, then signs in here when it does not come', () => {
    const r = install({ env: { STUB_STATUS: 'after_login', HORNHOOF_SIGNIN_WAIT: '2' } });
    expect(r.code).toBe(0);
    expect(r.calls.filter(c => c.startsWith('docker exec -it') && c.endsWith('login'))).toHaveLength(2);
    expect(r.out).not.toContain('got its sign-in from Hornhoof');
    expect(r.out).toMatch(/Claude: ready/);
  });

  it('says how else to sign in when a node is left without its sign-in', () => {
    const r = install({ env: { STUB_STATUS: 'needs_login', STUB_LOGIN_EXIT: '1' } });
    expect(r.code).toBe(0);
    expect(r.out).toContain('The sign-in on hornhoof-claude-1c07dac4 did not finish. Sign in once in Hornhoof under Subscriptions, or run the install command again without --join.');
    expect(r.out).toMatch(/Claude: needs sign-in, sign in once in Hornhoof under Subscriptions/);
  });

  it("takes the owner to agy's terms again on an update, and names that step when the owner leaves it", () => {
    const name = `hornhoof-antigravity-${SUB_A.slice(0, 8)}`;
    const r = install({ args: [], env: { STUB_CONTAINERS: `${name}=${SERVER}`, STUB_STATUS: 'needs_setup', STUB_LOGIN_EXIT: '1' } });
    expect(r.code).toBe(0);
    expect(r.calls.filter(c => c.startsWith(`docker exec -it ${name}`) && c.endsWith('login'))).toHaveLength(1);
    expect(r.out).toContain(`The sign-in or first setup on ${name} did not finish. To try again, run the install command without --join.`);
    expect(r.out).toContain(`Antigravity: needs its first setup, run the install command again without --join (${name})`);
  });

  it('sets up a node for a Google AI plan and signs in to Antigravity on it', () => {
    const r = install({ env: { STUB_JOIN_BODY: `${SUB_A} antigravity node-key-aaaaaaaaaaaaaaaa\\n` } });
    expect(r.code).toBe(0);
    expect(r.calls.some(c => c.startsWith(`docker run -d --name hornhoof-antigravity-${SUB_A.slice(0, 8)}`))).toBe(true);
    expect(r.calls).toContain(`stdin ${SERVER} ${SUB_A} antigravity node-key-aaaaaaaaaaaaaaaa`);
    expect(r.out).toContain('Signing in to Antigravity on');
    expect(r.out).toMatch(/Antigravity.*ready/);
  });

  it('connects a machine without a plan: one node that needs no sign-in and lends itself to test runs', () => {
    const r = install({ env: { STUB_JOIN_BODY: `${SUB_A} machine node-key-mmmmmmmmmmmmmmmm\\n` } });
    expect(r.code).toBe(0);
    const runs = r.calls.filter(c => c.startsWith('docker run -d'));
    expect(runs).toHaveLength(1);
    expect(runs[0]).toContain(`--name hornhoof-machine-${SUB_A.slice(0, 8)} `);
    expect(runs[0]).toContain(`--label hornhoof.subscription=${SUB_A}`);
    expect(r.calls).toContain(`stdin ${SERVER} ${SUB_A} machine node-key-mmmmmmmmmmmmmmmm`);
    expect(r.calls.filter(c => c.startsWith('docker exec -it'))).toEqual([]);
    expect(r.out).not.toContain('Signing in to');
    expect(r.out).toMatch(/Test runs, no plan: ready/);
    expect(r.out).toContain('To run agents here too, add one of your plans to this machine in Hornhoof under Subscriptions.');
  });

  it('says to run a command made for another machine there, and starts nothing', () => {
    const r = install({ env: { STUB_JOIN_STATUS: '409', STUB_JOIN_BODY: '{"error":{"code":"conflict","reason":"other_machine"}}' } });
    expect(r.code).toBe(1);
    expect(r.out).toContain('This command is for another of your machines. Run it on the machine you got it for: Hornhoof shows which one under Machines.');
    expect(r.calls.some(c => c.startsWith('docker run -d'))).toBe(false);
  });

  it('says a machine that runs what the command brings already keeps it, and how to update it instead', () => {
    const r = install({ env: { STUB_JOIN_STATUS: '409', STUB_JOIN_BODY: '{"error":{"code":"conflict","reason":"already_on_machine"}}' } });
    expect(r.code).toBe(1);
    expect(r.out).toContain('This machine already runs what this command connects, and keeps it as it is.');
    expect(r.out).toContain(`curl -fsSL ${SERVER}/install.sh | bash`);
    expect(r.out).not.toContain('another of your machines');
    expect(r.calls.some(c => c.startsWith('docker run -d'))).toBe(false);
  });

  it('keeps the same machine id on the next run', () => {
    const home = join(mkdtempSync(join(tmpdir(), 'hh-machine-')), '.hornhoof');
    const machineOf = (r: ReturnType<typeof install>) => r.calls.find(c => c.startsWith('curl-data'))!.match(/"machineId":"([0-9a-f]{32})"/)![1];
    const first = machineOf(install({ env: { HORNHOOF_HOME: home } }));
    expect(readFileSync(join(home, 'machine'), 'utf8').trim()).toBe(first);
    expect(machineOf(install({ env: { HORNHOOF_HOME: home } }))).toBe(first);
  });

  it('stops with a plain line when the command was already used', () => {
    const r = install({ env: { STUB_JOIN_STATUS: '410', STUB_JOIN_BODY: '{"error":"gone"}' } });
    expect(r.code).toBe(1);
    expect(r.out).toContain('This command was already used or is older than 24 hours. Get a new one in Hornhoof under Subscriptions.');
    expect(r.calls.some(c => c.startsWith('docker run -d'))).toBe(false);
  });

  it('stops with a plain line when the command is not valid', () => {
    const r = install({ env: { STUB_JOIN_STATUS: '404', STUB_JOIN_BODY: '{"error":"not_found"}' } });
    expect(r.code).toBe(1);
    expect(r.out).toContain('This command is not valid. Copy it again from Hornhoof.');
  });

  it('replaces existing containers and keeps their volumes', () => {
    const r = install({ env: { STUB_CONTAINERS: 'hornhoof-claude-1c07dac4 hornhoof-codex-9f1e2d3c' } });
    expect(r.code).toBe(0);
    const rename = indexOf(r.calls, 'docker rename hornhoof-claude-1c07dac4 hornhoof-claude-1c07dac4-old-');
    const run = indexOf(r.calls, 'docker run -d --name hornhoof-claude-1c07dac4');
    const rmOld = indexOf(r.calls, 'docker rm -f hornhoof-claude-1c07dac4-old-');
    expect(rename).toBeGreaterThanOrEqual(0);
    expect(run).toBeGreaterThan(rename);
    expect(rmOld).toBeGreaterThan(run);
    expect(r.calls.some(c => c.startsWith('docker volume rm'))).toBe(false);
  });

  it('leaves the other nodes on this machine alone on --join', () => {
    const r = install({ env: { STUB_CONTAINERS: 'hornhoof-kimi-00000000' } });
    expect(r.code).toBe(0);
    expect(r.calls.some(c => c.includes('hornhoof-kimi-00000000') && /docker (rm|run)/.test(c))).toBe(false);
    expect(r.calls.some(c => c.startsWith(`docker run -d --name hornhoof-claude-${SUB_A.slice(0, 8)}`))).toBe(true);
  });

  it('names the way out when a node does not start after the join used the code', () => {
    const r = install({ env: { STUB_RUN: 'fail' } });
    expect(r.code).toBe(1);
    expect(r.out).toContain('This command is used up: disconnect this machine in Hornhoof under Subscriptions, then get a new command.');
  });

  it('removes the nodes Hornhoof removed, with their volumes', () => {
    const r = install({ env: { STUB_CONTAINERS: `hornhoof-kimi-00000000=${SERVER}`, STUB_REMOVED: 'hornhoof-kimi-00000000' } });
    expect(r.code).toBe(0);
    expect(r.calls).toContain('docker rm -f hornhoof-kimi-00000000');
    expect(r.calls).toContain('docker volume rm hornhoof-kimi-00000000');
  });

  it('removes a stopped node whose volume marks its plan removed instead of starting it again', () => {
    const name = 'hornhoof-claude-1c07dac4';
    const r = install({
      args: [],
      env: {
        HORNHOOF_FROM_UPDATER: '1',
        HORNHOOF_NODES_ONLY: `id-of-${name}`,
        STUB_CONTAINERS: `${name}=${SERVER}`,
        STUB_STOPPED: name,
        STUB_REMOVED: name,
      },
    });
    expect(r.code).toBe(0);
    expect(r.calls).toContain(`docker rm -f ${name}`);
    expect(r.calls).toContain(`docker volume rm ${name}`);
    expect(r.calls.some(c => c.startsWith(`docker run -d --name ${name}`))).toBe(false);
  });

  it('recreates a stopped node of this server without /data/removed on the same volume and removes no volume', () => {
    const name = 'hornhoof-claude-1c07dac4';
    const r = install({
      args: [],
      env: {
        HORNHOOF_FROM_UPDATER: '1',
        HORNHOOF_NODES_ONLY: `id-of-${name}`,
        STUB_CONTAINERS: `${name}=${SERVER}`,
        STUB_STOPPED: name,
        STUB_REMOVED: '',
      },
    });
    expect(r.code).toBe(0);
    expect(r.calls).toContain(`docker cp ${name}:/data/removed -`);
    const rename = indexOf(r.calls, `docker rename ${name} ${name}-old-`);
    const run = indexOf(r.calls, `docker run -d --name ${name} `);
    const rmOld = indexOf(r.calls, `docker rm -f ${name}-old-`);
    expect(rename).toBeGreaterThanOrEqual(0);
    expect(run).toBeGreaterThan(rename);
    expect(rmOld).toBeGreaterThan(run);
    expect(r.calls[run]).toContain(`-v ${name}:/data`);
    expect(r.calls.some(c => c.startsWith('docker volume rm'))).toBe(false);
  });

  it('leaves a stopped node labeled for another server alone even when its volume has /data/removed', () => {
    const name = 'hornhoof-claude-1c07dac4';
    const r = install({
      args: [],
      env: {
        HORNHOOF_FROM_UPDATER: '1',
        HORNHOOF_NODES_ONLY: `id-of-${name}`,
        STUB_CONTAINERS: `${name}=https://other.example`,
        STUB_STOPPED: name,
        STUB_REMOVED: name,
      },
    });
    expect(r.code).toBe(0);
    expect(r.calls.some(c => c.includes(`${name}:/data/removed`))).toBe(false);
    expect(r.calls.some(c => c.includes(`rm -f ${name}`) || c.includes(`volume rm ${name}`))).toBe(false);
    expect(r.calls.some(c => c.startsWith(`docker run -d --name ${name}`))).toBe(false);
  });

  it('leaves a stopped node from before the server label alone even when its volume has /data/removed', () => {
    const name = 'hornhoof-claude-1c07dac4';
    const r = install({
      args: [],
      env: {
        HORNHOOF_FROM_UPDATER: '1',
        HORNHOOF_NODES_ONLY: `id-of-${name}`,
        STUB_CONTAINERS: name,
        STUB_STOPPED: name,
        STUB_REMOVED: name,
      },
    });
    expect(r.code).toBe(0);
    expect(r.calls.some(c => c.includes(`${name}:/data/removed`))).toBe(false);
    expect(r.calls.some(c => c.includes(`rm -f ${name}`) || c.includes(`volume rm ${name}`))).toBe(false);
    expect(r.calls.some(c => c.startsWith(`docker run -d --name ${name}`))).toBe(false);
  });

  it('points nodes at host.docker.internal when the server is on localhost', () => {
    const r = install({ env: { HORNHOOF_SERVER: 'http://localhost:8080' } });
    expect(r.code).toBe(0);
    const run = r.calls.find(c => c.startsWith('docker run -d'))!;
    expect(run).toContain('--add-host host.docker.internal:host-gateway');
    expect(r.calls).toContain(`stdin http://host.docker.internal:8080 ${SUB_A} claude node-key-aaaaaaaaaaaaaaaa`);
  });

  it('starts the latest image on this computer when it cannot download it', () => {
    const r = install({ env: { STUB_PULL: 'fail', STUB_IMAGE_LOCAL: '1' } });
    expect(r.code).toBe(0);
    expect(r.out).toContain('Using the local image.');
    expect(r.calls.filter(c => c.startsWith('docker run -d')).every(c => c.endsWith('ghcr.io/invariant0x/hornhoof-node:latest'))).toBe(true);
  });

  it('stops when the pull fails and there is no local image', () => {
    const r = install({ env: { STUB_PULL: 'fail' } });
    expect(r.code).toBe(1);
    expect(r.calls.some(c => c.startsWith('docker run -d'))).toBe(false);
  });

  it('updates the nodes on this machine when run without a code', () => {
    const r = install({ args: [], env: { STUB_CONTAINERS: `hornhoof-claude-1c07dac4=${SERVER}`, STUB_STATUS: 'needs_login' } });
    expect(r.code).toBe(0);
    expect(r.calls.some(c => c.includes('/api/nodes/join'))).toBe(false);
    expect(r.calls.some(c => c.startsWith('docker rm -f hornhoof-claude-1c07dac4-old-'))).toBe(true);
    expect(r.calls.some(c => c.startsWith('docker run -d --name hornhoof-claude-1c07dac4'))).toBe(true);
    expect(r.calls.some(c => c.startsWith('docker exec -it hornhoof-claude-1c07dac4'))).toBe(true);
  });

  it('labels each node with the server it works for', () => {
    const r = install();
    expect(r.code).toBe(0);
    for (const run of r.calls.filter(c => c.startsWith('docker run -d'))) expect(run).toContain(`--label hornhoof.server=${SERVER}`);
  });

  it('surfaces a named browser launch failure in the node summary without prompting for sign-in again', () => {
    const name = 'hornhoof-claude-1c07dac4';
    const r = install({ args: [], env: { STUB_CONTAINERS: `${name}=${SERVER}`, STUB_STATUS: 'browser_failed: libnss3.so missing' } });
    expect(r.code).toBe(0);
    expect(r.calls.some(c => c.includes(' login'))).toBe(false);
    expect(r.out).toContain(`Claude: browser did not start (libnss3.so missing), see docker logs ${name}`);
  });
});
