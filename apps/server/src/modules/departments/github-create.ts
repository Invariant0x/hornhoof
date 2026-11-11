import { z } from 'zod';
import type { HostKey, NewRepository, RepositoryCreator } from './repo-hosts.js';

const API = 'https://api.github.com';
/* How long one request waits for GitHub. */
const REQUEST_MS = 30_000;

const User = z.object({ login: z.string().min(1) });
const Created = z.object({ clone_url: z.url(), html_url: z.url(), default_branch: z.string().min(1) });

/* What to do when GitHub refuses to create it, in words for the person who saved the key. */
function refusal(status: number, key: HostKey, repo: NewRepository): string {
  const answered = `GitHub answered ${status}.`;
  if (status === 401) return `${answered} GitHub does not take this key any more: save a new key.`;
  if (status === 422) return `${answered} GitHub has a repository named ${repo.name} for ${key.owner} already, or does not take this name. Pick another name.`;
  if (status === 403)
    return `${answered} This key may not create repositories for ${key.owner}. Give it the right to: "Administration" and "Contents" set to "Read and write" for all repositories on a fine-grained key, or "repo" on a classic one.`;
  if (status === 404) return `${answered} GitHub shows this key no organization ${key.owner}. Check the owner's name, or give the key access to that organization.`;
  return answered;
}

/* Creates a private repository on GitHub with a first commit, a README holding its name and description, so that it can be
   cloned at once: in the key's own account when the owner is the key's user, else in the organization the owner names. It
   says what went wrong rather than throw, and never with the key. It follows no redirect, so the key stays with GitHub. */
export const createOnGitHub =
  (api = API, timeoutMs = REQUEST_MS): RepositoryCreator =>
  async (key, repo) => {
    const signal = AbortSignal.timeout(timeoutMs);
    const call = (path: string, body?: object) =>
      fetch(`${api}${path}`, {
        method: body ? 'POST' : 'GET',
        redirect: 'manual',
        signal,
        headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${key.token}`, 'user-agent': 'hornhoof', 'x-github-api-version': '2022-11-28', ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    try {
      const me = await call('/user');
      if (!me.ok) {
        await me.body?.cancel();
        return { problem: refusal(me.status, key, repo) };
      }
      const user = User.safeParse(await me.json());
      if (!user.success) return { problem: 'GitHub did not say whose key this is.' };
      const path = user.data.login.toLowerCase() === key.owner.toLowerCase() ? '/user/repos' : `/orgs/${encodeURIComponent(key.owner)}/repos`;
      const res = await call(path, { name: repo.name, description: repo.description, private: true, auto_init: true });
      if (res.status !== 201) {
        await res.body?.cancel();
        return { problem: refusal(res.status, key, repo) };
      }
      const made = Created.safeParse(await res.json());
      if (!made.success) return { problem: `GitHub created ${key.owner}/${repo.name} but did not say where it is. Connect it by its address.` };
      return { url: made.data.clone_url, branch: made.data.default_branch, page: made.data.html_url };
    } catch {
      return { problem: signal.aborted ? `GitHub did not answer within ${timeoutMs} ms.` : 'GitHub could not be reached.' };
    }
  };
