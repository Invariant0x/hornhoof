import { taskRoute } from './task-route';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { MaterialManifest } from '../src/types';
import { afterEach, describe, expect, it } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import { Shell } from '../src/screens/Shell';
import { openFromBoard } from './open-task';
import { CARD, decisions, DEV_ORG, MACHINES, ME, mockApi, REQUESTS, RUNNING_AGENTS, SUBS, TASK_DETAIL, TASKS, TURN } from './api-mock';

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
  await user.click(await screen.findByRole('button', { name: /^(Tasks|Задачи)/ }));
  await openFromBoard(user, /#12/);
  return screen.findByRole('complementary', { name: '#12 Checkout API' });
}

describe('a task', () => {
  it('lets an authorized person hide an existing secret, then clears the input', async () => {
    const user = userEvent.setup();
    const task = { ...TASK_DETAIL, mayHideSecret: true, body: 'OldMarker1077!' };
    const calls = shell({
      'GET /api/tasks/t12': [200, { task }],
      'POST /api/tasks/t12/hide-secret': [200, { task: { ...task, body: '[hidden]' } }],
    });
    const panel = await openTask(user);
    await user.click(within(panel).getAllByRole('button', { name: 'Hide secret' })[0]!);
    await user.type(within(panel).getByLabelText('Secret to hide'), 'OldMarker1077!');
    await user.click(within(panel).getByRole('button', { name: 'Hide everywhere' }));
    await waitFor(() => expect(calls.some(c => c.path === '/api/tasks/t12/hide-secret')).toBe(true));
    await waitFor(() => expect(within(panel).queryByLabelText('Secret to hide')).not.toBeInTheDocument());
  });

  it('does not offer secret hiding without permission from the server', async () => {
    const user = userEvent.setup();
    shell();
    const panel = await openTask(user);
    expect(within(panel).queryByRole('button', { name: 'Hide secret' })).not.toBeInTheDocument();
  });

  it('clears a secret after a failed request and lets the person cancel', async () => {
    const user = userEvent.setup();
    shell({
      'GET /api/tasks/t12': [200, { task: { ...TASK_DETAIL, mayHideSecret: true } }],
      'POST /api/tasks/t12/hide-secret': [403, { error: { code: 'forbidden', message: 'Access changed.' } }],
    });
    const panel = await openTask(user);
    await user.click(within(panel).getAllByRole('button', { name: 'Hide secret' })[0]!);
    const input = within(panel).getByLabelText('Secret to hide');
    expect(within(panel).getByRole('button', { name: 'Hide everywhere' })).toBeDisabled();
    await user.type(input, 'OldMarker1077!');
    await user.click(within(panel).getByRole('button', { name: 'Hide everywhere' }));
    expect(await within(panel).findByRole('alert')).toHaveTextContent('The secret could not be hidden.');
    expect(input).toHaveValue('');
    await user.click(within(panel).getByRole('button', { name: /^Cancel$/ }));
    expect(within(panel).queryByLabelText('Secret to hide')).not.toBeInTheDocument();
  });
  afterEach(() => localStorage.removeItem('hh-lang'));
  it.each([
    ['en', { workKind: 'bug', riskClass: 'money' }, 'Bug, risk: money'],
    ['ru', { workKind: 'legacy_code', riskClass: 'none' }, 'Старый код, риск: нет'],
    ['en', { workKind: 'unknown_path', riskClass: null }, 'Unknown path'],
    ['en', { workKind: null, riskClass: 'data' }, 'risk: data'],
  ])('names its kind and risk class in %s', async (language, labels, line) => {
    localStorage.setItem('hh-lang', language);
    const user = userEvent.setup();
    shell({ 'GET /api/tasks/t12': [200, { task: { ...TASK_DETAIL, ...labels } }] });
    await user.click(await screen.findByRole('button', { name: /^(Tasks|Задачи)/ }));
    await openFromBoard(user, /#12/);
    const panel = await screen.findByRole('complementary', { name: '#12 Checkout API' });
    expect(within(panel).getByText(line)).toHaveClass('tp-kind');
  });

  it.each([{}, { workKind: null, riskClass: null }])('has no line of kind and risk without them: %j', async labels => {
    const user = userEvent.setup();
    shell({ 'GET /api/tasks/t12': [200, { task: { ...TASK_DETAIL, ...labels } }] });
    const panel = await openTask(user);
    expect(panel.querySelector('.tp-kind')).toBeNull();
  });

  it.each([
    ['en', 'Run skipped: task is already closed.', ['resume after a restart', 'merge', 'continue after the program ended', 'assignment']],
    ['ru', 'Запуск пропущен: задача уже закрыта.', ['возобновление после перезапуска', 'слияние', 'продолжение после выхода программы', 'назначение']],
  ])('shows who was not woken and by which run in %s', async (language, heading, actions) => {
    localStorage.setItem('hh-lang', language);
    const user = userEvent.setup();
    const log = ['restart', 'merge', 'continue', 'assigned'].map((wake, i) => ({ kind: 'wake_skipped', text: 'Server fallback.', data: { wake, job: i === 0 ? 'abcdefgh-0000' : null }, by: { kind: 'agent' as const, id: 'b1', name: 'Bruno' }, at: '2026-11-03T21:00:00.000Z' }));
    shell({ 'GET /api/tasks/t12': [200, { task: { ...TASK_DETAIL, status: 'done', log } }] });
    await user.click(await screen.findByRole('button', { name: /^(Tasks|Задачи)/ }));
    await openFromBoard(user, /#12/);
    const panel = await screen.findByRole('complementary', { name: '#12 Checkout API' });
    const lines = within(within(panel).getByRole('list', { name: language === 'ru' ? 'Журнал' : 'Log' })).getAllByRole('listitem');
    expect(lines).toHaveLength(4);
    for (const [i, line] of lines.entries()) expect(line).toHaveTextContent(`${heading} Bruno: ${actions[i]}.`);
    expect(lines[0]).toHaveTextContent('abcdefgh-0000');
    expect(panel).not.toHaveTextContent('Server fallback.');
  });

  it.each([
    ['en', 'Wake-up became obsolete: the task moved on. Bruno: merge.'],
    ['ru', 'Побудка устарела: задача ушла дальше. Bruno: слияние.'],
  ])('shows an obsolete wake in the task log in %s', async (language, expected) => {
    localStorage.setItem('hh-lang', language);
    const user = userEvent.setup();
    const log = [{ kind: 'wake_obsolete', text: 'Server fallback.', data: { wake: 'merge', job: null }, by: { kind: 'agent' as const, id: 'b1', name: 'Bruno' }, at: '2026-11-03T21:00:00.000Z' }];
    shell({ 'GET /api/tasks/t12': [200, { task: { ...TASK_DETAIL, log } }] });
    await user.click(await screen.findByRole('button', { name: /^(Tasks|Задачи)/ }));
    await openFromBoard(user, /#12/);
    const panel = await screen.findByRole('complementary', { name: '#12 Checkout API' });
    const logList = within(panel).getByRole('list', { name: language === 'ru' ? 'Журнал' : 'Log' });
    expect(within(logList).getByRole('listitem')).toHaveTextContent(expected);
    expect(panel).not.toHaveTextContent('Server fallback.');
  });

  it.each(['en', 'ru'])('shows an external wait with its reason and deadline in %s, then clears it after a comment', async language => {
    localStorage.setItem('hh-lang', language);
    const user = userEvent.setup();
    const externalWait = { reason: 'Images on the registry', since: '2026-11-03T10:00:00.000Z', until: '2026-11-03T11:30:00.000Z' };
    shell({ 'GET /api/tasks/t12': [200, { task: { ...TASK_DETAIL, externalWait } }] });
    await user.click(await screen.findByRole('button', { name: /^(Tasks|Задачи)/ }));
    await openFromBoard(user, /#12/);
    const panel = await screen.findByRole('complementary', { name: '#12 Checkout API' });
    const clock = new Date(externalWait.until).toLocaleTimeString(language === 'ru' ? 'ru-RU' : 'en-GB', { hour: '2-digit', minute: '2-digit' });
    const text = language === 'ru' ? `ждет: Images on the registry, до ${clock}` : `waits: Images on the registry, until ${clock}`;
    expect(within(panel).getByText(text)).toHaveClass('muted');
    mockApi({ 'POST /api/tasks/t12/comments': [201, { task: TASK_DETAIL }], 'GET /api/tasks/t12': [200, { task: { ...TASK_DETAIL, externalWait: null } }] });
    await user.type(within(panel).getByRole('textbox', { name: language === 'ru' ? 'Комментарий' : 'Comment' }), 'Images ready.');
    await user.click(within(panel).getByRole('button', { name: language === 'ru' ? 'Добавить комментарий' : 'Add comment' }));
    await waitFor(() => expect(within(panel).queryByText(text)).toBeNull());
    localStorage.removeItem('hh-lang');
  });

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
      'GET /api/agents/b1/events?last=300': [200, { events: [], state: { ready: true, reason: null, busy: false, runningJobId: null, queued: 0 } }],
    });
    await user.click(await screen.findByRole('button', { name: /^Tasks/ }));
    await user.click(within(await screen.findByRole('region', { name: 'Waiting for you' })).getByRole('button', { name: /#12/ }));
    const panel = await screen.findByRole('complementary', { name: '#12 Checkout API' });
    const waiting = await within(panel).findByRole('region', { name: 'Waiting for your answer' });
    await user.click(within(waiting).getByRole('button', { name: "Open Bruno's terminal" }));
    expect(await screen.findByRole('complementary', { name: 'Bruno, Backend engineer' })).toBeInTheDocument();
  });

  it.each(['en', 'ru'])('shows the current Review owner and ordered stages in %s', async language => {
    localStorage.setItem('hh-lang', language);
    const user = userEvent.setup();
    shell();
    const panel = await openTask(user);
    const workflow = within(panel).getByRole('list', { name: language === 'ru' ? 'Маршрут задачи' : 'Task workflow' });
    expect(within(workflow).getAllByRole('listitem').map(li => li.querySelector('b')!.textContent)).toEqual(['Architecture', 'Development', 'Review', 'Security', 'Tests']);
    expect(workflow.querySelector('[aria-current="step"]')).toHaveTextContent('Review');
    expect(workflow.querySelector('[aria-current="step"]')).toHaveTextContent(language === 'ru' ? 'Исполнитель: Rita' : 'Owner: Rita');
    expect(workflow).not.toHaveTextContent('Cleanup');
  });

  it('opens with its current workflow, brief, body, subtasks and log', async () => {
    const user = userEvent.setup();
    shell();
    const panel = await openTask(user);
    const workflow = within(panel).getByRole('list', { name: 'Task workflow' });
    expect(workflow.querySelector('[aria-current="step"]')).toHaveTextContent('Review In progressOwner: Rita');
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
      assignee: TASK_DETAIL.executor,
      echelons: { ...taskRoute(), phase: 'waiting' as const, ownerAgentId: null },
      waitsFor: [11],
      after: [
        { id: 't9', number: 9, title: 'Pick a payment provider', status: 'done' as const },
        { id: 't11', number: 11, title: 'Cart page', status: 'working' as const },
      ],
      log: [...TASK_DETAIL.log, { kind: 'started', text: '#9 is done, so it starts now.', data: {}, by: null, at: '2026-10-30T09:00:00.000Z' }],
    };
    for (const [lang, words] of [
      ['en', { workflow: 'Task workflow', phase: 'Waiting for an owner', after: 'Starts after', done: 'Done', started: 'Hornhoof started it once what it waited for was done' }],
      ['ru', { workflow: 'Маршрут задачи', phase: 'Нужен исполнитель', after: 'Начнется после', done: 'Готова', started: 'Hornhoof запустил ее, когда то, чего она ждала, было готово' }],
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
      await openFromBoard(user, /#12/);
      const panel = await screen.findByRole('complementary', { name: '#12 Checkout API' });
      const workflow = within(panel).getByRole('list', { name: words.workflow });
      expect(workflow.querySelector('[aria-current="step"]')).toHaveTextContent('Development');
      expect(within(panel).getByRole('status')).toHaveTextContent(words.phase);
      const after = within(panel).getByRole('region', { name: words.after });
      expect(within(after).getAllByRole('listitem').map(li => li.textContent)).toEqual([expect.stringMatching(new RegExp(`#9 Pick a payment provider.*${words.done}`)), expect.stringContaining('#11 Cart page')]);
      expect(within(after).getByRole('button', { name: /#11 Cart page/ })).toBeInTheDocument();
      expect(panel).toHaveTextContent(words.started);
      unmount();
      localStorage.removeItem('hh-lang');
    }
  });

  it('says in its log, in each language, for whom the orchestrator answered', async () => {
    const answered = {
      ...TASK_DETAIL,
      log: [{ kind: 'answered', text: 'Approved.', data: { onBehalfOfPersonId: 'p1' }, by: { kind: 'agent' as const, id: 'a1', name: 'Orchestrator', for: { id: 'p1', name: 'Ivan' } }, at: '2026-10-30T09:00:00.000Z' }],
    };
    for (const [lang, line] of [
      ['en', 'Orchestrator for Ivan answered'],
      ['ru', 'Оркестратор за Ivan ответил'],
    ] as const) {
      localStorage.setItem('hh-lang', lang);
      const user = userEvent.setup();
      mockApi({
        'GET /api/org': [200, DEV_ORG],
        'GET /api/requests': [200, decisions([])],
        'GET /api/turns': [200, { turns: [TURN] }],
        'GET /api/tasks?status=all': [200, { tasks: TASKS }],
        'GET /api/tasks/t12': [200, { task: answered }],
      });
      const { unmount } = render(
        <LanguageProvider>
          <Shell me={ME} onSignOut={() => {}} />
        </LanguageProvider>,
      );
      await user.click(await screen.findByRole('button', { name: lang === 'en' ? /^Tasks/ : /^Задачи/ }));
      await openFromBoard(user, /#12/);
      const panel = await screen.findByRole('complementary', { name: '#12 Checkout API' });
      expect(panel).toHaveTextContent(line);
      unmount();
      localStorage.removeItem('hh-lang');
    }
  });

  it('says in its log, in each language, that the machine of a turn is out of reach, and that it is back', async () => {
    const bruno = { kind: 'agent' as const, id: 'b1', name: 'Bruno' };
    const job = 'aaaaaaaa-0000-4000-8000-000000000001';
    const away = {
      ...TASK_DETAIL,
      log: [
        ...TASK_DETAIL.log,
        { kind: 'away', text: "Bruno's turn runs on dev-laptop, which Hornhoof cannot reach since 2026-11-03 00:11 UTC. The work there is kept.", data: { job, stage: 'away', holder: 'b1', host: 'dev-laptop', since: '2026-11-03T00:11:00.000Z' }, by: bruno, at: '2026-11-03T00:16:00.000Z' },
        { kind: 'away', text: "The server's own machine is in reach again; Bruno's turn goes on there.", data: { job, stage: 'back', holder: 'b1', host: null, since: '2026-11-03T01:00:00.000Z' }, by: bruno, at: '2026-11-03T01:00:00.000Z' },
        { kind: 'away', text: 'The turn that ran on dev-laptop is over.', data: { job, stage: 'ended', holder: 'b1', host: 'dev-laptop', since: '2026-11-03T02:00:00.000Z' }, by: bruno, at: '2026-11-03T02:00:00.000Z' },
      ],
    };
    for (const [lang, words] of [
      ['en', { title: 'A turn and its machine', ended: 'The turn that ran on dev-laptop is over.', gone: ['The turn runs on dev-laptop, which Hornhoof cannot reach since ', 'The work there is kept, and the turn goes on when the machine is back.'], back: 'The machine is in reach again, and the turn goes on there.' }],
      ['ru', { title: 'Ход и его машина', ended: 'Ход, который шел на машине dev-laptop, закончился.', gone: ['Ход идет на машине dev-laptop, с которой Hornhoof не может связаться с ', 'Работа там сохранена, и ход продолжится, когда машина вернется.'], back: 'Машина снова на связи, и ход продолжается там.' }],
    ] as const) {
      localStorage.setItem('hh-lang', lang);
      const user = userEvent.setup();
      shell({ 'GET /api/tasks/t12': [200, { task: away }] });
      await user.click(await screen.findByRole('button', { name: lang === 'en' ? /^Tasks/ : /^Задачи/ }));
      await openFromBoard(user, /#12/);
      const panel = await screen.findByRole('complementary', { name: '#12 Checkout API' });
      await within(panel).findAllByRole('listitem');
      const lines = within(panel).getAllByRole('listitem').map(li => li.textContent!).filter(text => text.includes(words.title));
      expect(lines).toHaveLength(3);
      for (const said of words.gone) expect(lines[0]).toContain(said);
      expect(lines[1]).toContain(words.back);
      expect(lines[2]).toContain(words.ended);
      /* The English lines kept for the agents are not what a person reads. */
      expect(panel).not.toHaveTextContent('The work there is kept.');
      cleanup();
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
        { kind: 'interrupted', text: `Bruno's turn ${retry} was cut off.`, data: { job: retry, cause: 'container', at: '2026-11-03T00:20:00.000Z', node: { id: 'n1', name: 'dev-laptop' }, first: { job: first, cause: 'program', at: '2026-11-03T00:11:00.000Z' }, called: { id: 'r1', name: 'Rob' } }, by: bruno, at: '2026-11-03T00:20:00.000Z' },
      ],
    };
    for (const [lang, words] of [
      ['en', { title: "Bruno's turn was cut off by a node restart", first: ['The built-in node, ', 'Its program started again after a crash or a restart of its container.', 'Turn aaaaaaaa.', 'Retry 1 of 1.'], again: ['dev-laptop, ', 'Its container was created again, as an update of Hornhoof or a new install does.', 'Turn bbbbbbbb.', 'The retry was cut off too, so it is not run a third time. Rob of Operations was called.'] }],
      ['ru', { title: 'Ход Bruno прерван перезапуском ноды', first: ['Встроенная нода, ', 'Ее программа перезапустилась после сбоя или перезапуска контейнера.', 'Ход aaaaaaaa.', 'Повтор 1 из 1.'], again: ['dev-laptop, ', 'Ее контейнер создан заново: так бывает при обновлении Hornhoof или новой установке.', 'Ход bbbbbbbb.', 'Повтор тоже прерван, третьего запуска нет. Позвали Rob из Операций.'] }],
    ] as const) {
      localStorage.setItem('hh-lang', lang);
      const user = userEvent.setup();
      shell({ 'GET /api/tasks/t12': [200, { task: cut }] });
      await user.click(await screen.findByRole('button', { name: lang === 'en' ? /^Tasks/ : /^Задачи/ }));
      await openFromBoard(user, /#12/);
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

  it('shows the verified candidate as ready for authorized integration', async () => {
    const user = userEvent.setup();
    const echelons = { ...TASK_DETAIL.echelons, phase: 'ready' as const, ownerAgentId: null,
      stages: TASK_DETAIL.echelons.stages.map(step => ({ ...step, status: step.status === 'skipped' ? 'skipped' as const : 'complete' as const })) };
    shell({ 'GET /api/tasks/t12': [200, { task: { ...TASK_DETAIL, assignee: null, echelons } }] });
    const panel = await openTask(user);
    expect(within(panel).getByRole('status')).toHaveTextContent('Ready to merge');
    expect(within(panel).getByRole('list', { name: 'Task workflow' })).not.toHaveTextContent('Owner:');
  });

  it('posts a comment', async () => {
    const user = userEvent.setup();
    const calls = shell({ 'POST /api/tasks/t12/comments': [201, { task: TASK_DETAIL }] });
    const panel = await openTask(user);
    await user.type(within(panel).getByRole('textbox', { name: 'Comment' }), 'Ship it today.');
    await user.click(within(panel).getByRole('button', { name: 'Add comment' }));
    expect(calls.find(c => c.path === '/api/tasks/t12/comments')?.body).toEqual({ text: 'Ship it today.' });
  });

  it('lets the CEO pause a task with a reason and shows it paused', async () => {
    const user = userEvent.setup();
    const paused = { at: '2026-11-09T05:00:00.000Z', reason: 'Wait for the release.', root: 't12', by: { personId: 'p1' } };
    const calls = shell({ 'GET /api/tasks/t12': [200, { task: { ...TASK_DETAIL, mayPause: true } }], 'PUT /api/tasks/t12/paused': [200, { task: { ...TASK_DETAIL, mayPause: true, paused } }] });
    const panel = await openTask(user);
    await user.click(within(panel).getByRole('button', { name: 'Pause' }));
    await user.type(within(panel).getByRole('textbox', { name: 'Why pause it' }), 'Wait for the release.');
    await user.click(within(panel).getByRole('button', { name: 'Yes, pause it' }));
    expect(calls.find(c => c.method === 'PUT' && c.path === '/api/tasks/t12/paused')?.body).toEqual({ paused: true, reason: 'Wait for the release.' });
  });

  it('shows a paused task and resumes it in one step, and hides both for those who may not', async () => {
    const user = userEvent.setup();
    const paused = { at: '2026-11-09T05:00:00.000Z', reason: 'Wait for the release.', root: 't12', by: { personId: 'p1' } };
    const calls = shell({ 'GET /api/tasks/t12': [200, { task: { ...TASK_DETAIL, mayPause: true, paused } }], 'PUT /api/tasks/t12/paused': [200, { task: { ...TASK_DETAIL, mayPause: true } }] });
    const panel = await openTask(user);
    expect(within(panel).getByText('Paused: Wait for the release. Nobody is woken on it until it is resumed.')).toBeTruthy();
    await user.click(within(panel).getByRole('button', { name: 'Resume' }));
    expect(calls.find(c => c.method === 'PUT' && c.path === '/api/tasks/t12/paused')?.body).toEqual({ paused: false, reason: '' });
  });

  it('offers no pause to a person who may not pause', async () => {
    const user = userEvent.setup();
    shell({ 'GET /api/tasks/t12': [200, { task: { ...TASK_DETAIL, mayPause: false } }] });
    const panel = await openTask(user);
    expect(within(panel).queryByRole('button', { name: 'Pause' })).toBeNull();
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

  it.each([
    ['en', 'Can start now'],
    ['ru', 'Можно начать сейчас'],
  ])('shows the independent part and its linked child in %s', async (language, heading) => {
    localStorage.setItem('hh-lang', language);
    const user = userEvent.setup();
    const independentPart = {
      title: 'Contract tests', brief: 'Test first.', body: 'Cover the API contract.',
      executor: { id: 'b1', name: 'Bruno', kind: 'worker' as const, role: null },
      task: { id: 't13', number: 13, title: 'Contract tests', status: 'open' as const },
    };
    shell({ 'GET /api/tasks/t12': [200, { task: { ...TASK_DETAIL, independentPart } }] });
    const panel = await openTask(user);
    const part = within(panel).getByRole('region', { name: heading });
    expect(part).toHaveTextContent('Cover the API contract.');
    expect(part).toHaveTextContent('Bruno');
    expect(within(part).getByRole('button', { name: '#13 Contract tests' })).toBeInTheDocument();
    expect(part).toHaveTextContent(language === 'ru' ? 'Не начата' : 'Not started');
  });

  it.each([
    ['en', 'Can start now'],
    ['ru', 'Можно начать сейчас'],
  ])('shows why no independent part exists in %s and nothing for an old task', async (language, heading) => {
    localStorage.setItem('hh-lang', language);
    const user = userEvent.setup();
    shell({ 'GET /api/tasks/t12': [200, { task: { ...TASK_DETAIL, independentPart: { reason: 'The same author owns every file.' } } }] });
    const panel = await openTask(user);
    expect(within(panel).getByRole('region', { name: heading })).toHaveTextContent('The same author owns every file.');
    expect(within(panel).getByRole('region', { name: heading })).not.toHaveTextContent('#13');
    expect(within(panel).getByRole('region', { name: heading })).not.toHaveTextContent('Bruno');
  });

  it('lists answered and open task questions with their authors and states', async () => {
    const user = userEvent.setup();
    const requests = [
      { id: 'q1', kind: 'question' as const, text: 'Use the existing token?', commit: null, status: 'answered', answer: 'Yes, keep it.', agent: null, at: '2026-11-03T10:00:00.000Z' },
      { id: 'q2', kind: 'choice' as const, text: 'Which layout ships?', commit: null, status: 'awaiting_review', answer: null, agent: { id: 'b1', name: 'Bruno', kind: 'worker' as const, role: null }, at: '2026-11-03T10:05:00.000Z' },
    ];
    shell({ 'GET /api/tasks/t12': [200, { task: { ...TASK_DETAIL, requests } }] });
    const panel = await openTask(user);
    const questions = within(panel).getByRole('heading', { name: 'Questions' }).closest('section')!;
    expect(questions).toHaveTextContent('Hornhoof: Use the existing token? answered');
    expect(questions).toHaveTextContent('Yes, keep it.');
    expect(questions).toHaveTextContent('Bruno: Which layout ships? awaiting_review');
    expect(questions).not.toHaveTextContent('undefined');
  });

  it('opens versioned materials without answering and sends their stamps only with the explicit answer', async () => {
    const user = userEvent.setup();
    const requestId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const fileId = '11111111-1111-4111-8111-111111111111';
    const linkId = '22222222-2222-4222-8222-222222222222';
    const materialDigest = 'a'.repeat(64);
    const materialRoot = `/api/requests/${requestId}/materials`;
    const manifest = {
      materialRevision: 1,
      materialDigest,
      common: [
        {
          id: fileId,
          name: 'Release notes.txt',
          kind: 'file',
          state: 'available',
          contentUrl: `${materialRoot}/${fileId}/content`,
          downloadUrl: `${materialRoot}/${fileId}/download`,
          size: 128,
          sha256: 'b'.repeat(64),
          mediaType: 'text/plain',
        },
        { id: linkId, name: 'Approved preview', kind: 'link', state: 'available', url: 'https://preview.example.com/result' },
      ],
      options: [],
    } satisfies MaterialManifest;
    const legacy: import('../src/types').WaitingRequest = { ...REQUESTS[0]!, materialRevision: null, materialDigest: null };
    const asked: import('../src/types').WaitingRequest = {
      ...legacy,
      id: requestId,
      task: { ...REQUESTS[0]!.task, id: 't12', number: 12, title: 'Checkout API' },
      materialRevision: 1,
      materialDigest,
      hasMaterials: true,
    };
    const calls = shell({
      'GET /api/requests': [200, decisions([asked])],
      [`GET ${materialRoot}`]: [200, manifest],
      [`POST /api/requests/${requestId}`]: [200, { request: { id: requestId, status: 'answered' } }],
    });
    await user.click(await screen.findByRole('button', { name: /^Tasks/ }));
    await user.click(within(await screen.findByRole('region', { name: 'Waiting for you' })).getByRole('button', { name: /#12/ }));
    const panel = await screen.findByRole('complementary', { name: '#12 Checkout API' });
    const waiting = await within(panel).findByRole('region', { name: 'Waiting for your answer' });
    await user.click(await within(waiting).findByRole('button', { name: /Release notes\.txt/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Release notes.txt' });
    const download = within(dialog).getByRole('link', { name: 'Download file' });
    download.addEventListener('click', event => event.preventDefault(), { once: true });
    await user.click(download);
    await user.click(within(dialog).getByRole('button', { name: 'Next' }));
    expect(await screen.findByRole('dialog', { name: 'Approved preview' })).toBeInTheDocument();
    const external = within(dialog).getByRole('link', { name: 'Open link' });
    expect(external).toHaveAttribute('href', 'https://preview.example.com/result');
    expect(external).toHaveAttribute('target', '_blank');
    external.addEventListener('click', event => event.preventDefault(), { once: true });
    await user.click(external);
    await user.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(calls.filter(call => call.method === 'POST')).toEqual([]);
    await user.type(within(waiting).getByLabelText('Your answer'), 'The result is ready.');
    await user.click(within(waiting).getByRole('button', { name: 'Send answer' }));
    expect(calls.find(call => call.method === 'POST')?.body).toEqual({ materialRevision: 1, materialDigest, answer: 'The result is ready.' });
  });

  it('forwards native proposal stamps from the decisions list to the material manifest loader', async () => {
    const user = userEvent.setup();
    const materialDigest = 'd'.repeat(64);
    const proposal: import('../src/types').ProposalDecision = {
      id: 'pr-native', kind: 'structure', agent: { id: 'a1', name: 'Orchestrator' }, department: null,
      brief: 'Build the approved structure.', at: '2026-11-03T10:00:00.000Z', ownerPersonId: 'p1', canAnswer: true,
      items: [{ template: 'design', checked: true, note: '' }], materialRevision: 1, materialDigest, hasMaterials: true,
    };
    const manifest = { materialRevision: 1, materialDigest, common: [], options: [] } satisfies MaterialManifest;
    const calls = shell({
      'GET /api/requests': [200, decisions([], { proposals: [proposal] })],
      'GET /api/proposals/pr-native/materials': [200, manifest],
    });
    await user.click(await screen.findByRole('button', { name: /^Tasks/ }));
    await waitFor(() => expect(calls.some(call => call.method === 'GET' && call.path === '/api/proposals/pr-native/materials')).toBe(true));
  });

  it('forwards native proposal stamps from the orchestrator window to the material manifest loader', async () => {
    const user = userEvent.setup();
    const materialDigest = 'e'.repeat(64);
    const agents = [{ ...RUNNING_AGENTS[0]!, id: 'a1', name: 'Orchestrator' }];
    const proposal = { proposalId: 'pr-window', brief: 'Build the approved structure.', items: [], materialRevision: 1, materialDigest };
    const manifest = { materialRevision: 1, materialDigest, common: [], options: [] } satisfies MaterialManifest;
    const calls = shell({
      'GET /api/subscriptions': [200, { subscriptions: [{ ...SUBS[0]!, agents }] }],
      'GET /api/machines': [200, { machines: [{ ...MACHINES[0]!, running: { agents, parts: [] } }] }],
      'GET /api/agents/orchestrator': [200, { ...CARD, id: 'a1', kind: 'orchestrator', name: 'Orchestrator', role: null, department: null }],
      'GET /api/agents/orchestrator/events?last=300': [200, { events: [{ seq: 1, kind: 'proposal', data: proposal, jobId: null, person: null, at: '2026-11-03T10:00:00.000Z' }], state: { ready: true, reason: null, busy: false, runningJobId: null, queued: 0 } }],
      'POST /api/agents/orchestrator/start': [200, { started: false }],
      'GET /api/proposals/pr-window/materials': [200, manifest],
    });
    await user.click(await screen.findByRole('button', { name: 'Machines' }));
    await user.click(await screen.findByRole('button', { name: 'Open the card of dev-laptop' }));
    await user.click(screen.getByRole('button', { name: 'Open Orchestrator' }));
    await waitFor(() => expect(calls.some(call => call.method === 'GET' && call.path === '/api/proposals/pr-window/materials')).toBe(true));
  });

  it('closes with its cross and with Escape', async () => {
    const user = userEvent.setup();
    shell();
    await user.click(within(await openTask(user)).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('complementary', { name: '#12 Checkout API' })).not.toBeInTheDocument();
    await openFromBoard(user, /#12/);
    await screen.findByRole('complementary', { name: '#12 Checkout API' });
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('complementary', { name: '#12 Checkout API' })).not.toBeInTheDocument();
  });
});

describe('a task whose holder has its machine offline', () => {
  afterEach(() => localStorage.removeItem('hh-lang'));
  const SINCE = '2026-11-13T18:07:00.000Z';
  const at = (locale: string) => new Date(SINCE).toLocaleString(locale, { dateStyle: 'short', timeStyle: 'short' });

  it.each([
    ['en', `Machine workstation-eu is offline since ${at('en-GB')}.`],
    ['ru', `Машина workstation-eu не в сети с ${at('ru-RU')}.`],
  ])('says which machine is offline and since when, in %s', async (language, line) => {
    localStorage.setItem('hh-lang', language);
    const user = userEvent.setup();
    shell({ 'GET /api/tasks/t12': [200, { task: { ...TASK_DETAIL, assigneeOffline: { hostname: 'workstation-eu', since: SINCE } } }] });
    const panel = await openTask(user);
    expect(await within(panel).findByText(line)).toBeInTheDocument();
  });

  it('says nothing of a machine while the holder can run', async () => {
    const user = userEvent.setup();
    shell({ 'GET /api/tasks/t12': [200, { task: { ...TASK_DETAIL, assigneeOffline: null } }] });
    const panel = await openTask(user);
    await within(panel).findByText(/Checkout API/);
    expect(within(panel).queryByText(/is offline/)).not.toBeInTheDocument();
  });
});
