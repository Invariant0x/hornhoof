import { randomUUID } from 'node:crypto';
import type { CatalogValue, GateCode, MessageDocument } from '@hornhoof/protocol';
import { describe, expect, it } from 'vitest';
import type { Catalog, Place, Source } from '../src/modules/outbound/checks.js';
import { frozenDigest, renderMessage, sealedDigest, type Frozen, type RenderRequest } from '../src/modules/outbound/render.js';

const NOW = new Date('2026-11-06T10:00:00.000Z');
const PLACE: Place = { channelId: randomUUID(), departmentId: randomUUID(), productId: null };
const URL_OUT = 'https://hornhoof.example/api/outbound/unsubscribe/token';

const source = (value: CatalogValue, over: Partial<Source> = {}): Source => ({
  entryId: randomUUID(), revision: 1, kind: value.kind, locale: 'locale' in value ? value.locale : null, value, digest: `digest ${randomUUID()}`, status: 'published',
  validFrom: new Date('2026-11-01T00:00:00.000Z'), validUntil: null, departmentId: PLACE.departmentId, productId: null, channelId: null, ...over,
});
const text = (value: string) => ({ kind: 'text', text: value }) as const;
const slot = (type: Extract<Extract<CatalogValue, { kind: 'template' }>['parts'][number], { kind: 'slot' }>['type'], slotId: string = randomUUID()) => ({ kind: 'slot', slotId, type }) as const;
const PRICE_VALUE: CatalogValue = { kind: 'price', amount: '10.00', currency: 'USD', scale: 2, rounding: 'half_up', discountId: null, termsId: null, validFrom: '2026-11-01T00:00:00.000Z', validUntil: null };

/* What one language says of everything in a message, so that every rule is proved in every script. */
const WORDS = {
  en: { hello: 'Hello.', claim: 'We answer within a day.', know: 'Plans start monthly.', bye: 'To stop these letters: ' },
  ru: { hello: 'Здравствуйте.', claim: 'Мы отвечаем в течение дня.', know: 'Планы начинаются с месяца.', bye: 'Чтобы отписаться: ' },
  ar: { hello: 'مرحبا.', claim: 'نرد خلال يوم واحد.', know: 'تبدأ الخطط شهريا.', bye: 'لإيقاف هذه الرسائل: ' },
  he: { hello: 'שלום.', claim: 'אנחנו עונים תוך יום.', know: 'התוכניות מתחילות חודשית.', bye: 'כדי להפסיק הודעות: ' },
  ja: { hello: 'こんにちは。', claim: '一日以内にお返事します。', know: 'プランは月単位です。', bye: '配信停止はこちら: ' },
} as const;
type Lang = keyof typeof WORDS;
const LANGS = Object.keys(WORDS) as Lang[];

function aMessage(locale: Lang = 'en') {
  const words = WORDS[locale];
  const price = source(PRICE_VALUE);
  const link = source({ kind: 'link', url: 'https://shop.example/pricing' });
  const claim = source({ kind: 'claim', locale, text: words.claim });
  const knowledge = source({ kind: 'knowledge', locale, text: words.know });
  const unsubscribe = source({ kind: 'unsubscribe', locale, text: words.bye });
  const field = source({ kind: 'variable', field: 'account_label' });
  const variableSlot = randomUUID();
  const template = source({
    kind: 'template', locale, subject: words.hello,
    parts: [text(`${words.hello} `), slot('variable', variableSlot), text(' '), slot('claim'), text(' '), slot('knowledge'), text(' '), slot('price'), text(' '), slot('link'), text(' '), slot('unsubscribe')],
  });
  const document: MessageDocument = {
    locale, templateId: template.entryId, templateRevision: 1,
    blocks: [
      { kind: 'price', id: price.entryId, revision: 1 },
      { kind: 'link', id: link.entryId, revision: 1 },
      { kind: 'claim', id: claim.entryId, revision: 1 },
      { kind: 'knowledge', id: knowledge.entryId, revision: 1 },
    ],
    variables: [{ slotId: variableSlot, valueRef: field.entryId }],
  };
  return { words, price, link, claim, knowledge, unsubscribe, field, template, document, variableSlot };
}
type Built = ReturnType<typeof aMessage>;

const catalogOf = (...sources: Source[]): Catalog => id => sources.find(s => s.entryId === id) ?? null;
const allOf = (m: Built) => [m.price, m.link, m.claim, m.knowledge, m.field, m.template];
const request = (m: Built, over: Partial<RenderRequest> = {}): RenderRequest => ({
  document: m.document, place: PLACE, audience: 'direct', catalog: catalogOf(...allOf(m)), unsubscribe: { source: m.unsubscribe, url: URL_OUT }, fields: { account_label: 'Team One' }, now: NOW, ...over,
});
const reasons = (req: RenderRequest): GateCode[] => {
  const result = renderMessage(req);
  return result.ok ? [] : result.reasonCodes;
};
const swapped = (m: Built, replaced: Source): RenderRequest => request(m, { catalog: catalogOf(...allOf(m).filter(s => s.entryId !== replaced.entryId), replaced) });
const withParts = (m: Built, parts: Extract<CatalogValue, { kind: 'template' }>['parts']): RenderRequest => swapped(m, { ...m.template, value: { kind: 'template', locale: m.template.locale!, subject: 'Hi', parts } });

describe('a rendered message', () => {
  it.each(LANGS)('holds exactly what was approved, in its order, in %s', locale => {
    const m = aMessage(locale);
    const result = renderMessage(request(m));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rendered.subject).toBe(m.words.hello);
    const { text: body } = result.rendered;
    expect(body.startsWith(`${m.words.hello} Team One ${m.words.claim} ${m.words.know} `)).toBe(true);
    expect(body.endsWith(`https://shop.example/pricing ${m.words.bye}${URL_OUT}`)).toBe(true);
    expect(result.rendered.money).toEqual([{ minor: 1000n, currency: 'USD', scale: 2 }]);
  });

  it('names every source with its revision, so that a change to any of them changes the digest', () => {
    const m = aMessage();
    const first = renderMessage(request(m));
    const again = renderMessage(request(m));
    const changed = renderMessage(swapped(m, { ...m.claim, digest: 'another digest' }));
    expect(first.ok && again.ok && first.rendered.sourceRevisionsDigest === again.rendered.sourceRevisionsDigest).toBe(true);
    expect(first.ok && changed.ok && first.rendered.sourceRevisionsDigest !== changed.rendered.sourceRevisionsDigest).toBe(true);
    expect(first.ok && first.rendered.sources.map(s => s.entryId).sort()).toEqual([...allOf(m), m.unsubscribe].map(s => s.entryId).sort());
  });

  it('leaves the words of a price\'s terms in a terms slot and refuses to hide them', () => {
    const m = aMessage();
    const terms = source({ kind: 'terms', locale: 'en', text: 'Net 30.' });
    const price = { ...m.price, value: { ...PRICE_VALUE, termsId: terms.entryId } as CatalogValue };
    const shown = { ...m.template, value: { kind: 'template', locale: 'en', subject: 'Hi', parts: [slot('price'), text(' '), slot('terms'), text(' '), slot('unsubscribe')] } as CatalogValue };
    const document = { ...m.document, blocks: [{ kind: 'price', id: price.entryId, revision: 1 } as const], variables: [] };
    const result = renderMessage(request(m, { document, catalog: catalogOf(price, terms, shown) }));
    expect(result.ok && result.rendered.text.includes(' Net 30. ')).toBe(true);
    const hidden = { ...shown, value: { kind: 'template', locale: 'en', subject: 'Hi', parts: [slot('price'), text(' '), slot('unsubscribe')] } as CatalogValue };
    expect(reasons(request(m, { document, catalog: catalogOf(price, terms, hidden) }))).toEqual(['terms_unapproved']);
    expect(reasons(request(m, { document, catalog: catalogOf(m.price, shown) }))).toContain('template_unapproved');
  });
});

describe.each(LANGS)('the same failures in %s', locale => {
  const m = aMessage(locale);

  it('a revoked link', () => {
    expect(reasons(swapped(m, { ...m.link, status: 'revoked' }))).toEqual(['link_unapproved']);
  });
  it('a link never published', () => {
    expect(reasons(swapped(m, { ...m.link, status: 'proposed' }))).toEqual(['link_unapproved']);
  });
  it('a link that leads on elsewhere', () => {
    expect(reasons(swapped(m, { ...m.link, value: { kind: 'link', url: 'https://shop.example/r?to=https://evil.example' } }))).toEqual(['link_unapproved']);
  });
  it('a revoked claim', () => {
    expect(reasons(swapped(m, { ...m.claim, status: 'revoked' }))).toEqual(['claim_unapproved']);
  });
  it('an expired claim', () => {
    expect(reasons(swapped(m, { ...m.claim, validUntil: NOW }))).toEqual(['claim_unapproved']);
  });
  it('a claim with a hidden link in it', () => {
    expect(reasons(swapped(m, { ...m.claim, value: { kind: 'claim', locale, text: `${m.words.claim} https://evil.example` } }))).toEqual(['link_unapproved']);
  });
  it('a claim with markup in it', () => {
    expect(reasons(swapped(m, { ...m.claim, value: { kind: 'claim', locale, text: `<b>${m.words.claim}</b>` } }))).toEqual(['template_unapproved']);
  });
  it('a price taken back', () => {
    expect(reasons(swapped(m, { ...m.price, status: 'revoked' }))).toEqual(['price_unapproved']);
  });
  it('knowledge taken back', () => {
    expect(reasons(swapped(m, { ...m.knowledge, status: 'revoked' }))).toEqual(['claim_unapproved']);
  });
  it('a template taken back', () => {
    expect(reasons(swapped(m, { ...m.template, status: 'revoked' }))).toEqual(['template_unapproved']);
  });
  it('a stale template revision', () => {
    expect(reasons(request(m, { document: { ...m.document, templateRevision: 2 } }))).toEqual(['template_unapproved']);
  });
  it('no unsubscribe words in this language', () => {
    expect(reasons(request(m, { unsubscribe: { source: null, url: URL_OUT } }))).toEqual(['unsupported_locale']);
  });

  it('a claim written in another language: no fallback, whichever it is', () => {
    const other = LANGS.find(l => l !== locale)!;
    expect(reasons(swapped(m, { ...m.claim, locale: other, value: { kind: 'claim', locale: other, text: WORDS[other].claim } }))).toEqual(['unsupported_locale']);
  });
  it('a template written in another language', () => {
    const other = LANGS.find(l => l !== locale)!;
    expect(reasons(swapped(m, { ...m.template, locale: other, value: { kind: 'template', locale: other, subject: null, parts: [text(WORDS[other].hello)] } }))).toContain('unsupported_locale');
  });
  it('unsubscribe words in another language', () => {
    const other = LANGS.find(l => l !== locale)!;
    expect(reasons(request(m, { unsubscribe: { source: { ...m.unsubscribe, locale: other, value: { kind: 'unsubscribe', locale: other, text: WORDS[other].bye } }, url: URL_OUT } }))).toEqual(['unsupported_locale']);
  });
});

describe('no English shortcut', () => {
  it('a word that sounds risky in English is nobody\'s business in any language: the catalog decides, not a keyword', () => {
    const m = aMessage();
    const words = 'Guaranteed refund. Free. Legal. Price cut.';
    expect(renderMessage(swapped(m, { ...m.claim, value: { kind: 'claim', locale: 'en', text: words } })).ok).toBe(true);
  });

  it('the same refusal comes for a block of the wrong language however it is spelled', () => {
    const m = aMessage('ru');
    expect(reasons(request(m, { document: { ...m.document, locale: 'ru-RU' } }))).toContain('unsupported_locale');
    expect(renderMessage(request(m, { document: { ...m.document, locale: 'ru' } })).ok).toBe(true);
  });
});

describe('slots', () => {
  it('a slot with nothing to fill it', () => {
    const m = aMessage();
    expect(reasons(request(m, { document: { ...m.document, blocks: m.document.blocks.filter(b => b.kind !== 'claim') } }))).toEqual(['template_unapproved']);
  });
  it('a block with no slot for it', () => {
    const m = aMessage();
    const extra = source({ kind: 'claim', locale: 'en', text: 'One more.' });
    expect(reasons(request(m, { catalog: catalogOf(...allOf(m), extra), document: { ...m.document, blocks: [...m.document.blocks, { kind: 'claim', id: extra.entryId, revision: 1 }] } }))).toEqual(['template_unapproved']);
  });
  it('the same block twice for two slots', () => {
    const m = aMessage();
    const twice = withParts(m, [slot('claim'), slot('claim'), slot('unsubscribe')]);
    const claim = m.document.blocks.find(b => b.kind === 'claim')!;
    expect(reasons({ ...twice, document: { ...m.document, blocks: [claim, claim], variables: [] } })).toEqual(['template_unapproved']);
  });
  it('fills two slots of a kind in the order of its blocks', () => {
    const m = aMessage();
    const second = source({ kind: 'claim', locale: 'en', text: 'Second.' });
    const req = withParts(m, [slot('claim'), text(' '), slot('claim'), slot('unsubscribe')]);
    const result = renderMessage({ ...req, catalog: id => (id === second.entryId ? second : req.catalog(id)), document: { ...m.document, blocks: [{ kind: 'claim', id: m.claim.entryId, revision: 1 }, { kind: 'claim', id: second.entryId, revision: 1 }], variables: [] } });
    expect(result.ok && result.rendered.text.startsWith(`${m.words.claim} Second.`)).toBe(true);
  });
  it('a block that says it is one kind for an entry of another', () => {
    const m = aMessage();
    const blocks = m.document.blocks.map(b => (b.kind === 'claim' ? { ...b, id: m.link.entryId } : b));
    expect(reasons(request(m, { document: { ...m.document, blocks } }))).toEqual(['claim_unapproved']);
  });
  it('a block of another revision than the one that counts', () => {
    const m = aMessage();
    const blocks = m.document.blocks.map(b => (b.kind === 'link' ? { ...b, revision: 2 } : b));
    expect(reasons(request(m, { document: { ...m.document, blocks } }))).toEqual(['link_unapproved']);
  });
  it('an unknown id', () => {
    const m = aMessage();
    const blocks = m.document.blocks.map(b => (b.kind === 'link' ? { ...b, id: randomUUID() } : b));
    expect(reasons(request(m, { document: { ...m.document, blocks } }))).toEqual(['link_unapproved']);
  });
  it('a block of another department or channel', () => {
    const m = aMessage();
    expect(reasons(swapped(m, { ...m.link, departmentId: randomUUID() }))).toEqual(['link_unapproved']);
    expect(reasons(swapped(m, { ...m.claim, channelId: randomUUID() }))).toEqual(['claim_unapproved']);
  });
  it('a template with a link or markup in its own words', () => {
    const m = aMessage();
    expect(reasons(withParts(m, [text('See https://evil.example '), slot('unsubscribe')]))).toContain('link_unapproved');
    expect(reasons(withParts(m, [text('<a href="x">See</a> '), slot('unsubscribe')]))).toContain('template_unapproved');
  });
  it('a subject with a link in it', () => {
    const m = aMessage();
    expect(reasons(swapped(m, { ...m.template, value: { ...(m.template.value as Extract<CatalogValue, { kind: 'template' }>), subject: 'See https://evil.example' } }))).toEqual(['link_unapproved']);
  });
  it('known secrets and third persons in catalog words', () => {
    const m = aMessage();
    expect(reasons(swapped(m, { ...m.claim, value: { kind: 'claim', locale: 'en', text: 'AKIAABCDEFGHIJKLMNOP' } }))).toEqual(['secret_forbidden']);
    expect(reasons(swapped(m, { ...m.claim, value: { kind: 'claim', locale: 'en', text: 'Card 4111 1111 1111 1111' } }))).toEqual(['pii_forbidden']);
  });
  it('a stored value that is not what the schema allows', () => {
    const m = aMessage();
    expect(reasons(swapped(m, { ...m.claim, value: { kind: 'claim', locale: 'en', text: 'one\u0007two' } }))).toEqual(['claim_unapproved']);
  });
});

describe('variables', () => {
  it('a variable slot with no reference', () => {
    const m = aMessage();
    expect(reasons(request(m, { document: { ...m.document, variables: [] } }))).toEqual(['template_unapproved']);
  });
  it('a reference to a slot the template does not have', () => {
    const m = aMessage();
    expect(reasons(request(m, { document: { ...m.document, variables: [...m.document.variables, { slotId: randomUUID(), valueRef: m.field.entryId }] } }))).toEqual(['template_unapproved']);
  });
  it('two references to one slot', () => {
    const m = aMessage();
    const again = { slotId: m.variableSlot, valueRef: m.field.entryId };
    expect(reasons(request(m, { document: { ...m.document, variables: [again, again] } }))).toEqual(['template_unapproved']);
  });
  it('a reference that is no approved field', () => {
    const m = aMessage();
    expect(reasons(request(m, { document: { ...m.document, variables: [{ slotId: m.variableSlot, valueRef: randomUUID() }] } }))).toEqual(['template_unapproved']);
    expect(reasons(swapped(m, { ...m.field, status: 'revoked' }))).toEqual(['template_unapproved']);
    expect(reasons(request(m, { fields: {} }))).toEqual(['template_unapproved']);
  });
  it.each(['Team\nBcc: x', 'https://evil.example', '<b>Team</b>', 'x'.repeat(201), ''])('a value that is not one short plain line: %j', value => {
    const m = aMessage();
    expect(reasons(request(m, { fields: { account_label: value } })).length).toBeGreaterThan(0);
  });
});

describe('unsubscribe', () => {
  it('a direct message cannot leave without its slot', () => {
    const m = aMessage();
    expect(reasons(withParts(m, [text('Hi')]))).toContain('template_unapproved');
  });
  it('a direct message cannot leave without the signed address', () => {
    const m = aMessage();
    expect(reasons(request(m, { unsubscribe: { source: m.unsubscribe, url: null } }))).toEqual(['template_unapproved']);
  });
  it('words of another scope do not count', () => {
    const m = aMessage();
    expect(reasons(request(m, { unsubscribe: { source: { ...m.unsubscribe, channelId: randomUUID() }, url: URL_OUT } }))).toEqual(['template_unapproved']);
    expect(reasons(request(m, { unsubscribe: { source: { ...m.unsubscribe, status: 'revoked' }, url: URL_OUT } }))).toEqual(['template_unapproved']);
  });
  it('words that bring their own link do not count', () => {
    const m = aMessage();
    expect(reasons(request(m, { unsubscribe: { source: { ...m.unsubscribe, value: { kind: 'unsubscribe', locale: 'en', text: 'Go to https://evil.example ' } }, url: URL_OUT } }))).toEqual(['link_unapproved']);
  });
  it('a public post has none, and its absence is no failure', () => {
    const m = aMessage();
    const req = withParts(m, [text('Hello all.')]);
    const result = renderMessage({ ...req, audience: 'public', unsubscribe: { source: null, url: null }, document: { ...m.document, blocks: [], variables: [] } });
    expect(result.ok && result.rendered.text).toBe('Hello all.');
  });
  it('a public post cannot carry a slot for one', () => {
    const m = aMessage();
    const req = withParts(m, [text('Hello all.'), slot('unsubscribe')]);
    expect(reasons({ ...req, audience: 'public', unsubscribe: { source: null, url: null }, document: { ...m.document, blocks: [], variables: [] } })).toEqual(['template_unapproved']);
  });
});

describe('frozen bytes', () => {
  const FROZEN: Frozen = {
    subject: 'Hello.', text: 'Hello there.', recipientDigest: 'a'.repeat(64), accountId: randomUUID(), channelId: randomUUID(), purpose: 'first_contact', locale: 'en', segmentId: randomUUID(),
    scheduledAt: '2026-11-06T10:00:00.000Z', sourceRevisionsDigest: 'b'.repeat(64), bindingGeneration: 1,
  };

  it('are the same digest for the same content', () => {
    expect(frozenDigest({ ...FROZEN })).toBe(frozenDigest(FROZEN));
    expect(frozenDigest(FROZEN)).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each<[string, Partial<Frozen>]>([
    ['one byte of the body', { text: 'Hello there!' }],
    ['the subject', { subject: 'Hello!' }],
    ['the recipient', { recipientDigest: 'c'.repeat(64) }],
    ['the account', { accountId: randomUUID() }],
    ['the channel', { channelId: randomUUID() }],
    ['the purpose', { purpose: 'follow_up' }],
    ['the language', { locale: 'ru' }],
    ['the segment', { segmentId: randomUUID() }],
    ['the time', { scheduledAt: '2026-11-06T10:00:01.000Z' }],
    ['a source revision', { sourceRevisionsDigest: 'd'.repeat(64) }],
    ['the binding generation', { bindingGeneration: 2 }],
  ])('change when %s changes', (_name, change) => {
    expect(frozenDigest({ ...FROZEN, ...change })).not.toBe(frozenDigest(FROZEN));
  });

  it('name what is sealed, so that an edited seal does not match its digest', () => {
    const sealed = { recipient: 'ann@shop.example', subject: 'Hello.', text: 'Hello there.' };
    expect(sealedDigest(sealed)).toBe(sealedDigest({ ...sealed }));
    expect(sealedDigest({ ...sealed, text: 'Hello there!' })).not.toBe(sealedDigest(sealed));
    expect(sealedDigest({ ...sealed, recipient: 'bob@shop.example' })).not.toBe(sealedDigest(sealed));
  });
});
