import { render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { LANGUAGES, LanguageProvider } from '../src/i18n';
import { Subscriptions } from '../src/screens/Subscriptions';
import type { SubView, TokenSum } from '../src/types';
import { MACHINE, ME, SUBS } from './api-mock';
import { lists, openAll, rowOf, waitFor } from './subscriptions-helpers';

/* On a plan's card a number never breaks away from the unit or word it goes with (#1601): a no-break space, U+00A0, joins
   them in every shipped language, while the words still wrap between those pieces. Made-up numbers. */
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const sum = (input: number, output: number, cache: number): TokenSum => ({ input, output, cacheRead: cache, cacheWrite: 0, total: input + output + cache, turns: 3, noData: 0 });
const TOKENS = { today: sum(1200, 300, 40), week: sum(5, 6, 7), month: sum(0, 0, 0), all: sum(2_400_000, 30_000, 900) };

function plan(now: number): SubView {
  const at = (ms: number) => new Date(now + ms).toISOString();
  return {
    ...SUBS[0]!, id: 's-units', agents: [], signedInOnce: true, machines: [MACHINE], tokens: TOKENS,
    limits: { status: 'allowed', complete: true, windows: [
      { name: 'five_hour', utilization: 0.4, resetsAt: at(3 * HOUR + 5 * MINUTE + 30_000) },
      { name: 'seven_day', utilization: 0.1, resetsAt: at((4 * 24 + 14) * HOUR + 30_000) },
    ] },
    limitsUpdatedAt: new Date(now).toISOString(),
  };
}

afterEach(() => localStorage.removeItem('hh-lang'));

describe("a plan card's numbers and their units", () => {
  for (const { id: language } of LANGUAGES) {
    it(`stay together on one line in ${language}, and the words still wrap between them`, async () => {
      localStorage.setItem('hh-lang', language);
      lists({ 'GET /api/subscriptions': [200, { subscriptions: [plan(Date.now())] }] });
      render(<LanguageProvider><Subscriptions me={ME} /></LanguageProvider>);
      await openAll();
      const card = rowOf('Claude');
      await waitFor(() => expect(card.querySelector('.gauge .g-s > span')).not.toBeNull());
      const text = card.textContent ?? '';
      /* A number and the word after it ("14 h", "1 online", "7 days") and a word that names the number before it
         ("на связи: 1") are one piece. */
      expect(text).not.toMatch(/\d \p{L}/u);
      expect(text).not.toMatch(/\p{L}: \d/u);
      for (const piece of card.querySelectorAll('.gauge .g-s > span')) expect(piece.textContent).toMatch(/^\p{L}[\p{L} ]*\u00a0\d/u);
      /* Each reset is pieces of a number and its unit, and between the pieces it still wraps, as "4 days" then "14 h". */
      const durations = [...card.querySelectorAll('.gauge .g-s > bdi bdi[dir="ltr"]')].map(d => d.textContent ?? '');
      expect(durations).toHaveLength(2);
      for (const duration of durations) expect(duration).toMatch(/^\d+\u00a0\p{L}+ \d+\u00a0\p{L}+$/u);
    });
  }
});
