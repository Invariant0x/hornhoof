import * as acme from 'acme-client';
import { z } from 'zod';

export const LETS_ENCRYPT: string = acme.directory.letsencrypt.production;

const KEY_CURVE = 'P-256';
const REQUEST_TIMEOUT_MS = 15000;
const DETAIL_LIMIT = 200;
const NO_ANSWER = 'no answer';
const PROBLEM_TYPE = 'application/problem+json';
// The form an HTTP date is sent in. Date.parse alone also takes words like "retry 10" for some date.
const HTTP_DATE = /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/;
const DEFAULT_BACKOFF: Backoff = { attempts: 10, min: 2000, max: 10000 };

export type ChallengeHooks = { answer(token: string, keyAuthorization: string): void; forget(token: string): void };
type AcmeErrorKind = 'not_ready' | 'refused' | 'invalid' | 'unreachable';
type Backoff = { attempts: number; min: number; max: number };
export type Problem = { status: number; type: string; detail: string | null; retryAfterS: number | null };

type Issued = { certPem: string; keyPem: string };
type Challenge = acme.Authorization['challenges'][number];
// acme-client's type has no such field, and it sends what it is given as it is.
type OrderRequest = Parameters<acme.Client['createOrder']>[0] & { replaces?: string };

const ProblemBody = z.object({ type: z.string(), detail: z.string().nullish().catch(null) });
const ChallengeFailure = z.object({ type: z.string().optional(), detail: z.string().optional() });

export class AcmeError extends Error {
  readonly kind: AcmeErrorKind;
  readonly type: string | null;
  readonly retryAfterS: number | null;

  constructor(kind: AcmeErrorKind, opts: { type?: string | null; retryAfterS?: number | null; detail?: string } = {}) {
    const detail = opts.detail?.slice(0, DETAIL_LIMIT);
    super(detail ? `acme ${kind}: ${detail}` : `acme ${kind}`);
    this.name = 'AcmeError';
    this.kind = kind;
    this.type = opts.type ?? null;
    this.retryAfterS = opts.retryAfterS ?? null;
  }
}

// A Retry-After is either seconds or an HTTP date, and anything else says nothing.
export function retryAfterSeconds(header: unknown, nowMs: number = Date.now()): number | null {
  if (typeof header !== 'string') return null;
  const value = header.trim();
  if (/^\d+$/.test(value)) return Number(value);
  const at = HTTP_DATE.test(value) ? Date.parse(value) : Number.NaN;
  return Number.isNaN(at) ? null : Math.max(0, Math.ceil((at - nowMs) / 1000));
}

// The ACME problem document in an answer, or null when the answer is not one.
export function problemOf(status: number, contentType: unknown, body: unknown, retryAfter: unknown): Problem | null {
  if (typeof contentType !== 'string' || !contentType.toLowerCase().startsWith(PROBLEM_TYPE)) return null;
  const parsed = ProblemBody.safeParse(body);
  if (!parsed.success) return null;
  return { status, type: parsed.data.type, detail: parsed.data.detail ?? null, retryAfterS: retryAfterSeconds(retryAfter) };
}

// acme-client's errors carry only the problem's text, so the type and the Retry-After are read here. Only one ACME flow
// runs at a time in the app, so the last answer's problem is the failed step's.
let lastProblem: Problem | null = null;

// With its retry off, acme-client's handler trips over a request that got no answer and throws a TypeError about its own
// internals. A self-check's non-2xx is a real axios error and keeps its words.
function plainFailure(error: unknown): unknown {
  return (error as { isAxiosError?: boolean }).isAxiosError ? error : new Error(NO_ANSWER);
}

// Its own retry would sleep a rate limit's whole Retry-After inside the call; the manager's backoff does that waiting.
(acme.axios.defaults as unknown as { acmeSettings: { retryMaxAttempts: number } }).acmeSettings.retryMaxAttempts = 0;
acme.axios.defaults.timeout = REQUEST_TIMEOUT_MS;
acme.axios.interceptors.response.use(
  (response) => {
    const { headers } = response;
    lastProblem = problemOf(response.status, headers['content-type'], response.data, headers['retry-after']);
    return response;
  },
  (error: unknown) => {
    lastProblem = null;
    throw plainFailure(error);
  },
);

export const textOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

// What a failed step means, from the CA's last answer. A step that already said what it means keeps its word.
function meaningOf(err: unknown): AcmeError {
  if (err instanceof AcmeError) return err;
  const problem = lastProblem;
  const opts = { type: problem?.type, retryAfterS: problem?.retryAfterS, detail: problem?.detail ?? textOf(err) };
  return new AcmeError(problem && problem.status < 500 ? 'refused' : 'unreachable', opts);
}

async function saying<T>(step: () => Promise<T>): Promise<T> {
  try {
    return await step();
  } catch (err) {
    throw meaningOf(err);
  }
}

const http01Of = (authz: acme.Authorization): Challenge | undefined => authz.challenges.find((challenge) => challenge.type === 'http-01');

function invalidBecause(authz: acme.Authorization): AcmeError {
  const failure = ChallengeFailure.safeParse(http01Of(authz)?.error);
  return new AcmeError('invalid', failure.success ? failure.data : {});
}

function orderRequest(host: string, replaces?: string): OrderRequest {
  const request: OrderRequest = { identifiers: [{ type: 'dns', value: host }] };
  return replaces ? { ...request, replaces } : request;
}

const newKey = async (): Promise<string> => (await acme.crypto.createPrivateEcdsaKey(KEY_CURVE)).toString();

export const newAccountKey: () => Promise<string> = newKey;

// One company's account at one CA. It drives acme-client's own steps, as its auto() has no way to pass replaces.
export class AcmeAccount {
  private readonly client: acme.Client;

  constructor(directoryUrl: string, accountKeyPem: string, accountUrl?: string | null, opts: { backoff?: Backoff } = {}) {
    const backoff = opts.backoff ?? DEFAULT_BACKOFF;
    this.client = new acme.Client({
      directoryUrl,
      accountKey: accountKeyPem,
      accountUrl: accountUrl ?? undefined,
      backoffAttempts: backoff.attempts,
      backoffMin: backoff.min,
      backoffMax: backoff.max,
    });
  }

  // A URL already held is given back unasked: nothing is verified, so nothing false is said. The next order is what
  // meets the CA.
  account(): Promise<string> {
    return saying(async () => {
      if (!this.holdsAccountUrl()) await this.makeOrFind();
      return this.client.getAccountUrl();
    });
  }

  issue(host: string, hooks: ChallengeHooks, opts: { replaces?: string; selfCheck?: boolean } = {}): Promise<Issued> {
    return saying(async () => {
      await this.account();
      const order = await this.client.createOrder(orderRequest(host, opts.replaces));
      for (const authz of await this.client.getAuthorizations(order)) {
        if (authz.status !== 'valid') await this.prove(authz, order, hooks, opts.selfCheck ?? true);
      }
      return this.finish(order, host);
    });
  }

  // No contact is sent, by decision: the first order accepts the CA's terms and gives no one's address. For a key the CA
  // knows, acme-client follows the first answer with an update that says nothing new, and a CA may refuse that update, as
  // Pebble does. Called with no URL held, so a URL held after a throw came with this first answer, and such a refusal
  // changes nothing: no later failure may read it as its own.
  private async makeOrFind(): Promise<void> {
    try {
      await this.client.createAccount({ termsOfServiceAgreed: true });
    } catch (err) {
      if (!this.holdsAccountUrl()) throw err;
      lastProblem = null;
    }
  }

  private holdsAccountUrl(): boolean {
    try {
      this.client.getAccountUrl();
      return true;
    } catch {
      return false;
    }
  }

  private async prove(authz: acme.Authorization, order: acme.Order, hooks: ChallengeHooks, selfCheck: boolean): Promise<void> {
    const challenge = http01Of(authz);
    if (!challenge) throw new AcmeError('refused', { detail: 'the CA offers no http-01 challenge' });
    hooks.answer(challenge.token, await this.client.getChallengeKeyAuthorization(challenge));
    try {
      if (selfCheck) await this.checkOwnAnswer(authz, challenge);
      await this.client.completeChallenge(challenge);
      await this.awaitValid(authz, order);
    } finally {
      hooks.forget(challenge.token);
    }
  }

  // A failed self-check costs nothing at the CA, where a failed validation counts against the name's limit.
  private async checkOwnAnswer(authz: acme.Authorization, challenge: Challenge): Promise<void> {
    try {
      await this.client.verifyChallenge(authz, challenge);
    } catch (err) {
      throw new AcmeError('not_ready', { detail: textOf(err) });
    }
  }

  private async awaitValid(authz: acme.Authorization, order: acme.Order): Promise<void> {
    try {
      await this.client.waitForValidStatus(authz);
    } catch (err) {
      throw lastProblem ? err : await this.whyNotValid(order, err);
    }
  }

  // An authorization that went invalid answers 200, so its reason is in the authorization and not in a problem document.
  private async whyNotValid(order: acme.Order, err: unknown): Promise<unknown> {
    const invalid = (await this.client.getAuthorizations(order)).find((authz) => authz.status === 'invalid');
    return invalid ? invalidBecause(invalid) : err;
  }

  // finalizeOrder answers a new object, and an order ready from the start has its certificate URL only there.
  private async finish(order: acme.Order, host: string): Promise<Issued> {
    const keyPem = await newKey();
    const [, csr] = await acme.crypto.createCsr({ altNames: [host] }, keyPem);
    const finalized = await this.client.finalizeOrder(order, csr);
    return { certPem: await this.client.getCertificate(finalized), keyPem };
  }
}
