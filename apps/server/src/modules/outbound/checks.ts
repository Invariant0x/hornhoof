import { createHash } from 'node:crypto';
import { canonicalJson, CatalogValue, type ApprovalRule, type GateCode } from '@hornhoof/protocol';
import { outboundCatalogRevisions } from '../../db/schema.js';

/* What decides whether a part of a message may be said: exact money, the revision of a catalog entry that counts now, and
   what no catalog words may carry. Pure: the kernel reads the rows and these decide. No model, no keyword of any language. */

type Row = typeof outboundCatalogRevisions.$inferSelect;
export type Source = Pick<Row, 'entryId' | 'revision' | 'kind' | 'locale' | 'value' | 'digest' | 'status' | 'validFrom' | 'validUntil' | 'departmentId' | 'productId' | 'channelId'>;
/* The entry's revision that counts now, by id. */
export type Catalog = (entryId: string) => Source | null;
export type Place = { channelId: string; departmentId: string; productId: string | null };
export type Money = { minor: bigint; currency: string; scale: number };

type PriceValue = Extract<CatalogValue, { kind: 'price' }>;
type DiscountValue = Extract<CatalogValue, { kind: 'discount' }>;
type LimitRule = Extract<ApprovalRule, { mode: 'within_limits' }>;

/* A digest of any JSON value, the same however its keys were ordered. */
export const digestOf = (value: unknown): string => createHash('sha256').update(canonicalJson(value)).digest('hex');

const DECIMAL = /^[0-9]+(?:\.([0-9]+))?$/;
const digitsAfterPoint = (amount: string): number => amount.split('.')[1]?.length ?? 0;
const withoutPoint = (amount: string): bigint => BigInt(amount.replace('.', ''));

/* An amount as whole minor units, only when it is written at exactly its scale. */
export function minorUnits(amount: string, scale: number): bigint | null {
  if (!DECIMAL.test(amount) || digitsAfterPoint(amount) !== scale) return null;
  return withoutPoint(amount);
}

const ROUNDERS: Record<PriceValue['rounding'], (quotient: bigint, twiceLeft: bigint, whole: bigint) => bigint> = {
  down: quotient => quotient,
  half_up: (quotient, twiceLeft, whole) => (twiceLeft >= whole ? quotient + 1n : quotient),
  half_even: (quotient, twiceLeft, whole) => (twiceLeft > whole || (twiceLeft === whole && quotient % 2n === 1n) ? quotient + 1n : quotient),
};

function percentOff(minor: bigint, value: string, rounding: PriceValue['rounding']): bigint | null {
  const places = digitsAfterPoint(value);
  const whole = 100n * 10n ** BigInt(places);
  const taken = withoutPoint(value);
  if (taken > whole) return null;
  const left = minor * (whole - taken);
  return ROUNDERS[rounding](left / whole, (left % whole) * 2n, whole);
}

function amountOff(minor: bigint, value: string, scale: number): bigint | null {
  const places = digitsAfterPoint(value);
  if (places > scale) return null;
  const taken = withoutPoint(value) * 10n ** BigInt(scale - places);
  return taken > minor ? null : minor - taken;
}

function afterDiscount(minor: bigint, price: PriceValue, off: DiscountValue['off']): bigint | null {
  if (off.kind === 'percent') return percentOff(minor, off.value, price.rounding);
  return off.currency === price.currency ? amountOff(minor, off.value, price.scale) : null;
}

/* What a price comes to: never through a float, and refused when the discount does not fit it. */
export function priceAfterDiscount(price: PriceValue, discount: DiscountValue | null): Money | null {
  const minor = minorUnits(price.amount, price.scale);
  if (minor === null) return null;
  const left = discount ? afterDiscount(minor, price, discount.off) : minor;
  return left === null ? null : { minor: left, currency: price.currency, scale: price.scale };
}

const decimalOf = ({ minor, scale }: Money): string => {
  const digits = minor.toString().padStart(scale + 1, '0');
  return scale === 0 ? digits : `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
};

/* Money in a language's own way of writing it, from its exact digits. */
export function formatMoney(money: Money, locale: string): string {
  const format = new Intl.NumberFormat(locale, { style: 'currency', currency: money.currency, minimumFractionDigits: money.scale, maximumFractionDigits: money.scale });
  return format.format(decimalOf(money) as Intl.StringNumericLiteral);
}

const atScale = (money: Money, scale: number): bigint => money.minor * 10n ** BigInt(scale - money.scale);

/* A limit in minor units of a scale that holds both it and the money. A number too small to write plainly is not measured. */
function limitAt(limit: number, scale: number): bigint | null {
  const written = String(limit);
  return DECIMAL.test(written) && digitsAfterPoint(written) <= scale ? withoutPoint(written) * 10n ** BigInt(scale - digitsAfterPoint(written)) : null;
}

const measurable = (money: readonly Money[], unit: string | undefined): boolean => money.length > 0 && unit !== undefined && money.every(m => m.currency === unit);

/* Whether a message's money stays within a limit. What cannot be measured in the limit's own unit is not within it. */
export function moneyWithinLimit(money: readonly Money[], rule: Pick<LimitRule, 'limit' | 'unit'>): boolean {
  if (!measurable(money, rule.unit)) return false;
  const scale = Math.max(digitsAfterPoint(String(rule.limit)), ...money.map(m => m.scale));
  const limit = limitAt(rule.limit, scale);
  if (limit === null) return false;
  return money.reduce((sum, m) => sum + atScale(m, scale), 0n) <= limit;
}

/* The revision that counts: the newest that left the proposals, unless it was taken back. An older one does not come back
   by itself, as it may be the very mistake the newest corrected. */
export function currentRevision(rows: readonly Source[]): Source | null {
  const newest = rows.filter(r => r.status !== 'proposed').reduce<Source | null>((best, r) => (best === null || r.revision > best.revision ? r : best), null);
  return newest?.status === 'published' ? newest : null;
}

const inScope = (source: Source, place: Place): boolean =>
  source.departmentId === place.departmentId && (source.productId === null || source.productId === place.productId) && (source.channelId === null || source.channelId === place.channelId);
const inTime = (source: Source, now: Date): boolean => source.validFrom <= now && (source.validUntil === null || now < source.validUntil);

/* Whether a revision may be used here and now: published, in time, and of this department, product and channel. */
export const usable = (source: Source, place: Place, now: Date): boolean => source.status === 'published' && inScope(source, place) && inTime(source, now);

const valueOf = <K extends CatalogValue['kind']>(source: Source, kind: K): Extract<CatalogValue, { kind: K }> | null => {
  const parsed = CatalogValue.safeParse(source.value);
  return parsed.success && parsed.data.kind === kind ? (parsed.data as Extract<CatalogValue, { kind: K }>) : null;
};
export { valueOf as catalogValue };

type PriceAt = { place: Place; now: Date; locale: string };
type PriceChecked = { ok: true; money: Money; terms: Source | null; sources: Source[] } | { ok: false; reasonCodes: GateCode[] };
const refused = (code: GateCode): PriceChecked => ({ ok: false, reasonCodes: [code] });

const priceInTime = (price: PriceValue, now: Date): boolean => Date.parse(price.validFrom) <= now.getTime() && (price.validUntil === null || now.getTime() < Date.parse(price.validUntil));

/* The discount a price names, when it has none or one that holds now. */
function discountOf(price: PriceValue, catalog: Catalog, at: PriceAt): { source: Source | null; value: DiscountValue | null } | null {
  if (price.discountId === null) return { source: null, value: null };
  const source = catalog(price.discountId);
  const value = source && usable(source, at.place, at.now) ? valueOf(source, 'discount') : null;
  return value && { source, value };
}

/* The terms a price names, or the code of why they cannot be shown. */
function termsOf(price: PriceValue, catalog: Catalog, at: PriceAt): { terms: Source | null } | GateCode {
  if (price.termsId === null) return { terms: null };
  const terms = catalog(price.termsId);
  if (!terms || !usable(terms, at.place, at.now) || !valueOf(terms, 'terms')) return 'terms_unapproved';
  return terms.locale === at.locale ? { terms } : 'unsupported_locale';
}

/* The usable price a block names at the revision it names. */
function priceOf(block: { id: string; revision: number }, catalog: Catalog, at: PriceAt): { source: Source; value: PriceValue } | null {
  const source = catalog(block.id);
  if (!source || source.revision !== block.revision || !usable(source, at.place, at.now)) return null;
  const value = valueOf(source, 'price');
  return value && priceInTime(value, at.now) ? { source, value } : null;
}

/* One price block: what it comes to, and everything it rests on, so that a change in any of them changes the digest. */
export function checkPrice(block: { id: string; revision: number }, catalog: Catalog, at: PriceAt): PriceChecked {
  const price = priceOf(block, catalog, at);
  if (!price) return refused('price_unapproved');
  const discount = discountOf(price.value, catalog, at);
  const money = discount && priceAfterDiscount(price.value, discount.value);
  if (!money) return refused('price_unapproved');
  const terms = termsOf(price.value, catalog, at);
  if (typeof terms === 'string') return refused(terms);
  return { ok: true, money, terms: terms.terms, sources: [price.source, discount.source, terms.terms].filter(s => s !== null) };
}

/* Words a person published are still only words: a link goes in a link block. A scheme, www or a name with a domain's shape
   counts in any script. This supplements the catalog and never certifies what words mean. */
const LINKS = [/\b[a-z][a-z0-9+.-]*:\/\//i, /\bwww\./i, /\bmailto:/i, /(?:^|\s)\/\/\S/, /[\p{L}\p{N}-]+\.\p{L}{2,}/u];
const MARKUP = [/<[a-z/!?]/i, /&#?\w+;/, /\]\(/, /\{\{/, /\$\{/];
/* Characters that make a text read otherwise than it is stored. Joiners and direction marks stay: some scripts need them. */
const HIDING = /[\u202A-\u202E\u2066-\u2069\u{E0000}-\u{E007F}]/u;
const SECRETS = [/\bsk-[A-Za-z0-9_-]{20,}/, /\bAKIA[0-9A-Z]{16}\b/, /\bgh[pousr]_[A-Za-z0-9]{36,}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\bxox[abprs]-[A-Za-z0-9-]{10,}/];
const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/u;
const LONG_NUMBER = /(?<![\p{N}])\p{Nd}(?:[ -]?\p{Nd}){12,18}(?![\p{N}])/gu;

/* The check digit of a payment card number. */
function luhn(digits: string): boolean {
  let sum = 0;
  [...digits].reverse().forEach((d, i) => {
    const n = Number(d) * (i % 2 === 1 ? 2 : 1);
    sum += n > 9 ? n - 9 : n;
  });
  return sum % 10 === 0;
}
const holdsCard = (text: string): boolean => (text.match(LONG_NUMBER) ?? []).map(found => found.replace(/[ -]/g, '')).some(digits => /^[0-9]+$/.test(digits) && luhn(digits));

const SCANS: readonly [GateCode, (text: string) => boolean][] = [
  ['link_unapproved', text => LINKS.some(found => found.test(text))],
  ['template_unapproved', text => HIDING.test(text) || MARKUP.some(found => found.test(text))],
  ['secret_forbidden', text => SECRETS.some(found => found.test(text))],
  ['pii_forbidden', text => EMAIL.test(text) || holdsCard(text)],
];

/* What catalog words carry that they may not, by the code that refuses it. */
export const scanText = (text: string): GateCode[] => SCANS.filter(([, holds]) => holds(text)).map(([code]) => code);

const LEADS_ON = /[a-z][a-z0-9+.-]*:\/\/|\/\//i;
const decoded = (part: string): string | null => {
  try {
    return decodeURIComponent(part);
  } catch {
    return null;
  }
};
const hidesAnother = (part: string): boolean => {
  const plain = decoded(part);
  return plain === null || LEADS_ON.test(plain);
};

/* A link is one place: on https, with no sign-in, and with no other address inside it to be sent on to. */
export function unsafeLink(url: string): boolean {
  if (!URL.canParse(url)) return true;
  const { protocol, username, password, pathname, search, hash } = new URL(url);
  return protocol !== 'https:' || username !== '' || password !== '' || [pathname, search, hash].some(hidesAnother);
}
