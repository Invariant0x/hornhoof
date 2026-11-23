import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import { Subscriptions } from '../src/screens/Subscriptions';
import type { Me, SubView } from '../src/types';
import { ME, mockApi, ORG, ORG_WITH_TEAMS, SUBS } from './api-mock';

/* One section holds the plans and the APIs paid by the token: each says how it is paid, the table filters by it and shows
   what each used, and an open card shows its tokens next to its limits. Company scope connects any API and changes it. */

const sum = (total: number) => ({ input: total / 2, output: total / 10, cacheRead: total / 4, cacheWrite: total / 20, total, turns: 3, noData: 1 });
const periods = (n: number) => ({ today: sum(n), week: sum(n * 2), month: sum(n * 4), all: sum(n * 10) });
const ROUTER: SubView = {
  ...SUBS[3]!, id: 's-router', provider: 'openrouter', label: 'OpenRouter', last4: 'WXYZ', isOrchestrator: false,
  api: { baseUrl: 'https://openrouter.ai/api', protocol: 'anthropic' }, models: [{ id: 'meta-llama/llama-4-maverick', name: 'Llama 4 Maverick' }], tokens: periods(1000),
};
const LIST = [{ ...SUBS[0]!, tokens: periods(20) }, { ...SUBS[3]!, tokens: periods(0) }, ROUTER];
const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const n = (language: string, value: number) => new Intl.NumberFormat(language).format(value);

const lists = (extra: Parameters<typeof mockApi>[0] = {}) => mockApi({
  'GET /api/nodes/commands': [200, { commands: [] }],
  'GET /api/subscriptions': [200, { subscriptions: LIST }],
  'GET /api/org': [200, ORG],
  [`GET /api/subscriptions/s-router/tokens?zone=${encodeURIComponent(zone)}`]: [200, { tokens: periods(1000) }],
  ...extra,
});

afterEach(() => localStorage.clear());

/* A plan's own row, once it came: while the plans load, the table holds rows of its own. */
const planRow = (last4: string) => waitFor(() => {
  const found = screen.getAllByRole('row').find(r => r.textContent!.includes(last4));
  expect(found).toBeDefined();
  return found!;
});

describe('Subscriptions & API', () => {
  it.each([
    ['en', 'Subscriptions & API', 'Personal plan, paid by subscription', 'API key, paid by tokens', 'By tokens', 'Type'],
    ['ru', 'Подписки и API', 'Личная подписка, оплата по тарифу', 'API-ключ, оплата по токенам', 'По токенам', 'Тип'],
  ])('names the section in %s, marks how each connection is paid by a sign with its words and filters by it', async (language, heading, plan, key, tokens, payment) => {
    localStorage.setItem('hh-lang', language);
    lists();
    render(<LanguageProvider><Subscriptions me={ME} /></LanguageProvider>);
    expect(await screen.findByRole('heading', { level: 1, name: heading })).toBeInTheDocument();
    const rows = () => screen.getAllByRole('row').slice(1);
    expect(within(screen.getByRole('row', { name: /^Claude\b/ })).getByRole('img', { name: plan })).toHaveAttribute('title', plan);
    expect(within(rows().find(r => r.textContent!.includes('WXYZ'))!).getByRole('img', { name: key })).toHaveAttribute('title', key);
    expect(rows().map(r => r.textContent!.includes(tokens))).toEqual(rows().map(() => false));
    fireEvent.click(within(screen.getByRole('group', { name: payment })).getByRole('button', { name: new RegExp(`^${tokens}`) }));
    expect(rows().map(r => within(r).queryByRole('img', { name: key }) !== null)).toEqual([true, true]);
  });

  it.each([['en', 'Tokens, 30 days', 'Tokens', 'Today', '7\u00a0days', '30\u00a0days', 'All time', 'Input', 'turn told no tokens'], ['ru', 'Токены, 30 дней', 'Токены', 'Сегодня', '7\u00a0дней', '30\u00a0дней', 'Всего', 'Ввод', 'ход без данных']])(
    'shows in %s what each used in 30 days, and in the open card today, 7 and 30 days and all along', async (language, column, title, today, week, month, all, input, noData) => {
      localStorage.setItem('hh-lang', language);
      const calls = lists();
      render(<LanguageProvider><Subscriptions me={ME} /></LanguageProvider>);
      await screen.findByRole('table');
      expect(screen.getByRole('columnheader', { name: new RegExp(column) })).toBeInTheDocument();
      const row = screen.getAllByRole('row').find(r => r.textContent!.includes('WXYZ'))!;
      expect(row.textContent).toContain(n(language, 4000));
      fireEvent.click(within(row).getByRole('button', { name: /^(Open the card of |Открыть карточку )/ }));
      const card = await screen.findByRole('article', { name: /WXYZ/ });
      const part = [...card.querySelectorAll('.blk-facts .part')].find(p => p.querySelector('.part-h')?.textContent === title)!;
      expect(part).toBeDefined();
      await waitFor(() => expect(calls.some(c => c.path.startsWith('/api/subscriptions/s-router/tokens?zone='))).toBe(true));
      const gauges = [...part.querySelectorAll('.gauge')].map(g => g.textContent);
      expect(gauges).toHaveLength(4);
      for (const [i, [label, total]] of ([[today, 1000], [week, 2000], [month, 4000], [all, 10_000]] as const).entries()) {
        expect(gauges[i]).toContain(label);
        expect(gauges[i]).toContain(n(language, total));
      }
      expect(gauges[0]).toContain(`${input}\u00a0${n(language, 500)}`);
      expect(part.textContent).toContain(noData);
    },
  );

  it('marks each API with the program it runs in: Claude Code in the Anthropic protocol, Codex in the OpenAI one', async () => {
    const acme: SubView = { ...ROUTER, id: 's-acme', provider: 'custom_api', label: 'Acme LLM', last4: 'M3N4', api: { baseUrl: 'https://llm.acme.example/v1', protocol: 'openai' } };
    const codexRouter: SubView = { ...ROUTER, id: 's-router-codex', last4: 'QRST', api: { baseUrl: 'https://openrouter.ai/api/v1', protocol: 'openai' } };
    lists({ 'GET /api/subscriptions': [200, { subscriptions: [ROUTER, acme, codexRouter] }] });
    render(<LanguageProvider><Subscriptions me={ME} /></LanguageProvider>);
    await screen.findByRole('table');
    /* The program's mark comes first in a row, before the sign of how it is paid. */
    const mark = (last4: string) => within(screen.getAllByRole('row').find(r => r.textContent!.includes(last4))!).getAllByRole('img')[0]!.getAttribute('aria-label');
    expect([mark('WXYZ'), mark('M3N4'), mark('QRST')]).toEqual(['Claude', 'Codex', 'Codex']);
  });

  it('connects OpenRouter with the models it lists, the key going only to the server', async () => {
    const calls = lists({
      'POST /api/subscriptions/models': [200, { models: [{ id: 'anthropic/claude-sonnet-4.5', name: 'Anthropic: Claude Sonnet 4.5' }, { id: 'meta-llama/llama-4-maverick', name: 'Meta: Llama 4 Maverick' }] }],
      'POST /api/subscriptions': [201, { subscription: ROUTER }],
    });
    const user = userEvent.setup();
    render(<LanguageProvider><Subscriptions me={ME} /></LanguageProvider>);
    await user.click(await screen.findByRole('button', { name: 'Connect an API' }));
    const form = screen.getByRole('form', { name: 'Connect an API' });
    await user.selectOptions(within(form).getByLabelText('Service'), 'openrouter');
    await user.type(within(form).getByLabelText('Name'), 'OpenRouter');
    await user.type(within(form).getByLabelText('API key'), 'sk-or-v1-key-0123456789');
    expect(within(form).queryByLabelText('Address')).toBeNull();
    expect(within(form).getByLabelText('API key')).toHaveAccessibleDescription('Kept encrypted. Only its last 4 characters are ever shown.');
    expect(screen.getAllByText(/last 4 characters/)).toHaveLength(1);
    await user.click(within(form).getByRole('button', { name: 'Load from the API' }));
    await user.click(await within(form).findByRole('checkbox', { name: 'Meta: Llama 4 Maverick' }));
    await user.selectOptions(within(form).getByLabelText('Serves'), 'orchestrator');
    await user.click(within(form).getByRole('button', { name: 'Connect' }));
    await waitFor(() => expect(calls.some(c => c.method === 'POST' && c.path === '/api/subscriptions')).toBe(true));
    expect(calls.find(c => c.path === '/api/subscriptions/models')!.body).toEqual({ provider: 'openrouter', apiKey: 'sk-or-v1-key-0123456789' });
    expect(calls.find(c => c.method === 'POST' && c.path === '/api/subscriptions')!.body).toEqual({
      kind: 'api_key', provider: 'openrouter', label: 'OpenRouter', apiKey: 'sk-or-v1-key-0123456789', target: { kind: 'orchestrator' }, protocol: 'anthropic',
      models: [{ id: 'meta-llama/llama-4-maverick', name: 'Meta: Llama 4 Maverick' }],
    });
  });

  it('connects a compatible API at its address and in its protocol, with a model id written by hand', async () => {
    const calls = lists({ 'POST /api/subscriptions': [201, { subscription: { ...ROUTER, provider: 'custom_api' } }] });
    const user = userEvent.setup();
    render(<LanguageProvider><Subscriptions me={ME} /></LanguageProvider>);
    await user.click(await screen.findByRole('button', { name: 'Connect an API' }));
    const form = screen.getByRole('form', { name: 'Connect an API' });
    await user.selectOptions(within(form).getByLabelText('Service'), 'custom_api');
    await user.type(within(form).getByLabelText('Name'), 'Acme LLM');
    await user.type(within(form).getByLabelText('API key'), 'acme-key-0123456789');
    await user.type(within(form).getByLabelText('Address'), 'https://llm.acme.example/v1');
    await user.selectOptions(within(form).getByLabelText('Protocol'), 'openai');
    await user.type(within(form).getByLabelText('Model id'), 'llama-4-maverick');
    await user.click(within(form).getByRole('button', { name: 'Add' }));
    await user.click(within(form).getByRole('button', { name: 'Connect' }));
    await waitFor(() => expect(calls.some(c => c.method === 'POST' && c.path === '/api/subscriptions')).toBe(true));
    expect(calls.find(c => c.method === 'POST' && c.path === '/api/subscriptions')!.body).toEqual({
      kind: 'api_key', provider: 'custom_api', label: 'Acme LLM', apiKey: 'acme-key-0123456789', target: { kind: 'any' }, baseUrl: 'https://llm.acme.example/v1', protocol: 'openai',
      models: [{ id: 'llama-4-maverick', name: 'llama-4-maverick' }],
    });
  });

  it("changes a connection's name, models and reach with its own key, which the form never asks for again", async () => {
    const calls = lists({
      'POST /api/subscriptions/s-router/models': [200, { models: [{ id: 'qwen/qwen-3-coder', name: 'Qwen 3 Coder' }] }],
      'PATCH /api/subscriptions/s-router': [200, { subscription: { ...ROUTER, label: 'Router' } }],
    });
    const user = userEvent.setup();
    render(<LanguageProvider><Subscriptions me={ME} /></LanguageProvider>);
    const row = await planRow('WXYZ');
    fireEvent.click(within(row).getByRole('button', { name: /^(Open the card of |Открыть карточку )/ }));
    const card = await screen.findByRole('article', { name: /WXYZ/ });
    await user.click(within(card).getByRole('button', { name: /^Edit / }));
    const form = within(card).getByRole('form', { name: /^Edit / });
    expect(within(form).queryByLabelText('API key')).toBeNull();
    const name = within(form).getByLabelText('Name');
    await user.clear(name);
    await user.type(name, 'Router');
    await user.click(within(form).getByRole('button', { name: 'Load from the API' }));
    await user.click(await within(form).findByRole('checkbox', { name: 'Qwen 3 Coder' }));
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Do you really want to update this API connection?' });
    expect(dialog).toHaveAccessibleDescription('OpenRouter key ending WXYZ will be renamed to Router.');
    expect(within(dialog).getByText('OpenRouter key ending WXYZ').tagName).toBe('BDI');
    expect(within(dialog).getByText('Router').tagName).toBe('BDI');
    expect(within(dialog).getByRole('button', { name: 'Save changes' })).toHaveFocus();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(calls.some(c => c.method === 'PATCH')).toBe(false);
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(calls.some(c => c.method === 'PATCH')).toBe(true));
    expect(calls.find(c => c.method === 'PATCH')!.body).toEqual({
      label: 'Router', target: { kind: 'any' },
      models: [{ id: 'meta-llama/llama-4-maverick', name: 'Llama 4 Maverick' }, { id: 'qwen/qwen-3-coder', name: 'Qwen 3 Coder' }],
    });
  });

  it('confirms target change on an existing API connection and saves model-only changes directly', async () => {
    const calls = lists({
      'GET /api/org': [200, ORG_WITH_TEAMS],
      'PATCH /api/subscriptions/s-router': [200, { subscription: { ...ROUTER, target: { kind: 'team', id: 't1' } } }],
    });
    const user = userEvent.setup();
    render(<LanguageProvider><Subscriptions me={ME} /></LanguageProvider>);
    const row = await planRow('WXYZ');
    fireEvent.click(within(row).getByRole('button', { name: /^(Open the card of |Открыть карточку )/ }));
    const card = await screen.findByRole('article', { name: /WXYZ/ });
    await user.click(within(card).getByRole('button', { name: /^Edit / }));
    const form = within(card).getByRole('form', { name: /^Edit / });
    await user.type(within(form).getByLabelText('Model id'), 'claude-sonnet');
    await user.click(within(form).getByRole('button', { name: 'Add' }));
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    await waitFor(() => expect(calls.filter(c => c.method === 'PATCH')).toHaveLength(1));

    await user.click(within(card).getByRole('button', { name: /^Edit / }));
    const again = within(card).getByRole('form', { name: /^Edit / });
    await user.selectOptions(within(again).getByLabelText('Serves'), 'team:t1');
    await user.click(within(again).getByRole('button', { name: 'Save' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Do you really want to update this API connection?' });
    expect(dialog).toHaveAccessibleDescription('OpenRouter key ending WXYZ will serve Marketing, Social.');
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(calls.filter(c => c.method === 'PATCH')).toHaveLength(2));
  });

  describe('for a person who runs a department', () => {
    const DANA: Me = { person: { ...ME.person, id: 'p2', name: 'Dana', email: 'dana@acme.com', title: 'CMO', scopeKind: 'listed', isOwner: false }, company: ME.company };
    const KEY: SubView = { ...ROUTER, id: 's-mkt', label: 'Marketing key', last4: 'MKT1', owner: { id: 'p1', name: 'Ivan' }, place: { kind: 'department', id: 'd1', name: 'Marketing' }, target: { kind: 'department', id: 'd1' }, canChange: true };
    const card = async (last4: string) => {
      const row = await planRow(last4);
      fireEvent.click(within(row).getByRole('button', { name: /^(Open the card of |Открыть карточку )/ }));
      return screen.findByRole('article', { name: new RegExp(last4) });
    };

    it('connects an API key only in that department, and changes and removes the one that serves it', async () => {
      lists({ 'GET /api/subscriptions': [200, { subscriptions: [KEY], apiPlaces: ['d1'] }], 'GET /api/org': [200, ORG_WITH_TEAMS] });
      const user = userEvent.setup();
      render(<LanguageProvider><Subscriptions me={DANA} /></LanguageProvider>);
      const open = await card('MKT1');
      expect(within(open).getByRole('button', { name: /^Edit / })).toBeInTheDocument();
      expect(within(open).getByRole('button', { name: /^Remove / })).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Connect an API' }));
      const form = screen.getAllByRole('form').find(f => !open.contains(f))!;
      const serves = within(form).getByRole('combobox', { name: 'Serves' });
      expect((await within(serves).findAllByRole('option')).map(o => o.textContent)).toEqual(['Marketing', 'Marketing, Social', 'Marketing, Content']);
      expect(serves).toHaveValue('department:d1');
    });

    it('offers no API key to connect or change where they run nothing', async () => {
      lists({ 'GET /api/subscriptions': [200, { subscriptions: [{ ...KEY, canChange: false }], apiPlaces: [] }] });
      render(<LanguageProvider><Subscriptions me={DANA} /></LanguageProvider>);
      const open = await card('MKT1');
      expect(within(open).queryByRole('button', { name: /^Edit / })).toBeNull();
      expect(within(open).queryByRole('button', { name: /^Remove / })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Connect an API' })).toBeNull();
    });
  });
});
