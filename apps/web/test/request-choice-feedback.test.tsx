import { fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { en } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import type { WaitingRequest } from '../src/types';
import { Requests, forgetRequestDrafts, wordsAnswer } from '../src/ui/Requests';
import { mockApi, REQUESTS } from './api-mock';
import { decl } from './css';
import { renderIn, requestProps } from './request-feedback-fixture';

const DEV = { id: 'd2', name: 'Development' };
const ceoOnly = { kind: 'ceo_and_delegate' as const, department: null };

const CHOICE: WaitingRequest = {
  ...REQUESTS[0]!,
  id: 'r-choice',
  kind: 'choice',
  text: 'Which progress bar layout works best under the circle?',
  images: ['img-overview'],
  link: 'https://preview.example.com/argon',
  options: [
    { label: 'Option A (Argon): compact row below the circle', image: 'img-a' },
    { label: 'Option B (Neon): wide strip with counters', image: 'img-b' },
  ],
  canAnswer: true,
  decidedBy: ceoOnly,
  agent: { id: 'a-design', name: 'Interface Designer (Gemini)' },
  task: { id: 't402', number: 402, title: 'Turn progress options', department: DEV },
};

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function stubDeferredFetch() {
  const pending: { url: string; resolve: (res: Response) => void }[] = [];
  const posted: { url: string; body: unknown }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url;
      posted.push({ url, body: init?.body ? (JSON.parse(String(init.body)) as unknown) : null });
      return new Promise<Response>(resolve => {
        pending.push({ url, resolve });
      });
    }),
  );
  return {
    posted,
    answerNext(status: number, payload: unknown) {
      const next = pending.shift();
      if (!next) throw new Error('No pending request');
      next.resolve(jsonResponse(status, payload));
    },
    answerUrl(url: string, status: number, payload: unknown) {
      const idx = pending.findIndex(p => p.url === url);
      if (idx === -1) throw new Error(`No pending request for ${url}`);
      pending.splice(idx, 1)[0]!.resolve(jsonResponse(status, payload));
    },
  };
}

describe('choice request free-form feedback and option picking', () => {
  afterEach(() => {
    forgetRequestDrafts();
    localStorage.removeItem('hh-lang');
    vi.restoreAllMocks();
  });

  it('sends multi-line feedback without picking an option in English', async () => {
    const calls = mockApi({ 'POST /api/requests/r-choice': [200, { request: { id: 'r-choice', status: 'answered', picked: null } }] });
    const props = requestProps(CHOICE);
    const user = userEvent.setup();
    renderIn('en', <Requests {...props} />);

    const card = screen.getByRole('article', { name: '#402 Turn progress options' });
    const box = within(card).getByLabelText('Comment or feedback');
    expect(box.tagName).toBe('TEXTAREA');
    expect(box).toHaveAccessibleDescription('Pick an option above, or send feedback without picking one.');

    const feedback = 'Neither option fits yet.\nPut progress inside the existing department chips.';
    await user.type(box, `  ${feedback}  `);
    const send = within(card).getByRole('button', { name: 'Send without choosing' });
    expect(send).toBeEnabled();
    await user.click(send);

    expect(calls).toEqual([
      {
        method: 'POST',
        path: '/api/requests/r-choice',
        body: { answer: feedback },
      },
    ]);
    expect('pick' in (calls[0]!.body as Record<string, unknown>)).toBe(false);
    expect('approve' in (calls[0]!.body as Record<string, unknown>)).toBe(false);
    expect(props.onChanged).toHaveBeenCalledTimes(1);
  });

  it('sends multi-line feedback without picking an option in Russian via visible Отправить без выбора button', async () => {
    const calls = mockApi({ 'POST /api/requests/r-choice': [200, { request: { id: 'r-choice', status: 'answered', picked: null } }] });
    const props = requestProps(CHOICE);
    const user = userEvent.setup();
    renderIn('ru', <Requests {...props} />);

    const card = screen.getByRole('article', { name: '#402 Turn progress options' });
    const box = within(card).getByLabelText('Комментарий или замечания');
    expect(box).toHaveAccessibleDescription('Выберите вариант выше или отправьте замечания без выбора.');

    const feedback = 'Ни один вариант пока не подходит.\nСделайте синие квадратики прямо внутри плашек отделов.';
    await user.type(box, feedback);
    await user.click(within(card).getByRole('button', { name: 'Отправить без выбора' }));

    expect(calls).toEqual([
      {
        method: 'POST',
        path: '/api/requests/r-choice',
        body: { answer: feedback },
      },
    ]);
    expect('pick' in (calls[0]!.body as Record<string, unknown>)).toBe(false);
    expect(props.onChanged).toHaveBeenCalledTimes(1);
  });

  it('sends exact pick: 0 with trimmed comment, and pick: 0 alone when comment is blank', async () => {
    const calls = mockApi({ 'POST /api/requests/r-choice': [200, { request: { id: 'r-choice', status: 'answered', picked: 0 } }] });
    const user = userEvent.setup();
    const { unmount } = renderIn('en', <Requests {...requestProps(CHOICE)} />);

    await user.type(screen.getByLabelText('Comment or feedback'), '  Keep Argon, soften the glow  ');
    await user.click(screen.getByRole('button', { name: 'Choose option 1' }));
    expect(calls[0]?.body).toEqual({ pick: 0, answer: 'Keep Argon, soften the glow' });
    unmount();
    forgetRequestDrafts();

    renderIn('en', <Requests {...requestProps(CHOICE)} />);
    await user.type(screen.getByLabelText('Comment or feedback'), '   \n  ');
    await user.click(screen.getByRole('button', { name: 'Choose option 1' }));
    expect(calls[1]?.body).toEqual({ pick: 0 });
    expect('answer' in (calls[1]!.body as Record<string, unknown>)).toBe(false);
  });

  it('disables Send without choosing and refuses submission when feedback is empty or whitespace only', async () => {
    const calls = mockApi({ 'POST /api/requests/r-choice': [200, { request: { id: 'r-choice', status: 'answered' } }] });
    const props = requestProps(CHOICE);
    const user = userEvent.setup();
    renderIn('en', <Requests {...props} />);

    const send = screen.getByRole('button', { name: 'Send without choosing' });
    expect(send).toBeDisabled();

    const box = screen.getByLabelText('Comment or feedback');
    await user.type(box, '   \n\t  ');
    expect(send).toBeDisabled();

    const form = box.closest('form');
    expect(form).not.toBeNull();
    fireEvent.submit(form!);
    expect(calls).toEqual([]);
    expect(props.onChanged).not.toHaveBeenCalled();
  });

  it('shows the failure reason, preserves the full typed feedback, and succeeds on retry', async () => {
    let fail = true;
    const calls = mockApi({
      'POST /api/requests/r-choice': () =>
        fail
          ? [503, { error: { code: 'unavailable' } }]
          : [200, { request: { id: 'r-choice', status: 'answered', picked: null } }],
    });
    const props = requestProps(CHOICE);
    const user = userEvent.setup();
    renderIn('ru', <Requests {...props} />);

    const feedback = 'Первая строка замечаний.\nВторая строка: не закрывать запрос выдуманным выбором.';
    const box = screen.getByLabelText('Комментарий или замечания');
    await user.type(box, feedback);
    const send = screen.getByRole('button', { name: 'Отправить без выбора' });
    await user.click(send);

    expect(await screen.findByRole('alert')).toHaveTextContent(ru.errors.codes.unavailable);
    expect(box).toHaveValue(feedback);
    expect(send).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Выбрать вариант 1' })).toBeEnabled();
    expect(props.onChanged).not.toHaveBeenCalled();

    fail = false;
    await user.click(send);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.body).toEqual({ answer: feedback });
    expect(props.onChanged).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('prevents double submission while busy and after a successful post before reload unmounts', async () => {
    let resolvePost!: (res: Response) => void;
    const fetchSpy = vi.fn(
      () =>
        new Promise<Response>(resolve => {
          resolvePost = resolve;
        }),
    );
    vi.stubGlobal('fetch', fetchSpy);
    const props = requestProps(CHOICE);
    const user = userEvent.setup();
    renderIn('en', <Requests {...props} />);

    const box = screen.getByLabelText('Comment or feedback');
    await user.type(box, 'Hold this feedback');
    const send = screen.getByRole('button', { name: 'Send without choosing' });
    const optA = screen.getByRole('button', { name: 'Choose option 1' });

    fireEvent.click(send);
    fireEvent.click(send);
    fireEvent.click(optA);
    fireEvent.submit(box.closest('form')!);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(send).toBeDisabled();
    expect(optA).toBeDisabled();

    resolvePost(new Response(JSON.stringify({ request: { id: 'r-choice', status: 'answered' } }), { status: 200, headers: { 'content-type': 'application/json' } }));
    await vi.waitFor(() => expect(props.onChanged).toHaveBeenCalledTimes(1));

    /* Remains locked while parent refreshes /api/requests so a second click cannot double-answer. */
    expect(send).toBeDisabled();
    expect(optA).toBeDisabled();
    fireEvent.submit(box.closest('form')!);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('keeps read-only view strict when canAnswer is false, without options buttons or Send without choosing', () => {
    const plainReadOnly: WaitingRequest = {
      ...CHOICE,
      id: 'r-choice-plain-ro',
      canAnswer: false,
      images: [],
      link: null,
      options: CHOICE.options.map(o => ({ label: o.label, image: null })),
      task: { id: 't405', number: 405, title: 'Plain turn progress options', department: DEV },
    };
    renderIn('ru', <Requests {...requestProps(CHOICE, { requests: [{ ...CHOICE, canAnswer: false }, plainReadOnly] })} />);
    const card = screen.getByRole('article', { name: '#402 Turn progress options' });
    expect(card).toHaveAttribute('aria-busy', 'false');
    expect(within(card).queryByRole('status')).not.toBeInTheDocument();
    expect(within(card).queryByRole('alert')).not.toBeInTheDocument();
    expect(within(card).getByText('Option A (Argon): compact row below the circle')).toBeInTheDocument();
    expect(within(card).getByText('Option B (Neon): wide strip with counters')).toBeInTheDocument();
    expect(card.querySelectorAll('ol.opts button.mat.mat-large')).toHaveLength(2);
    expect(within(card).getByText(ru.tasks.decidedByCeo)).toBeInTheDocument();
    expect(within(card).queryByRole('textbox')).not.toBeInTheDocument();
    expect(within(card).queryByRole('button', { name: 'Отправить без выбора' })).not.toBeInTheDocument();
    expect(within(card).queryByRole('button', { name: /Выбрать вариант/ })).not.toBeInTheDocument();

    const plainCard = screen.getByRole('article', { name: '#405 Plain turn progress options' });
    expect(within(plainCard).getAllByRole('listitem').map(li => li.textContent)).toEqual([
      'Option A (Argon): compact row below the circle',
      'Option B (Neon): wide strip with counters',
    ]);
    expect(within(plainCard).queryByRole('button', { name: /Option A/ })).not.toBeInTheDocument();
  });

  it('distinguishes in-flight sending from server failure, keeps the full draft, and sends once on retry', async () => {
    const net = stubDeferredFetch();
    const props = requestProps(CHOICE);
    const user = userEvent.setup();
    renderIn('ru', <Requests {...props} />);

    const card = screen.getByRole('article', { name: '#402 Turn progress options' });
    expect(card).toHaveAttribute('aria-busy', 'false');
    expect(within(card).queryByRole('status')).not.toBeInTheDocument();
    expect(within(card).queryByRole('alert')).not.toBeInTheDocument();

    const feedback = 'Первая строка замечаний.\nВторая строка: сохранить весь черновик при сбое.';
    const box = within(card).getByLabelText('Комментарий или замечания');
    await user.type(box, feedback);
    const send = within(card).getByRole('button', { name: 'Отправить без выбора' });
    const optA = within(card).getByRole('button', { name: 'Выбрать вариант 1' });

    await user.click(send);
    expect(card).toHaveAttribute('aria-busy', 'true');
    expect(within(card).getByRole('status')).toHaveTextContent('Отправка');
    expect(within(card).queryByRole('alert')).not.toBeInTheDocument();
    expect(send).toBeDisabled();
    expect(optA).toBeDisabled();
    expect(box).toHaveValue(feedback);

    fireEvent.click(send);
    fireEvent.click(optA);
    fireEvent.submit(box.closest('form')!);
    expect(net.posted).toHaveLength(1);

    net.answerNext(503, { error: { code: 'unavailable' } });

    expect(await within(card).findByRole('alert')).toHaveTextContent(ru.errors.codes.unavailable);
    expect(card).toHaveAttribute('aria-busy', 'false');
    expect(within(card).queryByRole('status')).not.toBeInTheDocument();
    expect(box).toHaveValue(feedback);
    expect(send).toBeEnabled();
    expect(optA).toBeEnabled();
    expect(props.onChanged).not.toHaveBeenCalled();

    await user.click(send);
    expect(card).toHaveAttribute('aria-busy', 'true');
    expect(within(card).getByRole('status')).toHaveTextContent('Отправка');
    expect(within(card).queryByRole('alert')).not.toBeInTheDocument();
    expect(net.posted).toHaveLength(2);
    expect(net.posted[1]).toEqual({ url: '/api/requests/r-choice', body: { answer: feedback } });

    net.answerNext(200, { request: { id: 'r-choice', status: 'answered', picked: null } });
    await vi.waitFor(() => expect(props.onChanged).toHaveBeenCalledTimes(1));
    expect(send).toBeDisabled();
  });

  it('tracks independent sending and error states on approval and stuck cards without extra confirmation steps', async () => {
    const net = stubDeferredFetch();
    const approval: WaitingRequest = {
      ...CHOICE,
      id: 'r-approval',
      kind: 'approval',
      commit: 'c'.repeat(40),
      commitUrl: 'https://github.com/acme/repo/commit/' + 'c'.repeat(40),
      options: [],
      images: [],
      link: null,
      task: { id: 't403', number: 403, title: 'Release budget approval', department: DEV },
    };
    const stuck: WaitingRequest = {
      ...CHOICE,
      id: 'r-stuck-ind',
      kind: 'stuck',
      options: [],
      images: [],
      link: null,
      task: { id: 't404', number: 404, title: 'Stuck worker recovery', department: DEV },
    };
    const props = requestProps(CHOICE, { requests: [approval, stuck] });
    const user = userEvent.setup();
    renderIn('en', <Requests {...props} />);

    const approvalCard = screen.getByRole('article', { name: '#403 Release budget approval' });
    const stuckCard = screen.getByRole('article', { name: '#404 Stuck worker recovery' });

    const noteBox = within(approvalCard).getByLabelText(en.tasks.note);
    await user.type(noteBox, 'Within Q4 limit');
    await user.click(within(approvalCard).getByRole('button', { name: en.tasks.approve }));

    expect(net.posted).toEqual([{ url: '/api/requests/r-approval', body: { approve: true, answer: 'Within Q4 limit' } }]);
    expect(approvalCard).toHaveAttribute('aria-busy', 'true');
    expect(within(approvalCard).getByRole('status')).toHaveTextContent('Sending');
    expect(within(approvalCard).getByRole('button', { name: en.tasks.approve })).toBeDisabled();
    expect(within(approvalCard).getByRole('button', { name: en.tasks.decline })).toBeDisabled();
    expect(stuckCard).toHaveAttribute('aria-busy', 'false');
    expect(within(stuckCard).queryByRole('status')).not.toBeInTheDocument();

    net.answerUrl('/api/requests/r-approval', 409, { error: { code: 'conflict', reason: 'task_changed' } });

    expect(await within(approvalCard).findByRole('alert')).toHaveTextContent(en.errors.task_changed);
    expect(approvalCard).toHaveAttribute('aria-busy', 'false');
    expect(within(approvalCard).queryByRole('status')).not.toBeInTheDocument();
    expect(noteBox).toHaveValue('Within Q4 limit');
    expect(within(approvalCard).getByRole('button', { name: en.tasks.decline })).toBeEnabled();

    const stuckDraft = within(stuckCard).getByLabelText(en.tasks.yourAnswer);
    await user.type(stuckDraft, 'Check the logs first');
    await user.click(within(stuckCard).getByRole('button', { name: en.tasks.cancelTask }));
    expect(net.posted.filter(p => p.url === '/api/tasks/t404/cancel')).toEqual([]);
    const cancelDialog = screen.getByRole('alertdialog', { name: 'Do you really want to cancel this task?' });
    expect(cancelDialog).toHaveAccessibleDescription('#404 Stuck worker recovery and its open subtasks will be cancelled. Its record stays in history.');
    expect(cancelDialog.querySelector('bdi')).toHaveTextContent('#404 Stuck worker recovery');
    expect(within(cancelDialog).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    await user.click(within(cancelDialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(net.posted.filter(p => p.url === '/api/tasks/t404/cancel')).toEqual([]);
    expect(stuckDraft).toHaveValue('Check the logs first');

    await user.click(within(stuckCard).getByRole('button', { name: en.tasks.cancelTask }));
    const confirmCancel = screen.getByRole('alertdialog');
    await user.click(within(confirmCancel).getByRole('button', { name: en.tasks.cancelTask }));
    expect(net.posted.at(-1)).toEqual({ url: '/api/tasks/t404/cancel', body: {} });
    expect(stuckCard).toHaveAttribute('aria-busy', 'true');
    expect(within(stuckCard).getByRole('status')).toHaveTextContent('Sending');
    expect(within(stuckCard).getByRole('button', { name: en.tasks.cancelTask })).toBeDisabled();

    net.answerUrl('/api/tasks/t404/cancel', 500, { error: { code: 'internal', message: 'Cannot cancel now.' } });
    expect(await within(confirmCancel).findByRole('alert')).toHaveTextContent('Cannot cancel now.');
    expect(stuckDraft).toHaveValue('Check the logs first');

    await user.click(within(confirmCancel).getByRole('button', { name: en.tasks.cancelTask }));
    net.answerUrl('/api/tasks/t404/cancel', 200, {});
    await vi.waitFor(() => expect(props.onChanged).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
  });

  it('supports full keyboard navigation for both multi-line feedback submit and option pick', async () => {
    const plainChoice: WaitingRequest = {
      ...CHOICE,
      id: 'r-plain-choice',
      images: [],
      link: null,
      options: CHOICE.options.map(o => ({ label: o.label, image: null })),
    };
    const calls = mockApi({ 'POST /api/requests/r-plain-choice': [200, { request: { id: 'r-plain-choice', status: 'answered' } }] });
    const user = userEvent.setup();
    renderIn('en', <Requests {...requestProps(CHOICE, { requests: [plainChoice] })} />);

    const optA = screen.getByRole('button', { name: /Option A/ });
    const optB = screen.getByRole('button', { name: /Option B/ });
    const box = screen.getByLabelText('Comment or feedback');
    const send = screen.getByRole('button', { name: 'Send without choosing' });

    optA.focus();
    expect(optA).toHaveFocus();
    await user.tab();
    expect(optB).toHaveFocus();
    await user.tab();
    expect(box).toHaveFocus();

    /* Enter inside textarea inserts a newline without premature submit; Tab reaches Send and Enter submits. */
    await user.keyboard('Line 1{Enter}Line 2');
    expect(calls).toEqual([]);
    await user.tab();
    expect(send).toHaveFocus();
    await user.keyboard('{Enter}');

    expect(calls).toEqual([
      { method: 'POST', path: '/api/requests/r-plain-choice', body: { answer: 'Line 1\nLine 2' } },
    ]);
  });

  it('lays out choice options as an aligned responsive grid with left-aligned text and disabled feedback', () => {
    expect(decl('.req', 'min-width')).toBe('0');
    expect(decl('.req-form', 'min-width')).toBe('0');
    expect(decl('.req-options', 'display')).toBe('grid');
    expect(decl('.req-options', 'grid-template-columns')).toBe('repeat(auto-fit, minmax(min(100%, 220px), 1fr))');
    expect(decl('.req-option', 'align-content')).toBe('start');
    expect(decl('.req-option', 'text-align')).toBe('left');
    expect(decl('.req-option', 'min-width')).toBe('0');
    expect(decl('.req-option span', 'overflow-wrap')).toBe('anywhere');
    expect(decl('.req-option img', 'max-width')).toBe('100%');
    expect(decl('.req-option:disabled', 'opacity')).toBe('.45');
    expect(decl('.req-option:disabled', 'cursor')).toBe('not-allowed');
  });

  it('keeps wordsAnswer false for choice and true only for answerable question or stuck requests', () => {
    expect(wordsAnswer([CHOICE])).toBe(false);
    expect(wordsAnswer([{ ...CHOICE, kind: 'approval' }])).toBe(false);
    expect(wordsAnswer([{ ...CHOICE, kind: 'question', canAnswer: false }])).toBe(false);
    expect(wordsAnswer([{ ...CHOICE, kind: 'question', canAnswer: true }])).toBe(true);
    expect(wordsAnswer([{ ...CHOICE, kind: 'stuck', canAnswer: true }])).toBe(true);
  });

  it('preserves explained markdown, stuck cancel, and approval with or without commit link', async () => {
    const stuck: WaitingRequest = {
      ...CHOICE,
      id: 'r-stuck',
      kind: 'stuck',
      explained: '**Plain summary**',
      options: [],
      images: [],
      link: null,
    };
    const policyApproval: WaitingRequest = {
      ...CHOICE,
      id: 'r-policy',
      kind: 'approval',
      commit: null,
      commitUrl: null,
      options: [],
      images: [],
      link: null,
    };
    const linkedApproval: WaitingRequest = {
      ...policyApproval,
      id: 'r-commit',
      commit: 'b'.repeat(40),
      commitUrl: 'https://github.com/acme/repo/commit/' + 'b'.repeat(40),
    };
    const calls = mockApi({
      'POST /api/tasks/t402/cancel': [200, {}],
      'POST /api/requests/r-policy': [200, {}],
      'POST /api/requests/r-commit': [200, {}],
    });
    const onOpenTask = vi.fn();
    const onOpenAgent = vi.fn();
    const user = userEvent.setup();
    renderIn('en', <Requests {...requestProps(CHOICE, { requests: [stuck, policyApproval, linkedApproval], onOpenTask, onOpenAgent })} />);

    const [stuckCard, policyCard, commitCard] = screen.getAllByRole('article');
    expect(within(stuckCard!).getByText('Plain summary')).toBeInTheDocument();
    expect(within(stuckCard!).getByText(en.tasks.inDetail)).toBeInTheDocument();
    await user.click(within(stuckCard!).getByRole('button', { name: '#402 Turn progress options' }));
    expect(onOpenTask).toHaveBeenCalledWith('t402');
    await user.click(within(stuckCard!).getByRole('button', { name: en.tasks.openTerminal('Interface Designer (Gemini)') }));
    expect(onOpenAgent).toHaveBeenCalledWith('a-design');
    await user.click(within(stuckCard!).getByRole('button', { name: en.tasks.cancelTask }));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: en.tasks.cancelTask }));
    await vi.waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());

    expect(within(policyCard!).getByText(en.tasks.asksApprovalOf('Interface Designer (Gemini)'))).toBeInTheDocument();
    await user.type(within(policyCard!).getByLabelText(en.tasks.note), 'Needs budget sign-off');
    await user.click(within(policyCard!).getByRole('button', { name: en.tasks.decline }));

    expect(within(commitCard!).getByRole('link', { name: 'b'.repeat(40) })).toHaveAttribute('href', linkedApproval.commitUrl);
    await user.type(within(commitCard!).getByLabelText(en.tasks.note), 'Looks clean');
    await user.click(within(commitCard!).getByRole('button', { name: en.tasks.approve }));

    expect(calls).toEqual([
      { method: 'POST', path: '/api/tasks/t402/cancel', body: {} },
      { method: 'POST', path: '/api/requests/r-policy', body: { approve: false, answer: 'Needs budget sign-off' } },
      { method: 'POST', path: '/api/requests/r-commit', body: { approve: true, answer: 'Looks clean' } },
    ]);
  });
});
