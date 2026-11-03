import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import { Shell } from '../src/screens/Shell';
import { CARD, decisions, DEV_ORG, ME, mockApi, REQUESTS, TASK_DETAIL, TASKS, TURN } from './api-mock';

function shell(routes: Record<string, unknown> = {}) {
  const calls = mockApi({
    'GET /api/org': [200, DEV_ORG],
    'GET /api/requests': [200, decisions([])],
    'GET /api/turns': [200, { turns: [TURN] }],
    'GET /api/tasks?status=all': [200, { tasks: TASKS }],
    'GET /api/tasks/t12': [200, { task: TASK_DETAIL }],
    ...(routes as Record<string, [number, unknown]>),
  });
  render(
    <LanguageProvider>
      <Shell me={ME} onSignOut={() => {}} />
    </LanguageProvider>,
  );
  return calls;
}

async function openTask(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: /^Tasks/ }));
  await user.click(await screen.findByRole('button', { name: /#12/ }));
  return screen.findByRole('complementary', { name: '#12 Checkout API' });
}

describe('a task', () => {
  it("puts what waits for the person at the top, the orchestrator's plain question above the answer, and says that writing to the agent counts too", async () => {
    const user = userEvent.setup();
    const plain = 'Bruno cannot finish the checkout because the tests fail on the payment provider. He needs the provider keys, or a yes to leave those tests for later.';
    const stuck = {
      ...REQUESTS[0]!,
      id: 'r3',
      kind: 'stuck' as const,
      text: 'Ended 3 turns in a row on #12 without moving it. Tell it how to go on, or cancel the task.',
      explained: plain,
      agent: { id: 'b1', name: 'Bruno' },
      task: { ...REQUESTS[0]!.task, id: 't12', number: 12, title: 'Checkout API' },
    };
    const calls = shell({ 'GET /api/requests': [200, decisions([REQUESTS[0], stuck])], 'POST /api/requests/r3': [200, { request: { id: 'r3', status: 'answered' } }] });
    /* From the list of what waits, as a person goes. */
    await user.click(await screen.findByRole('button', { name: /^Tasks/ }));
    await user.click(within(await screen.findByRole('region', { name: 'Waiting for you' })).getByRole('button', { name: /#12/ }));
    const panel = await screen.findByRole('complementary', { name: '#12 Checkout API' });
    const waiting = await within(panel).findByRole('region', { name: 'Waiting for your answer' });
    /* Only this task's. */
    expect(within(waiting).getAllByRole('article')).toHaveLength(1);
    const question = within(waiting).getByText(plain);
    const answer = within(waiting).getByLabelText('Your answer');
    expect(question.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    /* What Hornhoof noted stays at hand, in the person's language. */
    const more = within(waiting).getByText('In more detail');
    expect(more.closest('details')).toHaveTextContent('Bruno ended several turns in a row without moving #12, so Hornhoof stopped waking it.');
    expect(waiting).not.toHaveTextContent('Ended 3 turns');
    expect(waiting).toHaveTextContent("A question can be answered in the agent's window or terminal too: what you write there counts.");
    /* One way to answer: write it and send it. */
    expect(within(waiting).queryByRole('button', { name: 'Let it go on' })).toBeNull();
    const send = within(waiting).getByRole('button', { name: 'Send answer' });
    expect(send).toBeDisabled();
    await user.type(answer, 'Skip them for now.');
    await user.click(send);
    expect(calls.find(c => c.path === '/api/requests/r3')?.body).toEqual({ answer: 'Skip them for now.' });
  });

  it("opens the asking agent's terminal from what waits for the person, to see what it did", async () => {
    const user = userEvent.setup();
    const asked = { ...REQUESTS[0]!, id: 'r5', agent: { id: 'b1', name: 'Bruno' }, task: { ...REQUESTS[0]!.task, id: 't12', number: 12, title: 'Checkout API' } };
    shell({
      'GET /api/requests': [200, decisions([asked])],
      'GET /api/agents/b1': [200, CARD],
      'GET /api/agents/b1/events?after=0': [200, { events: [], state: { ready: true, reason: null, busy: false, runningJobId: null, queued: 0 } }],
    });
    await user.click(await screen.findByRole('button', { name: /^Tasks/ }));
    await user.click(within(await screen.findByRole('region', { name: 'Waiting for you' })).getByRole('button', { name: /#12/ }));
    const panel = await screen.findByRole('complementary', { name: '#12 Checkout API' });
    const waiting = await within(panel).findByRole('region', { name: 'Waiting for your answer' });
    await user.click(within(waiting).getByRole('button', { name: "Open Bruno's terminal" }));
    expect(await screen.findByRole('complementary', { name: 'Bruno, Backend engineer' })).toBeInTheDocument();
  });

  it.each([
    ['en', ['Rita, Code reviewer, passed', 'Rex, Code reviewer, found what blocks', 'Tom, Test engineer, checking now', 'Sam, Security engineer, did not check']],
    ['ru', ['Rita, Ревьюер кода, пропустил', 'Rex, Ревьюер кода, нашел, что блокирует', 'Tom, Инженер по тестам, проверяет сейчас', 'Sam, Инженер безопасности, не проверял']],
  ])('shows the review of a turn with every reviewer checking at once, in %s', async (language, rows) => {
    localStorage.setItem('hh-lang', language);
    const user = userEvent.setup();
    const review = {
      ...TASK_DETAIL,
      title: 'Review of turn 4',
      turnReview: true,
      stage: 1,
      gates: [
        { ...TASK_DETAIL.gates[0]!, state: 'passed' as const },
        { ...TASK_DETAIL.gates[0]!, id: 'b5', name: 'Rex', state: 'returned' as const },
        { ...TASK_DETAIL.gates[1]!, state: 'current' as const },
        { ...TASK_DETAIL.gates[2]!, state: 'skipped' as const },
      ],
    };
    shell({ 'GET /api/tasks?status=all': [200, { tasks: [{ ...TASKS[0]!, title: 'Review of turn 4' }] }], 'GET /api/tasks/t12': [200, { task: review }] });
    await user.click(await screen.findByRole('button', { name: /^(Tasks|Задачи)/ }));
    await user.click(await screen.findByRole('button', { name: /#12/ }));
    const panel = await screen.findByRole('complementary', { name: '#12 Review of turn 4' });
    const gates = within(panel).getByRole('list', { name: language === 'ru' ? 'Ворота' : 'Gates' });
    /* The head gave the work and gets the verdicts: no executor row. */
    expect(within(gates).getAllByRole('listitem').map(li => li.textContent)).toEqual(rows);
    localStorage.removeItem('hh-lang');
  });

  it('opens with where it stands at its gates, its brief, body, subtasks and log', async () => {
    const user = userEvent.setup();
    shell();
    const panel = await openTask(user);
    const gates = within(panel).getByRole('list', { name: 'Gates' });
    expect(within(gates).getAllByRole('listitem').map(li => li.textContent)).toEqual(['Bruno, Backend engineer, did the work', 'Rita, Code reviewer, passed', 'Tom, Test engineer, checking now', 'Sam, Security engineer, next']);
    expect(panel).toHaveTextContent('Take card payments.');
    expect(within(panel).getByText('card token').tagName).toBe('STRONG');
    expect(within(panel).getByRole('button', { name: /#13 Refunds/ })).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: /#10 Payments/ })).toBeInTheDocument();
    const log = within(panel).getByRole('list', { name: 'Log' });
    expect(within(log).getAllByRole('listitem').map(li => li.textContent)).toEqual([
      expect.stringContaining('Dana gave the task'),
      expect.stringMatching(/Bruno handed it in.*Endpoint done.*npm test: 42 passed/),
      expect.stringMatching(/Rita passed it.*Looks right./),
      expect.stringMatching(/Ivan commented.*EUR only./),
    ]);
  });

  it('says what it comes after and that it waits for them, in each language', async () => {
    const waiting = {
      ...TASK_DETAIL,
      status: 'open' as const,
      stage: 0,
      waitsFor: [11],
      after: [
        { id: 't9', number: 9, title: 'Pick a payment provider', status: 'done' as const },
        { id: 't11', number: 11, title: 'Cart page', status: 'working' as const },
      ],
      log: [...TASK_DETAIL.log, { kind: 'started', text: '#9 is done, so it starts now.', data: {}, by: null, at: '2026-10-30T09:00:00.000Z' }],
    };
    for (const [lang, words] of [
      ['en', { gates: 'Gates', first: 'Bruno, Backend engineer, waits for #11', after: 'Starts after', done: 'Done', started: 'Hornhoof started it once what it waited for was done' }],
      ['ru', { gates: 'Ворота', first: 'Bruno, Бэкенд-разработчик, ждет #11', after: 'Начнется после', done: 'Готова', started: 'Hornhoof запустил ее, когда то, чего она ждала, было готово' }],
    ] as const) {
      localStorage.setItem('hh-lang', lang);
      const user = userEvent.setup();
      mockApi({
        'GET /api/org': [200, DEV_ORG],
        'GET /api/requests': [200, decisions([])],
        'GET /api/turns': [200, { turns: [TURN] }],
        'GET /api/tasks?status=all': [200, { tasks: TASKS }],
        'GET /api/tasks/t12': [200, { task: waiting }],
      });
      const { unmount } = render(
        <LanguageProvider>
          <Shell me={ME} onSignOut={() => {}} />
        </LanguageProvider>,
      );
      await user.click(await screen.findByRole('button', { name: lang === 'en' ? /^Tasks/ : /^Задачи/ }));
      await user.click(await screen.findByRole('button', { name: /#12/ }));
      const panel = await screen.findByRole('complementary', { name: '#12 Checkout API' });
      const gates = within(panel).getByRole('list', { name: words.gates });
      expect(within(gates).getAllByRole('listitem')[0]!.textContent).toBe(words.first);
      const after = within(panel).getByRole('region', { name: words.after });
      expect(within(after).getAllByRole('listitem').map(li => li.textContent)).toEqual([expect.stringMatching(new RegExp(`#9 Pick a payment provider.*${words.done}`)), expect.stringContaining('#11 Cart page')]);
      expect(within(after).getByRole('button', { name: /#11 Cart page/ })).toBeInTheDocument();
      expect(panel).toHaveTextContent(words.started);
      unmount();
      localStorage.removeItem('hh-lang');
    }
  });

  it('says in its log, in each language, why a node restart cut a turn off, the retry, and who was called when it happened again', async () => {
    const bruno = { kind: 'agent' as const, id: 'b1', name: 'Bruno' };
    const first = 'aaaaaaaa-0000-4000-8000-000000000001';
    const retry = 'bbbbbbbb-0000-4000-8000-000000000002';
    const cut = {
      ...TASK_DETAIL,
      log: [
        ...TASK_DETAIL.log,
        { kind: 'interrupted', text: `Bruno's turn ${first} was cut off.`, data: { job: first, cause: 'program', at: '2026-11-03T00:11:00.000Z', node: { id: null, name: 'the built-in node' }, retry: { job: retry, n: 1, of: 1 } }, by: bruno, at: '2026-11-03T00:11:00.000Z' },
        { kind: 'interrupted', text: `Bruno's turn ${retry} was cut off.`, data: { job: retry, cause: 'container', at: '2026-11-03T00:20:00.000Z', node: { id: 'n1', name: 'ivan-mbp' }, first: { job: first, cause: 'program', at: '2026-11-03T00:11:00.000Z' }, called: { id: 'r1', name: 'Rob' } }, by: bruno, at: '2026-11-03T00:20:00.000Z' },
      ],
    };
    for (const [lang, words] of [
      ['en', { title: "Bruno's turn was cut off by a node restart", first: ['The built-in node, ', 'Its program started again after a crash or a restart of its container.', 'Turn aaaaaaaa.', 'Retry 1 of 1.'], again: ['ivan-mbp, ', 'Its container was created again, as an update of Hornhoof or a new install does.', 'Turn bbbbbbbb.', 'The retry was cut off too, so it is not run a third time. Rob of Operations was called.'] }],
      ['ru', { title: 'Ход Bruno прерван перезапуском ноды', first: ['Встроенная нода, ', 'Ее программа перезапустилась после сбоя или перезапуска контейнера.', 'Ход aaaaaaaa.', 'Повтор 1 из 1.'], again: ['ivan-mbp, ', 'Ее контейнер создан заново: так бывает при обновлении Hornhoof или новой установке.', 'Ход bbbbbbbb.', 'Повтор тоже прерван, третьего запуска нет. Позвали Rob из Операций.'] }],
    ] as const) {
      localStorage.setItem('hh-lang', lang);
      const user = userEvent.setup();
      shell({ 'GET /api/tasks/t12': [200, { task: cut }] });
      await user.click(await screen.findByRole('button', { name: lang === 'en' ? /^Tasks/ : /^Задачи/ }));
      await user.click(await screen.findByRole('button', { name: /#12/ }));
      const panel = await screen.findByRole('complementary', { name: '#12 Checkout API' });
      await within(panel).findAllByRole('listitem');
      const lines = within(panel).getAllByRole('listitem').map(li => li.textContent!).filter(text => text.includes(words.title));
      expect(lines).toHaveLength(2);
      for (const said of words.first) expect(lines[0]).toContain(said);
      for (const said of words.again) expect(lines[1]).toContain(said);
      expect(panel).not.toHaveTextContent('was cut off.');
      cleanup();
      localStorage.removeItem('hh-lang');
    }
  });

  it('says its executor puts the work together with the rest of the turn once every gate passed it', async () => {
    const user = userEvent.setup();
    const gates = TASK_DETAIL.gates.map(g => ({ ...g, state: 'passed' as const }));
    shell({ 'GET /api/tasks/t12': [200, { task: { ...TASK_DETAIL, status: 'open', stage: 0, merging: true, gates } }] });
    const panel = await openTask(user);
    const list = within(panel).getByRole('list', { name: 'Gates' });
    expect(within(list).getAllByRole('listitem')[0]!.textContent).toBe('Bruno, Backend engineer, puts the work together with the rest of the turn');
  });

  it('posts a comment', async () => {
    const user = userEvent.setup();
    const calls = shell({ 'POST /api/tasks/t12/comments': [201, { task: TASK_DETAIL }] });
    const panel = await openTask(user);
    await user.type(within(panel).getByLabelText('Comment'), 'Ship it today.');
    await user.click(within(panel).getByRole('button', { name: 'Add comment' }));
    expect(calls.find(c => c.path === '/api/tasks/t12/comments')?.body).toEqual({ text: 'Ship it today.' });
  });

  it('asks before cancelling a task and the tasks under it', async () => {
    const user = userEvent.setup();
    const calls = shell({ 'POST /api/tasks/t12/cancel': [200, { task: { ...TASK_DETAIL, status: 'cancelled' } }] });
    const panel = await openTask(user);
    await user.click(within(panel).getByRole('button', { name: 'Cancel task' }));
    expect(calls.some(c => c.path === '/api/tasks/t12/cancel')).toBe(false);
    expect(panel).toHaveTextContent('Cancel #12 and its open subtasks?');
    await user.click(within(panel).getByRole('button', { name: 'Yes, cancel it' }));
    expect(calls.some(c => c.method === 'POST' && c.path === '/api/tasks/t12/cancel')).toBe(true);
  });

  it('opens a subtask from the list', async () => {
    const user = userEvent.setup();
    shell({ 'GET /api/tasks/t13': [200, { task: { ...TASK_DETAIL, id: 't13', number: 13, title: 'Refunds', subtasks: [], parent: { id: 't12', number: 12, title: 'Checkout API' } } }] });
    const panel = await openTask(user);
    await user.click(within(panel).getByRole('button', { name: /#13 Refunds/ }));
    expect(await screen.findByRole('complementary', { name: '#13 Refunds' })).toBeInTheDocument();
  });

  it('closes with its cross and with Escape', async () => {
    const user = userEvent.setup();
    shell();
    await user.click(within(await openTask(user)).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('complementary', { name: '#12 Checkout API' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /#12/ }));
    await screen.findByRole('complementary', { name: '#12 Checkout API' });
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('complementary', { name: '#12 Checkout API' })).not.toBeInTheDocument();
  });
});
