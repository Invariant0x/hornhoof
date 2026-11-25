import { taskRoute } from './task-route';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { MaterialManifest } from '../src/types';
import { afterEach, describe, expect, it } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import { en } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import { Shell } from '../src/screens/Shell';
import { openFromTracker, openTaskAction } from './open-task';
import { CARD, decisions, DEV_ORG, MACHINES, ME, mockApi, REQUESTS, RUNNING_AGENTS, SUBS, TASK_DETAIL, TASKS, TURN } from './api-mock';
import { decl } from './css';

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
  await openFromTracker(user, 12);
  return screen.findByRole('complementary', { name: '#12 Checkout API' });
}

describe('the simple task card', () => {
  it('titles the card in the 20 px display type of the mockup and wraps a long title', async () => {
    const user = userEvent.setup();
    const title = 'Keep every part of a task visible, including a long title and its actions';
    shell({ 'GET /api/tasks/t12': [200, { task: { ...TASK_DETAIL, title } }] });
    await user.click(await screen.findByRole('button', { name: 'Tasks' }));
    await openFromTracker(user, 12);
    const panel = within(await screen.findByRole('complementary', { name: `#12 ${title}` }));
    const heading = panel.getByRole('heading', { name: title });
    expect.soft(heading).toHaveClass('tp-heading');
    expect.soft(heading.tagName).toBe('H2');
    expect.soft(decl('.tp-heading', 'font')).toBe('600 20px/1.25 var(--f-display)');
    expect(decl('.tp-heading', 'overflow-wrap')).toBe('anywhere');
  });

  it('shows the path, kind, title, status, why and facts at the top, then the brief, body, subtasks and history', async () => {
    const user = userEvent.setup();
    shell({ 'GET /api/tasks/t12': [200, { task: {
      ...TASK_DETAIL, why: 'Accept card payments.', responsible: { id: 'p1', name: 'Ivan' }, askedBy: { id: 'p2', name: 'Oleg' }, dueAt: '2099-11-20T00:00:00.000Z',
      time: { inStatusSince: '2026-11-10T09:00:00.000Z', workSeconds: 0, waitsOn: [] },
    } }] });
    const panel = await openTask(user);
    const card = within(panel);
    /* The bar names the kind and number, without the window lights. */
    expect(panel.querySelector('.t-bar')).toHaveTextContent('Subtask #12');
    expect(panel.querySelector('.t-bar .lights')).toBeNull();
    const path = card.getByRole('navigation', { name: 'Where it belongs' });
    expect(within(path).getByRole('button', { name: '#10 Payments' })).toBeInTheDocument();
    const kind = card.getByText('Subtask', { selector: '.tp-kind' });
    const pill = card.getByText('Review', { selector: '.tr-status-pill' });
    expect(pill).toHaveClass('review');
    const facts = card.getByRole('group', { name: 'Facts' });
    /* Whose request it is and who decides are two facts, in this order. */
    expect(within(facts).getByRole('definition', { name: 'Asked by' })).toHaveTextContent('Oleg');
    expect(within(facts).getByRole('definition', { name: 'Decides' })).toHaveTextContent('Ivan');
    expect(within(facts).queryByRole('definition', { name: 'Waits for' })).not.toBeInTheDocument();
    expect(within(facts).getByRole('definition', { name: 'Decides' }).querySelector('.tr-avatar')).toBeInTheDocument();
    expect(within(facts).getByRole('definition', { name: 'Executor' })).toHaveTextContent('Bruno');
    expect(within(facts).getByRole('definition', { name: 'Due' })).toHaveTextContent(/^20 Nov · Review for/);
    const subtasks = card.getByRole('region', { name: 'Subtasks' });
    expect(within(subtasks).getByRole('heading', { name: 'Subtasks · 0 of 1' })).toBeInTheDocument();
    expect(within(subtasks).getByRole('link', { name: '#13 Refunds' })).toBeInTheDocument();
    const content = [path, kind, card.getByRole('heading', { name: 'Checkout API' }), pill, card.getByText('Accept card payments.'), facts,
      card.getByRole('button', { name: 'Graph from here' }), card.getByText('Take card payments.'), card.getByText('card token'), subtasks, card.getByRole('list', { name: 'Log' })];
    for (const [index, element] of content.slice(1).entries()) {
      expect(content[index]!.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    expect(card.getAllByRole('heading').map(heading => heading.textContent)).toEqual(['Checkout API', 'Subtasks · 0 of 1', 'History']);
    for (const [i, name] of ['Close', '#10 Payments', 'Task actions', 'Graph from here'].entries()) expect(card.getAllByRole('button')[i]).toHaveAccessibleName(name);
    expect(card.getAllByRole('button')).toHaveLength(4);
  });

  it.each([
    [0, 'Turn 44, once a person starts it'],
    [1, 'The next turn, after turn 44'],
    [2, 'The turn after next, after turn 44'],
    [3, 'The turn 3 turns ahead, after turn 44'],
  ])('says which turn a queued task waits for, %i turns ahead', async (ahead, text) => {
    const user = userEvent.setup();
    shell({ 'GET /api/tasks/t12': [200, { task: { ...TASK_DETAIL, assignee: null, queue: { ahead, position: ahead, openTurn: 44 } } }] });
    const facts = within(within(await openTask(user)).getByRole('group', { name: 'Facts' }));
    expect(facts.getByRole('definition', { name: 'Waits for' })).toHaveTextContent(text);
  });

  it('draws the card as the mockup drawer beside the tracker and the full screen on a phone', () => {
    const drawer = '.body.tracker-page ~ .acard.at-end';
    expect.soft(decl(':root', '--tracker-card-size')).toBe('460px');
    expect.soft(decl(':root', '--tracker-strips-room')).toBe('32px');
    expect.soft(decl(drawer, 'inline-size', '(min-width: 761px)')).toBe('var(--tracker-card-size)');
    expect.soft(decl(drawer, 'inset-inline-end', '(min-width: 761px)')).toBe('0');
    /* The page ends where the card starts, so the work reflows beside it instead of running under it. */
    expect.soft(decl('.body.tracker-page:has(~ .acard.at-end)', 'inset-inline-end', '(min-width: 761px)')).toBe('var(--tracker-card-size)');
    /* Minimized windows keep their strips at the right edge in reach beside it, and the page ends before both. */
    expect.soft(decl('.shell:has(.agent-strips:not(:empty)) .body.tracker-page ~ .acard.at-end:dir(ltr)', 'inset-inline-end', '(min-width: 761px)')).toBe('var(--tracker-strips-room)');
    expect.soft(decl('.shell:has(.agent-strips:not(:empty)) .body.tracker-page:has(~ .acard.at-end):dir(ltr)', 'inset-inline-end', '(min-width: 761px)'))
      .toBe('calc(var(--tracker-card-size) + var(--tracker-strips-room))');
    expect.soft(decl(drawer, 'border-inline-start', '(min-width: 761px)')).toBe('1px solid var(--line2)');
    expect.soft(decl(drawer, 'inset', '(max-width: 760px)')).toBe('68px 0 0');
    expect.soft(decl('.body.with-task .tracker', 'padding-inline-end', '(min-width: 1100px)')).toBeUndefined();
    expect.soft(decl('.acard.plain > .t-bar', 'min-block-size')).toBe('38px');
    expect.soft(decl('.acard.plain > .ac-body', 'padding')).toBe('16px 18px 24px');
    expect.soft(decl('.acard.plain > .ac-body', 'gap')).toBe('16px');
    expect.soft(decl('.tp-kind', 'font')).toBe('600 11px var(--f-body)');
    expect.soft(decl('.tp-kind', 'letter-spacing')).toBe('.06em');
    expect.soft(decl('.tp-card-facts', 'gap')).toBe('7px 10px');
    expect.soft(decl('.tp-card-facts', 'font-size')).toBe('13px');
    expect.soft(decl('.tp-sec > h3', 'font')).toBe('600 13px var(--f-display)');
    expect.soft(decl('.gbtn', 'min-block-size')).toBe('32px');
    expect(decl('.tp-row', 'border-block-end')).toBe('1px solid var(--line)');
  });

  it('folds a long description and opens it with one More control', async () => {
    const user = userEvent.setup();
    const body = ['Start with a **card token**.', 'Check the amount.', 'Record the payment.', 'Return the receipt.'].join('\n\n');
    shell({ 'GET /api/tasks/t12': [200, { task: { ...TASK_DETAIL, body } }] });
    const card = within(await openTask(user));
    expect(card.getByText('card token').tagName).toBe('STRONG');
    expect(card.queryByText('Return the receipt.')).not.toBeInTheDocument();
    const more = card.getByRole('button', { name: 'More' });
    expect(more).toHaveAttribute('aria-expanded', 'false');
    await user.click(more);
    expect(card.getByText('Return the receipt.')).toBeInTheDocument();
    await user.click(card.getByRole('button', { name: 'Show less' }));
    expect(card.queryByText('Return the receipt.')).not.toBeInTheDocument();
  });

  it('shows the latest four plain steps in time order and opens earlier steps without internal wake-ups', async () => {
    const user = userEvent.setup();
    const log = [...TASK_DETAIL.log, { ...TASK_DETAIL.log[3]!, text: 'Receipt sent.', at: '2026-10-30T08:55:00.000Z' }, {
      kind: 'wake_obsolete', text: 'An internal wake-up', data: { wake: 'merge' }, by: null, at: '2026-10-30T09:00:00.000Z',
    }].reverse();
    shell({ 'GET /api/tasks/t12': [200, { task: { ...TASK_DETAIL, log } }] });
    const card = within(await openTask(user));
    const rows = () => within(card.getByRole('list', { name: 'Log' })).getAllByRole('listitem');
    expect(rows().map(row => row.firstElementChild?.tagName)).toEqual(['TIME', 'TIME', 'TIME', 'TIME']);
    expect(rows()[0]).toHaveTextContent('Bruno handed it in');
    expect(rows()[3]).toHaveTextContent('Ivan commented: Receipt sent.');
    await user.click(card.getByRole('button', { name: 'Earlier steps' }));
    expect(rows()).toHaveLength(5);
    expect(rows()[0]).toHaveTextContent('Dana gave the task');
    expect(rows()[4]).toHaveTextContent('Ivan commented: Receipt sent.');
  });

  it('shows only the question this person can answer and puts it after the log', async () => {
    const user = userEvent.setup();
    const task = { ...REQUESTS[0]!.task, id: 't12', number: 12, title: TASK_DETAIL.title };
    const mine = { ...REQUESTS[0]!, task };
    const theirs = { ...mine, id: 'r-elsewhere', ownerPersonId: 'p2', canAnswer: false, text: 'A question for someone else.' };
    const log = [mine, theirs].map(request => ({ kind: 'asked', text: request.text, data: { kind: request.kind }, by: null, at: request.at }));
    shell({ 'GET /api/requests': [200, decisions([mine, theirs])], 'GET /api/tasks/t12': [200, { task: { ...TASK_DETAIL, log } }] });
    const panel = await openTask(user);
    const card = within(panel);
    const question = card.getByRole('region', { name: 'Waiting for your answer' });
    expect(card.getByRole('list', { name: 'Log' }).compareDocumentPosition(question) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(question).toHaveTextContent(mine.text);
    expect(within(question).getByRole('textbox', { name: 'Your answer' })).toBeEnabled();
    expect(panel).not.toHaveTextContent(theirs.text);
    expect(card.getByRole('list', { name: 'Log' })).toHaveTextContent('asked a person');
    expect(card.getByRole('list', { name: 'Log' })).not.toHaveTextContent(mine.text);
  });

  it("does not address the viewer as 'you' on another person's request opened in the task panel", async () => {
    const user = userEvent.setup();
    const task = { ...REQUESTS[0]!.task, id: 't12', number: 12, title: TASK_DETAIL.title };
    const forMaria = {
      ...REQUESTS[0]!,
      id: 'r-maria-choice',
      kind: 'choice' as const,
      text: 'Pick a layout for Design.',
      options: [{ label: 'Compact', image: null }, { label: 'Wide', image: null }],
      ownerPersonId: 'p2',
      canAnswer: true,
      task,
    };
    shell({ 'GET /api/requests': [200, decisions([forMaria])], 'GET /api/tasks/t12': [200, { task: TASK_DETAIL }] });
    const panel = await openTask(user);
    const header = within(panel).getByRole('article', { name: `#12 ${TASK_DETAIL.title}` }).querySelector('header')!;
    expect(header).toHaveTextContent('Dana asks for a choice');
    expect(header).not.toHaveTextContent(/\basks you\b/i);
  });

  /* B2 of #1569: the card a person approves in the task shows no "In more detail", so the list Hornhoof keeps of what a release
     brings that no check covers shows there next to Approve, apart from the plain words. */
  it('shows next to Approve on the card in the task what a release brings that no check covers, under plain words without it', async () => {
    const user = userEvent.setup();
    const stray = '1'.repeat(40);
    const task = { ...REQUESTS[1]!.task, id: 't12', number: 12, title: TASK_DETAIL.title };
    const release = { ...REQUESTS[1]!, task, explained: 'The release of the turn is ready. Approve it to let it go to main.', unchecked: [{ kind: 'commit' as const, commit: stray }] };
    shell({ 'GET /api/requests': [200, decisions([release])] });
    const panel = await openTask(user);
    const waiting = within(panel).getByRole('region', { name: 'Waiting for your answer' });
    const list = within(waiting).getByRole('region', { name: 'What this release brings that no check covers: 1 item' });
    expect(list).toHaveTextContent(`${stray} came in without any check.`);
    expect(list).toHaveTextContent('Approve only if you accept each of these.');
    const approve = within(waiting).getByRole('button', { name: 'Approve' });
    expect(list.compareDocumentPosition(approve) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('puts a current wait in the log, shows why and the materials, and keeps other task details in the menu', async () => {
    const user = userEvent.setup();
    const task = {
      ...TASK_DETAIL, why: 'Accept card payments.', independentPart: { reason: 'The same author owns every file.' },
      files: [{ id: 'f1', name: 'contract.txt', size: 512, by: null, at: TASK_DETAIL.createdAt }],
      externalWait: { reason: 'Images on the registry', since: '2026-11-03T10:00:00.000Z', until: '2099-11-03T11:30:00.000Z' },
    };
    shell({ 'GET /api/tasks/t12': [200, { task }] });
    const card = within(await openTask(user));
    expect(card.getByRole('list', { name: 'Log' })).toHaveTextContent(task.externalWait.reason);
    expect(card.getByText(task.why)).toBeInTheDocument();
    const materials = card.getByRole('region', { name: 'Materials' });
    expect(within(materials).getByText('File', { selector: '.tp-mat-kind' })).toBeInTheDocument();
    expect(within(materials).getByText('contract.txt')).toBeInTheDocument();
    expect(within(materials).getByRole('link', { name: 'Open contract.txt' })).toHaveAttribute('href', expect.stringContaining('f1'));
    expect(card.queryByText(task.independentPart.reason)).not.toBeInTheDocument();
    await user.click(card.getByRole('button', { name: 'Task actions' }));
    expect(card.queryByRole('button', { name: 'Materials' })).not.toBeInTheDocument();
    await user.click(card.getByRole('button', { name: 'Details' }));
    expect(card.getByText(task.independentPart.reason)).toBeInTheDocument();
    expect(card.getAllByText(task.why)).toHaveLength(1);
  });

  it('keeps edit and urgency behind the title menu and the graph in sight', async () => {
    const user = userEvent.setup();
    const task = { ...TASK_DETAIL, parentId: null, parent: null, mayEdit: true, mayPause: true, version: 2, revision: 4 };
    const calls = shell({
      'GET /api/tasks/t12': [200, { task }],
      'PATCH /api/tasks/t12': [200, { task }],
      'PUT /api/tasks/t12/urgent': [200, { task }],
    });
    const card = within(await openTask(user));
    expect(card.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    expect(card.queryByRole('button', { name: 'Make urgent' })).not.toBeInTheDocument();
    await user.click(card.getByRole('button', { name: 'Task actions' }));
    await user.click(card.getByRole('button', { name: 'Edit' }));
    const form = within(card.getByRole('form', { name: 'Edit the task' }));
    const title = form.getByRole('textbox', { name: 'Title' });
    await user.clear(title);
    await user.type(title, 'Checkout and refunds');
    await user.click(form.getByRole('button', { name: 'Save' }));
    expect(calls.find(c => c.method === 'PATCH' && c.path === '/api/tasks/t12')?.body).toEqual({ title: 'Checkout and refunds', version: 2, revision: 4 });
    await waitFor(() => expect(card.queryByRole('form', { name: 'Edit the task' })).not.toBeInTheDocument());
    await user.click(card.getByRole('button', { name: 'Task actions' }));
    await user.click(card.getByRole('button', { name: 'Make urgent' }));
    expect(calls.find(c => c.method === 'PUT' && c.path === '/api/tasks/t12/urgent')?.body).toEqual({ urgent: true });
    await waitFor(() => expect(card.queryByRole('button', { name: 'Make urgent' })).not.toBeInTheDocument());
    await user.click(card.getByRole('button', { name: 'Task actions' }));
    expect(within(card.getByRole('group', { name: 'Task actions' })).queryByRole('button', { name: 'Graph from here' })).not.toBeInTheDocument();
    await user.click(card.getByRole('button', { name: 'Graph from here' }));
    expect(location.search).toBe('?root=t12&view=graph');
  });
});

describe('a task', () => {
  it.each([
    ['en', 'Save passwords in the company vault'],
    ['ru', 'Сохраняйте пароли в хранилище компании'],
  ])('offers the vault for masked text in %s without exposing a value', async (language, label) => {
    localStorage.setItem('hh-lang', language);
    const user = userEvent.setup();
    shell({ 'GET /api/tasks/t12': [200, { task: { ...TASK_DETAIL, body: 'password=[hidden]' } }] });
    const panel = await openTask(user);
    await openTaskAction(user, panel, language === 'ru' ? ru.tasks.details : en.tasks.details);
    expect(within(panel).getByRole('link', { name: label })).toHaveAttribute('href', '/settings/passwords');
  });

  it('lets an authorized person hide an existing secret, then clears the input', async () => {
    const user = userEvent.setup();
    const task = { ...TASK_DETAIL, mayHideSecret: true, body: 'OldMarker1077!' };
    const calls = shell({
      'GET /api/tasks/t12': [200, { task }],
      'POST /api/tasks/t12/hide-secret': [200, { task: { ...task, body: '[hidden]' } }],
    });
    const panel = await openTask(user);
    await openTaskAction(user, panel, 'Hide secret');
    await user.type(within(panel).getByLabelText('Secret to hide'), 'OldMarker1077!');
    await user.click(within(panel).getByRole('button', { name: 'Hide everywhere' }));
    await waitFor(() => expect(calls.some(c => c.path === '/api/tasks/t12/hide-secret')).toBe(true));
    await waitFor(() => expect(within(panel).queryByLabelText('Secret to hide')).not.toBeInTheDocument());
  });

  it('does not offer secret hiding without permission from the server', async () => {
    const user = userEvent.setup();
    shell();
    const panel = await openTask(user);
    await openTaskAction(user, panel);
    expect(within(panel).queryByRole('button', { name: 'Hide secret' })).not.toBeInTheDocument();
  });

  it('clears a secret after a failed request and lets the person cancel', async () => {
    const user = userEvent.setup();
    shell({
      'GET /api/tasks/t12': [200, { task: { ...TASK_DETAIL, mayHideSecret: true } }],
      'POST /api/tasks/t12/hide-secret': [403, { error: { code: 'forbidden', message: 'Access changed.' } }],
    });
    const panel = await openTask(user);
    await openTaskAction(user, panel, 'Hide secret');
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
    await openFromTracker(user, 12);
    const panel = await screen.findByRole('complementary', { name: '#12 Checkout API' });
    await openTaskAction(user, panel, language === 'ru' ? ru.tasks.details : en.tasks.details);
    expect(within(panel).getByText(line)).toBeInTheDocument();
  });

  it.each([{}, { workKind: null, riskClass: null }])('has no line of kind and risk without them: %j', async labels => {
    const user = userEvent.setup();
    shell({ 'GET /api/tasks/t12': [200, { task: { ...TASK_DETAIL, ...labels } }] });
    const panel = await openTask(user);
    await openTaskAction(user, panel, 'Details');
    expect(within(panel).queryByText(/risk:/)).not.toBeInTheDocument();
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
    await openFromTracker(user, 12);
    const panel = await screen.findByRole('complementary', { name: '#12 Checkout API' });
    const label = language === 'ru' ? ru.tasks.fullLog : en.tasks.fullLog;
    await openTaskAction(user, panel, label);
    const lines = within(within(panel).getByRole('list', { name: label })).getAllByRole('listitem');
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
    await openFromTracker(user, 12);
    const panel = await screen.findByRole('complementary', { name: '#12 Checkout API' });
    const label = language === 'ru' ? ru.tasks.fullLog : en.tasks.fullLog;
    await openTaskAction(user, panel, label);
    const logList = within(panel).getByRole('list', { name: label });
    expect(within(logList).getByRole('listitem')).toHaveTextContent(expected);
    expect(panel).not.toHaveTextContent('Server fallback.');
  });

  it.each(['en', 'ru'])('shows an external wait with its reason and deadline in %s, then clears it after a comment', async language => {
    localStorage.setItem('hh-lang', language);
    const user = userEvent.setup();
    const externalWait = { reason: 'Images on the registry', since: '2026-11-03T10:00:00.000Z', until: '2099-11-03T11:30:00.000Z' };
    shell({ 'GET /api/tasks/t12': [200, { task: { ...TASK_DETAIL, externalWait } }] });
    await user.click(await screen.findByRole('button', { name: /^(Tasks|Задачи)/ }));
    await openFromTracker(user, 12);
    const panel = await screen.findByRole('complementary', { name: '#12 Checkout API' });
    const clock = new Date(externalWait.until).toLocaleTimeString(language === 'ru' ? 'ru-RU' : 'en-GB', { hour: '2-digit', minute: '2-digit' });
    const reason = /Images on the registry/;
    const deadline = language === 'ru' ? `ожидание поставил Rita, до ${clock}` : `set by Rita, until ${clock}`;
    const log = within(panel).getByRole('list', { name: language === 'ru' ? ru.tasks.log : en.tasks.log });
    expect(log).toHaveTextContent(reason);
    expect(log).toHaveTextContent(deadline);
    await openTaskAction(user, panel, language === 'ru' ? ru.tasks.comment : en.tasks.comment);
    mockApi({ 'POST /api/tasks/t12/comments': [201, { task: TASK_DETAIL }], 'GET /api/tasks/t12': [200, { task: { ...TASK_DETAIL, externalWait: null } }] });
    await user.type(within(panel).getByRole('textbox', { name: language === 'ru' ? 'Комментарий' : 'Comment' }), 'Images ready.');
    await user.click(within(panel).getByRole('button', { name: language === 'ru' ? 'Добавить комментарий' : 'Add comment' }));
    await waitFor(() => expect(within(panel).queryByText(reason)).toBeNull());
    expect(within(panel).queryByText(deadline)).toBeNull();
    localStorage.removeItem('hh-lang');
  });

  it("shows the orchestrator's plain question above the answer and keeps the technical explanation in Details", async () => {
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
    await openTaskAction(user, panel, 'Details');
    const questions = within(panel).getByRole('region', { name: 'Questions' });
    const more = within(questions).getByText('In more detail');
    expect(more.closest('details')).toHaveTextContent('Bruno ended several turns in a row without moving #12, so Hornhoof stopped waking it.');
    expect(waiting).not.toHaveTextContent('Ended 3 turns');
    expect(questions).toHaveTextContent("A question can be answered in the agent's window or terminal too: what you write there counts.");
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
    await openTaskAction(user, panel, 'Details');
    const questions = within(panel).getByRole('region', { name: 'Questions' });
    await user.click(within(questions).getByRole('button', { name: "Open Bruno's terminal" }));
    expect(await screen.findByRole('complementary', { name: 'Bruno, Backend engineer' })).toBeInTheDocument();
  });

  it.each(['en', 'ru'])('shows the current Review owner and ordered stages in %s', async language => {
    localStorage.setItem('hh-lang', language);
    const user = userEvent.setup();
    shell();
    const panel = await openTask(user);
    await openTaskAction(user, panel, language === 'ru' ? ru.tasks.details : en.tasks.details);
    const workflow = within(panel).getByRole('list', { name: language === 'ru' ? 'Маршрут задачи' : 'Task workflow' });
    const stages = language === 'ru' ? ['Архитектура', 'Разработка', 'Проверка', 'Безопасность', 'Тесты'] : ['Architecture', 'Development', 'Review', 'Security', 'Tests'];
    expect(within(workflow).getAllByRole('listitem').map(li => li.querySelector('b')!.textContent)).toEqual(stages);
    expect(workflow.querySelector('[aria-current="step"]')).toHaveTextContent(stages[2]!);
    expect(workflow.querySelector('[aria-current="step"]')).toHaveTextContent(language === 'ru' ? 'Исполнитель: Rita' : 'Owner: Rita');
    expect(workflow).not.toHaveTextContent(language === 'ru' ? 'Уборка лишнего' : 'Cleanup');
  });

  it('keeps submission evidence, verdicts and comments in the full log', async () => {
    const user = userEvent.setup();
    shell();
    const panel = await openTask(user);
    await openTaskAction(user, panel, 'Full log');
    const log = within(panel).getByRole('list', { name: 'Full log' });
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
      ['en', { workflow: 'Task workflow', stage: 'Development', phase: 'Waiting for an owner', after: 'Waits for', started: 'Hornhoof started it once what it waited for was done' }],
      ['ru', { workflow: 'Маршрут задачи', stage: 'Разработка', phase: 'Нужен исполнитель', after: 'Ждет', started: 'Hornhoof запустил ее, когда то, чего она ждала, было готово' }],
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
      await openFromTracker(user, 12);
      const panel = await screen.findByRole('complementary', { name: '#12 Checkout API' });
      await openTaskAction(user, panel, lang === 'ru' ? ru.tasks.details : en.tasks.details);
      const workflow = within(panel).getByRole('list', { name: words.workflow });
      expect(workflow.querySelector('[aria-current="step"]')).toHaveTextContent(words.stage);
      expect(within(panel).getByRole('status')).toHaveTextContent(words.phase);
      const links = within(panel).getByRole('region', { name: lang === 'ru' ? ru.tracker.card.relations : en.tracker.card.relations });
      expect(within(links).getByRole('link', { name: '#9 Pick a payment provider' })).toHaveAttribute('title', words.after);
      expect(within(links).getByRole('link', { name: '#11 Cart page' })).toHaveAttribute('title', words.after);
      expect(within(links).getAllByText(words.after.toLowerCase(), { selector: '.tp-rel' })).toHaveLength(2);
      expect(within(links).getByText(lang === 'ru' ? 'Готово' : 'Done', { selector: '.tr-status-pill' })).toHaveClass('done');
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
      await openFromTracker(user, 12);
      const panel = await screen.findByRole('complementary', { name: '#12 Checkout API' });
      expect(panel).toHaveTextContent(line);
      unmount();
      localStorage.removeItem('hh-lang');
    }
  });

  it("marks, in each language, an owner's answer that the orchestrator gave, in the log and under the question", async () => {
    const given = {
      ...TASK_DETAIL,
      requests: [{ id: 'r1', kind: 'question' as const, text: 'Is tax in scope?', commit: null, status: 'answered', answer: 'Yes, with tax.', byOrchestrator: true, agent: null, at: '2026-10-30T08:00:00.000Z' }],
      log: [{ kind: 'answered', text: 'Yes, with tax.', data: { byOrchestrator: true }, by: { kind: 'person' as const, id: 'p1', name: 'Ivan', byOrchestrator: true as const }, at: '2026-10-30T09:00:00.000Z' }],
    };
    for (const [lang, line, mark] of [
      ['en', 'Ivan answered', 'decided by the orchestrator'],
      ['ru', 'Ivan ответил', 'решил оркестратор'],
    ] as const) {
      localStorage.setItem('hh-lang', lang);
      const user = userEvent.setup();
      mockApi({
        'GET /api/org': [200, DEV_ORG],
        'GET /api/requests': [200, decisions([])],
        'GET /api/turns': [200, { turns: [TURN] }],
        'GET /api/tasks?status=all': [200, { tasks: TASKS }],
        'GET /api/tasks/t12': [200, { task: given }],
      });
      const { unmount } = render(
        <LanguageProvider>
          <Shell me={ME} onSignOut={() => {}} />
        </LanguageProvider>,
      );
      await user.click(await screen.findByRole('button', { name: lang === 'en' ? /^Tasks/ : /^Задачи/ }));
      await openFromTracker(user, 12);
      const panel = await screen.findByRole('complementary', { name: '#12 Checkout API' });
      expect(panel).toHaveTextContent(line);
      expect(within(panel).getByRole('list', { name: lang === 'ru' ? ru.tasks.log : en.tasks.log })).toHaveTextContent(mark);
      await openTaskAction(user, panel, lang === 'ru' ? ru.tasks.details : en.tasks.details);
      const question = within(panel).getByRole('heading', { name: lang === 'ru' ? ru.tasks.questions : en.tasks.questions }).closest('section');
      expect(question).toHaveTextContent(mark);
      unmount();
      localStorage.removeItem('hh-lang');
    }
  });

  it('shows each one-shot call in its log, in each language: its brief, input, answer, verdict and how long it took', async () => {
    const bruno = { kind: 'agent' as const, id: 'b1', name: 'Bruno' };
    const call = (over: object) => ({ batch: 'aaaaaaaa-0000-4000-8000-000000000001', judge: false, brief: 'Look for unsafe SQL.', input: null, stage: null, error: null, verdict: null, startedAt: '2026-11-17T10:00:00.000Z', finishedAt: '2026-11-17T10:02:00.000Z', ...over });
    const withCalls = {
      ...TASK_DETAIL,
      log: [
        ...TASK_DETAIL.log,
        { kind: 'call', text: 'One-shot call 1 of batch aaaa answered: Line 12 builds SQL from a string.', data: call({ number: 1, input: 'src/users.ts', status: 'done', result: 'Line 12 builds SQL from a string.', verdict: { pass: false, reason: 'unsafe SQL on line 12' } }), by: bruno, at: '2026-11-17T10:02:00.000Z' },
        { kind: 'call', text: 'One-shot call 2 of batch aaaa failed: out of time', data: call({ number: 2, input: 'src/orders.ts', status: 'failed', error: 'timeout', result: 'out of time', finishedAt: '2026-11-17T10:00:30.000Z' }), by: bruno, at: '2026-11-17T10:02:01.000Z' },
        { kind: 'call', text: 'The judge call of batch aaaa answered: The finding is real.', data: call({ number: 3, judge: true, brief: 'Keep only the real findings.', status: 'done', result: 'The finding is real.', verdict: { pass: false, reason: 'the finding is real' } }), by: bruno, at: '2026-11-17T10:04:00.000Z' },
      ],
    };
    for (const [lang, words] of [
      ['en', { title: 'Bruno ran a one-shot call', judge: 'Bruno ran a judge call', answered: 'Call 1 answered; it took 2 min.', failed: 'Call 2 failed; it ran less than a minute.', judged: 'The judge answered; it took 2 min.', verdict: 'Verdict: did not pass. unsafe SQL on line 12', brief: 'Brief: Look for unsafe SQL.', input: 'Input: src/users.ts', answer: 'Answer: Line 12 builds SQL from a string.' }],
      ['ru', { title: 'Bruno запустил разовый вызов', judge: 'Bruno запустил судью вызовов', answered: 'Вызов 1 ответил, это заняло 2 мин.', failed: 'Вызов 2 не справился, он шел менее минуты.', judged: 'Судья ответил, это заняло 2 мин.', verdict: 'Итог: не принято. unsafe SQL on line 12', brief: 'Задание: Look for unsafe SQL.', input: 'Входные данные: src/users.ts', answer: 'Ответ: Line 12 builds SQL from a string.' }],
    ] as const) {
      localStorage.setItem('hh-lang', lang);
      const user = userEvent.setup();
      shell({ 'GET /api/tasks/t12': [200, { task: withCalls }] });
      await user.click(await screen.findByRole('button', { name: lang === 'en' ? /^Tasks/ : /^Задачи/ }));
      await openFromTracker(user, 12);
      const panel = await screen.findByRole('complementary', { name: '#12 Checkout API' });
      const label = lang === 'ru' ? ru.tasks.fullLog : en.tasks.fullLog;
      await openTaskAction(user, panel, label);
      const lines = within(within(panel).getByRole('list', { name: label })).getAllByRole('listitem').map(li => li.textContent!).filter(text => text.includes(words.title) || text.includes(words.judge));
      expect(lines).toHaveLength(3);
      for (const said of [words.title, words.answered, words.verdict, words.brief, words.input, words.answer]) expect(lines[0]).toContain(said);
      expect(lines[1]).toContain(words.failed);
      expect(lines[1]).toContain('out of time');
      for (const said of [words.judge, words.judged]) expect(lines[2]).toContain(said);
      /* The English line kept for the agents is not what a person reads. */
      expect(panel).not.toHaveTextContent('of batch aaaa');
      cleanup();
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
      await openFromTracker(user, 12);
      const panel = await screen.findByRole('complementary', { name: '#12 Checkout API' });
      const label = lang === 'ru' ? ru.tasks.fullLog : en.tasks.fullLog;
      await openTaskAction(user, panel, label);
      const lines = within(within(panel).getByRole('list', { name: label })).getAllByRole('listitem').map(li => li.textContent!).filter(text => text.includes(words.title));
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
      await openFromTracker(user, 12);
      const panel = await screen.findByRole('complementary', { name: '#12 Checkout API' });
      const label = lang === 'ru' ? ru.tasks.fullLog : en.tasks.fullLog;
      await openTaskAction(user, panel, label);
      const lines = within(within(panel).getByRole('list', { name: label })).getAllByRole('listitem').map(li => li.textContent!).filter(text => text.includes(words.title));
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
    await openTaskAction(user, panel, 'Details');
    expect(within(panel).getByRole('status')).toHaveTextContent('Ready to merge');
    expect(within(panel).getByRole('list', { name: 'Task workflow' })).not.toHaveTextContent('Owner:');
  });

  it('posts a comment', async () => {
    const user = userEvent.setup();
    const calls = shell({ 'POST /api/tasks/t12/comments': [201, { task: TASK_DETAIL }] });
    const panel = await openTask(user);
    await openTaskAction(user, panel, 'Comment');
    await user.type(within(panel).getByRole('textbox', { name: 'Comment' }), 'Ship it today.');
    await user.click(within(panel).getByRole('button', { name: 'Add comment' }));
    expect(calls.find(c => c.path === '/api/tasks/t12/comments')?.body).toEqual({ text: 'Ship it today.' });
  });

  it('lets the CEO pause a task with a reason and shows it paused', async () => {
    const user = userEvent.setup();
    const paused = { at: '2026-11-09T05:00:00.000Z', reason: 'Wait for the release.', root: 't12', by: { personId: 'p1' } };
    const calls = shell({ 'GET /api/tasks/t12': [200, { task: { ...TASK_DETAIL, mayPause: true } }], 'PUT /api/tasks/t12/paused': [200, { task: { ...TASK_DETAIL, mayPause: true, paused } }] });
    const panel = await openTask(user);
    await openTaskAction(user, panel, 'Pause');
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
    await openTaskAction(user, panel, 'Resume');
    expect(calls.find(c => c.method === 'PUT' && c.path === '/api/tasks/t12/paused')?.body).toEqual({ paused: false, reason: '' });
  });

  it('offers no pause to a person who may not pause', async () => {
    const user = userEvent.setup();
    shell({ 'GET /api/tasks/t12': [200, { task: { ...TASK_DETAIL, mayPause: false } }] });
    const panel = await openTask(user);
    await openTaskAction(user, panel);
    expect(within(panel).queryByRole('button', { name: 'Pause' })).toBeNull();
  });

  it('asks before cancelling a task and the tasks under it', async () => {
    const user = userEvent.setup();
    const calls = shell({ 'POST /api/tasks/t12/cancel': [200, { task: { ...TASK_DETAIL, status: 'cancelled' } }] });
    const panel = await openTask(user);
    await openTaskAction(user, panel, 'Cancel task');
    expect(calls.some(c => c.path === '/api/tasks/t12/cancel')).toBe(false);
    expect(panel).toHaveTextContent('Cancel #12 and its open subtasks?');
    await user.click(within(panel).getByRole('button', { name: 'Yes, cancel it' }));
    expect(calls.some(c => c.method === 'POST' && c.path === '/api/tasks/t12/cancel')).toBe(true);
  });

  it('opens a subtask from the list', async () => {
    const user = userEvent.setup();
    shell({ 'GET /api/tasks/t13': [200, { task: { ...TASK_DETAIL, id: 't13', number: 13, title: 'Refunds', subtasks: [], parent: { id: 't12', number: 12, title: 'Checkout API' } } }] });
    const panel = await openTask(user);
    await user.click(within(panel).getByRole('link', { name: /#13 Refunds/ }));
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
    await openTaskAction(user, panel, language === 'ru' ? ru.tasks.details : en.tasks.details);
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
    await openTaskAction(user, panel, language === 'ru' ? ru.tasks.details : en.tasks.details);
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
    await openTaskAction(user, panel, 'Details');
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
    await openFromTracker(user, 12);
    const reopened = await screen.findByRole('complementary', { name: '#12 Checkout API' });
    await openTaskAction(user, reopened);
    await user.keyboard('{Escape}');
    const menu = within(reopened).getByRole('button', { name: 'Task actions' });
    expect(menu).toHaveAttribute('aria-expanded', 'false');
    expect(menu).toHaveFocus();
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
