import { FillPlain, type FillField, type FillKind, type FillStatus, type FillTarget, type SecretFill, type SecretFilled, type SiteSession } from '@hornhoof/protocol';
import { totpCode, totpCodesAround } from './totp.js';
import { SecretValue } from './values.js';

/* The node's one way to type a vault sign-in into a target, for its browser and for a company phone alike: Hornhoof
   sealed the values to this node's key, the node opens them, hides them from everything it says before any of it is
   typed, lets the target's adapter type them and answers with a status only. No adapter sees the sealed part or the
   entry, so none can resolve a sign-in of its own. */

export { SecretValue } from './values.js';

export type FillValues = { login: SecretValue; password: SecretValue; code(): SecretValue | null };
export type FillReceipt = { status: FillStatus; filled: FillField[]; session?: SiteSession; shot?: string };
export type TargetOf<K extends FillKind> = Extract<FillTarget, { kind: K }>;

/* shield: before the first byte of a value, every picture of the target (screenshot, element tree, live view, recording)
   is masked whole until the release it returns has run. fill: types the fields asked for and tells how it went, never
   with a value, never with one in a log line or in the arguments of a process it starts, which other users can read. */
export type FillAdapter<K extends FillKind = FillKind> = {
  kind: K;
  shield(target: TargetOf<K>): Promise<() => Promise<void>>;
  fill(target: TargetOf<K>, values: FillValues, fields: FillField[], signal: AbortSignal): Promise<FillReceipt>;
};

type SecretFillDeps = {
  /* Opens the sealed part with the node's own key; throws when it is not for this node. */
  open(sealed: string): Promise<Uint8Array>;
  /* Hides values from all the node's output until the moment given. */
  hide(values: string[], untilMs: number): void;
  send(message: SecretFilled): void;
  log(line: string): void;
};

/* How long one fill may take, within the time Hornhoof's tool waits for its answer. */
export const FILL_MAX_MS = 40_000;
/* How long a one-time code stays hidden after it was made: far past the period a site takes it in. */
const CODE_HIDE_MS = 10 * 60_000;
/* How long a request is remembered, so the same one never runs twice. */
const SEEN_MS = 10 * 60_000;

export class SecretFills {
  readonly #deps: SecretFillDeps;
  readonly #adapters = new Map<FillKind, FillAdapter>();
  readonly #seen = new Map<string, number>();

  constructor(deps: SecretFillDeps) {
    this.#deps = deps;
  }

  register<K extends FillKind>(adapter: FillAdapter<K>): void {
    this.#adapters.set(adapter.kind, adapter as unknown as FillAdapter);
  }

  kinds(): FillKind[] {
    return [...this.#adapters.keys()];
  }

  async handle(m: SecretFill): Promise<void> {
    if (!this.#first(m.requestId)) return;
    const answer = (receipt: FillReceipt) => this.#deps.send({ type: 'secret.filled', requestId: m.requestId, ...receipt });
    if (!(Date.parse(m.expiresAt) > Date.now())) return answer({ status: 'expired', filled: [] });
    const adapter = this.#adapters.get(m.target.kind);
    if (!adapter) return answer({ status: 'unsupported', filled: [] });
    const plain = await this.#open(m.sealed);
    if (!plain) {
      this.#deps.log('A vault sign-in from Hornhoof could not be opened on this node, so nothing was typed.');
      return answer({ status: 'failed', filled: [] });
    }
    answer(await this.#fill(adapter, m, plain));
  }

  #first(requestId: string): boolean {
    const now = Date.now();
    for (const [id, at] of this.#seen) if (at + SEEN_MS <= now) this.#seen.delete(id);
    if (this.#seen.has(requestId)) return false;
    this.#seen.set(requestId, now);
    return true;
  }

  async #open(sealed: string): Promise<FillPlain | null> {
    try {
      const parsed = FillPlain.safeParse(JSON.parse(new TextDecoder().decode(await this.#deps.open(sealed))));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  async #fill(adapter: FillAdapter, m: SecretFill, plain: FillPlain): Promise<FillReceipt> {
    const { hide } = this.#deps;
    hide([plain.password, ...(plain.totp ? [plain.totp.secret] : [])], Number.POSITIVE_INFINITY);
    const totp = plain.totp;
    const hideCodes = (at: number) => totp && hide(totpCodesAround(totp, at), at + CODE_HIDE_MS);
    hideCodes(Date.now());
    const values: FillValues = {
      login: new SecretValue(plain.login),
      password: new SecretValue(plain.password),
      code: () => {
        if (!totp) return null;
        const at = Date.now();
        hideCodes(at);
        return new SecretValue(totpCode(totp, at));
      },
    };
    const stop = new AbortController();
    const timer = setTimeout(() => stop.abort(), FILL_MAX_MS);
    let release: (() => Promise<void>) | null = null;
    try {
      release = await adapter.shield(m.target);
      const receipt = await adapter.fill(m.target, values, m.fields, stop.signal);
      if (receipt.session) hide(sessionValues(receipt.session), Number.POSITIVE_INFINITY);
      return receipt;
    } catch {
      return { status: stop.signal.aborted ? 'expired' : 'failed', filled: [] };
    } finally {
      clearTimeout(timer);
      await release?.().catch(() => this.#deps.log('A target could not be released after a vault sign-in.'));
    }
  }
}

/* The cookies and stored values a sign-in brought, which no line of the node shows either. */
function sessionValues(session: SiteSession): string[] {
  return [...session.cookies.map(c => c.value), ...session.origins.flatMap(o => o.localStorage.map(s => s.value))].filter(v => v.length >= 8);
}
