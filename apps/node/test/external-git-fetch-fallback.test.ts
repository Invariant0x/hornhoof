import { describe, expect, it } from 'vitest';
import { answer, calls, clones, expectSameAsPlain, FakePort, GLOB, MAIN_ONLY, OPERATION_LINE, plainFetch, planFor, type Prepare, realGit, refsOf, REFUSED, refusedFirst, runShim, serve, type Stand, stand, tracking, twoLiterals } from './external-git-helpers.js';

describe('a fetch by the settings of the remote', () => {
  describe('when the first attempt fails', () => {
    it('waits and goes on with the same snapshot, whatever the remote settings became', async () => {
      const s = stand();
      const { agent, plain, moveRemote } = clones(s, tracking);
      moveRemote();
      const plainRan = plainFetch(s, plain, ['fetch', 'origin']);
      const { port, ran } = await refusedFirst(s, agent);
      expect(ran.partial().stderr).not.toContain('503');
      realGit(agent, 'config', '--replace-all', 'remote.origin.fetch', MAIN_ONLY);
      port.release();
      const ended = await ran;
      expectSameAsPlain(ended, plainRan, agent, plain);
      const [first, second] = calls(s, 'fetch');
      expect(second!.argv).toEqual(first!.argv);
      expect(second!.argv).toContain(`remote.hh-${port.registered[0]!.operationId}.fetch=${GLOB}`);
      expect(port.registered).toHaveLength(1);
    });

    it('also goes on after a refspec was added and with a fetch without a remote', async () => {
      const s = stand();
      const { agent, plain, moveRemote } = clones(s, work => { twoLiterals(work); tracking(work); });
      moveRemote();
      const plainRan = plainFetch(s, plain, ['fetch']);
      const { port, ran } = await refusedFirst(s, agent, ['fetch']);
      realGit(agent, 'config', '--add', 'remote.origin.fetch', '+refs/heads/zeta:refs/remotes/origin/zeta');
      port.release();
      expectSameAsPlain(await ran, plainRan, agent, plain);
      expect(realGit(agent, 'for-each-ref', '--format=%(objectname)', 'refs/remotes/origin/zeta')).toBe(realGit(plain, 'for-each-ref', '--format=%(objectname)', 'refs/remotes/origin/zeta'));
    });

    it('deletes nothing when pruning is switched on during the wait', async () => {
      const s = stand();
      const { agent } = clones(s, tracking);
      const { port, ran } = await refusedFirst(s, agent);
      realGit(agent, 'config', 'fetch.prune', 'true');
      realGit(agent, 'config', 'fetch.pruneTags', 'true');
      realGit(s.remote, 'update-ref', '-d', 'refs/heads/zeta');
      port.release();
      expect((await ran).code).toBe(0);
      expect(refsOf(agent)).toContain('refs/remotes/origin/zeta');
    });

    it('shows the output and exit code of a permanent failure', async () => {
      const s = stand();
      const { agent } = clones(s, tracking);
      planFor(s, { fetch: [REFUSED] });
      const port = new FakePort();
      port.replies = [{ accepted: true, state: 'failed_permanent' }];
      const { env } = await serve(s, port);
      const ended = await runShim(['fetch', 'origin'], agent, env);
      expect(ended.code).toBe(128);
      expect(ended.stderr).toContain('error: 503');
      expect(ended.stderr).toMatch(OPERATION_LINE);
    });

    it('waits on an unknown outcome and tries again when the server allows it', async () => {
      const s = stand();
      const { agent, plain, moveRemote } = clones(s, tracking);
      moveRemote();
      const plainRan = plainFetch(s, plain, ['fetch', 'origin']);
      const { port, ran } = await refusedFirst(s, agent, ['fetch', 'origin'], [{ accepted: true, state: 'outcome_unknown' }]);
      expect(ran.partial().stderr).toContain('the result of this fetch is not known yet');
      expect(ran.partial().stderr).not.toContain('push');
      port.release();
      expectSameAsPlain(await ran, plainRan, agent, plain);
      expect(calls(s, 'fetch')).toHaveLength(2);
      for (const recorded of port.recorded) expect(recorded).not.toHaveProperty('observedHead');
    });
  });

  describe('stays plain git', () => {
    const asked = (work: string) => ({ kind: 'fetch_configured', cwd: work, remote: 'origin', flags: [] });

    it.each<[string, string, (s: Stand, work: string) => void]>([
      ['git_version', 'git 2.48', s => { planFor(s, { '--version': [{ do: 'say', stdout: 'git version 2.48.0\n', exit: 0 }] }); }],
      ['git_version', 'a later git', s => { planFor(s, { '--version': [{ do: 'say', stdout: 'git version 3.0.0\n', exit: 0 }] }); }],
      ['git_version', 'a version it cannot read', s => { planFor(s, { '--version': [{ do: 'say', stdout: 'some other program\n', exit: 0 }] }); }],
      ['git_version', 'a version git would not tell', s => { planFor(s, { '--version': [{ do: 'say', exit: 1 }] }); }],
      ['remote_settings', 'remote.origin.prune', (_s, work) => { realGit(work, 'config', 'remote.origin.prune', 'true'); }],
      ['remote_settings', 'remote.origin.pruneTags', (_s, work) => { realGit(work, 'config', 'remote.origin.pruneTags', 'true'); }],
      ['remote_settings', 'remote.origin.tagOpt', (_s, work) => { realGit(work, 'config', 'remote.origin.tagOpt', '--no-tags'); }],
      ['remote_settings', 'remote.origin.mirror', (_s, work) => { realGit(work, 'config', 'remote.origin.mirror', 'true'); }],
      ['remote_settings', 'remote.origin.uploadpack', (_s, work) => { realGit(work, 'config', 'remote.origin.uploadpack', 'x'); }],
      ['remote_settings', 'remote.origin.proxy', (_s, work) => { realGit(work, 'config', 'remote.origin.proxy', 'http://x'); }],
      ['remote_settings', 'remote.origin.promisor', (_s, work) => { realGit(work, 'config', 'remote.origin.promisor', 'true'); }],
      ['remote_settings', 'a group with the name of the remote', (_s, work) => { realGit(work, 'config', 'remotes.origin', 'origin'); }],
      ['remote_settings', 'no fetch setting', (_s, work) => { realGit(work, 'config', '--unset-all', 'remote.origin.fetch'); }],
      ['remote_settings', 'a negative refspec', (_s, work) => { realGit(work, 'config', '--add', 'remote.origin.fetch', '^refs/heads/zeta'); }],
      ['remote_settings', 'a destination outside refs/remotes', (_s, work) => { realGit(work, 'config', '--replace-all', 'remote.origin.fetch', '+refs/heads/*:refs/heads/*'); }],
      ['remote_settings', 'a refspec without a destination', (_s, work) => { realGit(work, 'config', '--replace-all', 'remote.origin.fetch', 'refs/heads/main'); }],
      ['remote_settings', 'an address changed by a rewrite rule', (s, work) => { realGit(work, 'config', 'remote.origin.url', 'file:///short'); realGit(work, 'config', `url.${s.url}.insteadOf`, 'file:///short'); }],
      ['prune_settings', 'fetch.prune', (_s, work) => { realGit(work, 'config', 'fetch.prune', 'yes'); }],
      ['prune_settings', 'fetch.pruneTags', (_s, work) => { realGit(work, 'config', 'fetch.pruneTags', 'true'); }],
      ['branch_settings', 'an upstream of another remote', (_s, work) => { realGit(work, 'remote', 'add', 'other', 'file:///other'); realGit(work, 'config', 'branch.feat.remote', 'other'); }],
      ['branch_settings', 'an upstream in this repository', (_s, work) => { realGit(work, 'config', 'branch.feat.remote', '.'); }],
      ['branch_settings', 'a merge ref without a remote', (_s, work) => { realGit(work, 'config', '--unset', 'branch.feat.remote'); }],
      ['branch_settings', 'another remote without a merge ref', (_s, work) => { realGit(work, 'config', '--unset', 'branch.feat.merge'); realGit(work, 'config', 'branch.feat.remote', 'other'); }],
      ['branch_settings', 'a branch name git options cannot carry', (_s, work) => { realGit(work, 'checkout', '--quiet', '--no-track', '-b', 'a=b', 'origin/feat'); }],
    ])('answers %s for %s', async (reason, _name, prepare) => {
      const s = stand();
      const { agent } = clones(s, tracking);
      prepare(s, agent);
      const port = new FakePort();
      const served = await serve(s, port);
      expect(await answer(served, asked(agent))).toEqual([{ type: 'unmanaged', reason }]);
      expect(port.registered).toEqual([]);
      expect(calls(s, 'fetch')).toEqual([]);
    });

    it('runs plain git with its own output when the node turns it down', async () => {
      const s = stand();
      const { agent, plain, moveRemote } = clones(s, work => { tracking(work); realGit(work, 'config', 'remote.origin.tagOpt', '--no-tags'); });
      moveRemote();
      const plainRan = plainFetch(s, plain, ['fetch', 'origin']);
      const port = new FakePort();
      const { env } = await serve(s, port);
      const ran = await runShim(['fetch', 'origin'], agent, env);
      expectSameAsPlain(ran, plainRan, agent, plain);
      expect(port.registered).toEqual([]);
      expect(calls(s, 'fetch').map(call => call.argv)).toEqual([['fetch', 'origin']]);
    });

    /* The one test where the git of this machine says what it is. A clone without origin/HEAD is what sets 2.48 apart: from then on
       plain git writes it, and a fetch through the service remote would not. */
    it('goes by what the real git says about itself and gives what it gives', async () => {
      const s = stand();
      const withoutRemoteHead: Prepare = work => { realGit(work, 'remote', 'set-head', 'origin', '--delete'); tracking(work); };
      const { agent, plain, moveRemote } = clones(s, withoutRemoteHead);
      moveRemote();
      const plainRan = plainFetch(s, plain, ['fetch', 'origin']);
      planFor(s, { '--version': [{ do: 'real' }] });
      const port = new FakePort();
      const { env } = await serve(s, port);
      const ran = await runShim(['fetch', 'origin'], agent, env);
      expectSameAsPlain(ran, plainRan, agent, plain);
      const [major, minor] = /(\d+)\.(\d+)/.exec(realGit(s.dir, '--version'))!.slice(1).map(Number) as [number, number];
      const belowTheChange = major < 2 || (major === 2 && minor < 48);
      expect(port.registered).toHaveLength(belowTheChange ? 1 : 0);
    });

    it('takes the last git before the change and settings that do not touch a fetch', async () => {
      const s = stand();
      const { agent } = clones(s, tracking);
      planFor(s, { '--version': [{ do: 'say', stdout: 'git version 2.47.9\n', exit: 0 }] });
      realGit(agent, 'config', 'remote.origin.pushurl', s.url);
      realGit(agent, 'config', 'remote.origin.push', 'refs/heads/feat');
      realGit(agent, 'config', 'remote.origin.gh-resolved', 'base');
      const port = new FakePort();
      const { env } = await serve(s, port);
      expect((await runShim(['fetch', 'origin'], agent, env)).code).toBe(0);
      expect(port.registered).toHaveLength(1);
    });
  });
});
