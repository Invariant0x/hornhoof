/* What a report keeps of what a person or an agent wrote, before it leaves the installation and again when the inbox takes
   it: secrets, keys, tokens and passwords, addresses of repositories and other places, email and paths in a home folder
   are hidden, each by a mark that says what stood there. Hornhoof's own pages stay, as they tell nothing of the company.
   A text cleaned once has nothing more to hide. */

export type Hidden = { secret: number; email: number; address: number; path: number };
type Kind = keyof Hidden;

const MARK: Record<Kind, string> = { secret: '[secret]', email: '[email]', address: '[address]', path: '[path]' };

/* A private key block, whole. */
const PEM = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;
/* An address with a scheme, up to a space, a quote or a bracket; the stop at its end stays outside. */
const URL_LIKE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"'()[\]{}]+/gi;
/* A git address written as user@host:path. */
const SCP = /\b[\w.-]+@[\w-]+(?:\.[\w-]+)+:[\w./~-]+/g;
const EMAIL = /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g;
/* Keys and tokens as their makers write them: Anthropic and OpenAI, GitHub, Slack, AWS, Google, GitLab, and a JWT. */
const TOKENS = [
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\bglpat-[A-Za-z0-9_-]{16,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g,
];
const BEARER = /\b(Bearer\s+)(?!\[secret\])[\w.~+/=-]+/gi;
/* A setting whose name says it holds a secret, and its value: quoted whole, or up to a space, a comma or a semicolon. */
const SETTING =
  /\b([\w.-]*?(?:password|passwd|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|[_-]key|credentials?)["']?\s*[:=]\s*)(?!\[secret\])("[^"\n]*"|'[^'\n]*'|[^\s,;]+)/gi;
/* A path in a home folder: Linux, macOS and Windows home folders, the root one and ~. */
const HOME_PATH = /(?:(?<![\w~])~[/\\]|(?<![\w\\])[A-Za-z]:\\Users\\|(?<![\w/])(?:\/[\w.-]+)*\/(?:home|Users)\/|(?<![\w/])\/root(?=[/\s]|$))[^\s"'<>]*/g;
/* A long run of letters and digits with both in it, which a key, a hash or a code looks like. */
const LONG = /(?<![\w+/=-])(?=[A-Za-z0-9+/=_-]*\d)(?=[A-Za-z0-9+/=_-]*[A-Za-z])[A-Za-z0-9+/=_-]{32,}(?![\w+/=-])/g;

/* Hornhoof's own pages: its repository on GitHub and hornhoof.org itself, with no sign-in in them. */
function ownPage(address: string): boolean {
  try {
    const url = new URL(address);
    if (url.username || url.password || url.protocol !== 'https:') return false;
    const host = url.hostname.toLowerCase();
    if (host === 'hornhoof.org' || host === 'www.hornhoof.org') return true;
    return host === 'github.com' && /^\/invariant0x\/hornhoof(?:[/?#]|$)/i.test(url.pathname);
  } catch {
    return false;
  }
}

/* An address without the stop that ends the sentence around it. */
const STOP = /[.,;:!?]+$/;

/* The text around Hornhoof's own pages, which the rest of the cleaning never reads into, and each page kept whole. */
function aroundOwnPages(text: string, hide: (kind: Kind) => string): { plain: string[]; kept: string[] } {
  const plain: string[] = [];
  const kept: string[] = [];
  let from = 0;
  for (const found of text.matchAll(URL_LIKE)) {
    const stop = STOP.exec(found[0])?.[0] ?? '';
    const address = found[0].slice(0, found[0].length - stop.length);
    const own = ownPage(address);
    plain.push(text.slice(from, found.index) + (own ? '' : hide('address')));
    kept.push(own ? address : '');
    from = found.index + address.length;
  }
  plain.push(text.slice(from));
  return { plain, kept };
}

/* What stays of a stretch of text with no address of Hornhoof's own in it. */
function cleanPlain(text: string, hide: (kind: Kind) => string): string {
  let clean = text.replace(SCP, () => hide('address'));
  clean = clean.replace(EMAIL, () => hide('email'));
  for (const token of TOKENS) clean = clean.replace(token, () => hide('secret'));
  clean = clean.replace(BEARER, (_found, bearer: string) => bearer + hide('secret'));
  clean = clean.replace(SETTING, (_found, name: string) => name + hide('secret'));
  clean = clean.replace(HOME_PATH, found => hide('path') + (STOP.exec(found)?.[0] ?? ''));
  return clean.replace(LONG, () => hide('secret'));
}

export function cleanText(input: string): { text: string; hidden: Hidden } {
  const hidden: Hidden = { secret: 0, email: 0, address: 0, path: 0 };
  const hide = (kind: Kind) => {
    hidden[kind] += 1;
    return MARK[kind];
  };
  const { plain, kept } = aroundOwnPages(input.replace(PEM, () => hide('secret')), hide);
  const text = plain.map((part, i) => cleanPlain(part, hide) + (kept[i] ?? '')).join('');
  return { text, hidden };
}
