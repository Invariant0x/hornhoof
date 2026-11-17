import { QUIET_SIGN_MS } from '@hornhoof/protocol/map';
import { cleanup, render } from '@testing-library/react';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import { en } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import type { Employee, FailureKind, ProgramRetry, ProgramView, TurnRetry } from '../src/types';
import { AgentState, programLine, type AgentLive } from '../src/ui/AgentState';
import { agentWorking } from '../src/ui/Chip';

const clock = (hours: number, minutes: number) => new Date(2026, 10, 3, hours, minutes).getTime();
const NOW = clock(14, 0);
const SERVER_NOW = new Date(NOW).toISOString();

function freezeClock() {
  vi.useFakeTimers({ toFake: ['performance'] });
  onTestFinished(() => {
    vi.useRealTimers();
  });
}

function program(
  state: ProgramView['state'],
  minutesAgo: number,
  extra: { tool?: string | null; signAt?: number | null; retry?: ProgramRetry | null } = {},
): ProgramView {
  return {
    state,
    since: NOW - minutesAgo * 60_000,
    tool: extra.tool ?? null,
    screenAt: NOW,
    signAt: extra.signAt ?? null,
    retry: extra.retry ?? null,
    reportedAt: NOW,
  };
}

function shown(lang: 'en' | 'ru', agent: AgentLive): HTMLElement | null {
  localStorage.setItem('hh-lang', lang);
  const { container } = render(
    <LanguageProvider>
      <AgentState agent={agent} serverNow={SERVER_NOW} />
    </LanguageProvider>,
  );
  const el = container.querySelector<HTMLElement>('.ast');
  cleanup();
  localStorage.removeItem('hh-lang');
  return el;
}

describe('AgentState', () => {
  it.each([
    ['thinking', 'work', 'thinking 5 min', 'думает 5 мин'],
    ['tool', 'work', 'Bash running 5 min', 'Bash работает 5 мин'],
    ['asking', 'person', 'asking', 'спрашивает'],
    ['retrying', 'work', 'retrying', 'повторяет запрос'],
    ['gone', 'calm', 'no program', 'программы нет'],
    ['idle', 'calm', 'waiting for input', 'ждет ввода'],
  ] as const)('keeps the historical %s line without live sign or retry fields', (state, tone, enText, ruText) => {
    const p = { state, since: NOW - 5 * 60_000, tool: 'Bash' };
    expect(programLine(en.dept.now, p, NOW)).toEqual({ tone, text: enText });
    expect(programLine(ru.dept.now, p, NOW)).toEqual({ tone, text: ruText });
  });

  it('keeps a tool with no recorded name and an age below one minute', () => {
    const p = { state: 'tool' as const, since: NOW, tool: null };
    expect(programLine(en.dept.now, p, NOW)).toEqual({ tone: 'work', text: ' running <1 min' });
    expect(programLine(ru.dept.now, p, NOW)).toEqual({ tone: 'work', text: ' работает <1 мин' });
  });

  it('says the program retry with and without max and next time, in English and Russian', () => {
    freezeClock();
    const nextAt = clock(14, 5);
    const cases: [ProgramRetry | null, string, string][] = [
      [
        { attempt: 3, max: 10, nextAt },
        'retrying, attempt 3 of 10, next at 14:05',
        'повторяет запрос, попытка 3 из 10, следующая в 14:05',
      ],
      [
        { attempt: 3, max: null, nextAt },
        'retrying, attempt 3, next at 14:05',
        'повторяет запрос, попытка 3, следующая в 14:05',
      ],
      [
        { attempt: 3, max: 10, nextAt: null },
        'retrying, attempt 3 of 10',
        'повторяет запрос, попытка 3 из 10',
      ],
      [
        { attempt: 3, max: null, nextAt: null },
        'retrying, attempt 3',
        'повторяет запрос, попытка 3',
      ],
      [null, 'retrying', 'повторяет запрос'],
    ];
    for (const [retry, enText, ruText] of cases) {
      const agent: AgentLive = { id: 'b1', program: program('retrying', 2, { retry }), alarm: null };
      const enEl = shown('en', agent);
      const ruEl = shown('ru', agent);
      expect(enEl?.textContent).toBe(enText);
      expect(enEl?.className).toBe('ast work');
      expect(ruEl?.textContent).toBe(ruText);
      expect(ruEl?.className).toBe('ast work');
    }
  });

  it('adds how long a thinking or retrying program gave no sign only past QUIET_SIGN_MS and when signAt is known', () => {
    freezeClock();
    const quietThinking: AgentLive = {
      id: 'b1',
      program: program('thinking', 32, { signAt: NOW - 31 * 60_000 }),
      alarm: null,
    };
    const enThink = shown('en', quietThinking);
    const ruThink = shown('ru', quietThinking);
    expect(enThink?.textContent).toBe('thinking 32 min, no sign 31 min');
    expect(enThink?.className).toBe('ast work');
    expect(ruThink?.textContent).toBe('думает 32 мин, без признаков 31 мин');
    expect(ruThink?.className).toBe('ast work');

    const quietRetrying: AgentLive = {
      id: 'b1',
      program: program('retrying', 15, {
        signAt: NOW - 12 * 60_000,
        retry: { attempt: 3, max: 10, nextAt: clock(14, 5) },
      }),
      alarm: null,
    };
    expect(shown('en', quietRetrying)?.textContent).toBe('retrying, attempt 3 of 10, next at 14:05, no sign 12 min');
    expect(shown('ru', quietRetrying)?.textContent).toBe('повторяет запрос, попытка 3 из 10, следующая в 14:05, без признаков 12 мин');

    /* Exactly at QUIET_SIGN_MS it is not past the threshold yet; 1 ms past it is. */
    const atBoundary: AgentLive = {
      id: 'b1',
      program: program('thinking', 12, { signAt: NOW - QUIET_SIGN_MS }),
      alarm: null,
    };
    expect(shown('en', atBoundary)?.textContent).toBe('thinking 12 min');
    expect(shown('ru', atBoundary)?.textContent).toBe('думает 12 мин');

    const pastBoundary: AgentLive = {
      id: 'b1',
      program: program('thinking', 12, { signAt: NOW - QUIET_SIGN_MS - 1 }),
      alarm: null,
    };
    expect(shown('en', pastBoundary)?.textContent).toBe('thinking 12 min, no sign 5 min');
    expect(shown('ru', pastBoundary)?.textContent).toBe('думает 12 мин, без признаков 5 мин');

    /* An older node sends signAt: null and keeps today's line. */
    const olderNode: AgentLive = {
      id: 'b1',
      program: program('thinking', 32, { signAt: null }),
      alarm: null,
    };
    expect(shown('en', olderNode)?.textContent).toBe('thinking 32 min');
    expect(shown('ru', olderNode)?.textContent).toBe('думает 32 мин');

    /* A running tool does not add the quiet-sign suffix, and the server alarm stays red. */
    const toolRun: AgentLive = {
      id: 'b1',
      program: program('tool', 40, { tool: 'Bash', signAt: NOW - 31 * 60_000 }),
      alarm: null,
    };
    expect(shown('en', toolRun)?.textContent).toBe('Bash running 40 min');
    expect(shown('ru', toolRun)?.textContent).toBe('Bash работает 40 мин');

    const alarmed: AgentLive = {
      ...quietThinking,
      alarm: { reason: 'program_stalled', since: NOW - 34 * 60_000 },
    };
    const alarmEl = shown('en', alarmed);
    expect(alarmEl?.textContent).toBe('program frozen 34 min');
    expect(alarmEl?.className).toBe('ast alarm');
  });

  it("shows Hornhoof's waiting retry when no program runs, with every failure kind in English and Russian", () => {
    freezeClock();
    const at = clock(14, 5);
    const kinds: [FailureKind, string, string][] = [
      ['overloaded', 'provider overloaded', 'провайдер перегружен'],
      ['model_access_denied', 'this plan cannot use the selected model', 'этот тариф не дает доступ к выбранной модели'],
      ['rate_limited', 'too many requests', 'слишком много запросов'],
      ['usage_limit', 'plan limit reached', 'лимит тарифа'],
      ['auth', 'sign-in needed', 'нужен вход'],
      ['tools', "Hornhoof's tools missing", 'нет инструментов Hornhoof'],
      ['network', 'network error', 'ошибка сети'],
      ['cut', 'answer cut off', 'ответ оборвался'],
      ['refused', 'refused by the provider', 'отказ провайдера'],
      ['too_big', 'too much for the model', 'слишком большой объем'],
      ['crash', 'program crashed', 'программа упала'],
      ['unknown', 'unknown error', 'неизвестная ошибка'],
    ];
    for (const [kind, enKind, ruKind] of kinds) {
      const retry: TurnRetry = { attempt: 2, max: 4, at, kind };
      const agent: AgentLive = { id: 'b1', program: null, alarm: null, retry, status: 'queued' };
      const enEl = shown('en', agent);
      const ruEl = shown('ru', agent);
      expect(enEl?.textContent).toBe(`retry 2 of 4 at 14:05 (${enKind})`);
      expect(enEl?.className).toBe('ast calm');
      expect(ruEl?.textContent).toBe(`повтор 2 из 4 в 14:05 (${ruKind})`);
      expect(ruEl?.className).toBe('ast calm');
    }

    /* Once a program runs, its own state shows instead of the waiting retry. */
    const running: AgentLive = {
      id: 'b1',
      program: program('thinking', 5),
      alarm: null,
      retry: { attempt: 2, max: 4, at, kind: 'overloaded' },
    };
    expect(shown('en', running)?.textContent).toBe('thinking 5 min');
  });

  it('keeps idle calm after more than a minute instead of turning red', () => {
    freezeClock();
    const idleLong: AgentLive = {
      id: 'b1',
      program: program('idle', 5),
      alarm: null,
    };
    const enEl = shown('en', idleLong);
    const ruEl = shown('ru', idleLong);
    expect(enEl?.textContent).toBe('waiting for input');
    expect(enEl?.className).toBe('ast calm');
    expect(ruEl?.textContent).toBe('ждет ввода');
    expect(ruEl?.className).toBe('ast calm');
  });

  it.each([
    ['budget', 'waiting: task share until 15:05', 'ждет: доля тарифа на задачи до 15:05'],
    ['limit', 'waiting: plan limit until 15:05', 'ждет: лимит тарифа до 15:05'],
  ] as const)('shows a %s hold only after ten minutes, in English and Russian', (reason, enText, ruText) => {
    freezeClock();
    const held = { reason, since: new Date(NOW - 10 * 60_000).toISOString(), until: new Date(clock(15, 5)).toISOString() };
    const atBoundary: AgentLive = { id: 'b1', program: null, alarm: null, status: 'queued', held };
    expect(shown('en', atBoundary)?.textContent).toBe('in the queue');
    expect(shown('ru', atBoundary)?.textContent).toBe('в очереди');

    const pastBoundary: AgentLive = { ...atBoundary, held: { ...held, since: new Date(NOW - 10 * 60_000 - 1).toISOString() } };
    expect(shown('en', pastBoundary)?.textContent).toBe(enText);
    expect(shown('en', pastBoundary)?.className).toBe('ast calm');
    expect(shown('ru', pastBoundary)?.textContent).toBe(ruText);
    expect(shown('ru', pastBoundary)?.className).toBe('ast calm');
  });
});

/* A turn past its machine's limit of turns at once (#1212) waits for a place there and says so on the map, in the tree and
   on the agent's card, calm: it has not hung. */
describe('a turn that waits for a place on its machine', () => {
  it.each([['en', 'waiting for a place on its machine'], ['ru', 'ждет место на машине']] as const)('says so in %s, calm, in place of the queue line', (lang, text) => {
    const agent: AgentLive = { id: 'b1', program: null, alarm: null, retry: null, status: 'queued', slotWait: true };
    const el = shown(lang, agent);
    expect(el?.textContent).toBe(text);
    expect(el).toHaveClass('calm');
  });

  it('gives way to an alarm and to a running program, and the map passes it from an employee to the line', () => {
    expect(shown('en', { id: 'b1', program: null, alarm: { reason: 'node_silent', since: NOW - 5 * 60_000 }, slotWait: true })?.className).toContain('alarm');
    expect(shown('en', { id: 'b1', program: program('thinking', 2), alarm: null, slotWait: true })?.textContent).toBe('thinking 2 min');
    const employee = { id: 'b1', program: null, alarm: null, held: null, retry: null, slotWait: true } as unknown as Employee;
    expect(agentWorking(employee)).toMatchObject({ id: 'b1', slotWait: true });
  });
});
