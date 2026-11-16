import type { BrowsedPage } from '@hornhoof/protocol';
import type { BrowseRequest } from './browse.js';
import type { BrowseResult } from './read.js';

/* hh-browse in an agent's turn: it asks Hornhoof first whether a sign-in is saved for the agent on the page's site. With
   one, the node of the turn reads the page in a browser of its own process and hh-browse prints what it got, so no cookie
   passes the agent's process. With none, hh-browse reads the page itself, as outside a turn. */

export type AgentBrowseDeps = {
  /* HH_ATTACH_URL and HH_ATTACH_PASS, which the node sets for each turn. */
  url: string | undefined;
  pass: string | undefined;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  local(request: BrowseRequest): Promise<BrowseResult>;
  writeFile(path: string, bytes: Buffer): void;
};

type Unavailable = 'node_offline' | 'unsupported' | 'no_answer' | 'expired' | 'unopened' | 'failed';
type Answer =
  | { kind: 'none' }
  | { kind: 'expired'; site: string }
  | { kind: 'unavailable'; site: string; reason: Unavailable }
  | { kind: 'browsed'; site: string; page: BrowsedPage; shot?: string };

const WHY: Record<Unavailable, string> = {
  node_offline: 'the machine of your turn is not connected',
  unsupported: 'the machine of your turn cannot open pages with a sign-in yet',
  no_answer: 'the machine of your turn did not answer in time',
  expired: 'the machine of your turn could not open it in time',
  unopened: 'the machine of your turn could not open it',
  failed: 'the machine of your turn could not read the page with it',
};
const NOT_ASKED = 'Hornhoof could not be asked for a sign-in saved for you, so the page was read without one.';

const noted = (result: BrowseResult, note: string): BrowseResult => ({ ...result, notes: [note, ...result.notes] });

async function askHornhoof(request: BrowseRequest, deps: AgentBrowseDeps & { url: string; pass: string }): Promise<Answer | null> {
  try {
    const res = await deps.fetch(`${deps.url}/browse`, {
      method: 'POST',
      headers: { authorization: `Bearer ${deps.pass}`, 'content-type': 'application/json' },
      body: JSON.stringify({ address: request.address, screenshot: request.screenshot !== null, fullPage: request.fullPage, waitFor: request.waitFor, limits: request.limits }),
      ...(request.signal ? { signal: request.signal } : {}),
    });
    return res.ok ? ((await res.json()) as Answer) : null;
  } catch {
    return null;
  }
}

/* The page the node read: its picture lands where the agent asked for it. */
function printed(request: BrowseRequest, answer: Extract<Answer, { kind: 'browsed' }>, deps: AgentBrowseDeps): BrowseResult {
  const file = request.screenshot && answer.shot ? request.screenshot : null;
  if (file) deps.writeFile(file, Buffer.from(answer.shot!, 'base64'));
  return { ...answer.page, screenshot: file, notes: [`The page was opened with the sign-in saved for you for ${answer.site}.`, ...answer.page.notes] };
}

function expired(request: BrowseRequest, site: string): BrowseResult {
  return {
    status: 'login_required', reason: `The sign-in saved for you for ${site} has expired. A person needs to sign you in again.`, address: request.address,
    finalAddress: null, httpStatus: null, title: null, text: null, textLength: 0, links: [], linkCount: 0, screenshot: null, notes: [],
  };
}

export async function browseAsAgent(request: BrowseRequest, deps: AgentBrowseDeps): Promise<BrowseResult> {
  const { url, pass } = deps;
  if (!url || !pass) return deps.local(request);
  const answer = await askHornhoof(request, { ...deps, url, pass });
  if (!answer) return noted(await deps.local(request), NOT_ASKED);
  if (answer.kind === 'browsed') return printed(request, answer, deps);
  if (answer.kind === 'expired') return expired(request, answer.site);
  if (answer.kind === 'unavailable') return noted(await deps.local(request), `The sign-in saved for you for ${answer.site} could not be used, as ${WHY[answer.reason] ?? WHY.failed}; the page was read without it.`);
  return deps.local(request);
}
