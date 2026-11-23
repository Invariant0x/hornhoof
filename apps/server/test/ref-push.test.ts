import { describe, expect, it } from 'vitest';
import { pushRefs } from '../src/modules/repos/ref-push.js';
import { git, headOf, host, origin } from './git-origin.js';

const refOf = (dir: string, ref: string): string | null => {
  try { return git(dir, 'rev-parse', '--verify', '--quiet', ref); } catch { return null; }
};

describe('changing refs of a repository by a push git itself takes', () => {
  it('deletes a branch only where it is still at the commit the caller saw, and touches no other', async () => {
    const { dir, main, other } = origin();
    git(dir, 'branch', 'task-7', other);
    const { url } = await host(dir);
    expect(await pushRefs({ url, token: '' }, [{ ref: 'refs/heads/task-7', old: other, next: null }])).toEqual({ refs: { 'refs/heads/task-7': null } });
    expect(headOf(dir, 'task-7')).toBeNull();
    expect(headOf(dir, 'other')).toBe(other);
    expect(headOf(dir, 'main')).toBe(main);
  });

  it('keeps a branch that moved after the caller saw it, and says which ref was refused', async () => {
    const { dir, main, other } = origin();
    git(dir, 'branch', 'task-7', other);
    const { url } = await host(dir);
    const answer = await pushRefs({ url, token: '' }, [{ ref: 'refs/heads/task-7', old: main, next: null }]);
    expect(answer).toEqual({ refs: { 'refs/heads/task-7': expect.any(String) as unknown } });
    expect(headOf(dir, 'task-7')).toBe(other);
  });

  it('makes a hidden ref at a commit that is there, only where there is none, and never moves one that is', async () => {
    const { dir, main, other } = origin();
    const { url } = await host(dir);
    const archive = 'refs/hornhoof/archive/task-7';
    expect(await pushRefs({ url, token: '' }, [{ ref: archive, old: null, next: other }])).toEqual({ refs: { [archive]: null } });
    expect(refOf(dir, archive)).toBe(other);
    expect(headOf(dir, 'other')).toBe(other);
    const again = await pushRefs({ url, token: '' }, [{ ref: archive, old: null, next: main }]);
    expect(again).toEqual({ refs: { [archive]: expect.any(String) as unknown } });
    expect(refOf(dir, archive)).toBe(other);
  });

  it('does not delete the main line the caller names, whatever it is called, and asks the repository nothing', async () => {
    const { dir, main } = origin();
    git(dir, 'branch', 'develop', main);
    const { url, pushes } = await host(dir);
    const answer = await pushRefs({ url, token: '' }, [{ ref: 'refs/heads/develop', old: main, next: null }], { main: 'develop' });
    expect(answer).toEqual({ problem: expect.stringContaining('develop') as unknown });
    expect(pushes).toHaveLength(0);
    expect(headOf(dir, 'develop')).toBe(main);
    /* A branch of another name goes, with the same option. */
    git(dir, 'branch', 'task-9', main);
    expect(await pushRefs({ url, token: '' }, [{ ref: 'refs/heads/task-9', old: main, next: null }], { main: 'develop' })).toEqual({ refs: { 'refs/heads/task-9': null } });
  });

  it('takes several refs in one push and says for each whether it was done', async () => {
    const { dir, main, other } = origin();
    git(dir, 'branch', 'task-1', other);
    git(dir, 'branch', 'task-2', other);
    const { url, pushes } = await host(dir);
    const answer = await pushRefs({ url, token: '' }, [
      { ref: 'refs/heads/task-1', old: other, next: null },
      { ref: 'refs/heads/task-2', old: main, next: null },
    ]);
    expect(pushes).toHaveLength(1);
    expect(answer).toEqual({ refs: { 'refs/heads/task-1': null, 'refs/heads/task-2': expect.any(String) as unknown } });
    expect(headOf(dir, 'task-1')).toBeNull();
    expect(headOf(dir, 'task-2')).toBe(other);
  });

  it('never touches a tag, and takes no ref git would not take, before it asks the repository anything', async () => {
    const { dir, main } = origin();
    git(dir, 'tag', 'v1.0.0', main);
    const { url, pushes } = await host(dir);
    for (const ref of ['refs/tags/v1.0.0', 'refs/tags/v2.0.0', 'v1.0.0', 'refs/heads/a b', 'refs/heads/../main', 'refs/heads/x\nrefs/tags/v1.0.0', 'refs/remotes/origin/main']) {
      expect(await pushRefs({ url, token: '' }, [{ ref, old: main, next: null }])).toEqual({ problem: expect.stringContaining('not a ref') as unknown });
    }
    expect(await pushRefs({ url, token: '' }, [{ ref: 'refs/heads/x', old: null, next: null }])).toEqual({ problem: expect.stringContaining('nothing to change') as unknown });
    expect(await pushRefs({ url, token: '' }, [])).toEqual({ problem: expect.stringContaining('nothing to change') as unknown });
    expect(pushes).toHaveLength(0);
    expect(refOf(dir, 'refs/tags/v1.0.0')).toBe(main);
  });

  it('never deletes main, whatever the caller asks', async () => {
    const { dir, main } = origin();
    const { url, pushes } = await host(dir);
    expect(await pushRefs({ url, token: '' }, [{ ref: 'refs/heads/main', old: main, next: null }])).toEqual({ problem: expect.stringContaining('main is never deleted') as unknown });
    expect(pushes).toHaveLength(0);
    expect(headOf(dir, 'main')).toBe(main);
  });

  it('says why when the repository will not take the push, and never with the token', async () => {
    const { dir, other } = origin();
    git(dir, 'branch', 'task-7', other);
    const { url } = await host(dir, { status: 403 });
    const answer = await pushRefs({ url, token: 'secret-token-0123456789' }, [{ ref: 'refs/heads/task-7', old: other, next: null }]);
    expect(answer).toEqual({ problem: expect.stringMatching(/403/) as unknown });
    expect(JSON.stringify(answer)).not.toContain('secret-token');
    expect(headOf(dir, 'task-7')).toBe(other);
  });
});
