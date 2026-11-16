import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import { Subscriptions } from '../src/screens/Subscriptions';
import type { Limits, SubView } from '../src/types';
import { MACHINE, ME, mockApi, SUBS } from './api-mock';

const NOW = Date.parse('2026-11-01T00:00:00.000Z');
const at = (milliseconds: number) => new Date(NOW + milliseconds).toISOString();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function fixedTime() {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
}

async function renderSubs(subscriptions: SubView[], language: 'en' | 'ru' = 'en') {
  if (language === 'ru') localStorage.setItem('hh-lang', 'ru');
  mockApi({ 'GET /api/subscriptions': [200, { subscriptions }], 'GET /api/machines': [200, { machines: [] }] });
  await act(async () => {
    render(
      <LanguageProvider>
        <Subscriptions me={ME} />
      </LanguageProvider>,
    );
  });
}

async function renderLimits(limits: Limits, language: 'en' | 'ru' = 'en') {
  await renderSubs([{ ...SUBS[0]!, limits }], language);
  fireEvent.click(screen.getByRole('button', { name: /^(Open the card of |Открыть карточку )Claude$/ }));
  return screen.getByRole('article', { name: 'Claude, Ivan' }).querySelector('.gauges')!;
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
    const [five, seven, two, month, one] = [...list.querySelectorAll('.gauge')];
    expect(five).toHaveTextContent('5 hours10%usedresets in 3 days 7 h');
    expect(seven).toHaveTextContent('7 days20%usedresets in 2 days');
    expect(two).toHaveTextContent('2 hours30%usedresets in 7 h 5 min');
    expect(month).toHaveTextContent('Month40%usedresets in less than a minute');
    expect(one).toHaveTextContent('1 day50%usedresets in 1 day');
  });

  it('uses short English units for hours and minutes and plurals for days', async () => {
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
    const items = [...list.querySelectorAll('.gauge')];
    expect(items[0]).toHaveTextContent('resets in 1 day');
    expect(items[1]).toHaveTextContent('resets in 2 days');
    expect(items[2]).toHaveTextContent('resets in 1 h');
    expect(items[3]).toHaveTextContent('resets in 2 h');
    expect(items[4]).toHaveTextContent('resets in 1 min');
    expect(items[5]).toHaveTextContent('resets in 2 min');
  });

  it.each([
    { milliseconds: MINUTE, expected: '1 мин' },
    { milliseconds: 2 * MINUTE, expected: '2 мин' },
    { milliseconds: 5 * MINUTE, expected: '5 мин' },
    { milliseconds: 11 * MINUTE, expected: '11 мин' },
    { milliseconds: 21 * MINUTE, expected: '21 мин' },
    { milliseconds: HOUR, expected: '1 ч' },
    { milliseconds: 2 * HOUR, expected: '2 ч' },
    { milliseconds: 5 * HOUR, expected: '5 ч' },
    { milliseconds: 11 * HOUR, expected: '11 ч' },
    { milliseconds: 21 * HOUR, expected: '21 ч' },
    { milliseconds: DAY, expected: '1 день' },
    { milliseconds: 2 * DAY, expected: '2 дня' },
    { milliseconds: 5 * DAY, expected: '5 дней' },
    { milliseconds: 11 * DAY, expected: '11 дней' },
    { milliseconds: 21 * DAY, expected: '21 день' },
  ])('uses short Russian units for hours and minutes and plurals for days: $expected', async ({ milliseconds, expected }) => {
    fixedTime();
    const list = await renderLimits({ status: 'allowed', windows: [{ name: 'five_hour', utilization: 0.1, resetsAt: at(milliseconds) }] }, 'ru');
    expect(list).toHaveTextContent(`до сброса ${expected}`);
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
    expect(list).toHaveTextContent('5 hours10%usedresets in 1 day');
    expect(list).toHaveTextContent('7 days20%usedresets in less than a minute');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(31_000);
    });
    expect(list).toHaveTextContent('5 hours10%usedresets in 23 h 59 min');
    expect(list).toHaveTextContent('7 daysUnknown, no limit data received yet');
    expect(list).not.toHaveTextContent(/resets in -/);
    expect(list).not.toHaveTextContent(/restored/i);
  });

  it('keeps provider windows separate and marks null or invalid reset times unknown', async () => {
    fixedTime();
    const claude = { ...SUBS[0]!, limits: { status: 'allowed' as const, windows: [{ name: 'five_hour', utilization: 0.42, resetsAt: at(79 * HOUR) }] } };
    /* Working plans: a plan that does not work shows no limits. */
    const codex = { ...SUBS[1]!, status: 'ready' as const, machines: [MACHINE], limits: { status: 'allowed' as const, windows: [{ name: '120_minutes', utilization: 0.05, resetsAt: at(7 * HOUR + 5 * MINUTE) }, { name: 'five_hour', utilization: null, resetsAt: null }] } };
    const kimi = { ...SUBS[2]!, status: 'ready' as const, online: true, machines: [MACHINE], limits: { status: 'allowed' as const, complete: true, windows: [{ name: 'five_hour', utilization: 0.88, resetsAt: at(30_000) }, { name: 'month', utilization: 0.06, resetsAt: 'not-a-time' }] } };
    await renderSubs([claude, codex, kimi]);
    for (const button of screen.getAllByRole('button', { name: /^Open the card of / })) fireEvent.click(button);
    /* A reset's line by its whole words, one piece in the direction of its own words: the time in it stands in a piece of its own. */
    const resetLine = (text: string) => (_: string, el: Element | null) => !!el?.matches('.g-s > bdi:not([dir])') && el.textContent === text;
    expect(within(screen.getByRole('article', { name: 'Claude, Ivan' })).getByText(resetLine('resets in 3 days 7 h'))).toBeInTheDocument();
    expect(within(screen.getByRole('article', { name: 'Codex, Ivan' })).getByText(resetLine('resets in 7 h 5 min'))).toBeInTheDocument();
    expect(within(screen.getByRole('article', { name: 'Codex, Ivan' })).getByText(resetLine('Reset time unknown'))).toBeInTheDocument();
    expect(within(screen.getByRole('article', { name: 'Kimi, Ivan' })).getByText(resetLine('resets in less than a minute'))).toBeInTheDocument();
    expect(within(screen.getByRole('article', { name: 'Kimi, Ivan' })).getByText(resetLine('Reset time unknown'))).toBeInTheDocument();
  });
});
