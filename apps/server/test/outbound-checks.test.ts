import { randomUUID } from 'node:crypto';
import { MessageDocument, type CatalogValue, type GateCode } from '@hornhoof/protocol';
import { describe, expect, it } from 'vitest';
import { aSource } from './outbound-fixture.js';
import { checkPrice, currentRevision, formatMoney, minorUnits, moneyWithinLimit, priceAfterDiscount, scanText, unsafeLink, type Catalog, type Money, type Place, type Source } from '../src/modules/outbound/checks.js';

const NOW = new Date('2026-11-06T10:00:00.000Z');
const PLACE: Place = { channelId: randomUUID(), departmentId: randomUUID(), productId: randomUUID() };

const source = (value: CatalogValue, over: Partial<Source> = {}): Source => aSource(PLACE, value, over);
const priceValue = (over: Partial<Extract<CatalogValue, { kind: 'price' }>> = {}): Extract<CatalogValue, { kind: 'price' }> => ({
  kind: 'price', amount: '10.00', currency: 'USD', scale: 2, rounding: 'half_up', discountId: null, termsId: null, validFrom: '2026-11-01T00:00:00.000Z', validUntil: null, ...over,
});
const percent = (value: string): Extract<CatalogValue, { kind: 'discount' }> => ({ kind: 'discount', off: { kind: 'percent', value } });
const off = (value: string, currency = 'USD'): Extract<CatalogValue, { kind: 'discount' }> => ({ kind: 'discount', off: { kind: 'amount', value, currency } });

const catalogOf = (...sources: Source[]): Catalog => id => sources.find(s => s.entryId === id) ?? null;
const check = (price: Source, catalog: Catalog = catalogOf(price), locale = 'en', now = NOW) => checkPrice({ id: price.entryId, revision: price.revision }, catalog, { place: PLACE, now, locale });
const refusal = (result: ReturnType<typeof checkPrice>): GateCode[] => (result.ok ? [] : result.reasonCodes);

describe('exact money', () => {
  it('reads an amount as whole minor units, only at its own scale', () => {
    expect(minorUnits('10.00', 2)).toBe(1000n);
    expect(minorUnits('0.07', 2)).toBe(7n);
    expect(minorUnits('5', 0)).toBe(5n);
    expect(minorUnits('10.0', 2)).toBeNull();
    expect(minorUnits('10.000', 2)).toBeNull();
    expect(minorUnits('1e3', 0)).toBeNull();
    expect(minorUnits('-1.00', 2)).toBeNull();
    expect(minorUnits('١٠٫٠٠', 2)).toBeNull();
  });

  it('keeps every digit of an amount no float can hold', () => {
    expect(minorUnits('90071992547409.93', 2)).toBe(9007199254740993n);
    expect(priceAfterDiscount(priceValue({ amount: '90071992547409.93' }), null)).toEqual({ minor: 9007199254740993n, currency: 'USD', scale: 2 });
  });

  it.each([
    ['half_up', '19.99', '12.5', 1749n],
    ['half_up', '0.10', '5', 10n],
    ['half_even', '0.10', '5', 10n],
    ['half_even', '0.30', '5', 28n],
    ['down', '19.99', '12.5', 1749n],
    ['down', '0.10', '5', 9n],
  ] as const)('rounds a percent off by the price\'s own rule: %s %s less %s%%', (rounding, amount, value, minor) => {
    expect(priceAfterDiscount(priceValue({ amount, rounding }), percent(value))?.minor).toBe(minor);
  });

  it('takes an amount off in the same currency at no finer scale', () => {
    expect(priceAfterDiscount(priceValue(), off('2.50'))?.minor).toBe(750n);
    expect(priceAfterDiscount(priceValue(), off('2.5'))?.minor).toBe(750n);
    expect(priceAfterDiscount(priceValue(), off('2.50', 'EUR'))).toBeNull();
    expect(priceAfterDiscount(priceValue(), off('2.505'))).toBeNull();
  });

  it('refuses a discount larger than what it is taken from', () => {
    expect(priceAfterDiscount(priceValue(), off('10.01'))).toBeNull();
    expect(priceAfterDiscount(priceValue(), percent('100.01'))).toBeNull();
    expect(priceAfterDiscount(priceValue(), percent('100'))?.minor).toBe(0n);
  });

  it.each([
    ['en', '$12,345,678,901,234.56'],
    ['ru', '12 345 678 901 234,56 $'],
    ['ar-EG', '١٢٬٣٤٥٬٦٧٨٬٩٠١٬٢٣٤٫٥٦'],
    ['ja', '$12,345,678,901,234.56'],
  ])('writes it out in %s with every digit', (locale, digits) => {
    const money: Money = { minor: 1234567890123456n, currency: 'USD', scale: 2 };
    const written = formatMoney(money, locale).replace(/[\s\u00A0\u202F\u200F\u061C]/g, ' ');
    expect(written.replace(/[^\p{N},.٬٫]/gu, '')).toBe(digits.replace(/[^\p{N},.٬٫]/gu, ''));
  });

  it('compares with a limit exactly, in the limit\'s own unit', () => {
    const limit = { limit: 100.5, unit: 'USD' };
    const usd = (minor: bigint): Money => ({ minor, currency: 'USD', scale: 2 });
    expect(moneyWithinLimit([usd(10050n)], limit)).toBe(true);
    expect(moneyWithinLimit([usd(10051n)], limit)).toBe(false);
    expect(moneyWithinLimit([usd(5000n), usd(5050n)], limit)).toBe(true);
    expect(moneyWithinLimit([usd(5000n), usd(5051n)], limit)).toBe(false);
  });

  it('asks the person when the amount cannot be measured against the limit', () => {
    const usd: Money = { minor: 1n, currency: 'USD', scale: 2 };
    expect(moneyWithinLimit([], { limit: 100, unit: 'USD' })).toBe(false);
    expect(moneyWithinLimit([usd], { limit: 100 })).toBe(false);
    expect(moneyWithinLimit([usd], { limit: 100, unit: 'EUR' })).toBe(false);
    expect(moneyWithinLimit([usd, { ...usd, currency: 'EUR' }], { limit: 100, unit: 'USD' })).toBe(false);
  });
});

describe('the revision that counts', () => {
  const rows = (...statuses: Source['status'][]) => statuses.map((status, i) => source(priceValue(), { revision: i + 1, status }));

  it('is the newest published one, not a proposal on top of it', () => {
    expect(currentRevision(rows('published', 'published', 'proposed'))?.revision).toBe(2);
  });

  it('is none once the newest was taken back: an older price does not come back by itself', () => {
    expect(currentRevision(rows('published', 'revoked'))).toBeNull();
    expect(currentRevision(rows('proposed'))).toBeNull();
    expect(currentRevision([])).toBeNull();
  });
});

describe('a price block', () => {
  it('passes with its exact amount when everything it rests on is current', () => {
    const terms = source({ kind: 'terms', locale: 'en', text: 'Net 30.' });
    const discount = source(percent('10'));
    const price = source(priceValue({ discountId: discount.entryId, termsId: terms.entryId }));
    const result = check(price, catalogOf(price, terms, discount));
    expect(result).toMatchObject({ ok: true, money: { minor: 900n, currency: 'USD', scale: 2 }, terms: { entryId: terms.entryId } });
    expect(result.ok && result.sources.map(s => s.entryId).sort()).toEqual([price.entryId, terms.entryId, discount.entryId].sort());
  });

  it.each<[string, Partial<Source>, Date?]>([
    ['never published', { status: 'proposed' }],
    ['taken back', { status: 'revoked' }],
    ['not yet valid', { validFrom: new Date('2026-11-07T00:00:00.000Z') }],
    ['expired at this very moment', { validUntil: NOW }],
    ['of another department', { departmentId: randomUUID() }],
    ['of another product', { productId: randomUUID() }],
    ['of another channel', { channelId: randomUUID() }],
  ])('is refused when it is %s', (_name, over) => {
    expect(refusal(check(source(priceValue(), over)))).toEqual(['price_unapproved']);
  });

  it('is refused when the value itself says it expired', () => {
    expect(refusal(check(source(priceValue({ validUntil: '2026-11-02T00:00:00.000Z' }))))).toEqual(['price_unapproved']);
  });

  it('passes for the holding department\'s price and for the product\'s and channel\'s own', () => {
    expect(check(source(priceValue(), { productId: PLACE.productId })).ok).toBe(true);
    expect(check(source(priceValue(), { channelId: PLACE.channelId })).ok).toBe(true);
  });

  it('is refused for an unknown id, a revision that is not the current one, or another kind of entry', () => {
    const price = source(priceValue(), { revision: 2 });
    const catalog = catalogOf(price);
    expect(refusal(checkPrice({ id: randomUUID(), revision: 1 }, catalog, { place: PLACE, now: NOW, locale: 'en' }))).toEqual(['price_unapproved']);
    expect(refusal(checkPrice({ id: price.entryId, revision: 1 }, catalog, { place: PLACE, now: NOW, locale: 'en' }))).toEqual(['price_unapproved']);
    const link = source({ kind: 'link', url: 'https://shop.example/' });
    expect(refusal(check(link))).toEqual(['price_unapproved']);
  });

  it('is refused when its amount does not fit its scale, whatever got it stored', () => {
    expect(refusal(check(source(priceValue({ amount: '10.0' }))))).toEqual(['price_unapproved']);
  });

  it.each<[string, (id: string) => Source | null]>([
    ['is gone', () => null],
    ['was taken back', id => source(percent('10'), { entryId: id, status: 'revoked' })],
    ['expired', id => source(percent('10'), { entryId: id, validUntil: NOW })],
    ['belongs elsewhere', id => source(percent('10'), { entryId: id, departmentId: randomUUID() })],
    ['is not a discount', id => source({ kind: 'link', url: 'https://shop.example/' }, { entryId: id })],
    ['does not fit the price', id => source(off('11.00'), { entryId: id })],
  ])('is refused when its discount %s', (_name, make) => {
    const id = randomUUID();
    const price = source(priceValue({ discountId: id }));
    const discount = make(id);
    expect(refusal(check(price, catalogOf(price, ...(discount ? [discount] : []))))).toEqual(['price_unapproved']);
  });

  it.each<[string, (id: string) => Source | null]>([
    ['are gone', () => null],
    ['were taken back', id => source({ kind: 'terms', locale: 'en', text: 'Net 30.' }, { entryId: id, status: 'revoked' })],
    ['expired', id => source({ kind: 'terms', locale: 'en', text: 'Net 30.' }, { entryId: id, validUntil: NOW })],
    ['belong elsewhere', id => source({ kind: 'terms', locale: 'en', text: 'Net 30.' }, { entryId: id, channelId: randomUUID() })],
  ])('is refused as to its terms when they %s', (_name, make) => {
    const id = randomUUID();
    const price = source(priceValue({ termsId: id }));
    const terms = make(id);
    expect(refusal(check(price, catalogOf(price, ...(terms ? [terms] : []))))).toEqual(['terms_unapproved']);
  });

  it('never falls back to terms in another language', () => {
    const terms = source({ kind: 'terms', locale: 'en', text: 'Net 30.' });
    const price = source(priceValue({ termsId: terms.entryId }));
    expect(refusal(check(price, catalogOf(price, terms), 'ru'))).toEqual(['unsupported_locale']);
    expect(check(price, catalogOf(price, terms), 'en').ok).toBe(true);
  });

  it.each(['10.00', '10,00', '١٠٫٠٠', '１０．００', '10 USD'])('has no field for an amount of its own, however it is written: %s', amount => {
    const document = { locale: 'en', templateId: randomUUID(), templateRevision: 1, variables: [] };
    expect(MessageDocument.safeParse({ ...document, blocks: [{ kind: 'price', id: randomUUID(), revision: 1 }] }).success).toBe(true);
    expect(MessageDocument.safeParse({ ...document, blocks: [{ kind: 'price', id: randomUUID(), revision: 1, amount }] }).success).toBe(false);
    expect(MessageDocument.safeParse({ ...document, blocks: [], variables: [{ slotId: randomUUID(), valueRef: amount }] }).success).toBe(false);
    expect(MessageDocument.safeParse({ ...document, blocks: [], text: amount }).success).toBe(false);
  });
});

describe('what no catalog text may carry', () => {
  it.each([
    'Visit https://evil.example/now',
    'Visit HTTP://evil.example',
    'ftp://evil.example/file',
    'Visit www.evil.example today',
    'Visit evil.example/now',
    'Visit evil.example today',
    'Посетите пример.рф сегодня',
    'mailto:someone',
    'Go //evil.example/x',
  ])('finds a link outside a link block: %s', text => {
    expect(scanText(text)).toContain('link_unapproved');
  });

  it.each(['Read <a href="x">this</a>', '<img src=x>', '</b>', '&#x68;ello', '&amp;', '[click](x)', '{{name}}', '${name}'])('finds markup and expressions: %s', text => {
    expect(scanText(text)).toContain('template_unapproved');
  });

  it.each(['safe\u202Etxet', 'safe\u2066text\u2069', 'tag\u{E0041}'])('finds characters that hide what a text says: %j', text => {
    expect(scanText(text)).toContain('template_unapproved');
  });

  it.each(['token sk-abcdefghijklmnopqrstuvwx', 'AKIAABCDEFGHIJKLMNOP', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789', '-----BEGIN RSA PRIVATE KEY-----', 'xoxb-1234567890-abcdefghij'])('finds a known secret: %s', text => {
    expect(scanText(text)).toContain('secret_forbidden');
  });

  it.each(['Write to ann@shop.example', 'Card 4111 1111 1111 1111', 'Card 4111-1111-1111-1111'])('finds a third person\'s details: %s', text => {
    expect(scanText(text)).toContain('pii_forbidden');
  });

  it.each([
    'Our service costs less than you think, and it is ready today.',
    'Наш сервис уже готов. Цена указана ниже, 3.5 процента за год.',
    'خدمتنا جاهزة اليوم. السعر أدناه.',
    'השירות שלנו מוכן היום. המחיר למטה.',
    'می\u200Cتوانید امروز شروع کنید',
    'サービスは本日からご利用いただけます。価格は下記のとおりです。',
    'Order 1234 5678 stays open, version 2.5 is out. Ask about e.g. shipping.',
    'A & B < C',
  ])('passes ordinary words in any language: %s', text => {
    expect(scanText(text)).toEqual([]);
  });

  it.each([
    'https://shop.example/r?to=https://evil.example',
    'https://shop.example/r?to=https%3A%2F%2Fevil.example',
    'https://shop.example/r?to=//evil.example',
    'https://shop.example/#https://evil.example',
    'https://shop.example/r/https://evil.example',
    'http://shop.example/',
    'https://user:pw@shop.example/',
  ])('refuses a link that leads on somewhere else: %s', url => {
    expect(unsafeLink(url)).toBe(true);
  });

  it.each(['https://shop.example/', 'https://shop.example/pricing?plan=team&utm_source=mail#top', 'https://xn--e1afmkfd.xn--p1ai/цены'])('passes a plain link: %s', url => {
    expect(unsafeLink(url)).toBe(false);
  });
});
