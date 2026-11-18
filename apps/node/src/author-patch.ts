import type { AuthorCheckPin } from '@hornhoof/protocol';

type ReadGit = (args: string[], input?: Buffer) => Promise<Buffer>;
const SHA = /^[a-f0-9]{40}$/;
const PATCH_FLAGS = ['--no-ext-diff', '--no-textconv', '--no-renames', '--binary', '--full-index'];

export async function matchingAuthorPatch(pin: AuthorCheckPin, mainCommit: string, read: ReadGit): Promise<string | null> {
  const { baseCommit, commit, paths } = pin;
  const path = paths[0];
  if (!path) return null;
  const ids = async (diff: Buffer) => (await read(['patch-id', '--stable'], diff)).toString('ascii');
  const diff = await read(['diff', ...PATCH_FLAGS, baseCommit, commit, '--']);
  const id = (await ids(diff)).split(' ')[0];
  if (!id || !SHA.test(id)) return null;
  /* This path narrows the history only. Hash the full patch for each possible source. */
  const log = await read(['rev-list', '--full-history', baseCommit, mainCommit, '--', path]);
  for (const source of log.toString('ascii').trim().split('\n').filter(Boolean)) {
    if (!SHA.test(source)) throw new Error('Invalid source commit from git rev-list.');
    const patch = await read(['diff-tree', '--root', '-m', '-p', ...PATCH_FLAGS, source]);
    if ((await ids(patch)).split('\n').some(line => line === id + ' ' + source)) return source;
  }
  return null;
}
