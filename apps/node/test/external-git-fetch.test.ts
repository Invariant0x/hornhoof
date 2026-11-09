import { describe, expect, it } from 'vitest';
import { calls, clones, detached, expectSameAsPlain, FakePort, FEAT_ONLY, GLOB, MAIN_ONLY, noUpstream, plainFetch, type Prepare, REPOSITORY, runShim, serve, stand, tracking, twoLiterals } from './external-git-helpers.js';

describe('a fetch by the settings of the remote', () => {
  describe('gives what plain git gives', () => {
    it.each<[string, string[], Prepare]>([
      ['a branch with an upstream', ['fetch', 'origin'], tracking],
      ['a branch with an upstream', ['fetch'], tracking],
      ['a branch without an upstream', ['fetch', 'origin'], noUpstream],
      ['a branch without an upstream', ['fetch'], noUpstream],
      ['no branch', ['fetch', 'origin'], detached],
      ['no branch', ['fetch'], detached],
      ['two literal refspecs and no upstream', ['fetch', 'origin'], work => { twoLiterals(work); noUpstream(work); }],
      ['two literal refspecs and an upstream', ['fetch', 'origin'], work => { twoLiterals(work); tracking(work); }],
      ['the options it keeps', ['fetch', '--quiet', '--no-tags', 'origin'], tracking],
      ['a verbose fetch', ['fetch', '--verbose', 'origin'], tracking],
    ])('with %s: %j', async (_name, args, prepare) => {
      const s = stand();
      const { agent, plain, moveRemote } = clones(s, prepare);
      moveRemote();
      const plainRan = plainFetch(s, plain, args);
      const port = new FakePort();
      const { env } = await serve(s, port);
      const ran = await runShim(args, agent, env);
      expectSameAsPlain(ran, plainRan, agent, plain);
      expect(port.registered).toHaveLength(1);
      expect(calls(s, 'fetch')).toHaveLength(1);
    });
  });

  it('freezes the refspecs, the branch and its merge refs in the intent', async () => {
    const s = stand();
    const { agent } = clones(s, work => { twoLiterals(work); tracking(work); });
    const port = new FakePort();
    const { env } = await serve(s, port);
    expect((await runShim(['fetch', 'origin'], agent, env)).code).toBe(0);
    expect(port.registered[0]!.intent).toEqual({
      kind: 'git_fetch', repositoryId: REPOSITORY,
      target: { kind: 'configured', refspecs: [MAIN_ONLY, FEAT_ONLY], merge: { branch: 'feat', refs: ['refs/heads/feat'] } },
    });
    const { operationId } = port.registered[0]!;
    expect(calls(s, 'fetch')[0]!.argv).toEqual([
      '-C', agent, '-c', `remote.hh-${operationId}.url=${s.url}`, '-c', `remote.hh-${operationId}.fetch=${MAIN_ONLY}`, '-c', `remote.hh-${operationId}.fetch=${FEAT_ONLY}`,
      '-c', 'fetch.prune=false', '-c', 'fetch.pruneTags=false', '-c', `branch.feat.remote=hh-${operationId}`, 'fetch', `hh-${operationId}`,
    ]);
  });

  it('names no branch and no merge refs when there is no branch', async () => {
    const s = stand();
    const { agent } = clones(s, detached);
    const port = new FakePort();
    const { env } = await serve(s, port);
    expect((await runShim(['fetch', 'origin'], agent, env)).code).toBe(0);
    expect(port.registered[0]!.intent).toMatchObject({ target: { kind: 'configured', refspecs: [GLOB], merge: { branch: null, refs: [] } } });
    expect(calls(s, 'fetch')[0]!.argv.join(' ')).not.toContain('branch.');
  });

  it('carries no single commit of its own', async () => {
    const s = stand();
    const { agent, moveRemote } = clones(s, tracking);
    moveRemote();
    const port = new FakePort();
    const { env } = await serve(s, port);
    expect((await runShim(['fetch', 'origin'], agent, env)).code).toBe(0);
    expect(port.recorded[0]).toMatchObject({ settled: true });
    expect(port.recorded[0]).not.toHaveProperty('observedHead');
  });
});
