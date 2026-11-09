import { describe, expect, it } from 'vitest';
import { eventually } from '../../../test-support/eventually.mjs';
import { calls, clones, detached, FakePort, KEY, noUpstream, planFor, type Prepare, realGit, refsOf, refusedFirst, runShim, serve, type Stand, stand, tracking } from './external-git-helpers.js';

describe('a fetch by the settings of the remote', () => {
  describe('stops without another fetch', () => {
    const stoppedBy = async (s: Stand, ran: ReturnType<typeof runShim>, port: FakePort, words: string, attempts: number) => {
      port.release();
      const ended = await ran;
      expect(ended.code).toBe(128);
      expect(ended.stderr).toContain(words);
      expect(calls(s, 'fetch')).toHaveLength(attempts);
      expect(port.cancelled).toHaveLength(1);
      expect(port.recorded).toHaveLength(attempts);
    };
    const SETTINGS = 'fatal: the settings of this branch changed while this git command was waiting';
    const REMOTE = 'fatal: the remote changed while this git command was waiting';

    it.each<[string, Prepare, Prepare]>([
      ['the merge refs of the branch changed', tracking, work => { realGit(work, 'config', 'branch.feat.merge', 'refs/heads/zeta'); }],
      ['a merge ref was added', tracking, work => { realGit(work, 'config', '--add', 'branch.feat.merge', 'refs/heads/zeta'); }],
      ['the merge refs of the branch went away', tracking, work => { realGit(work, 'config', '--unset', 'branch.feat.merge'); }],
      ['another branch with an upstream is out', tracking, work => { realGit(work, 'checkout', '--quiet', '-b', 'zeta', '--track', 'origin/zeta'); }],
      ['another branch without one is out', noUpstream, work => { realGit(work, 'checkout', '--quiet', '--no-track', '-b', 'own-2', 'origin/feat'); }],
      ['a branch is out after none', detached, work => { realGit(work, 'checkout', '--quiet', '--no-track', '-b', 'own-2', 'origin/feat'); }],
      ['no branch is out after one', noUpstream, work => { realGit(work, 'checkout', '--quiet', '--detach'); }],
      ['a merge ref came to a branch without one', noUpstream, work => { realGit(work, 'config', 'branch.own.remote', 'origin'); realGit(work, 'config', 'branch.own.merge', 'refs/heads/zeta'); }],
    ])('when %s', async (_name, prepare, change) => {
      const s = stand();
      const { agent } = clones(s, prepare);
      const { port, ran } = await refusedFirst(s, agent);
      change(agent);
      await stoppedBy(s, ran, port, SETTINGS, 1);
    });

    it.each<[string, (alias: string) => [string, string]]>([
      ['a fetch value', alias => [`remote.${alias}.fetch`, '+refs/heads/zeta:refs/remotes/stolen/zeta']],
      ['an address', alias => [`remote.${alias}.url`, 'file:///nowhere']],
      ['any other setting', alias => [`remote.${alias}.tagOpt`, '--tags']],
      ['a group', alias => [`remotes.${alias}`, 'origin']],
    ])('when the service remote inherits %s', async (_name, setting) => {
      const s = stand();
      const { agent } = clones(s, tracking);
      const { port, ran } = await refusedFirst(s, agent);
      realGit(agent, 'config', ...setting(`hh-${port.registered[0]!.operationId}`));
      await stoppedBy(s, ran, port, SETTINGS, 1);
      expect(refsOf(agent)).not.toContain('stolen');
    });

    it('and says the turn ended when that stops a read of the settings', async () => {
      const s = stand();
      const { agent } = clones(s, tracking);
      planFor(s, { 'symbolic-ref': [{ do: 'real' }, { do: 'hang' }] });
      const port = new FakePort();
      const { env, adapter } = await serve(s, port);
      const ran = runShim(['fetch', 'origin'], agent, env);
      await eventually(() => calls(s, 'symbolic-ref').length === 2);
      adapter.unbind(KEY);
      const ended = await ran;
      expect(ended.code).toBe(128);
      expect(ended.stderr).toContain('the turn ended');
      expect(ended.stderr).not.toContain('settings');
      expect(calls(s, 'fetch')).toEqual([]);
    });

    it('when the address of the remote changed', async () => {
      const s = stand();
      const { agent } = clones(s, tracking);
      const { port, ran } = await refusedFirst(s, agent);
      realGit(agent, 'config', 'remote.origin.url', 'file:///nowhere');
      await stoppedBy(s, ran, port, REMOTE, 1);
    });

    it('when a rewrite rule now sends the address elsewhere', async () => {
      const s = stand();
      const { agent } = clones(s, tracking);
      const { port, ran } = await refusedFirst(s, agent);
      realGit(agent, 'config', 'url.file:///nowhere/.insteadOf', s.url);
      await stoppedBy(s, ran, port, REMOTE, 1);
    });

    it.each<[string, (s: Stand, agent: string) => void, string]>([
      ['the settings changed', (_s, agent) => { realGit(agent, 'config', 'branch.feat.merge', 'refs/heads/zeta'); }, SETTINGS],
      ['the address changed', (_s, agent) => { realGit(agent, 'config', 'remote.origin.url', 'file:///nowhere'); }, REMOTE],
    ])('when %s before the first attempt was allowed', async (_name, change, words) => {
      const s = stand();
      const { agent } = clones(s, tracking);
      const port = new FakePort();
      port.registration = { disposition: 'wait', attemptId: null, nextAttemptAt: null };
      const { env } = await serve(s, port);
      const ran = runShim(['fetch', 'origin'], agent, env);
      await eventually(() => ran.partial().stderr.includes('keeps waiting'));
      change(s, agent);
      await stoppedBy(s, ran, port, words, 0);
    });
  });
});
