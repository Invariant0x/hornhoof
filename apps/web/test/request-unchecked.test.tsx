import { cleanup, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { en } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import type { WaitingRequest } from '../src/types';
import { Requests } from '../src/ui/Requests';
import { REQUESTS } from './api-mock';
import { renderIn, requestProps } from './request-feedback-fixture';

const STRAY = '1'.repeat(40);
const MAIN = '7'.repeat(40);
const RELEASE = 'a'.repeat(40);

/* B2 of #1569: the approval of a release that brings what no check covers, explained in plain words that leave the list
   out. Hornhoof keeps the list apart from those words and shows it where the person approves. */
const RELEASE_CARD: WaitingRequest = {
  ...REQUESTS[1]!,
  explained: 'The release of the turn is ready. Approve it to let it go to main.',
  unchecked: [{ kind: 'commit', commit: STRAY }, { kind: 'holder_off', task: 12 }, { kind: 'unread', base: MAIN, commit: RELEASE }],
};

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('the approval of a release that brings what no check covers', () => {
  it.each([['en', en], ['ru', ru]] as const)('names each of them next to Approve, in %s, whatever the plain words above say', (lang, t) => {
    renderIn(lang, <Requests {...requestProps(RELEASE_CARD)} />);
    const card = screen.getByRole('article', { name: '#10 Payments' });
    const list = within(card).getByRole('region', { name: t.tasks.unchecked.heading(3) });
    expect(within(list).getAllByRole('listitem').map(item => item.textContent)).toEqual([
      t.tasks.unchecked.commit(STRAY), t.tasks.unchecked.holderOff(12), t.tasks.unchecked.unread(MAIN, RELEASE),
    ]);
    expect(list).toHaveTextContent(t.tasks.unchecked.accept);
    expect(list.closest('details')).toBeNull();
    const approve = within(card).getByRole('button', { name: t.tasks.approve });
    expect(list.compareDocumentPosition(approve) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(card).getByText(RELEASE_CARD.explained!)).toBeInTheDocument();
  });

  it('says every kind of what no check covers in plain words of each language', () => {
    const items: NonNullable<WaitingRequest['unchecked']> = [
      { kind: 'no_candidate', task: 3 }, { kind: 'checker', task: 4, commit: RELEASE }, { kind: 'task_unread', task: 5 },
      { kind: 'unpinned', task: 6 }, { kind: 'unstarted', task: 7 }, { kind: 'merge', commit: STRAY },
    ];
    for (const [lang, t] of [['en', en], ['ru', ru]] as const) {
      renderIn(lang, <Requests {...requestProps({ ...RELEASE_CARD, unchecked: items })} />);
      const list = screen.getByRole('region', { name: t.tasks.unchecked.heading(6) });
      expect(within(list).getAllByRole('listitem').map(item => item.textContent)).toEqual([
        t.tasks.unchecked.noCandidate(3), t.tasks.unchecked.checker(4, RELEASE), t.tasks.unchecked.taskUnread(5), t.tasks.unchecked.unpinned(6), t.tasks.unchecked.unstarted(7), t.tasks.unchecked.merge(STRAY),
      ]);
      cleanup();
    }
  });

  it('shows the list to someone who reads the card without answering it, too', () => {
    renderIn('en', <Requests {...requestProps({ ...RELEASE_CARD, canAnswer: false })} />);
    expect(screen.getByRole('region', { name: en.tasks.unchecked.heading(3) })).toHaveTextContent(en.tasks.unchecked.commit(STRAY));
  });

  it('shows no list on an approval that brings nothing unchecked', () => {
    renderIn('en', <Requests {...requestProps({ ...RELEASE_CARD, unchecked: null })} />);
    expect(screen.queryByRole('region', { name: /no check covers/ })).toBeNull();
  });
});
