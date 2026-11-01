import type { KeyboardEvent } from 'react';
import { useLanguage, useT } from '../i18n';
import type { Improvement, ImprovementEvidence, ImprovementLocale, ImprovementPresentation as Presentation } from '../types';
import { Markdown } from '../ui/Markdown';

function Section({ title, text }: { title: string; text: string }) {
  return (
    <section className="imp-section">
      <h4>{title}</h4>
      <p>{text}</p>
    </section>
  );
}

function TextList({ title, items }: { title: string; items: string[] }) {
  if (!items.length) return null;
  return (
    <section className="imp-section">
      <h4>{title}</h4>
      <ul>{items.map(item => <li key={item}>{item}</li>)}</ul>
    </section>
  );
}

function safeUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? url : null;
  } catch {
    return null;
  }
}

function Source({ source }: { source: ImprovementEvidence }) {
  const href = safeUrl(source.url);
  return href ? <a href={href} target="_blank" rel="noreferrer">{source.sourceRef}</a> : <span>{source.sourceRef}</span>;
}

function onDetailsKey(event: KeyboardEvent<HTMLDetailsElement>) {
  if (event.key === 'Escape') {
    if (!event.currentTarget.open) return;
    event.preventDefault();
    event.currentTarget.open = false;
    event.currentTarget.querySelector('summary')?.focus();
    return;
  }
  if ((event.key === 'Enter' || event.key === ' ') && (event.target as HTMLElement).tagName === 'SUMMARY') {
    event.preventDefault();
    event.currentTarget.open = !event.currentTarget.open;
  }
}

function Evidence({ source }: { source: ImprovementEvidence }) {
  const { language } = useLanguage();
  const when = new Date(source.at).toLocaleString(language === 'ru' ? 'ru-RU' : 'en-GB', { dateStyle: 'short', timeStyle: 'short' });
  return (
    <li className="imp-evidence">
      <div><Source source={source} /> <time dateTime={source.at}>{when}</time></div>
      <p className="imp-evidence-meta"><span>{source.id}</span><span>{source.author}</span></p>
      <blockquote>{source.quote}</blockquote>
    </li>
  );
}

function Details({ item, presentation, evidence, currentSourceRevision }: { item: Improvement; presentation: Presentation; evidence: ImprovementEvidence[]; currentSourceRevision?: string }) {
  const t = useT();
  return (
    <details className="imp-details" onKeyDown={onDetailsKey}>
      <summary>{t.improvements.details}</summary>
      {evidence.length > 0 && (
        <section className="imp-original">
          <h4>{t.improvements.evidence}</h4>
          <ul className="imp-evidence-list">{evidence.map(source => <Evidence key={source.id} source={source} />)}</ul>
        </section>
      )}
      <section className="imp-original">
        <h4>{t.improvements.original}</h4>
        <p>{t.improvements.presentationRevision}: {presentation.sourceRevision}</p>
        {currentSourceRevision && <p>{t.improvements.currentSourceRevision}: {currentSourceRevision}</p>}
        <p className="imp-original-title">{item.title}</p>
        <Markdown text={item.text} />
      </section>
    </details>
  );
}

function linkedFact(fact: ImprovementLocale['facts'][number]): boolean {
  return !!fact.text && Array.isArray(fact.evidenceIds) && fact.evidenceIds.length > 0 && fact.evidenceIds.every(id => !!id);
}

function completeLocale(locale: ImprovementLocale | null | undefined): ImprovementLocale | null {
  if (!locale) return null;
  const textReady = [locale.title, locale.observation, locale.impact, locale.change, locale.expectedResult].every(Boolean);
  const listsReady = [locale.facts, locale.hypotheses, locale.unknowns].every(Array.isArray);
  return textReady && listsReady && locale.facts.every(linkedFact) ? locale : null;
}

function sourceRevisionChanged(presentation: Presentation | null | undefined, current: string | undefined): boolean {
  return !!presentation && current !== undefined && presentation.sourceRevision !== current;
}

function selectedLocale(presentation: Presentation | null | undefined, language: 'en' | 'ru', sourceChanged: boolean): ImprovementLocale | null {
  if (sourceChanged || presentation?.state !== 'ready') return null;
  return completeLocale(presentation.locales[language]);
}

function warningFor(presentation: Presentation | null | undefined, ready: ImprovementLocale | null, sourceChanged: boolean, messages: ReturnType<typeof useT>['improvements']): string | null {
  if (sourceChanged) return messages.sourceChanged;
  if (presentation?.state === 'draft') return messages.draft;
  if (presentation && !ready) return messages.missingLocale;
  return null;
}

function ReadyContent({ locale }: { locale: ImprovementLocale }) {
  const t = useT();
  return (
    <div className="imp-explanation">
      <Section title={t.improvements.observation} text={locale.observation} />
      <Section title={t.improvements.impact} text={locale.impact} />
      <Section title={t.improvements.change} text={locale.change} />
      <Section title={t.improvements.expectedResult} text={locale.expectedResult} />
      <section className="imp-section">
        <h4>{t.improvements.facts}</h4>
        <ul>{locale.facts.map(fact => (
          <li key={fact.text}>
            {fact.text}
            <span className="imp-evidence-refs"> [{fact.evidenceIds.join(', ')}]</span>
          </li>
        ))}</ul>
      </section>
      <TextList title={t.improvements.hypotheses} items={locale.hypotheses} />
      <TextList title={t.improvements.unknowns} items={locale.unknowns} />
    </div>
  );
}

export function ImprovementPresentation({ item, headingId, evidence = [], currentSourceRevision }: { item: Improvement; headingId: string; evidence?: ImprovementEvidence[]; currentSourceRevision?: string }) {
  const t = useT();
  const { language } = useLanguage();
  const presentation = item.presentation;
  const sourceChanged = sourceRevisionChanged(presentation, currentSourceRevision);
  const ready = selectedLocale(presentation, language, sourceChanged);
  const warning = warningFor(presentation, ready, sourceChanged, t.improvements);

  return (
    <>
      <h3 id={headingId}>{ready ? ready.title : item.title}</h3>
      {warning && <p className="imp-notice" role="status">{warning}</p>}
      {ready ? <ReadyContent locale={ready} /> : <div className="imp-text"><Markdown text={item.text} /></div>}
      {presentation && <Details item={item} presentation={presentation} evidence={evidence} currentSourceRevision={currentSourceRevision} />}
    </>
  );
}
