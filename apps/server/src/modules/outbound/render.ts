import { ContactFieldValue, SENDER_FIELDS } from '@hornhoof/protocol';
import type { CatalogValue, GateCode, MessageDocument } from '@hornhoof/protocol';
import { catalogValue, checkPrice, digestOf, formatMoney, scanText, unsafeLink, usable, type Catalog, type Money, type Place, type Source } from './checks.js';

/* A message is rendered by the server from approved parts and nothing else: the author names a template, blocks and fields,
   and every byte comes from the catalog. Failures come as codes, the same in every language. */

type TemplateValue = Extract<CatalogValue, { kind: 'template' }>;
type Part = TemplateValue['parts'][number];
type Slot = Extract<Part, { kind: 'slot' }>;
type BlockKind = MessageDocument['blocks'][number]['kind'];
type Block = MessageDocument['blocks'][number];

export type RenderRequest = {
  document: MessageDocument;
  place: Place;
  audience: 'direct' | 'public';
  catalog: Catalog;
  /* The published words of this language and the signed address, when there are any. */
  unsubscribe: { source: Source | null; url: string | null };
  /* Sender fields and this department's private values for the selected contact. */
  fields: Readonly<Record<string, string>>;
  now: Date;
};
export type SourceRef = { entryId: string; revision: number; digest: string };
export type Rendered = { subject: string; text: string; sources: SourceRef[]; sourceRevisionsDigest: string; money: Money[] };
type RenderResult = { ok: true; rendered: Rendered } | { ok: false; reasonCodes: GateCode[] };

const BLOCK_REFUSAL: Record<BlockKind, GateCode> = { price: 'price_unapproved', link: 'link_unapproved', claim: 'claim_unapproved', knowledge: 'claim_unapproved' };

/* One render's notes: the codes so far and the revisions it rests on. All failures come at once. */
type Notes = { reasons: Set<GateCode>; sources: Map<string, Source>; money: Money[] };
type Filler = (slot: Slot) => string | null;

const refuse = (notes: Notes, code: GateCode): null => {
  notes.reasons.add(code);
  return null;
};
const used = (notes: Notes, source: Source): void => void notes.sources.set(source.entryId, source);

/* Words of the catalog, after what no words may carry was looked for. */
function clean(notes: Notes, text: string): string {
  for (const code of scanText(text)) notes.reasons.add(code);
  return text;
}

const sameLanguage = (source: Source, locale: string): boolean => source.locale === locale;

/* The usable words of a claim or a piece of knowledge a block names. */
function wordsOf(block: Block, kind: 'claim' | 'knowledge', request: RenderRequest, notes: Notes): string | null {
  const source = request.catalog(block.id);
  const value = source && source.revision === block.revision && usable(source, request.place, request.now) ? catalogValue(source, kind) : null;
  if (!source || !value) return refuse(notes, BLOCK_REFUSAL[kind]);
  if (!sameLanguage(source, request.document.locale)) return refuse(notes, 'unsupported_locale');
  used(notes, source);
  return clean(notes, value.text);
}

function linkOf(block: Block, request: RenderRequest, notes: Notes): string | null {
  const source = request.catalog(block.id);
  const value = source && source.revision === block.revision && usable(source, request.place, request.now) ? catalogValue(source, 'link') : null;
  if (!source || !value || unsafeLink(value.url)) return refuse(notes, 'link_unapproved');
  used(notes, source);
  return value.url;
}

/* The price in this language, and its terms waiting for a terms slot. */
function priceOf(block: Block, request: RenderRequest, notes: Notes, terms: Source[]): string | null {
  const checked = checkPrice(block, request.catalog, { place: request.place, now: request.now, locale: request.document.locale });
  if (!checked.ok) {
    for (const code of checked.reasonCodes) notes.reasons.add(code);
    return null;
  }
  checked.sources.forEach(source => used(notes, source));
  notes.money.push(checked.money);
  if (checked.terms) terms.push(checked.terms);
  return formatMoney(checked.money, request.document.locale);
}

const fillBlock = (block: Block, request: RenderRequest, notes: Notes, terms: Source[]): string | null => {
  if (block.kind === 'price') return priceOf(block, request, notes, terms);
  if (block.kind === 'link') return linkOf(block, request, notes);
  return wordsOf(block, block.kind, request, notes);
};

/* A template's blocks fill its slots of their kind in order; the count of each must match exactly. */
function blockFillers(template: TemplateValue, request: RenderRequest, notes: Notes, terms: Source[]): Map<string, string | null> {
  const fills = new Map<string, string | null>();
  for (const kind of Object.keys(BLOCK_REFUSAL) as BlockKind[]) {
    const slots = template.parts.filter((p): p is Slot => p.kind === 'slot' && p.type === kind);
    const blocks = request.document.blocks.filter(b => b.kind === kind);
    if (slots.length !== blocks.length) refuse(notes, 'template_unapproved');
    slots.forEach((slot, i) => fills.set(slot.slotId, blocks[i] ? fillBlock(blocks[i], request, notes, terms) : null));
  }
  return fills;
}

const distinct = <T>(values: readonly T[]): boolean => new Set(values).size === values.length;

/* Each block once: the same entry named twice would say one thing twice as if it were two. */
function noRepeats(request: RenderRequest, notes: Notes): void {
  if (!distinct(request.document.blocks.map(b => b.id))) refuse(notes, 'template_unapproved');
}

/* Terms slots show the terms of the prices in the message: every one of them, so that none is hidden. */
function termsFillers(template: TemplateValue, terms: readonly Source[], notes: Notes): Map<string, string | null> {
  const slots = template.parts.filter((p): p is Slot => p.kind === 'slot' && p.type === 'terms');
  if (slots.length > terms.length) refuse(notes, 'template_unapproved');
  if (slots.length < terms.length) refuse(notes, 'terms_unapproved');
  return new Map(slots.map((slot, i) => [slot.slotId, termsWords(terms[i], notes)]));
}
function termsWords(source: Source | undefined, notes: Notes): string | null {
  const value = source && catalogValue(source, 'terms');
  return value ? clean(notes, value.text) : null;
}

function fieldValue(valueRef: string, request: RenderRequest, notes: Notes): string | null {
  const source = request.catalog(valueRef);
  const value = source && usable(source, request.place, request.now) ? catalogValue(source, 'variable') : null;
  if (!value) return refuse(notes, 'template_unapproved');
  const contact = !(SENDER_FIELDS as readonly string[]).includes(value.field);
  const said = Object.hasOwn(request.fields, value.field) ? request.fields[value.field] : undefined;
  if (said === undefined) return refuse(notes, contact ? 'contact_field_missing' : 'template_unapproved');
  if (!ContactFieldValue.safeParse(said).success) return refuse(notes, contact ? 'contact_field_invalid' : 'template_unapproved');
  return said;
}

/* Variables name a slot and an approved field. A value is one short plain line, and it gets no way to be more. */
function variableFillers(template: TemplateValue, request: RenderRequest, notes: Notes): Map<string, string | null> {
  const slots = template.parts.filter((p): p is Slot => p.kind === 'slot' && p.type === 'variable').map(s => s.slotId);
  const refs = request.document.variables;
  const matches = slots.length === refs.length && distinct(refs.map(r => r.slotId)) && refs.every(r => slots.includes(r.slotId));
  if (!matches) refuse(notes, 'template_unapproved');
  return new Map(refs.map(ref => [ref.slotId, variableWords(ref.valueRef, request, notes)]));
}
function variableWords(valueRef: string, request: RenderRequest, notes: Notes): string | null {
  const said = fieldValue(valueRef, request, notes);
  if (said === null) return null;
  used(notes, request.catalog(valueRef)!);
  return clean(notes, said);
}

/* A direct message always says how to stop them, in its own language; a public post has nobody to unsubscribe. */
function unsubscribeWords(template: TemplateValue, request: RenderRequest, notes: Notes): Map<string, string | null> {
  const slots = template.parts.filter((p): p is Slot => p.kind === 'slot' && p.type === 'unsubscribe');
  if (request.audience === 'public') {
    if (slots.length) refuse(notes, 'template_unapproved');
    return new Map();
  }
  if (slots.length !== 1) refuse(notes, 'template_unapproved');
  const words = theStopLine(request, notes);
  return new Map(slots.map(slot => [slot.slotId, words]));
}
function theStopLine(request: RenderRequest, notes: Notes): string | null {
  const { source, url } = request.unsubscribe;
  if (!source) return refuse(notes, 'unsupported_locale');
  if (!sameLanguage(source, request.document.locale)) return refuse(notes, 'unsupported_locale');
  const value = usable(source, request.place, request.now) ? catalogValue(source, 'unsubscribe') : null;
  if (!value || !url) return refuse(notes, 'template_unapproved');
  used(notes, source);
  return `${clean(notes, value.text).trimEnd()} ${url}`;
}

/* The template a document names, at that revision and in that language. */
function theTemplate(request: RenderRequest, notes: Notes): TemplateValue | null {
  const { document, catalog, place, now } = request;
  const source = catalog(document.templateId);
  const value = source && source.revision === document.templateRevision && usable(source, place, now) ? catalogValue(source, 'template') : null;
  if (!source || !value) return refuse(notes, 'template_unapproved');
  if (!sameLanguage(source, document.locale)) refuse(notes, 'unsupported_locale');
  used(notes, source);
  return value;
}

const scanTemplate = (template: TemplateValue, notes: Notes): void => {
  for (const part of template.parts) if (part.kind === 'text') clean(notes, part.text);
  if (template.subject) clean(notes, template.subject);
};

/* Every slot's filler, by slot id, from all that can fill one. */
function fillers(template: TemplateValue, request: RenderRequest, notes: Notes): Filler {
  const terms: Source[] = [];
  noRepeats(request, notes);
  const blocks = blockFillers(template, request, notes, terms);
  const all = new Map([...blocks, ...termsFillers(template, terms, notes), ...variableFillers(template, request, notes), ...unsubscribeWords(template, request, notes)]);
  return slot => all.get(slot.slotId) ?? null;
}

const refsOf = (notes: Notes): SourceRef[] => [...notes.sources.values()].map(s => ({ entryId: s.entryId, revision: s.revision, digest: s.digest })).sort((a, b) => a.entryId.localeCompare(b.entryId));
const orderedReasons = (notes: Notes): GateCode[] => [...notes.reasons].sort();

/* The digest of what a message rests on: a new revision of any of them gives another. */
export const sourcesDigest = (sources: readonly SourceRef[]): string => digestOf(sources);

function written(template: TemplateValue, fill: Filler): string {
  return template.parts.map(part => (part.kind === 'text' ? part.text : (fill(part) ?? ''))).join('');
}

export function renderMessage(request: RenderRequest): RenderResult {
  const notes: Notes = { reasons: new Set(), sources: new Map(), money: [] };
  const template = theTemplate(request, notes);
  if (!template) return { ok: false, reasonCodes: orderedReasons(notes) };
  scanTemplate(template, notes);
  const text = written(template, fillers(template, request, notes));
  if (notes.reasons.size) return { ok: false, reasonCodes: orderedReasons(notes) };
  const sources = refsOf(notes);
  return { ok: true, rendered: { subject: template.subject ?? '', text, sources, sourceRevisionsDigest: sourcesDigest(sources), money: notes.money } };
}

/* What an approval and a review are of: the exact bytes, who they go to and from whom, in what language and when, and what
   they rest on. Any change is another digest, so that nothing approved can be edited afterwards. */
export type Frozen = {
  subject: string; text: string; recipientDigest: string; accountId: string; channelId: string; purpose: string; locale: string; segmentId: string | null;
  scheduledAt: string; sourceRevisionsDigest: string; bindingGeneration: number;
};
export const frozenDigest = (frozen: Frozen): string => digestOf(frozen);
