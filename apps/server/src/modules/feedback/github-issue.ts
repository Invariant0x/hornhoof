import { z } from 'zod';
import type { HostKey } from '../departments/repo-hosts.js';
import type { Priority } from './inbox.js';

const API = 'https://api.github.com';
/* How long one request waits for GitHub. */
const REQUEST_MS = 30_000;
/* Where the inbox's issues go. */
export const ISSUE_REPOSITORY = 'invariant0x/hornhoof';
const TITLE_MAX = 256;

export type NewIssue = { repo: string; title: string; body: string };
/* The issue's number and its page; or why it was not created. */
type OpenedIssue = { number: number; url: string } | { problem: string };
export type IssueCreator = (key: HostKey, issue: NewIssue) => Promise<OpenedIssue>;

const Created = z.object({ number: z.number().int().positive(), html_url: z.string() });

/* What to do when GitHub refuses, in words for the person who saved the key. */
function refusal(status: number, repo: string): string {
  const answered = `GitHub answered ${status}.`;
  if (status === 401) return `${answered} GitHub does not take this key any more: save a new key.`;
  if (status === 403) return `${answered} This key may not create issues in ${repo}. Give it "Issues" set to "Read and write" on a fine-grained key, or "repo" on a classic one.`;
  if (status === 404) return `${answered} GitHub shows this key no repository ${repo}. Give the key access to it.`;
  if (status === 410) return `${answered} The repository ${repo} turned issues off.`;
  if (status === 422) return `${answered} GitHub did not take this issue.`;
  return answered;
}

/* The number and page of the issue GitHub created, kept only when the page is on github.com and ends in that number. */
function createdOf(answer: unknown, repo: string): OpenedIssue {
  const made = Created.safeParse(answer);
  const page = made.success ? made.data.html_url : '';
  if (!made.success || !page.startsWith('https://github.com/') || !page.endsWith(`/issues/${made.data.number}`)) return { problem: `GitHub created the issue but did not say where it is. Look for it in ${repo}.` };
  return { number: made.data.number, url: page };
}

/* Creates an issue in the repository with a key the company saved, as a repository is created in github-create.ts. It says
   what went wrong rather than throw, and never with the key. It follows no redirect, so the key stays with GitHub, and keeps
   only a page on github.com that ends in the number GitHub gave. */
export const openIssueOnGitHub =
  (api = API, timeoutMs = REQUEST_MS): IssueCreator =>
  async (key, issue) => {
    const signal = AbortSignal.timeout(timeoutMs);
    try {
      const res = await fetch(`${api}/repos/${issue.repo}/issues`, {
        method: 'POST',
        redirect: 'manual',
        signal,
        headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${key.token}`, 'user-agent': 'hornhoof', 'x-github-api-version': '2022-11-28', 'content-type': 'application/json' },
        body: JSON.stringify({ title: issue.title, body: issue.body }),
      });
      if (res.status !== 201) {
        await res.body?.cancel();
        return { problem: refusal(res.status, issue.repo) };
      }
      return createdOf(await res.json(), issue.repo);
    } catch {
      return { problem: signal.aborted ? `GitHub did not answer within ${timeoutMs} ms.` : 'GitHub could not be reached.' };
    }
  };

/* The card an issue is made of. */
type IssueCard = {
  kind: 'bug' | 'improvement' | 'idea';
  title: string;
  text: string;
  errorCode: string | null;
  versions: string[];
  platforms: string[];
  signals: number;
  installations: number;
  priority: Priority;
};

const KIND: Record<IssueCard['kind'], string> = { bug: 'Bug', improvement: 'Improvement', idea: 'Idea' };

/* A fence longer than any run of backticks in what it holds, so nothing inside can close it. */
function fenceFor(...texts: string[]): string {
  const longest = Math.max(0, ...texts.flatMap(t => (t.match(/`+/g) ?? []).map(run => run.length)));
  return '`'.repeat(Math.max(3, longest + 1));
}

/* The issue a card becomes. What installations sent goes inside code blocks, where GitHub links, mentions and runs
   nothing; outside them are only the program's own words. The title is plain text on one line. */
export function issueOf(card: IssueCard): NewIssue {
  const title = `${KIND[card.kind]}: ${card.title.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').replace(/[\r\n\t]+/g, ' ').trim()}`.slice(0, TITLE_MAX);
  const facts = [
    `Kind: ${card.kind}`,
    `Priority: ${card.priority}`,
    `Signals: ${card.signals} from ${card.installations} installations`,
    `Versions: ${card.versions.join(', ') || 'none'}`,
    `Platforms: ${card.platforms.join(', ') || 'none'}`,
    `Error code: ${card.errorCode ?? 'none'}`,
  ].join('\n');
  const fence = fenceFor(facts, card.text);
  const block = (text: string) => `${fence}text\n${text}\n${fence}\n`;
  return { repo: ISSUE_REPOSITORY, title, body: `Sent from Hornhoof installations through the feedback inbox.\n\n${block(facts)}\n${block(card.text)}` };
}
