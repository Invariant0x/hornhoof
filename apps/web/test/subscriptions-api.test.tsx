import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import { Subscriptions } from '../src/screens/Subscriptions';
import type { SubView } from '../src/types';
import { ME, mockApi, ORG, SUBS } from './api-mock';

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

describe('Subscriptions & API', () => {
  it.each([
    ['en', 'Subscriptions & API', 'By subscription', 'By tokens', 'Payment'],
    ['ru', 'Подписки и API', 'По подписке', 'По токенам', 'Оплата'],
  ])('names the section in %s, marks how each connection is paid and filters by it', async (language, heading, plan, tokens, payment) => {
    localStorage.setItem('hh-lang', language);
    lists();
    render(<LanguageProvider><Subscriptions me={ME} /></LanguageProvider>);
    expect(await screen.findByRole('heading', { level: 1, name: heading })).toBeInTheDocument();
    const rows = () => screen.getAllByRole('row').slice(1);
    expect(within(rows().find(r => r.textContent!.startsWith('Claude'))!).getByText(plan)).toHaveClass('badge');
    expect(within(rows().find(r => r.textContent!.includes('WXYZ'))!).getByText(tokens)).toHaveClass('badge');
    fireEvent.click(within(screen.getByRole('group', { name: payment })).getByRole('button', { name: new RegExp(`^${tokens}`) }));
    expect(rows().map(r => r.textContent!.includes('By tokens') || r.textContent!.includes('По токенам'))).toEqual([true, true]);
  });

  it.each([['en', 'Tokens, 30 days', 'Tokens', 'Today', '7 days', '30 days', 'All time', 'in', 'turn told no tokens'], ['ru', 'Токены, 30 дней', 'Токены', 'Сегодня', '7 дней', '30 дней', 'Всего', 'вход', 'ход без данных']])(
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
      expect(gauges[0]).toContain(`${input} ${n(language, 500)}`);
      expect(part.textContent).toContain(noData);
    },
  );

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
    const row = (await screen.findAllByRole('row')).find(r => r.textContent!.includes('WXYZ'))!;
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
    await waitFor(() => expect(calls.some(c => c.method === 'PATCH')).toBe(true));
    expect(calls.find(c => c.method === 'PATCH')!.body).toEqual({
      label: 'Router', target: { kind: 'any' },
      models: [{ id: 'meta-llama/llama-4-maverick', name: 'Llama 4 Maverick' }, { id: 'qwen/qwen-3-coder', name: 'Qwen 3 Coder' }],
    });
  });
});
