import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import { en } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import { Subscriptions } from '../src/screens/Subscriptions';
import { tokenCount } from '../src/ui/token-count';
import type { SubView } from '../src/types';
import { ME, mockApi, ORG, SUBS } from './api-mock';
import { decl } from './css';

/* What the head of Design asked of Subscriptions & API (#947): neutral marks of how a connection is paid, each with its
   sign; a neutral orchestrator; a Type filter that starts with All; one cell for the two limits of an API; a key the
   person may show while they type it; a short search hint on a phone; and a Tokens part in the reference's words, with
   each model's share and the whole count where a short one stands. */

const sum = (total: number, turns = 3) => ({ input: Math.round(total / 10), output: Math.round(total / 20), cacheRead: total - Math.round(total / 10) - Math.round(total / 20) * 2, cacheWrite: Math.round(total / 20), total, turns, noData: 0 });
const periods = (n: number) => ({ today: sum(n), week: sum(n * 6), month: sum(n * 21), all: sum(n * 40) });
const ROUTER: SubView = {
  ...SUBS[3]!, id: 's-router', provider: 'openrouter', label: 'OpenRouter', last4: 'WXYZ', isOrchestrator: true,
  api: { baseUrl: 'https://openrouter.ai/api', protocol: 'anthropic' }, models: [{ id: 'meta-llama/llama-4-maverick', name: 'Llama 4 Maverick' }], tokens: periods(1_250_000),
};
const LIST = [{ ...SUBS[0]!, tokens: periods(20) }, ROUTER];
const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const MODELS = [{ model: 'meta-llama/llama-4-maverick', total: 19_687_500 }, { model: 'qwen/qwen-3-coder', total: 5_250_000 }, { model: null, total: 1_312_500 }];

const lists = (extra: Parameters<typeof mockApi>[0] = {}) => mockApi({
  'GET /api/nodes/commands': [200, { commands: [] }],
  'GET /api/subscriptions': [200, { subscriptions: LIST }],
  'GET /api/org': [200, ORG],
  [`GET /api/subscriptions/s-router/tokens?zone=${encodeURIComponent(zone)}`]: [200, { tokens: periods(1_250_000), models: MODELS }],
  [`GET /api/subscriptions/${SUBS[0]!.id}/tokens?zone=${encodeURIComponent(zone)}`]: [200, { tokens: periods(20), models: [] }],
  ...extra,
});
const show = (language = 'en') => {
  localStorage.setItem('hh-lang', language);
  render(<LanguageProvider><Subscriptions me={ME} /></LanguageProvider>);
};
/* A row by its connection's name: the plan is Claude, the API ends in WXYZ. */
const row = (text: string) => screen.getByRole('row', { name: text === 'Claude' ? /^Claude$/ : new RegExp(text) });
const openCard = async (text: string) => {
  fireEvent.click(within(row(text)).getByRole('button', { name: /^(Open the card of |Открыть карточку )/ }));
  return screen.findByRole('article', { name: text === 'Claude' ? /^Claude, / : new RegExp(text) });
};

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe('marks of a connection', () => {
  /* Since #1048 a sign by the name, its words its name and tooltip, stands for the word in a badge. */
  it('say how it is paid in a sign by the name with its words, in the quiet ink of the page: color carries no meaning', async () => {
    lists();
    show();
    await screen.findByRole('table');
    for (const [text, kind] of [['Claude', 'personal'], ['WXYZ', 'api_key']] as const) {
      const sign = within(row(text)).getByRole('img', { name: en.subs.kindHint[kind] });
      expect(sign).toHaveClass('pay-sign');
      expect(sign).toHaveAttribute('title', en.subs.kindHint[kind]);
      expect(sign.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
      expect(within(row(text)).queryByText(en.subs.pay[kind])).toBeNull();
      expect(row(text).querySelector('.badge')).toBeNull();
    }
    expect(decl('.pay-sign', 'color')).toBe('var(--muted)');
  });

  /* Since #1048 the orchestrator's role is a small line under the name, not a badge. */
  it('mark the orchestrator in a small line under the name, without the color of attention', async () => {
    lists();
    show();
    await screen.findByRole('table');
    const role = within(row('WXYZ')).getByText('Orchestrator');
    expect(role.tagName).toBe('SMALL');
    expect(role.parentElement).toHaveClass('nm');
    expect(role).not.toHaveClass('badge');
    expect(decl('.nm small', 'color')).toBe('var(--muted)');
    /* Not the orchestrator's window, which is .orch: a mark of its own class takes none of its place on the page. */
    expect(role).not.toHaveClass('orch');
  });
});

describe('the Type filter', () => {
  it.each([['en', 'Type', 'All', 'By tokens'], ['ru', 'Тип', 'Все', 'По токенам']])('in %s starts with All, which shows every connection again', async (language, type, all, tokens) => {
    lists();
    show(language);
    await screen.findByRole('table');
    const group = screen.getByRole('group', { name: type });
    const buttons = within(group).getAllByRole('button');
    expect(buttons[0]).toHaveTextContent(`${all}2`);
    expect(buttons[0]).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(within(group).getByRole('button', { name: new RegExp(`^${tokens}`) }));
    expect(buttons[0]).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getAllByRole('row').slice(1)).toHaveLength(1);
    fireEvent.click(buttons[0]!);
    expect(buttons[0]).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getAllByRole('row').slice(1)).toHaveLength(2);
    expect(group).toHaveClass('whole');
    expect(decl('.fgroup.whole .chipf', 'min-block-size')).toBe('44px');
    expect(decl('.fgroup.whole .chipf[aria-pressed="true"]', 'border-color')).toBe('var(--cyan-ink)');
  });
});

describe('every filter group', () => {
  /* Two owners, three programs and three states: each group shows, and each starts with All. */
  const MIXED = [SUBS[0]!, { ...SUBS[1]!, owner: { id: 'p2', name: 'Maria' } }, SUBS[2]!, ROUTER];
  const groups = (language: 'en' | 'ru') => {
    const t = { en, ru }[language];
    return [
      [t.tables.provider, /^Codex/, 1],
      [t.tables.owner, /^Maria/, 1],
      [t.tables.status, new RegExp(`^${t.subs.states.needs_login}`), 1],
    ] as const;
  };

  it.each(['en', 'ru'] as const)('in %s starts with All N, pressed until a value is, 44 px high and framed in the ink of a link when chosen', async language => {
    lists({ 'GET /api/subscriptions': [200, { subscriptions: MIXED }] });
    show(language);
    await screen.findByRole('table');
    const all = { en, ru }[language].tables.all;
    for (const [label, option, shown] of groups(language)) {
      const group = screen.getByRole('group', { name: label });
      const buttons = within(group).getAllByRole('button');
      expect(group).toHaveClass('whole');
      expect(buttons[0]).toHaveTextContent(`${all}${MIXED.length}`);
      expect(buttons[0]).toHaveAttribute('aria-pressed', 'true');
      fireEvent.click(within(group).getByRole('button', { name: option }));
      expect(buttons[0]).toHaveAttribute('aria-pressed', 'false');
      expect(screen.getAllByRole('row').slice(1)).toHaveLength(shown);
      fireEvent.click(buttons[0]!);
      expect(buttons[0]).toHaveAttribute('aria-pressed', 'true');
      expect(screen.getAllByRole('row').slice(1)).toHaveLength(MIXED.length);
    }
  });

  it("keeps a program's own mark in its button: the sign's lines are for the signs of payment only", async () => {
    lists({ 'GET /api/subscriptions': [200, { subscriptions: MIXED }] });
    show();
    await screen.findByRole('table');
    const provider = screen.getByRole('group', { name: 'Provider' });
    expect(provider.querySelector('svg.pm')).not.toBeNull();
    expect(provider.querySelector('svg.sign')).toBeNull();
    expect(screen.getByRole('group', { name: 'Type' }).querySelectorAll('svg.sign')).toHaveLength(2);
    expect(decl('.fgroup.whole .chipf svg', 'fill')).toBeUndefined();
    expect(decl('.chipf svg.sign', 'fill')).toBe('none');
  });
});

describe('the table of the section', () => {
  it('sorts by every column, the API that used more tokens above the plan', async () => {
    lists();
    show();
    await screen.findByRole('table');
    const headers = screen.getAllByRole('columnheader');
    for (const header of headers) {
      fireEvent.click(within(header).getByRole('button'));
      expect(header).toHaveAttribute('aria-sort', expect.stringMatching(/^(ascending|descending)$/));
      expect(screen.getAllByRole('row').slice(1)).toHaveLength(2);
    }
    const tokens = screen.getByRole('columnheader', { name: /^Tokens, 30 days/ });
    fireEvent.click(within(tokens).getByRole('button'));
    if (tokens.getAttribute('aria-sort') !== 'descending') fireEvent.click(within(tokens).getByRole('button'));
    expect(screen.getAllByRole('row')[1]).toHaveAccessibleName(/WXYZ/);
  });
});

describe('the limits of an API', () => {
  it('say once across both limit columns that it pays as it goes, while a plan keeps a cell for each', async () => {
    lists();
    show();
    await screen.findByRole('table');
    const api = within(row('WXYZ')).getAllByRole('cell');
    const once = api.filter(cell => cell.textContent === 'Pay as you go, no plan limits');
    expect(once).toHaveLength(1);
    expect(once[0]).toHaveAttribute('colspan', '2');
    expect(once[0]).toHaveAttribute('data-label', 'Limits');
    expect(api).toHaveLength(within(row('Claude')).getAllByRole('cell').length - 1);
  });
});

describe('the key of a new API', () => {
  it('shows what the person typed while they ask, and hides it again; a saved key never comes back to show', async () => {
    lists();
    const user = userEvent.setup();
    show();
    await user.click(await screen.findByRole('button', { name: 'Connect an API' }));
    const form = screen.getByRole('form', { name: 'Connect an API' });
    const key = within(form).getByLabelText('API key');
    await user.type(key, 'sk-or-v1-typed-0123456789');
    /* Shown or not, a text field, so no browser fills the person's Hornhoof sign-in into it (#1320); only its mask changes. */
    expect(key).toHaveAttribute('type', 'text');
    expect(key).toHaveClass('secret-masked');
    await user.click(within(form).getByRole('button', { name: 'Show the key' }));
    expect(key).not.toHaveClass('secret-masked');
    expect(key).toHaveValue('sk-or-v1-typed-0123456789');
    await user.click(within(form).getByRole('button', { name: 'Hide the key' }));
    expect(key).toHaveClass('secret-masked');
    expect(key).toHaveAttribute('type', 'text');
    expect(key.closest('.keybox')).not.toBeNull();
    expect(decl('.keybox input', 'min-block-size')).toBe('44px');
    expect(decl('.keybox .show', 'min-block-size')).toBe('44px');
  });
});

describe('the search of the section', () => {
  const narrow = (matches: boolean) => vi.stubGlobal('matchMedia', (query: string) => ({ matches, media: query, addEventListener: () => {}, removeEventListener: () => {} }));

  it.each([['en', 'Search connections'], ['ru', 'Поиск подключений']])('in %s asks in short on a phone, and in full where it fits', async (language, short) => {
    narrow(true);
    lists();
    show(language);
    expect(await screen.findByRole('searchbox')).toHaveAttribute('placeholder', short);
  });

  it('keeps the whole hint on a wide screen', async () => {
    narrow(false);
    lists();
    show();
    expect(await screen.findByRole('searchbox')).toHaveAttribute('placeholder', 'Search by plan, owner, agent or machine');
  });
});

describe('the Tokens part of an open card', () => {
  const n = (language: string, value: number) => new Intl.NumberFormat(language).format(value);

  it.each([
    ['en', 'Input', 'Output', 'Cache', 'tokens', 'By model, 30 days', 'Default model'],
    ['ru', 'Ввод', 'Вывод', 'Кэш', 'токенов', 'По моделям за 30 дней', 'Модель по умолчанию'],
  ])('in %s names in, out and cache as the reference does, gives each tile its whole count, and splits 30 days by model', async (language, input, output, cache, tokens, byModel, defaultModel) => {
    lists();
    show(language);
    await screen.findByRole('table');
    const card = await openCard('WXYZ');
    const part = await waitFor(() => {
      const found = [...card.querySelectorAll('.blk-facts .part')].find(p => p.querySelector('.models'));
      expect(found).toBeDefined();
      return found as HTMLElement;
    });
    const today = periods(1_250_000).today;
    const tile = within(part).getByRole('group', { name: new RegExp(`${n(language, today.total)} ${tokens}`) });
    expect(tile).toHaveAttribute('title', `${n(language, today.total)} ${tokens}`);
    expect(tile.textContent).toContain(`${input} ${n(language, today.input)}`);
    expect(tile.textContent).toContain(`${output} ${n(language, today.output)}`);
    expect(tile.textContent).toMatch(new RegExp(`${cache} `));
    expect(within(part).getAllByRole('group', { name: new RegExp(` ${tokens}$`) })).toHaveLength(4);

    const models = part.querySelector('.models')!;
    expect(models.textContent).toContain(byModel);
    const rows = [...models.querySelectorAll('li')];
    expect(rows.map(r => r.querySelector('.mname')!.textContent)).toEqual(['Llama 4 Maverick', 'qwen/qwen-3-coder', defaultModel]);
    expect(rows[0]!.textContent).toContain(n(language, 19_687_500));
    expect(rows[0]!.textContent).toContain(new Intl.NumberFormat(language, { style: 'percent' }).format(0.75));
    expect(rows[0]!.querySelector<HTMLElement>('.bar i')!.style.inlineSize).toBe('75%');
    expect(decl('.models .bar i', 'background')).toBe('var(--cyan-ink)');
  });

  it('shows no split by model, nor its frame, where no turn told its model', async () => {
    lists();
    show();
    await screen.findByRole('table');
    const card = await openCard('Claude');
    await waitFor(() => expect(card.querySelectorAll('.blk-facts .gauge').length).toBeGreaterThan(0));
    expect(card.querySelector('.models')).toBeNull();
  });

  /* Design #1053: a page laid out right to left read a count unit first, «млн 25» for «25 млн», and a tile's name «дней 7».
     Each count and each tile's name is one piece that reads left to right, and the words by a count stay outside that
     piece, so they stand mirrored. */
  it.each([['en', 'Tokens, 30 days'], ['ru', 'Токены, 30 дней']])('in %s holds each token count and each model share in one piece read left to right', async (language, column) => {
    lists();
    show(language);
    await screen.findByRole('table');
    const cell = row('WXYZ').querySelector(`td[data-label="${column}"]`)!;
    const card = await openCard('WXYZ');
    const part = await waitFor(() => {
      const found = [...card.querySelectorAll('.blk-facts .part')].find(p => p.querySelector('.models'));
      expect(found).toBeDefined();
      return found as HTMLElement;
    });
    const pieces = (el: Element) => [...el.querySelectorAll('bdi')].map(b => `${b.getAttribute('dir')} ${b.textContent}`);
    const counts = periods(1_250_000);
    expect(pieces(cell)).toEqual([`ltr ${tokenCount(language, ROUTER.tokens!.month.total)}`]);
    const words = language === 'en' ? en.subs.tokens : ru.subs.tokens;
    expect([...part.querySelectorAll('.g-l')].map(pieces)).toEqual((['today', 'week', 'month', 'all'] as const).map(p => [`ltr ${words[p]}`]));
    expect([...part.querySelectorAll('.g-f b')].map(pieces)).toEqual((['today', 'week', 'month', 'all'] as const).map(p => [`ltr ${tokenCount(language, counts[p].total)}`]));
    const today = [...part.querySelectorAll('.gauge')][0]!;
    const lines = [...today.querySelectorAll('.g-s > span')];
    expect(lines.map(pieces)).toEqual([counts.today.input, counts.today.output, counts.today.cacheRead + counts.today.cacheWrite].map(c => [`ltr ${tokenCount(language, c)}`]));
    for (const line of lines) expect(line.lastChild?.nodeName, line.textContent!).toBe('BDI');
    const share = new Intl.NumberFormat(language, { style: 'percent' });
    expect([...part.querySelectorAll('.models .dd')].map(pieces)).toEqual(MODELS.map(m => [`ltr ${n(language, m.total)}`, `ltr ${share.format(m.total / 26_250_000)}`]));
  });
});
