import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import { ImprovementPresentation } from '../src/screens/ImprovementPresentation';
import type { Improvement } from '../src/types';
import { EVIDENCE, PRESENTATION } from './improvement-presentation-fixture';

const ITEM: Improvement = {
  id: 'fixture-ready',
  title: 'Run the node-check utility',
  text: 'Execute `node-check --verbose` and inspect the raw output.',
  seen: 2,
  status: 'open',
  result: null,
  decidedBy: null,
  at: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
  agent: { id: 'fixture-agent', name: 'Fixture collector' },
  department: { id: 'fixture-department', name: 'Fixture operations' },
  presentation: PRESENTATION,
};

function show({ item = ITEM, evidence = [], currentSourceRevision }: { item?: Improvement; evidence?: (typeof EVIDENCE)[]; currentSourceRevision?: string } = {}) {
  return render(
    <LanguageProvider>
      <ImprovementPresentation item={item} headingId={`imp-${item.id}`} evidence={evidence} currentSourceRevision={currentSourceRevision} />
    </LanguageProvider>,
  );
}

function details(): HTMLDetailsElement {
  const element = screen.getByText('Evidence and technical details').closest('details');
  if (!element) throw new Error('Details are missing');
  return element;
}

describe('improvement presentation details', () => {
  it('keeps evidence closed by default and shows its reference, date, author, quote and safe source on request', async () => {
    const user = userEvent.setup();
    const { container } = show({ evidence: [EVIDENCE] });
    expect(details().open).toBe(false);
    await user.click(screen.getByText('Evidence and technical details'));
    expect(details().open).toBe(true);
    expect(details()).toHaveTextContent('ev-1');
    expect(details()).toHaveTextContent(EVIDENCE.author);
    expect(details()).toHaveTextContent(EVIDENCE.quote);
    expect(container.querySelector('time')).toHaveAttribute('datetime', EVIDENCE.at);
    const link = within(details()).getByRole('link', { name: EVIDENCE.sourceRef });
    expect(link).toHaveAttribute('href', EVIDENCE.url);
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noreferrer');
  });

  it('keeps an unsafe source URL inert without removing the source text', async () => {
    const user = userEvent.setup();
    show({ evidence: [{ ...EVIDENCE, url: 'javascript:alert(1)' }] });
    await user.click(screen.getByText('Evidence and technical details'));
    expect(details()).toHaveTextContent(EVIDENCE.sourceRef);
    expect(within(details()).queryByRole('link')).not.toBeInTheDocument();
  });

  it('renders raw HTML in the original as inert text and makes no external request', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      const text = '<img src=x onerror=alert(1)> node-check --verbose';
      const { container } = show({ item: { ...ITEM, text }, evidence: [EVIDENCE] });
      expect(container.querySelector('img')).toBeNull();
      expect(details()).toHaveTextContent(text);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('uses the original and reports both revisions when the source changed', () => {
    show({ currentSourceRevision: 'rev-2' });
    expect(screen.getByRole('heading', { level: 3, name: ITEM.title })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 3, name: PRESENTATION.locales.en.title })).not.toBeInTheDocument();
    expect(screen.getByText('The source changed. This explanation may be out of date.')).toBeInTheDocument();
    expect(screen.queryByText(PRESENTATION.locales.en.observation)).not.toBeInTheDocument();
    expect(details()).toHaveTextContent('Presentation revision: rev-1');
    expect(details()).toHaveTextContent('Current source revision: rev-2');
  });

  it('opens by keyboard, closes on Escape and returns focus to the summary', async () => {
    const user = userEvent.setup();
    show();
    const summary = screen.getByText('Evidence and technical details');
    summary.focus();
    expect(summary).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(details().open).toBe(true);
    await user.keyboard('{Escape}');
    expect(details().open).toBe(false);
    expect(summary).toHaveFocus();
  });

  it('falls back to the original when a locale has no facts array', () => {
    const en = { ...PRESENTATION.locales.en, facts: undefined } as unknown as typeof PRESENTATION.locales.en;
    show({ item: { ...ITEM, presentation: { ...PRESENTATION, locales: { ...PRESENTATION.locales, en } } } });
    expect(screen.getByRole('heading', { level: 3, name: ITEM.title })).toBeInTheDocument();
    expect(screen.getByText('This explanation is not ready in your language yet.')).toBeInTheDocument();
  });

  it('does not show a fact without an evidence reference as ready', () => {
    const en = { ...PRESENTATION.locales.en, facts: [{ text: 'Unlinked synthetic fact.', evidenceIds: [] }] };
    show({ item: { ...ITEM, presentation: { ...PRESENTATION, locales: { ...PRESENTATION.locales, en } } } });
    expect(screen.getByRole('heading', { level: 3, name: ITEM.title })).toBeInTheDocument();
    expect(screen.getByText('This explanation is not ready in your language yet.')).toBeInTheDocument();
    expect(screen.queryByText('Unlinked synthetic fact.')).not.toBeInTheDocument();
  });

  it('hides empty hypotheses and unknowns instead of inventing content', () => {
    const en = { ...PRESENTATION.locales.en, hypotheses: [], unknowns: [] };
    show({ item: { ...ITEM, presentation: { ...PRESENTATION, locales: { ...PRESENTATION.locales, en } } } });
    expect(screen.queryByText('Hypotheses')).not.toBeInTheDocument();
    expect(screen.queryByText('Still unknown')).not.toBeInTheDocument();
  });
});
