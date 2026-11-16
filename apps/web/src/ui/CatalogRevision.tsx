import type { ReactNode } from 'react';
import { useLanguage, useT, type Language } from '../i18n';
import { changes, partsAsTokens, wordsOf, type Piece, type Token } from './catalog-diff';

/* One revision of a catalog entry as a person reads it before they publish it or take it back: what a message would say,
   with the places it fills in marked, in which language, who proposed it and when, and what changed from the revision
   messages use now. The same view in every place the catalog is shown. */

type Part = { kind: 'text'; text: string } | { kind: 'slot'; slotId: string; type: string };
type TemplateValue = { kind: 'template'; locale: string; subject: string | null; parts: Part[] };
export type ShownRevision = { revision: number; summary: string; value: { kind?: string }; createdAt: string; createdBy: { name: string | null } };
export type ShownEntry = { locale: string | null; current: number | null; revisions: ShownRevision[] };

/* Pieces of one line, the dot held to the piece before it, so that no line begins with it. */
export const joined = (pieces: readonly (string | null | undefined | false)[]): string => pieces.filter(Boolean).join(' · ');

export const whenOf = (language: Language, iso: string): string => new Date(iso).toLocaleString(language === 'ru' ? 'ru-RU' : 'en-GB', { dateStyle: 'short', timeStyle: 'short' });

function languageName(locale: string, language: Language): string {
  try {
    return new Intl.DisplayNames([language], { type: 'language' }).of(locale) ?? locale;
  } catch {
    return locale;
  }
}

const templateOf = (value: ShownRevision['value']): TemplateValue | null => (value.kind === 'template' && Array.isArray((value as TemplateValue).parts) ? (value as TemplateValue) : null);

/* The words a comparison takes: a template's subject and text, anything else by its value. */
const subjectOf = (revision: ShownRevision): Token[] => wordsOf(templateOf(revision.value)?.subject ?? '');
const textOf = (revision: ShownRevision): Token[] => {
  const template = templateOf(revision.value);
  return template ? partsAsTokens(template.parts) : wordsOf(revision.summary);
};

function Slot({ type }: { type: string }) {
  const slots = useT().outboundSetup.slots as Record<string, string>;
  return <span className="outbound-slot">{slots[type] ?? type}</span>;
}

function Words({ pieces }: { pieces: readonly Piece[] }) {
  return (
    <>
      {pieces.map((piece, at) => {
        const said = piece.slot === undefined ? piece.text : <Slot type={piece.slot} />;
        if (piece.change === 'added') return <ins key={at}>{said}</ins>;
        if (piece.change === 'removed') return <del key={at}>{said}</del>;
        return <span key={at}>{said}</span>;
      })}
    </>
  );
}

const unchanged = (tokens: readonly Token[]): Piece[] => tokens.map(token => ({ ...token, change: 'same' }));

function Changes({ entry, revision }: { entry: ShownEntry; revision: ShownRevision }) {
  const v = useT().outboundSetup.view;
  const inUse = entry.revisions.find(r => r.revision === entry.current);
  if (!inUse) return <p className="outbound-note">{v.isNew}</p>;
  if (inUse.revision === revision.revision) return <p className="outbound-note">{v.inUseNow}</p>;
  const subject = changes(subjectOf(inUse), subjectOf(revision));
  const text = changes(textOf(inUse), textOf(revision));
  const same = [...subject, ...text].every(piece => piece.change === 'same');
  return (
    <div className="outbound-changes" role="group" aria-label={v.changesFrom(inUse.revision)}>
      <b>{v.changesFrom(inUse.revision)}</b>
      {same ? (
        <p className="outbound-note">{v.same}</p>
      ) : (
        <>
          <small>{v.key}</small>
          {templateOf(revision.value) && <p className="outbound-words"><Words pieces={subject} /></p>}
          <p className="outbound-words"><Words pieces={text} /></p>
        </>
      )}
    </div>
  );
}

export function RevisionView({ id, entry, revision, children }: { id: string; entry: ShownEntry; revision: ShownRevision; children?: ReactNode }) {
  const s = useT().outboundSetup;
  const v = s.view;
  const { language } = useLanguage();
  const template = templateOf(revision.value);
  return (
    <section className="outbound-view" id={id} aria-label={s.revision(revision.revision)}>
      <p className="outbound-meta">
        {entry.locale && <span>{`${v.language}: ${languageName(entry.locale, language)}`}</span>}
        <span>{v.proposed(revision.createdBy.name ?? '', whenOf(language, revision.createdAt))}</span>
      </p>
      {template ? (
        <dl className="outbound-facts">
          <dt>{v.subject}</dt>
          <dd>{template.subject ?? v.noSubject}</dd>
          <dt>{v.text}</dt>
          <dd>
            <p className="outbound-words"><Words pieces={unchanged(partsAsTokens(template.parts))} /></p>
            <small>{v.places}</small>
          </dd>
        </dl>
      ) : (
        <dl className="outbound-facts">
          <dt>{v.value}</dt>
          <dd>{revision.summary}</dd>
        </dl>
      )}
      <Changes entry={entry} revision={revision} />
      {children}
    </section>
  );
}
