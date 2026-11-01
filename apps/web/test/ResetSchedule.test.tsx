import { act, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import { Subscriptions } from '../src/screens/Subscriptions';
import type { Limits, SubView } from '../src/types';
import { ME, mockApi, SUBS } from './api-mock';

const NOW = Date.parse('2026-11-01T00:00:00.000Z');
const at = (milliseconds: number) => new Date(NOW + milliseconds).toISOString();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function fixedTime() {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
}

async function renderSubs(subscriptions: SubView[], language: 'en' | 'ru' = 'en') {
  if (language === 'ru') localStorage.setItem('hh-lang', 'ru');
  mockApi({ 'GET /api/subscriptions': [200, { subscriptions }], 'GET /api/machines': [200, { machines: [] }] });
  render(
    <LanguageProvider>
      <Subscriptions me={ME} />
    </LanguageProvider>,
  );
}

async function renderLimits(limits: Limits, language: 'en' | 'ru' = 'en') {
  await renderSubs([{ ...SUBS[0]!, limits }], language);
  const row = await screen.findByRole('row', { name: /^Claude\b/ });
  return within(row).getByRole('list', { name: language === 'ru' ? 'Лимиты' : 'Limits' });
}

afterEach(() => {
  localStorage.clear();
  vi.useRealTimers();
});

describe('relative subscription reset times', () => {
  it('shows at most two units and does not change duration with the ISO timezone offset', async () => {
    fixedTime();
    const list = await renderLimits({
      status: 'allowed',
      windows: [
        { name: 'five_hour', utilization: 0.1, resetsAt: '2026-11-04T12:30:00.000+05:30' },
        { name: 'seven_day', utilization: 0.2, resetsAt: at(2 * DAY) },
        { name: '120_minutes', utilization: 0.3, resetsAt: at(7 * HOUR + 5 * MINUTE) },
        { name: 'month', utilization: 0.4, resetsAt: at(30_000) },
        { name: 'one_day', utilization: 0.5, resetsAt: at(DAY + 30_000) },
      ],
    });
    const [five, seven, two, month, one] = within(list).getAllByRole('listitem');
    expect(five).toHaveTextContent('5 hours10%resets in 3 days 7 hours');
    expect(seven).toHaveTextContent('7 days20%resets in 2 days');
    expect(two).toHaveTextContent('2 hours30%resets in 7 hours 5 minutes');
    expect(month).toHaveTextContent('Month40%resets in less than a minute');
    expect(one).toHaveTextContent('1 day50%resets in 1 day');
  });

  it('uses English singular and plural units at exact boundaries', async () => {
    fixedTime();
    const list = await renderLimits({
      status: 'allowed',
      windows: [
        { name: 'five_hour', utilization: 0.1, resetsAt: at(DAY) },
        { name: 'seven_day', utilization: 0.2, resetsAt: at(2 * DAY) },
        { name: '120_minutes', utilization: 0.3, resetsAt: at(HOUR) },
        { name: 'month', utilization: 0.4, resetsAt: at(2 * HOUR) },
        { name: 'one_day', utilization: 0.5, resetsAt: at(MINUTE) },
        { name: '60_minutes', utilization: 0.6, resetsAt: at(2 * MINUTE) },
      ],
    });
    const items = within(list).getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('resets in 1 day');
    expect(items[1]).toHaveTextContent('resets in 2 days');
    expect(items[2]).toHaveTextContent('resets in 1 hour');
    expect(items[3]).toHaveTextContent('resets in 2 hours');
    expect(items[4]).toHaveTextContent('resets in 1 minute');
    expect(items[5]).toHaveTextContent('resets in 2 minutes');
  });

  it.each([
    { milliseconds: MINUTE, expected: '1 минута' },
    { milliseconds: 2 * MINUTE, expected: '2 минуты' },
    { milliseconds: 5 * MINUTE, expected: '5 минут' },
    { milliseconds: 11 * MINUTE, expected: '11 минут' },
    { milliseconds: 21 * MINUTE, expected: '21 минута' },
    { milliseconds: HOUR, expected: '1 час' },
    { milliseconds: 2 * HOUR, expected: '2 часа' },
    { milliseconds: 5 * HOUR, expected: '5 часов' },
    { milliseconds: 11 * HOUR, expected: '11 часов' },
    { milliseconds: 21 * HOUR, expected: '21 час' },
    { milliseconds: DAY, expected: '1 день' },
    { milliseconds: 2 * DAY, expected: '2 дня' },
    { milliseconds: 5 * DAY, expected: '5 дней' },
    { milliseconds: 11 * DAY, expected: '11 дней' },
    { milliseconds: 21 * DAY, expected: '21 день' },
  ])('uses Russian plurals for $expected', async ({ milliseconds, expected }) => {
    fixedTime();
    const list = await renderLimits({ status: 'allowed', windows: [{ name: 'five_hour', utilization: 0.1, resetsAt: at(milliseconds) }] }, 'ru');
    expect(list).toHaveTextContent(`До сброса ${expected}`);
  });

  it('updates an open view across day and past boundaries without a reload', async () => {
    fixedTime();
    const list = await renderLimits({
      status: 'allowed',
      windows: [
        { name: 'five_hour', utilization: 0.1, resetsAt: at(DAY + 30_000) },
        { name: 'seven_day', utilization: 0.2, resetsAt: at(30_000) },
      ],
    });
    expect(list).toHaveTextContent('5 hours10%resets in 1 day');
    expect(list).toHaveTextContent('7 days20%resets in less than a minute');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(31_000);
    });
    expect(list).toHaveTextContent('5 hours10%resets in 23 hours 59 minutes');
    expect(list).toHaveTextContent('7 daysNo data yetReset time unknown');
    expect(list).not.toHaveTextContent(/resets in -/);
    expect(list).not.toHaveTextContent(/restored/i);
  });

  it('keeps provider windows separate and marks null or invalid reset times unknown', async () => {
    fixedTime();
    const claude = { ...SUBS[0]!, limits: { status: 'allowed' as const, windows: [{ name: 'five_hour', utilization: 0.42, resetsAt: at(79 * HOUR) }] } };
    const codex = { ...SUBS[1]!, limits: { status: 'allowed' as const, windows: [{ name: '120_minutes', utilization: 0.05, resetsAt: at(7 * HOUR + 5 * MINUTE) }, { name: 'five_hour', utilization: null, resetsAt: null }] } };
    const kimi = { ...SUBS[2]!, limits: { status: 'allowed' as const, complete: true, windows: [{ name: 'five_hour', utilization: 0.88, resetsAt: at(30_000) }, { name: 'month', utilization: 0.06, resetsAt: 'not-a-time' }] } };
    await renderSubs([claude, codex, kimi]);
    expect(within(await screen.findByRole('row', { name: /^Claude\b/ })).getByText('resets in 3 days 7 hours')).toBeInTheDocument();
    expect(within(screen.getByRole('row', { name: /^Codex\b/ })).getByText('resets in 7 hours 5 minutes')).toBeInTheDocument();
    expect(within(screen.getByRole('row', { name: /^Codex\b/ })).getByText('Reset time unknown')).toBeInTheDocument();
    expect(within(screen.getByRole('row', { name: /^Kimi\b/ })).getByText('resets in less than a minute')).toBeInTheDocument();
    expect(within(screen.getByRole('row', { name: /^Kimi\b/ })).getByText('Reset time unknown')).toBeInTheDocument();
  });
});
