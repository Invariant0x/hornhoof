import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import { Machines } from '../src/screens/Machines';
import type { BuiltinView, ConnectionHistory, MachineDrop, NodeDropView } from '../src/types';
import { MachineConnections } from '../src/ui/MachineConnections';
import { MACHINES, ME, mockApi, SUBS } from './api-mock';
import { shownTable } from './shown-table';

const AT = '2026-11-04T17:15:00.000Z';
const when = (language: 'en' | 'ru', at = AT) => new Date(at).toLocaleString(language === 'ru' ? 'ru-RU' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short' });

const nodeDrop = (over: Partial<NodeDropView> = {}): NodeDropView => ({
  nodeId: 'n1',
  subscriptionId: null,
  at: AT,
  back: '2026-11-04T17:15:40.000Z',
  offlineMs: 40_000,
  cause: 'network',
  closeCode: 1006,
  closeReason: null,
  error: null,
  report: null,
  ...over,
});
const event = (over: Partial<MachineDrop> = {}, drops: NodeDropView[] = [nodeDrop()]): MachineDrop => ({ at: AT, back: '2026-11-04T17:15:40.000Z', offlineMs: 40_000, cause: 'network', drops, ...over });
const report = (over: Partial<NonNullable<NodeDropView['report']>> = {}): NonNullable<NodeDropView['report']> => ({
  disconnectedAt: AT,
  reconnectedAt: '2026-11-04T17:15:40.000Z',
  offlineMs: 40_000,
  attempts: 1,
  cause: 'socket_error',
  closeCode: null,
  closeReason: null,
  errorCode: null,
  error: null,
  dnsFailed: false,
  watchdogTimedOut: false,
  clockJumpMs: null,
  networkChanged: false,
  ...over,
});
const history = (over: Partial<ConnectionHistory> = {}): ConnectionHistory => ({ summary: { drops: 5, averageMs: 40_000, cause: 'network' }, events: [event()], ...over });

const PATH = '/api/machines/m1/connections';

function show(language: 'en' | 'ru' = 'en', online = true) {
  localStorage.setItem('hh-lang', language);
  return render(<LanguageProvider><MachineConnections id="m1" hostname="dev-laptop" online={online} /></LanguageProvider>);
}

const heading = { en: 'Connection to the server', ru: 'Связь с сервером' };
const SHOW_DETAILS = /^(Show technical details|Показать технические подробности)$/;
/* The technical facts of the drops stay folded until a person asks for them. */
const details = async () => fireEvent.click(await screen.findByRole('button', { name: SHOW_DETAILS }));

afterEach(() => {
  localStorage.clear();
  vi.useRealTimers();
});

describe('what the card of a machine says first of its connection (#1027)', () => {
  const away = event({ back: null, offlineMs: null }, [nodeDrop({ back: null, offlineMs: null })]);
  it.each([
    ['en', { summary: { drops: 0, averageMs: null, cause: null }, events: [] }, 'Stable', 'No drops so far. If the connection breaks, its time and cause appear here.'],
    ['en', history({ summary: { drops: 0, averageMs: null, cause: null } }), 'Stable', 'No drops in the last 24 hours.'],
    ['en', history(), 'Had drops', '5 drops in the last 24 hours, 40 s on average. Most often: the network cut the connection.'],
    ['en', history({ summary: { drops: 1, averageMs: null, cause: 'network' }, events: [away] }), 'Offline now', '1 drop in the last 24 hours. Cause: the network cut the connection.'],
    ['ru', { summary: { drops: 0, averageMs: null, cause: null }, events: [] }, 'Стабильна', 'Обрывов пока не было. Если связь прервется, здесь появятся время и причина.'],
    ['ru', history(), 'Были обрывы', 'За сутки 5 обрывов, в среднем 40 с. Чаще всего: сеть оборвала соединение.'],
    ['ru', history({ summary: { drops: 1, averageMs: null, cause: 'network' }, events: [away] }), 'Сейчас нет связи', 'За сутки 1 обрыв. Причина: сеть оборвала соединение.'],
  ] as const)('says in a word whether it holds, then the day in a sentence, in %s: %s', async (language, answer, word, sentence) => {
    mockApi({ [`GET ${PATH}`]: [200, answer] });
    show(language);
    const state = await screen.findByText(word);
    expect(state).toHaveClass('status');
    expect(state.closest('p')).toHaveTextContent(`${word} ${sentence}`);
    expect(screen.getByRole('region', { name: heading[language] })).toContainElement(state);
  });

  it.each([
    ['en', 'Offline for 40 s', 'The network cut the connection', 'Show technical details', 'Hide technical details', 'code 1006'],
    ['ru', 'Без связи 40 с', 'Сеть оборвала соединение', 'Показать технические подробности', 'Скрыть технические подробности', 'код 1006'],
  ] as const)('lists each drop as when, how long it was off and why, and folds the technical details until asked, in %s', async (language, off, cause, open, hide, code) => {
    mockApi({ [`GET ${PATH}`]: [200, history()] });
    show(language);
    const line = within(await screen.findByRole('list')).getAllByRole('listitem')[0]!;
    expect([...line.children].slice(0, 3).map(part => part.textContent)).toEqual([when(language), off, cause]);
    expect(line).not.toHaveTextContent(code);
    const toggle = screen.getByRole('button', { name: open });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    expect(within(screen.getByRole('list')).getAllByRole('listitem')[0]).toHaveTextContent(code);
    expect(screen.getByRole('button', { name: hide })).toHaveAttribute('aria-expanded', 'true');
  });

  it('offers no technical details where no drop has any', async () => {
    mockApi({ [`GET ${PATH}`]: [200, history({ events: [event({}, [nodeDrop({ closeCode: null })])] })] });
    show();
    await screen.findByRole('list');
    expect(screen.queryByRole('button', { name: SHOW_DETAILS })).toBeNull();
  });
});

describe('what the card of a machine says of its connection', () => {
  it.each([
    ['en', '5 drops in the last 24 hours, 40 s on average. Most often: the network cut the connection.'],
    ['ru', 'За сутки 5 обрывов, в среднем 40 с. Чаще всего: сеть оборвала соединение.'],
  ] as const)('sums up the last day in plain words in %s', async (language, text) => {
    mockApi({ [`GET ${PATH}`]: [200, history()] });
    show(language);
    expect(await screen.findByText(text)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: heading[language] })).toBeInTheDocument();
  });

  it.each([
    ['en', 2, 90_000, '2 drops in the last 24 hours, 1 min on average. Most often: the network cut the connection.'],
    ['ru', 2, 90_000, 'За сутки 2 обрыва, в среднем 1 мин. Чаще всего: сеть оборвала соединение.'],
    ['ru', 21, 3_660_000, 'За сутки 21 обрыв, в среднем 1 ч 1 мин. Чаще всего: сеть оборвала соединение.'],
    ['en', 3, 400, '3 drops in the last 24 hours, under a second on average. Most often: the network cut the connection.'],
    ['ru', 3, 400, 'За сутки 3 обрыва, в среднем меньше секунды. Чаще всего: сеть оборвала соединение.'],
    ['en', 2, 59_500, '2 drops in the last 24 hours, 60 s on average. Most often: the network cut the connection.'],
    ['en', 2, 60_000, '2 drops in the last 24 hours, 1 min on average. Most often: the network cut the connection.'],
    ['en', 2, 1000, '2 drops in the last 24 hours, 1 s on average. Most often: the network cut the connection.'],
  ] as const)('words counts and lengths in %s: %i drops, %i ms', async (language, drops, averageMs, text) => {
    mockApi({ [`GET ${PATH}`]: [200, history({ summary: { drops, averageMs, cause: 'network' } })] });
    show(language);
    expect(await screen.findByText(text)).toBeInTheDocument();
  });

  it.each([
    ['en', 40_000, '1 drop in the last 24 hours, 40 s. Cause: the network cut the connection.'],
    ['ru', 40_000, 'За сутки 1 обрыв, 40 с. Причина: сеть оборвала соединение.'],
    ['en', null, '1 drop in the last 24 hours. Cause: the network cut the connection.'],
    ['ru', null, 'За сутки 1 обрыв. Причина: сеть оборвала соединение.'],
  ] as const)('speaks of one drop as one in %s, with %s ms away', async (language, averageMs, text) => {
    mockApi({ [`GET ${PATH}`]: [200, history({ summary: { drops: 1, averageMs, cause: 'network' } })] });
    show(language);
    expect(await screen.findByText(text)).toBeInTheDocument();
  });

  it.each([
    ['en', '4 drops in the last 24 hours. Most often: the network cut the connection.'],
    ['ru', 'За сутки 4 обрыва. Чаще всего: сеть оборвала соединение.'],
  ] as const)('gives no average in %s while no drop has ended', async (language, text) => {
    mockApi({ [`GET ${PATH}`]: [200, history({ summary: { drops: 4, averageMs: null, cause: 'network' } })] });
    show(language);
    expect(await screen.findByText(text)).toBeInTheDocument();
  });

  it.each([
    ['en', 'No drops in the last 24 hours.'],
    ['ru', 'За сутки обрывов не было.'],
  ] as const)('says a quiet day was quiet in %s, and still lists older drops', async (language, text) => {
    mockApi({ [`GET ${PATH}`]: [200, history({ summary: { drops: 0, averageMs: null, cause: null } })] });
    show(language);
    expect(await screen.findByText(text)).toBeInTheDocument();
    expect(within(screen.getByRole('list')).getAllByRole('listitem')).toHaveLength(1);
  });

  it.each([
    ['en', 'No drops so far. If the connection breaks, its time and cause appear here.'],
    ['ru', 'Обрывов пока не было. Если связь прервется, здесь появятся время и причина.'],
  ] as const)('says what comes here when nothing has happened, in %s', async (language, text) => {
    mockApi({ [`GET ${PATH}`]: [200, { summary: { drops: 0, averageMs: null, cause: null }, events: [] }] });
    show(language);
    expect(await screen.findByText(text)).toBeInTheDocument();
    expect(screen.queryByRole('list')).toBeNull();
  });

  it('says it is loading until the history comes', async () => {
    let answer!: (value: [number, unknown]) => void;
    mockApi({ [`GET ${PATH}`]: () => new Promise(done => (answer = done)) });
    show();
    expect(screen.getByText('Loading…')).toBeInTheDocument();
    await act(async () => answer([200, history()]));
    expect(screen.queryByText('Loading…')).toBeNull();
  });

  it.each([
    ['en', /no longer connected/],
    ['ru', /больше не подключена/],
  ] as const)('says why in %s when it gets no history', async (language, text) => {
    mockApi({ [`GET ${PATH}`]: [404, { error: { code: 'not_found', message: 'This machine does not exist.', reason: 'machine_unknown' } }] });
    show(language);
    expect(await screen.findByRole('alert')).toHaveTextContent(text);
    expect(screen.queryByText('Loading…')).toBeNull();
  });
});

describe('the drops the card of a machine lists', () => {
  const row = async () => within(await screen.findByRole('list')).getAllByRole('listitem')[0]!;

  it.each([
    ['en', 'Offline for 40 s', 'The network cut the connection', 'code 1006'],
    ['ru', 'Без связи 40 с', 'Сеть оборвала соединение', 'код 1006'],
  ] as const)('says when, for how long, why and with what code in %s', async (language, back, cause, code) => {
    mockApi({ [`GET ${PATH}`]: [200, history()] });
    show(language);
    await details();
    const line = await row();
    expect(line).toHaveTextContent(when(language));
    expect(line).toHaveTextContent(back);
    expect(line).toHaveTextContent(cause);
    expect(line).toHaveTextContent(code);
  });

  it.each([
    ['en', 999, 'Offline for under a second'],
    ['ru', 999, 'Без связи меньше секунды'],
    ['en', 1000, 'Offline for 1 s'],
    ['ru', 1000, 'Без связи 1 с'],
  ] as const)('says one that was over within a second was over at once, in %s, at %i ms', async (language, offlineMs, text) => {
    mockApi({ [`GET ${PATH}`]: [200, history({ events: [event({ offlineMs })] })] });
    show(language);
    expect(await row()).toHaveTextContent(text);
  });

  it('names its list by the machine', async () => {
    mockApi({ [`GET ${PATH}`]: [200, history()] });
    show();
    expect(await screen.findByRole('list', { name: 'Latest drops of dev-laptop' })).toBeInTheDocument();
  });

  it.each([
    ['en', 'Still offline'],
    ['ru', 'Связи пока нет'],
  ] as const)('marks one the machine is not back from in %s', async (language, text) => {
    mockApi({ [`GET ${PATH}`]: [200, history({ events: [event({ back: null, offlineMs: null }, [nodeDrop({ back: null, offlineMs: null })])] })] });
    show(language);
    const line = await row();
    expect(line).toHaveTextContent(text);
    expect(line.className).toContain('away');
  });

  it('marks no finished drop as away', async () => {
    mockApi({ [`GET ${PATH}`]: [200, history()] });
    show();
    expect((await row()).className).not.toContain('away');
  });

  it.each([
    ['missed_pongs', 'The machine stopped answering the server\'s checks', 'Машина перестала отвечать на проверки связи'],
    ['node_closed', 'The machine closed the connection', 'Машина сама закрыла соединение'],
    ['network', 'The network cut the connection', 'Сеть оборвала соединение'],
    ['socket_error', 'The connection failed with an error', 'Соединение оборвалось с ошибкой'],
    ['replaced', 'The machine connected again before the old connection ended', 'Машина подключилась заново, пока старое соединение еще не закрылось'],
    ['server_stopped', 'The server restarted', 'Сервер перезапускался'],
    ['watchdog_timeout', 'The machine stopped hearing the server', 'Машина перестала слышать сервер'],
    ['server_close', 'The server closed the connection', 'Сервер закрыл соединение'],
    ['dns_error', 'The server\'s address could not be found', 'Адрес сервера не нашелся'],
    ['handshake_timeout', 'The server did not answer in time', 'Сервер не ответил вовремя'],
    ['http_rejected', 'The server refused the connection', 'Сервер не принял соединение'],
    ['abnormal_close', 'The connection broke with no warning', 'Соединение оборвалось без предупреждения'],
  ] as const)('words the cause %s in both languages', async (cause, en, ru) => {
    mockApi({ [`GET ${PATH}`]: [200, history({ events: [event({ cause })] })] });
    const first = show('en');
    expect(await row()).toHaveTextContent(en);
    first.unmount();
    show('ru');
    expect(await row()).toHaveTextContent(ru);
  });

  it('leaves out the words the server closed a socket with, which its cause says in the language of the screen', async () => {
    mockApi({ [`GET ${PATH}`]: [200, history({ events: [event({ cause: 'replaced' }, [nodeDrop({ cause: 'replaced', closeCode: 4000, closeReason: 'Replaced by a newer connection.' })])] })] });
    show('ru');
    await details();
    const line = await row();
    expect(line).toHaveTextContent('код 4000');
    expect(line).not.toHaveTextContent('Replaced by a newer connection.');
  });

  it('shows the words a machine closed with and those of the error, as they are and never as markup', async () => {
    mockApi({ [`GET ${PATH}`]: [200, history({ events: [event({ cause: 'node_closed' }, [nodeDrop({ cause: 'node_closed', closeCode: 1002, closeReason: '<b>Bad frame</b>', error: 'Invalid WebSocket frame' })])] })] });
    show();
    await details();
    const line = await row();
    expect(line).toHaveTextContent('code 1002');
    expect(line).toHaveTextContent('<b>Bad frame</b>');
    expect(line).toHaveTextContent('Invalid WebSocket frame');
    expect(line.querySelector('b b')).toBeNull();
  });

  it('writes no empty line when there is nothing more to say of a drop', async () => {
    mockApi({ [`GET ${PATH}`]: [200, history({ events: [event({}, [nodeDrop({ closeCode: null })]), event({ at: '2026-11-04T16:15:00.000Z' })] })] });
    show();
    await details();
    const [quiet, coded] = within(screen.getByRole('list')).getAllByRole('listitem');
    expect(quiet!.querySelector('.mc-tech')).toBeNull();
    expect(coded!.querySelector('.mc-tech')).toHaveTextContent('code 1006');
  });

  it('gives a code of zero, which is one', async () => {
    mockApi({ [`GET ${PATH}`]: [200, history({ events: [event({}, [nodeDrop({ closeCode: 0 })])] })] });
    show();
    await details();
    expect(await row()).toHaveTextContent('code 0');
  });

  it('gives no code it does not know', async () => {
    mockApi({ [`GET ${PATH}`]: [200, history({ events: [event({}, [nodeDrop({ closeCode: null })])] })] });
    show();
    expect(await row()).not.toHaveTextContent(/code/i);
  });

  it.each([
    ['en', '3 connections'],
    ['ru', 'соединений: 3'],
  ] as const)('says how many connections broke together in %s', async (language, text) => {
    mockApi({ [`GET ${PATH}`]: [200, history({ events: [event({}, [nodeDrop(), nodeDrop({ nodeId: 'n2' }), nodeDrop({ nodeId: 'n3' })])] })] });
    show(language);
    await details();
    expect(await row()).toHaveTextContent(text);
  });

  it('says nothing of a count for one connection', async () => {
    mockApi({ [`GET ${PATH}`]: [200, history()] });
    show();
    await details();
    expect(await row()).not.toHaveTextContent('connections');
  });

  it.each([
    ['en', 'The machine saw: the connection failed with an error, ECONNRESET, 3 tries to connect, the server\'s address could not be found, the machine stopped hearing the server, the machine slept or its clock jumped by 2 min, the network changed.'],
    ['ru', 'Машина видела: соединение оборвалось с ошибкой, ECONNRESET, попыток подключиться: 3, адрес сервера не нашелся, машина перестала слышать сервер, машина спала или ее часы сдвинулись на 2 мин, сменилась сеть.'],
  ] as const)('shows what the machine itself saw next to what the server saw, in %s', async (language, text) => {
    const said = report({ errorCode: 'ECONNRESET', error: 'read ECONNRESET', attempts: 3, dnsFailed: true, watchdogTimedOut: true, clockJumpMs: 120_000, networkChanged: true });
    mockApi({ [`GET ${PATH}`]: [200, history({ events: [event({}, [nodeDrop({ report: said })])] })] });
    show(language);
    await details();
    const line = await row();
    expect(line).toHaveTextContent(text);
    expect(line).toHaveTextContent(language === 'en' ? 'The network cut the connection' : 'Сеть оборвала соединение');
  });

  it('says only what the machine has to add', async () => {
    mockApi({ [`GET ${PATH}`]: [200, history({ events: [event({ cause: 'socket_error' }, [nodeDrop({ report: report({ error: 'read ECONNRESET' }) })])] })] });
    show();
    await details();
    const saw = await screen.findByText(/^The machine saw:/);
    /* Its cause is the one already given, it connected at the first try, and nothing else happened. */
    expect(saw).toHaveTextContent(/^The machine saw: read ECONNRESET\.$/);
  });

  it('says nothing of what the machine saw when it adds nothing', async () => {
    mockApi({ [`GET ${PATH}`]: [200, history({ events: [event({ cause: 'socket_error' }, [nodeDrop({ report: report() })])] })] });
    show();
    await details();
    await row();
    expect(screen.queryByText(/^The machine saw:/)).toBeNull();
  });

  it('says nothing of what the machine saw for a node from before', async () => {
    mockApi({ [`GET ${PATH}`]: [200, history()] });
    show();
    await details();
    await row();
    expect(screen.queryByText(/saw/)).toBeNull();
  });

  it('finds what a machine saw in whichever of its connections said it', async () => {
    mockApi({ [`GET ${PATH}`]: [200, history({ events: [event({}, [nodeDrop(), nodeDrop({ nodeId: 'n2', report: report({ dnsFailed: true, cause: 'dns_error' }) })])] })] });
    show();
    await details();
    expect(await screen.findByText(/^The machine saw:/)).toHaveTextContent(/the server's address could not be found/);
  });

  it('uses the first report even when a later report adds more facts', async () => {
    mockApi({ [`GET ${PATH}`]: [200, history({ events: [event({ cause: 'socket_error' }, [
      nodeDrop(),
      nodeDrop({ nodeId: 'n2', report: report() }),
      nodeDrop({ nodeId: 'n3', report: report({ errorCode: 'LATER', attempts: 4, networkChanged: true }) }),
    ])] })] });
    show();
    await details();
    await row();
    expect(screen.queryByText(/^The machine saw:/)).toBeNull();
    expect(screen.getByRole('listitem')).not.toHaveTextContent('LATER');
  });

  it.each([
    ['ECONNRESET', 'raw <b>error</b>', 'The machine saw: ECONNRESET.'],
    [null, 'raw <b>error</b>', 'The machine saw: raw <b>error</b>.'],
    ['', 'raw error', null],
  ] as const)('prefers the report code %s to its raw error, including an empty code', async (errorCode, error, text) => {
    mockApi({ [`GET ${PATH}`]: [200, history({ events: [event({ cause: 'socket_error' }, [nodeDrop({ report: report({ errorCode, error }) })])] })] });
    show();
    await details();
    await row();
    const saw = screen.queryByText(/^The machine saw:/);
    if (text === null) expect(saw).toBeNull();
    else expect(saw).toHaveTextContent(text);
    expect(saw?.querySelector('b')).toBeFalsy();
  });

  it.each([
    [0, 'under a second'],
    [1000, '1 s'],
    [60_000, '1 min'],
  ] as const)('keeps a report clock jump of %i ms, including zero', async (clockJumpMs, length) => {
    mockApi({ [`GET ${PATH}`]: [200, history({ events: [event({ cause: 'socket_error' }, [nodeDrop({ report: report({ clockJumpMs }) })])] })] });
    show();
    await details();
    expect(await screen.findByText(/^The machine saw:/)).toHaveTextContent(`The machine saw: the machine slept or its clock jumped by ${length}.`);
  });

  it('does not repeat that the name was not found when that is the cause it gives', async () => {
    mockApi({ [`GET ${PATH}`]: [200, history({ events: [event({}, [nodeDrop({ report: report({ cause: 'dns_error', dnsFailed: true }) })])] })] });
    show();
    await details();
    const saw = await screen.findByText(/^The machine saw:/);
    expect(saw).toHaveTextContent(/^The machine saw: the server's address could not be found\.$/);
  });

  it('does not repeat that it stopped hearing the server when that is the cause it gives', async () => {
    mockApi({ [`GET ${PATH}`]: [200, history({ events: [event({}, [nodeDrop({ report: report({ cause: 'watchdog_timeout', watchdogTimedOut: true }) })])] })] });
    show();
    await details();
    const saw = await screen.findByText(/^The machine saw:/);
    expect(saw).toHaveTextContent(/^The machine saw: the machine stopped hearing the server\.$/);
  });

  const many = (n: number) => Array.from({ length: n }, (_, i) => event({ at: new Date(Date.parse(AT) - i * 600_000).toISOString() }));

  it.each([
    ['en', 'Show all 7', 'Show fewer'],
    ['ru', 'Показать все: 7', 'Показать меньше'],
  ] as const)('lists the latest five, and the rest on request, in %s', async (language, more, fewer) => {
    mockApi({ [`GET ${PATH}`]: [200, history({ events: many(7) })] });
    show(language);
    const list = await screen.findByRole('list');
    expect(within(list).getAllByRole('listitem')).toHaveLength(5);
    expect(within(list).getAllByRole('listitem')[0]).toHaveTextContent(when(language));

    const button = screen.getByRole('button', { name: more });
    expect(button).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(button);
    expect(within(screen.getByRole('list')).getAllByRole('listitem')).toHaveLength(7);
    const back = screen.getByRole('button', { name: fewer });
    expect(back).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(back);
    expect(within(screen.getByRole('list')).getAllByRole('listitem')).toHaveLength(5);
  });

  it('asks for no more when all five are listed', async () => {
    mockApi({ [`GET ${PATH}`]: [200, history({ events: many(5) })] });
    show();
    await screen.findByRole('list');
    expect(screen.queryByRole('button', { name: /^Show all/ })).toBeNull();
  });
});

describe('how the card of a machine keeps its history fresh', () => {
  const tick = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

  it('looks again every half minute on its own', async () => {
    vi.useFakeTimers();
    const calls = mockApi({ [`GET ${PATH}`]: [200, history()] });
    show();
    await tick(0);
    expect(calls.filter(c => c.path === PATH)).toHaveLength(1);
    await tick(29_999);
    expect(calls.filter(c => c.path === PATH)).toHaveLength(1);
    await tick(1);
    expect(calls.filter(c => c.path === PATH)).toHaveLength(2);
  });

  it('looks again the moment the machine goes away or comes back', async () => {
    const calls = mockApi({ [`GET ${PATH}`]: [200, history()] });
    const view = show();
    await screen.findByRole('list');
    view.rerender(<LanguageProvider><MachineConnections id="m1" hostname="dev-laptop" online={false} /></LanguageProvider>);
    await act(async () => {});
    expect(calls.filter(c => c.path === PATH)).toHaveLength(2);
  });

  it('keeps what it has when a later look fails, says so, and clears that when one succeeds', async () => {
    vi.useFakeTimers();
    let status = 200;
    mockApi({ [`GET ${PATH}`]: () => [status, status === 200 ? history() : { error: { code: 'internal', message: 'Something failed.' } }] });
    show();
    await tick(0);
    expect(screen.getByRole('list')).toBeInTheDocument();
    status = 500;
    await tick(30_000);
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('list')).toBeInTheDocument();
    status = 200;
    await tick(30_000);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('stops looking when its card closes, and takes no late answer', async () => {
    vi.useFakeTimers();
    let answer!: (value: [number, unknown]) => void;
    const calls = mockApi({ [`GET ${PATH}`]: () => new Promise(done => (answer = done)) });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const view = show();
    await tick(0);
    view.unmount();
    await act(async () => answer([200, history()]));
    await tick(60_000);
    expect(calls.filter(c => c.path === PATH)).toHaveLength(1);
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  it('takes no late answer about the machine it showed before', async () => {
    let answer!: (value: [number, unknown]) => void;
    mockApi({
      [`GET ${PATH}`]: () => new Promise(done => (answer = done)),
      'GET /api/machines/m2/connections': [200, history({ summary: { drops: 2, averageMs: 1000, cause: 'server_stopped' } })],
    });
    const view = show();
    await act(async () => {});
    view.rerender(<LanguageProvider><MachineConnections id="m2" hostname="build-box" online /></LanguageProvider>);
    await screen.findByText(/^2 drops/);
    await act(async () => answer([200, history()]));
    expect(screen.getByText(/^2 drops/)).toBeInTheDocument();
    expect(screen.queryByText(/^5 drops/)).toBeNull();
  });

  it('takes no late failure about the machine it showed before', async () => {
    let answer!: (value: [number, unknown]) => void;
    mockApi({
      [`GET ${PATH}`]: () => new Promise(done => (answer = done)),
      'GET /api/machines/m2/connections': [200, history({ summary: { drops: 2, averageMs: 1000, cause: 'server_stopped' } })],
    });
    const view = show();
    await act(async () => {});
    view.rerender(<LanguageProvider><MachineConnections id="m2" hostname="build-box" online /></LanguageProvider>);
    await screen.findByText(/^2 drops/);
    await act(async () => answer([500, { error: { code: 'internal', message: 'Something failed.' } }]));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows the history of the machine it is given when that changes', async () => {
    mockApi({
      [`GET ${PATH}`]: [200, history()],
      'GET /api/machines/m2/connections': [200, history({ summary: { drops: 2, averageMs: 1000, cause: 'server_stopped' } })],
    });
    const view = show();
    await screen.findByText(/^5 drops/);
    view.rerender(<LanguageProvider><MachineConnections id="m2" hostname="build-box" online /></LanguageProvider>);
    expect(await screen.findByText(/^2 drops/)).toBeInTheDocument();
  });
});

describe('the machines screen and the history of a machine', () => {
  const BUILTIN: BuiltinView = { online: true, load: null, running: { agents: [], parts: [] } };
  const lists = (extra: Parameters<typeof mockApi>[0] = {}, machines = MACHINES, builtin: BuiltinView | null = BUILTIN) =>
    mockApi({ 'GET /api/subscriptions': [200, { subscriptions: SUBS }], 'GET /api/machines': [200, { machines, builtin }], [`GET ${PATH}`]: [200, history()], ...extra });
  const open = async (name: string) => {
    render(<LanguageProvider><Machines me={ME} /></LanguageProvider>);
    await shownTable();
    fireEvent.click(screen.getByRole('button', { name: `Open the card of ${name}` }));
    return screen.getByRole('article', { name });
  };

  it('puts it in the card of the machine, and asks for it only once the card is open', async () => {
    const calls = lists();
    render(<LanguageProvider><Machines me={ME} /></LanguageProvider>);
    await shownTable();
    expect(calls.filter(c => c.path === PATH)).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Open the card of dev-laptop' }));
    const card = screen.getByRole('article', { name: 'dev-laptop' });
    expect(await within(card).findByText(/^5 drops in the last 24 hours/)).toBeInTheDocument();
    expect(within(card).getByRole('heading', { name: heading.en })).toBeInTheDocument();
    expect(calls.filter(c => c.path === PATH)).toHaveLength(1);
  });

  it('looks again the moment the screen hears the machine went away', async () => {
    vi.useFakeTimers();
    let online = true;
    const calls = lists({ 'GET /api/machines': () => [200, { machines: MACHINES.map(m => ({ ...m, online: m.id === 'm1' ? online : m.online })), builtin: BUILTIN }] });
    render(<LanguageProvider><Machines me={ME} /></LanguageProvider>);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    fireEvent.click(screen.getByRole('button', { name: 'Open the card of dev-laptop' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(calls.filter(c => c.path === PATH)).toHaveLength(1);
    online = false;
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(calls.filter(c => c.path === PATH)).toHaveLength(2);
  });

  it('has none for the built-in node, which has no machine of its own', async () => {
    const calls = lists({}, []);
    const card = await open('Built-in node');
    expect(within(card).queryByRole('heading', { name: heading.en })).toBeNull();
    expect(calls.filter(c => c.path.endsWith('/connections'))).toEqual([]);
  });
});
