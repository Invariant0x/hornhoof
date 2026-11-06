import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import { en } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import type { TaskPlace, WaitingRequest } from '../src/types';
import { Requests, wordsAnswer } from '../src/ui/Requests';
import { mockApi, REQUESTS } from './api-mock';
import { decl } from './css';

const DEV = { id: 'd2', name: 'Development' };
const ceoOnly = { kind: 'ceo_and_delegate' as const, department: null };

function renderIn(lang: 'en' | 'ru', node: ReactNode) {
  localStorage.setItem('hh-lang', lang);
  return render(<LanguageProvider>{node}</LanguageProvider>);
}

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

function makeProps(overrides: Partial<Parameters<typeof Requests>[0]> = {}) {
  return {
    requests: [CHOICE],
    onChanged: vi.fn(),
    onOpenTask: vi.fn(),
    onOpenAgent: vi.fn(),
    placeName: (p: TaskPlace) => p?.name ?? '',
    ...overrides,
  };
}

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
    localStorage.removeItem('hh-lang');
    vi.restoreAllMocks();
  });

  it('sends multi-line feedback without picking an option in English', async () => {
    const calls = mockApi({ 'POST /api/requests/r-choice': [200, { request: { id: 'r-choice', status: 'answered', picked: null } }] });
    const props = makeProps();
    const user = userEvent.setup();
    renderIn('en', <Requests {...props} />);

    const card = screen.getByRole('article', { name: '#402 Turn progress options' });
    const box = within(card).getByLabelText('Comment or feedback');
    expect(box.tagName).toBe('TEXTAREA');
    expect(box).toHaveAccessibleDescription('Pick an option above, or send feedback without picking one.');

    const feedback = 'Neither option fits yet.\nPut progress inside the existing department chips.';
    await user.type(box, `  ${feedback}  `);
    const send = within(card).getByRole('button', { name: 'Send' });
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

  it('sends multi-line feedback without picking an option in Russian via visible Отправить button', async () => {
    const calls = mockApi({ 'POST /api/requests/r-choice': [200, { request: { id: 'r-choice', status: 'answered', picked: null } }] });
    const props = makeProps();
    const user = userEvent.setup();
    renderIn('ru', <Requests {...props} />);

    const card = screen.getByRole('article', { name: '#402 Turn progress options' });
    const box = within(card).getByLabelText('Комментарий или замечания');
    expect(box).toHaveAccessibleDescription('Выберите вариант выше или отправьте замечания без выбора.');

    const feedback = 'Ни один вариант пока не подходит.\nСделайте синие квадратики прямо внутри плашек отделов.';
    await user.type(box, feedback);
    await user.click(within(card).getByRole('button', { name: 'Отправить' }));

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
    const { unmount } = renderIn('en', <Requests {...makeProps()} />);

    await user.type(screen.getByLabelText('Comment or feedback'), '  Keep Argon, soften the glow  ');
    await user.click(screen.getByRole('button', { name: /Option A \(Argon\)/ }));
    expect(calls[0]?.body).toEqual({ pick: 0, answer: 'Keep Argon, soften the glow' });
    unmount();

    renderIn('en', <Requests {...makeProps()} />);
    await user.type(screen.getByLabelText('Comment or feedback'), '   \n  ');
    await user.click(screen.getByRole('button', { name: /Option A \(Argon\)/ }));
    expect(calls[1]?.body).toEqual({ pick: 0 });
    expect('answer' in (calls[1]!.body as Record<string, unknown>)).toBe(false);
  });

  it('disables Send and refuses submission when feedback is empty or whitespace only', async () => {
    const calls = mockApi({ 'POST /api/requests/r-choice': [200, { request: { id: 'r-choice', status: 'answered' } }] });
    const props = makeProps();
    const user = userEvent.setup();
    renderIn('en', <Requests {...props} />);

    const send = screen.getByRole('button', { name: 'Send' });
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
    const props = makeProps();
    const user = userEvent.setup();
    renderIn('ru', <Requests {...props} />);

    const feedback = 'Первая строка замечаний.\nВторая строка: не закрывать запрос выдуманным выбором.';
    const box = screen.getByLabelText('Комментарий или замечания');
    await user.type(box, feedback);
    const send = screen.getByRole('button', { name: 'Отправить' });
    await user.click(send);

    expect(await screen.findByRole('alert')).toHaveTextContent(ru.errors.codes.unavailable);
    expect(box).toHaveValue(feedback);
    expect(send).toBeEnabled();
    expect(screen.getByRole('button', { name: /Option A/ })).toBeEnabled();
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
    const props = makeProps();
    const user = userEvent.setup();
    renderIn('en', <Requests {...props} />);

    const box = screen.getByLabelText('Comment or feedback');
    await user.type(box, 'Hold this feedback');
    const send = screen.getByRole('button', { name: 'Send' });
    const optA = screen.getByRole('button', { name: /Option A/ });

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

  it('keeps read-only view strict when canAnswer is false, without options buttons or Send', () => {
    renderIn('ru', <Requests {...makeProps({ requests: [{ ...CHOICE, canAnswer: false }] })} />);
    const card = screen.getByRole('article', { name: '#402 Turn progress options' });
    expect(card).toHaveAttribute('aria-busy', 'false');
    expect(within(card).queryByRole('status')).not.toBeInTheDocument();
    expect(within(card).queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getAllByRole('listitem').map(li => li.textContent)).toEqual([
      'Option A (Argon): compact row below the circle',
      'Option B (Neon): wide strip with counters',
    ]);
    expect(screen.getByText(ru.tasks.decidedByCeo)).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Отправить' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Option A/ })).not.toBeInTheDocument();
  });

  it('distinguishes in-flight sending from server failure, keeps the full draft, and sends once on retry', async () => {
    const net = stubDeferredFetch();
    const props = makeProps();
    const user = userEvent.setup();
    renderIn('ru', <Requests {...props} />);

    const card = screen.getByRole('article', { name: '#402 Turn progress options' });
    expect(card).toHaveAttribute('aria-busy', 'false');
    expect(within(card).queryByRole('status')).not.toBeInTheDocument();
    expect(within(card).queryByRole('alert')).not.toBeInTheDocument();

    const feedback = 'Первая строка замечаний.\nВторая строка: сохранить весь черновик при сбое.';
    const box = within(card).getByLabelText('Комментарий или замечания');
    await user.type(box, feedback);
    const send = within(card).getByRole('button', { name: 'Отправить' });
    const optA = within(card).getByRole('button', { name: /Option A/ });

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
    const props = makeProps({ requests: [approval, stuck] });
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

    await user.click(within(stuckCard).getByRole('button', { name: en.tasks.cancelTask }));
    expect(net.posted.at(-1)).toEqual({ url: '/api/tasks/t404/cancel', body: {} });
    expect(stuckCard).toHaveAttribute('aria-busy', 'true');
    expect(within(stuckCard).getByRole('status')).toHaveTextContent('Sending');
    expect(within(stuckCard).getByRole('button', { name: en.tasks.cancelTask })).toBeDisabled();

    net.answerUrl('/api/tasks/t404/cancel', 200, {});
    await vi.waitFor(() => expect(props.onChanged).toHaveBeenCalledTimes(1));
  });

  it('supports full keyboard navigation for both multi-line feedback submit and option pick', async () => {
    const calls = mockApi({ 'POST /api/requests/r-choice': [200, { request: { id: 'r-choice', status: 'answered' } }] });
    const user = userEvent.setup();
    renderIn('en', <Requests {...makeProps()} />);

    const optA = screen.getByRole('button', { name: /Option A/ });
    const optB = screen.getByRole('button', { name: /Option B/ });
    const box = screen.getByLabelText('Comment or feedback');
    const send = screen.getByRole('button', { name: 'Send' });

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
      { method: 'POST', path: '/api/requests/r-choice', body: { answer: 'Line 1\nLine 2' } },
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
    renderIn('en', <Requests {...makeProps({ requests: [stuck, policyApproval, linkedApproval], onOpenTask, onOpenAgent })} />);

    const [stuckCard, policyCard, commitCard] = screen.getAllByRole('article');
    expect(within(stuckCard!).getByText('Plain summary')).toBeInTheDocument();
    expect(within(stuckCard!).getByText(en.tasks.inDetail)).toBeInTheDocument();
    await user.click(within(stuckCard!).getByRole('button', { name: '#402 Turn progress options' }));
    expect(onOpenTask).toHaveBeenCalledWith('t402');
    await user.click(within(stuckCard!).getByRole('button', { name: en.tasks.openTerminal('Interface Designer (Gemini)') }));
    expect(onOpenAgent).toHaveBeenCalledWith('a-design');
    await user.click(within(stuckCard!).getByRole('button', { name: en.tasks.cancelTask }));

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

describe('server-authorized human requests, plain envelopes, executable rejection and hidden-source isolation', () => {
  afterEach(() => {
    localStorage.removeItem('hh-lang');
    vi.restoreAllMocks();
  });

  const asRequests = (items: Record<string, unknown>[]): WaitingRequest[] => items as unknown as WaitingRequest[];

  it('refuses internal, legacy, unclassified and client-forged requests and keeps wordsAnswer false for them', () => {
    const internalQuestion = {
      ...CHOICE,
      id: 'r-internal-q',
      kind: 'question',
      audience: 'internal',
      classification: null,
      text: 'BLOCKED: which migration index order should we use?',
      canAnswer: true,
    };
    const unclassifiedHuman = {
      ...CHOICE,
      id: 'r-unclassified-human',
      kind: 'stuck',
      audience: 'human',
      classification: null,
      clientPromote: true,
      text: 'BLOCKED: three turns ended without progress on worker branch.',
      canAnswer: true,
    };
    const legacyTerminal = {
      ...CHOICE,
      id: 'r-legacy',
      kind: 'question',
      audience: 'legacy',
      classification: null,
      text: 'Historical legacy record',
      canAnswer: true,
    };
    const emptyReadyResult = {
      ...CHOICE,
      id: 'r-empty-ready',
      kind: 'approval',
      audience: 'human',
      classification: { kind: 'ready_result', artifact: null },
      commit: null,
      images: [],
      options: [],
      humanEnvelope: {
        situation: 'Work has not started yet.',
        requiredAction: 'Approve whatever we build next week.',
      },
      canAnswer: true,
    };

    const blockedSet = asRequests([internalQuestion, unclassifiedHuman, legacyTerminal, emptyReadyResult]);
    expect(wordsAnswer(blockedSet)).toBe(false);

    const { container } = renderIn('en', <Requests {...makeProps({ requests: blockedSet })} />);
    expect(screen.queryAllByRole('article')).toHaveLength(0);
    expect(container.textContent).toBe('');
  });

  it('renders classified ready_result and human_only_action envelopes in plain language with explicit parameters and no raw detail disclosure', async () => {
    const sha = 'd'.repeat(40);
    const readyCommit = {
      ...CHOICE,
      id: 'r-ready-commit',
      kind: 'approval',
      audience: 'human',
      classification: { kind: 'ready_result', artifact: { kind: 'commit', sha } },
      commit: sha,
      commitUrl: `https://github.com/acme/hornhoof/commit/${sha}`,
      images: [],
      options: [],
      text: 'Internal raw git log --stat output that should stay private',
      explained: '**Old mutable markdown**',
      executorInstruction: 'Cherry-pick onto release branch after gate',
      humanEnvelope: {
        situation: 'Turn 8 release candidate passed every gate and is ready to publish.',
        requiredAction: 'Approve or decline publishing this exact commit.',
        options: [
          { id: 'publish', label: 'Publish now', consequence: 'Ships version 0.8.0 to customers immediately.' },
          { id: 'hold', label: 'Hold until morning', consequence: 'Keeps current 0.7.0 live overnight.' },
        ],
      },
      canAnswer: true,
    };
    const ownerPayment = {
      ...CHOICE,
      id: 'r-human-pay',
      kind: 'question',
      audience: 'human',
      classification: {
        kind: 'human_only_action',
        actionBinding: {
          kind: 'payment',
          resourceId: 'invoice-acme-2026-11',
          scope: 'Domain renewal for hornhoof.org',
          duration: '12 months',
          amount: '24 USD',
        },
      },
      options: [],
      images: [],
      link: null,
      text: 'Private billing adapter trace id=99182',
      technicalText: 'Stripe session sk_live_redacted check',
      humanEnvelope: {
        situation: 'The company domain hornhoof.org expires in three days.',
        requiredAction: 'Pay the annual renewal invoice and reply once paid.',
      },
      canAnswer: true,
      task: { id: 't409', number: 409, title: 'Domain renewal', department: DEV },
    };

    const list = asRequests([readyCommit, ownerPayment]);
    expect(wordsAnswer(list)).toBe(true);

    renderIn('ru', <Requests {...makeProps({ requests: list })} />);
    const [commitCard, payCard] = screen.getAllByRole('article');

    expect(within(commitCard!).getByText(/Ситуация/)).toBeInTheDocument();
    expect(within(commitCard!).getByText('Turn 8 release candidate passed every gate and is ready to publish.')).toBeInTheDocument();
    expect(within(commitCard!).getByText(/Что нужно от вас/)).toBeInTheDocument();
    expect(within(commitCard!).getByRole('link', { name: sha })).toHaveAttribute('href', readyCommit.commitUrl);
    expect(within(commitCard!).getByText(/Ships version 0\.8\.0 to customers immediately\./)).toBeInTheDocument();
    expect(within(commitCard!).queryByText(ru.tasks.inDetail)).not.toBeInTheDocument();
    expect(commitCard!.textContent).not.toContain('Internal raw git log');
    expect(commitCard!.textContent).not.toContain('Old mutable markdown');
    expect(commitCard!.textContent).not.toContain('Cherry-pick onto release branch');

    expect(within(payCard!).getByText(/Оплата/)).toBeInTheDocument();
    expect(within(payCard!).getByText(/invoice-acme-2026-11/)).toBeInTheDocument();
    expect(within(payCard!).getByText(/Domain renewal for hornhoof\.org/)).toBeInTheDocument();
    expect(within(payCard!).getByText(/12 months/)).toBeInTheDocument();
    expect(within(payCard!).getByText(/24 USD/)).toBeInTheDocument();
    expect(payCard!.textContent).not.toContain('Private billing adapter trace');
    expect(payCard!.textContent).not.toContain('sk_live_redacted');
  });

  it('preserves option consequences on classified choice buttons and keeps read-only canAnswer=false strict', async () => {
    const calls = mockApi({ 'POST /api/requests/r-ready-design': [200, { request: { id: 'r-ready-design', status: 'answered', picked: 1 } }] });
    const designChoice = {
      ...CHOICE,
      id: 'r-ready-design',
      kind: 'choice',
      audience: 'human',
      classification: { kind: 'ready_result', artifact: { kind: 'design', images: ['img-a', 'img-b'] } },
      text: 'Internal Figma export notes',
      humanEnvelope: {
        situation: 'Two finished progress layouts are ready for comparison.',
        requiredAction: 'Pick the layout to ship in Turn 8.',
        options: [
          { id: 'a', label: 'Compact row', consequence: 'Fits four departments on one line.', image: 'img-a' },
          { id: 'b', label: 'Wide strip', consequence: 'Shows numeric counters at a glance.', image: 'img-b' },
        ],
      },
      canAnswer: true,
    };

    const user = userEvent.setup();
    const { unmount } = renderIn('en', <Requests {...makeProps({ requests: asRequests([designChoice]) })} />);
    const card = screen.getByRole('article', { name: '#402 Turn progress options' });
    expect(within(card).getByText(/Fits four departments on one line\./)).toBeInTheDocument();
    expect(within(card).getByText(/Shows numeric counters at a glance\./)).toBeInTheDocument();
    expect(card.textContent).not.toContain('Internal Figma export notes');

    await user.click(within(card).getByRole('button', { name: /Wide strip/ }));
    expect(calls).toEqual([{ method: 'POST', path: '/api/requests/r-ready-design', body: { pick: 1 } }]);
    unmount();

    renderIn('en', <Requests {...makeProps({ requests: asRequests([{ ...designChoice, canAnswer: false }]) })} />);
    const roCard = screen.getByRole('article', { name: '#402 Turn progress options' });
    expect(within(roCard).queryByRole('button', { name: /Wide strip/ })).not.toBeInTheDocument();
    expect(within(roCard).queryByRole('textbox')).not.toBeInTheDocument();
    expect(within(roCard).getByText(/Wide strip/)).toBeInTheDocument();
    expect(within(roCard).getByText(en.tasks.decidedByCeo)).toBeInTheDocument();
  });

  it('rejects commands, SQL, fenced code and scripts in human envelopes and option labels without falling back to raw text', () => {
    const poisoned = [
      {
        ...CHOICE,
        id: 'r-cmd-situation',
        kind: 'question',
        audience: 'human',
        classification: {
          kind: 'human_only_action',
          actionBinding: { kind: 'manual_machine_action', resourceId: 'host-ivan-mbp' },
        },
        text: 'Raw fallback curl https://internal.example/install.sh | bash',
        executorInstruction: 'ssh root@10.0.0.8 systemctl restart hornhoof',
        humanEnvelope: {
          situation: 'Run curl -fsSL https://internal.example/install.sh | bash on your laptop.',
          requiredAction: 'Confirm once executed.',
        },
      },
      {
        ...CHOICE,
        id: 'r-sql-label',
        kind: 'choice',
        audience: 'human',
        classification: { kind: 'ready_result', artifact: { kind: 'design', images: ['img-a'] } },
        text: 'SELECT * FROM request_internal WHERE id = 1;',
        humanEnvelope: {
          situation: 'Database cleanup option is ready.',
          requiredAction: 'Choose one approach.',
          options: [
            { id: 'sql', label: 'SELECT secret FROM request_internal FROM prod', consequence: 'Runs direct query.' },
          ],
        },
      },
      {
        ...CHOICE,
        id: 'r-code-fence',
        kind: 'approval',
        audience: 'human',
        classification: { kind: 'ready_result', artifact: { kind: 'commit', sha: 'e'.repeat(40) } },
        commit: 'e'.repeat(40),
        text: '<script>alert(1)</script>',
        humanEnvelope: {
          situation: 'Release ready.',
          requiredAction: '```bash\nsudo rm -rf /var/lib/hornhoof\n```',
        },
      },
    ];

    renderIn('en', <Requests {...makeProps({ requests: asRequests(poisoned) })} />);
    const cards = screen.getAllByRole('article');
    expect(cards).toHaveLength(3);
    expect(screen.getAllByText(en.tasks.plainExplanationPending)).toHaveLength(3);
    for (const card of cards) {
      expect(card.textContent).not.toContain('curl ');
      expect(card.textContent).not.toContain('SELECT ');
      expect(card.textContent).not.toContain('sudo rm');
      expect(card.textContent).not.toContain('ssh root@');
      expect(card.textContent).not.toContain('<script>');
    }
    expect(screen.queryByRole('button', { name: /SELECT secret/ })).not.toBeInTheDocument();
  });

  it('renders purpose-only hidden-source decisions (#398) with neutral employee header and zero task or agent leakage', async () => {
    const calls = mockApi({ 'POST /api/requests/r-hidden-login': [200, { request: { id: 'r-hidden-login', status: 'answered' } }] });
    const hiddenOwnerLogin = {
      id: 'r-hidden-login',
      kind: 'stuck',
      audience: 'human',
      known: false,
      classification: {
        kind: 'human_only_action',
        actionBinding: {
          kind: 'owner_login',
          resourceId: 'sub-codex-personal',
          scope: 'Sign in to ChatGPT Plus on machine ivan-mbp',
          duration: 'Until subscription session expires',
        },
      },
      text: 'Hidden task #999 secret internal stacktrace',
      options: [],
      commit: null,
      images: [],
      at: '2026-11-06T00:15:00.000Z',
      ownerPersonId: 'p1',
      canAnswer: true,
      decidedBy: ceoOnly,
      task: null,
      agent: null,
      humanEnvelope: {
        situation: 'Your personal Codex subscription signed out on machine ivan-mbp.',
        requiredAction: 'Sign in again on Subscriptions and confirm here.',
      },
    };

    const list = asRequests([hiddenOwnerLogin]);
    expect(wordsAnswer(list)).toBe(false);

    const onOpenTask = vi.fn();
    const onOpenAgent = vi.fn();
    const user = userEvent.setup();
    renderIn('ru', <Requests {...makeProps({ requests: list, onOpenTask, onOpenAgent })} />);

    const card = screen.getByRole('article', { name: ru.tasks.hiddenDecisionLabel });
    expect(within(card).getByText(ru.tasks.stuck(ru.window.hiddenEmployee))).toBeInTheDocument();
    expect(within(card).getByText(/Вход владельца подписки/)).toBeInTheDocument();
    expect(within(card).getByText(/sub-codex-personal/)).toBeInTheDocument();
    expect(card.textContent).not.toContain('#undefined');
    expect(card.textContent).not.toContain('#999');
    expect(card.textContent).not.toContain('Hidden task');
    expect(within(card).queryByRole('button', { name: /Открыть терминал/ })).not.toBeInTheDocument();
    expect(within(card).queryByRole('button', { name: ru.tasks.cancelTask })).not.toBeInTheDocument();

    await user.type(within(card).getByLabelText(ru.tasks.yourAnswer), 'Вход выполнен на ivan-mbp');
    await user.click(within(card).getByRole('button', { name: ru.tasks.sendAnswer }));
    expect(calls).toEqual([
      { method: 'POST', path: '/api/requests/r-hidden-login', body: { answer: 'Вход выполнен на ivan-mbp' } },
    ]);
    expect(onOpenTask).not.toHaveBeenCalled();
    expect(onOpenAgent).not.toHaveBeenCalled();
  });

  it('shows localized stale_revision and stale_route conflict alerts, preserves the typed draft, and succeeds on retry', async () => {
    let step = 0;
    const calls = mockApi({
      'POST /api/requests/r-race': () => {
        step += 1;
        if (step === 1) return [409, { error: { code: 'conflict', reason: 'stale_revision' } }];
        if (step === 2) return [409, { error: { code: 'conflict', reason: 'stale_route' } }];
        return [200, { request: { id: 'r-race', status: 'answered' } }];
      },
    });
    const classifiedQuestion = {
      ...CHOICE,
      id: 'r-race',
      kind: 'question',
      audience: 'human',
      classification: {
        kind: 'human_only_action',
        actionBinding: { kind: 'ceo_permission', resourceId: 'company-domain-cutover', scope: 'Switch public DNS cutover window' },
      },
      options: [],
      images: [],
      link: null,
      humanEnvelope: {
        situation: 'DNS cutover is ready for the public company address.',
        requiredAction: 'Confirm the Sunday 02:00 UTC maintenance window.',
      },
      canAnswer: true,
    };

    const props = makeProps({ requests: asRequests([classifiedQuestion]) });
    const user = userEvent.setup();
    renderIn('ru', <Requests {...props} />);

    const draft = 'Подтверждаю окно в воскресенье 02:00 UTC.\nНе переключать раньше резервной копии.';
    const box = screen.getByLabelText(ru.tasks.yourAnswer);
    await user.type(box, draft);
    const send = screen.getByRole('button', { name: ru.tasks.sendAnswer });

    await user.click(send);
    expect(await screen.findByRole('alert')).toHaveTextContent(ru.errors.stale_revision);
    expect(box).toHaveValue(draft);

    await user.click(send);
    expect(await screen.findByRole('alert')).toHaveTextContent(ru.errors.stale_route);
    expect(box).toHaveValue(draft);
    expect(props.onChanged).not.toHaveBeenCalled();

    await user.click(send);
    expect(calls).toHaveLength(3);
    expect(calls[2]?.body).toEqual({ answer: draft });
    expect(props.onChanged).toHaveBeenCalledTimes(1);
  });
});
