import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { en } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import type { TaskDetail, WaitingRequest } from '../src/types';
import { Requests } from '../src/ui/Requests';
import { formatFileSize, fullTextOf } from '../src/ui/TaskAttachments';
import { TaskPanel } from '../src/ui/TaskPanel';
import { DEV_ORG, mockApi, REQUESTS, TASK_DETAIL } from './api-mock';
import { openTaskAction } from './open-task';
import { decl } from './css';
import { renderIn, requestProps } from './request-feedback-fixture';

const DEV = { id: 'd2', name: 'Development' };
const ceoOnly = { kind: 'ceo_and_delegate' as const, department: null };

/* Builds a deterministic >= 12,000-character multi-line UTF-8 text with distinct head, middle and tail markers. */
function makeLongText(prefix: string, targetLength = 12_000): string {
  const head = `[${prefix}:HEAD] Line 1 - multi-line UTF-8 проверка (RU/EN).\n`;
  const tail = `\n[${prefix}:TAIL] Final verified line at exact target length.`;
  const chunk = 'Section block: detailed review findings, reproducible commands, and user-facing notes.\n';
  const bodyBudget = targetLength - head.length - tail.length;
  const repeats = Math.ceil(bodyBudget / chunk.length);
  const middle = chunk.repeat(repeats).slice(0, bodyBudget);
  const full = `${head}${middle}${tail}`;
  expect(full.length).toBe(targetLength);
  return full;
}

const CHOICE: WaitingRequest = {
  ...REQUESTS[0]!,
  id: 'r-choice-long',
  kind: 'choice',
  text: 'Which layout should we ship for turn progress?',
  images: [],
  link: null,
  options: [
    { label: 'Option A: compact row', image: null },
    { label: 'Option B: wide strip', image: null },
  ],
  canAnswer: true,
  decidedBy: ceoOnly,
  agent: { id: 'a-design', name: 'Interface Designer' },
  task: { id: 't12', number: 12, title: 'Checkout API', department: DEV },
};

type MockReply =
  | { kind: 'json'; status: number; data?: unknown }
  | { kind: 'text'; status: number; text: string }
  | { kind: 'network' };

const NO_RECORDINGS: MockReply = { kind: 'json', status: 200, data: { recordings: [] } };

function stubFetchRoutes(routes: Record<string, MockReply | ((body: unknown) => MockReply | Promise<MockReply>)>) {
  const calls: { method: string; path: string; body: unknown; credentials?: RequestCredentials }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
      calls.push({ method, path, body, credentials: init.credentials });
      /* The task panel asks every task for its phone recordings; a task of these tests has none, as mockApi answers too.
         Unanswered, the panel would show a second alert beside the one a test looks for. */
      const handler = routes[`${method} ${path}`] ?? (method === 'GET' && /^\/api\/tasks\/[^/]+\/phone-recordings$/.test(path) ? NO_RECORDINGS : undefined);
      const reply: MockReply =
        typeof handler === 'function'
          ? await handler(body)
          : handler ?? { kind: 'json', status: 404, data: { error: { code: 'not_found', message: 'Not found.' } } };
      if (reply.kind === 'network') throw new TypeError('Failed to fetch');
      if (reply.kind === 'text') {
        return new Response(reply.text, { status: reply.status, headers: { 'content-type': 'text/plain; charset=utf-8' } });
      }
      return new Response(reply.data === undefined ? null : JSON.stringify(reply.data), {
        status: reply.status,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
  return calls;
}

describe('long 12,000-character feedback, answers, and full report reading', () => {
  afterEach(() => {
    cleanup();
    localStorage.removeItem('hh-lang');
    vi.restoreAllMocks();
  });

  it.each([
    ['en', 'Comment or feedback', 'Send without choosing'],
    ['ru', 'Комментарий или замечания', 'Отправить без выбора'],
  ] as const)('sends a full 12,000-character neutral choice feedback without pick in %s', async (lang, label, sendLabel) => {
    const feedback12k = makeLongText(`CHOICE-${lang.toUpperCase()}`, 12_000);
    const calls = mockApi({
      'POST /api/requests/r-choice-long': [200, { request: { id: 'r-choice-long', status: 'answered', picked: null, answer: feedback12k } }],
    });
    const props = requestProps(CHOICE);
    const user = userEvent.setup();
    renderIn(lang, <Requests {...props} />);

    const box = screen.getByLabelText(label) as HTMLTextAreaElement;
    await user.click(box);
    await user.paste(feedback12k);
    expect(box.value.length).toBe(12_000);
    expect(box.value).toBe(feedback12k);

    await user.click(screen.getByRole('button', { name: sendLabel }));
    expect(calls).toEqual([
      {
        method: 'POST',
        path: '/api/requests/r-choice-long',
        body: { answer: feedback12k },
      },
    ]);
    const sent = calls[0]!.body as Record<string, unknown>;
    expect((sent.answer as string).length).toBe(12_000);
    expect(sent.answer).toContain(`[CHOICE-${lang.toUpperCase()}:TAIL]`);
    expect('pick' in sent).toBe(false);
    expect(props.onChanged).toHaveBeenCalledTimes(1);
  });

  it('sends a full 12,000-character comment alongside explicit option pick: 0', async () => {
    const comment12k = makeLongText('PICK0-COMMENT', 12_000);
    const calls = mockApi({
      'POST /api/requests/r-choice-long': [200, { request: { id: 'r-choice-long', status: 'answered', picked: 0, answer: comment12k } }],
    });
    const user = userEvent.setup();
    renderIn('en', <Requests {...requestProps(CHOICE)} />);

    const box = screen.getByLabelText('Comment or feedback');
    await user.click(box);
    await user.paste(comment12k);
    await user.click(screen.getByRole('button', { name: /Option A/ }));

    expect(calls).toEqual([
      {
        method: 'POST',
        path: '/api/requests/r-choice-long',
        body: { pick: 0, answer: comment12k },
      },
    ]);
  });

  it('accepts and sends 12,000-character multi-line answers on question, stuck, and approval requests without stripping newlines', async () => {
    const questionText = makeLongText('QUESTION', 12_000);
    const stuckText = makeLongText('STUCK', 12_000);
    const approvalNote = makeLongText('APPROVAL-NOTE', 12_000);
    const questionReq: WaitingRequest = { ...REQUESTS[0]!, id: 'r-q-12k', kind: 'question', canAnswer: true };
    const stuckReq: WaitingRequest = { ...REQUESTS[0]!, id: 'r-s-12k', kind: 'stuck', canAnswer: true };
    const approvalReq: WaitingRequest = { ...REQUESTS[1]!, id: 'r-a-12k', kind: 'approval', canAnswer: true };

    const calls = mockApi({
      'POST /api/requests/r-q-12k': [200, { request: { id: 'r-q-12k', status: 'answered' } }],
      'POST /api/requests/r-s-12k': [200, { request: { id: 'r-s-12k', status: 'answered' } }],
      'POST /api/requests/r-a-12k': [200, { request: { id: 'r-a-12k', status: 'declined' } }],
    });
    const user = userEvent.setup();
    renderIn('en', <Requests {...requestProps(CHOICE, { requests: [questionReq, stuckReq, approvalReq] })} />);

    const [qCard, sCard, aCard] = screen.getAllByRole('article');

    const qBox = within(qCard!).getByLabelText(en.tasks.yourAnswer);
    await user.click(qBox);
    await user.paste(questionText);
    await user.click(within(qCard!).getByRole('button', { name: en.tasks.sendAnswer }));

    const sBox = within(sCard!).getByLabelText(en.tasks.yourAnswer);
    await user.click(sBox);
    await user.paste(stuckText);
    await user.click(within(sCard!).getByRole('button', { name: en.tasks.sendAnswer }));

    const aBox = within(aCard!).getByLabelText(en.tasks.note);
    await user.click(aBox);
    await user.paste(approvalNote);
    await user.click(within(aCard!).getByRole('button', { name: en.tasks.decline }));

    expect(calls).toEqual([
      { method: 'POST', path: '/api/requests/r-q-12k', body: { answer: questionText } },
      { method: 'POST', path: '/api/requests/r-s-12k', body: { answer: stuckText } },
      { method: 'POST', path: '/api/requests/r-a-12k', body: { approve: false, answer: approvalNote } },
    ]);
    expect((calls[2]!.body as { answer: string }).answer).toContain('\n[APPROVAL-NOTE:TAIL]');
  });

  it('preserves all 12,000 characters on server refusal, keeps request open with localized alert, and succeeds on retry', async () => {
    const feedback12k = makeLongText('RETRY-12K', 12_000);
    let rejectNow = true;
    const calls = mockApi({
      'POST /api/requests/r-choice-long': () =>
        rejectNow
          ? [400, { error: { code: 'validation' } }]
          : [200, { request: { id: 'r-choice-long', status: 'answered', picked: null, answer: feedback12k } }],
    });
    const props = requestProps(CHOICE);
    const user = userEvent.setup();
    renderIn('ru', <Requests {...props} />);

    const box = screen.getByLabelText('Комментарий или замечания') as HTMLTextAreaElement;
    await user.click(box);
    await user.paste(feedback12k);
    const send = screen.getByRole('button', { name: 'Отправить без выбора' });
    await user.click(send);

    expect(await screen.findByRole('alert')).toHaveTextContent(ru.errors.codes.validation);
    expect(box.value.length).toBe(12_000);
    expect(box.value).toBe(feedback12k);
    expect(props.onChanged).not.toHaveBeenCalled();

    rejectNow = false;
    await user.click(send);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.body).toEqual({ answer: feedback12k });
    expect(props.onChanged).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('keeps canAnswer: false strict read-only without exposing any long-text inputs or buttons', () => {
    renderIn('en', <Requests {...requestProps(CHOICE, { requests: [{ ...CHOICE, canAnswer: false }] })} />);
    expect(screen.getByText(en.tasks.decidedByCeo)).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send without choosing' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Option A/ })).not.toBeInTheDocument();
  });

  it.each([
    ['en', { readFull: 'Read in full', showLess: 'Show less', files: 'Files', questions: 'Questions', evidence: 'Evidence', verdictLink: 'Open file (verdict-comment.txt, 14 KB)', evLink: 'Open file (submit-evidence.txt, 13 KB)', smallSize: '512 B', mbSize: '2.5 MB' }],
    ['ru', { readFull: 'Показать полностью', showLess: 'Свернуть', files: 'Файлы', questions: 'Вопросы', evidence: 'Доказательства', verdictLink: 'Открыть файл (verdict-comment.txt, 14 КБ)', evLink: 'Открыть файл (submit-evidence.txt, 13 КБ)', smallSize: '512 Б', mbSize: '2.5 МБ' }],
  ] as const)(
    'reads full 12,000-char verdict text, submit evidence, task files, and inline choice answer in TaskPanel (%s) without technical noise',
    async (lang, words) => {
      const fullVerdict = makeLongText('VERDICT-FULL', 12_400);
      const fullEvidence = makeLongText('EVIDENCE-FULL', 12_150);
      const fullAnswer = makeLongText('ANSWER-INLINE', 12_050);
      const verdictSha = 'deadbeef'.repeat(8);
      const evidenceSha = 'feedface'.repeat(8);

      const taskWithLongData: TaskDetail = {
        ...TASK_DETAIL,
        requests: [
          {
            id: 'req-answered-12k',
            kind: 'choice',
            text: 'Which progress design works best?',
            commit: null,
            status: 'answered',
            answer: fullAnswer,
            agent: TASK_DETAIL.executor,
            at: '2026-11-05T12:00:00.000Z',
          },
        ],
        files: [
          { id: 'att/note 1', name: 'summary-note.txt', size: 512, by: { id: 'b1', name: 'Bruno' }, at: '2026-11-05T12:01:00.000Z' },
          { id: 'att-verdict', name: 'verdict-comment.txt', size: 14_000, by: { id: 'b2', name: 'Rita' }, at: '2026-11-05T12:02:00.000Z' },
          { id: 'att-bundle', name: 'playwright-trace-archive-very-long-unspaced-name.zip', size: 2_621_440, by: { id: 'b1', name: 'Bruno' }, at: '2026-11-05T12:03:00.000Z' },
        ],
        log: [
          {
            kind: 'submitted',
            text: 'Implemented slice.',
            data: {
              evidence: '[EVIDENCE-PREVIEW] First 3800 chars...',
              fullTexts: [{ field: 'evidence', id: 'att-ev', name: 'submit-evidence.txt', size: 12_500, sha256: evidenceSha }],
            },
            by: { kind: 'agent', id: 'b1', name: 'Bruno' },
            at: '2026-11-05T12:05:00.000Z',
          },
          {
            kind: 'verdict',
            text: '[VERDICT-PREVIEW] Beginning of reviewer findings...',
            data: {
              pass: false,
              fullTexts: [
                { field: 'text', id: 'att-verdict', name: 'verdict-comment.txt', size: 14_000, sha256: verdictSha },
                /* Malformed entries are ignored safely without crashing. */
                null,
                { field: 'unknown', id: 'x', name: 'x.txt', size: 10 },
                { field: 'text', id: '', name: 'empty.txt', size: 10 },
                { field: 'text', id: 'bad-size', name: 'bad.txt', size: Number.NaN },
              ],
            },
            by: { kind: 'agent', id: 'b2', name: 'Rita' },
            at: '2026-11-05T12:10:00.000Z',
          },
        ],
      };

      const calls = stubFetchRoutes({
        'GET /api/org': { kind: 'json', status: 200, data: DEV_ORG },
        'GET /api/tasks/t12': { kind: 'json', status: 200, data: { task: taskWithLongData } },
        'GET /api/attachments/att-verdict': { kind: 'text', status: 200, text: fullVerdict },
        'GET /api/attachments/att-ev': { kind: 'text', status: 200, text: fullEvidence },
      });

      const user = userEvent.setup();
      renderIn(
        lang,
        <TaskPanel
          taskId="t12"
          onClose={vi.fn()}
          onOpen={vi.fn()}
          requests={[]}
          onRequestsChanged={vi.fn()}
          onOpenAgent={vi.fn()}
        />,
      );

      const panel = await screen.findByRole('complementary', { name: '#12 Checkout API' });

      const t = lang === 'ru' ? ru : en;
      await openTaskAction(user, panel, t.tasks.details);
      /* 1. Inline 12,000+ char request answer renders completely without truncation. */
      const questionsSection = within(panel).getByRole('heading', { name: words.questions }).closest('section')!;
      expect(questionsSection.textContent).toContain('[ANSWER-INLINE:HEAD]');
      expect(questionsSection.textContent).toContain('[ANSWER-INLINE:TAIL]');

      /* 2. Task files section shows plain file names, links, and formatted sizes. */
      await openTaskAction(user, panel, t.tracker.card.materials);
      const filesRegion = within(panel).getByRole('region', { name: words.files });
      const noteLink = within(filesRegion).getByRole('link', { name: 'summary-note.txt' });
      expect(noteLink).toHaveAttribute('href', '/api/attachments/att%2Fnote%201');
      expect(noteLink).toHaveClass('req-link');
      expect(filesRegion).toHaveTextContent(words.smallSize);
      expect(filesRegion).toHaveTextContent(words.mbSize);

      await openTaskAction(user, panel, t.tasks.fullLog);
      /* 3. Before expanding: preview and plain links show, with zero sha256 or hh-fetch noise. */
      expect(panel.textContent).toContain('[VERDICT-PREVIEW] Beginning of reviewer findings...');
      expect(panel.textContent).not.toContain(verdictSha);
      expect(panel.textContent).not.toContain(evidenceSha);
      expect(panel.textContent).not.toContain('hh-fetch');

      const logList = within(panel).getByRole('list', { name: t.tasks.fullLog });
      const [subItem, verdictItem] = within(logList).getAllByRole('listitem');

      const verdictFileLink = within(verdictItem!).getByRole('link', { name: words.verdictLink });
      expect(verdictFileLink).toHaveAttribute('href', '/api/attachments/att-verdict');

      const expandVerdict = within(verdictItem!).getByRole('button', { name: words.readFull });
      expect(expandVerdict).toHaveAttribute('aria-expanded', 'false');

      /* 4. Clicking Read in full loads the exact 12,400-char UTF-8 verdict byte-for-byte. */
      await user.click(expandVerdict);
      const collapseVerdict = await within(verdictItem!).findByRole('button', { name: words.showLess });
      expect(collapseVerdict).toHaveAttribute('aria-expanded', 'true');
      expect(verdictItem!.textContent).toContain('[VERDICT-FULL:HEAD]');
      expect(verdictItem!.textContent).toContain('[VERDICT-FULL:TAIL]');
      expect(verdictItem!.textContent).not.toContain('[VERDICT-PREVIEW]');

      /* 5. Collapsing and re-expanding reuses the loaded text without another network fetch. */
      await user.click(collapseVerdict);
      expect(verdictItem!.textContent).toContain('[VERDICT-PREVIEW]');
      expect(verdictItem!.textContent).not.toContain('[VERDICT-FULL:TAIL]');
      const verdictFetchesBefore = calls.filter(c => c.path === '/api/attachments/att-verdict').length;
      expect(verdictFetchesBefore).toBe(1);
      expect(calls.find(c => c.path === '/api/attachments/att-verdict')?.credentials).toBe('same-origin');

      await user.click(within(verdictItem!).getByRole('button', { name: words.readFull }));
      expect(verdictItem!.textContent).toContain('[VERDICT-FULL:TAIL]');
      expect(calls.filter(c => c.path === '/api/attachments/att-verdict')).toHaveLength(1);

      /* 6. Expanding submit evidence loads the full 12,150-char evidence independently. */
      expect(within(subItem!).getByRole('link', { name: words.evLink })).toHaveAttribute('href', '/api/attachments/att-ev');
      await user.click(within(subItem!).getByRole('button', { name: words.readFull }));
      await within(subItem!).findByRole('button', { name: words.showLess });
      expect(subItem!.textContent).toContain(`${words.evidence}: [EVIDENCE-FULL:HEAD]`);
      expect(subItem!.textContent).toContain('[EVIDENCE-FULL:TAIL]');
    },
  );

  it('prevents duplicate attachment fetches while loading, shows alert on failure keeping preview, and succeeds on retry', async () => {
    const fullReport = makeLongText('REPORT-RETRY', 12_000);
    let attempt = 0;
    let resolvePending!: (reply: MockReply) => void;

    const taskWithReport: TaskDetail = {
      ...TASK_DETAIL,
      log: [
        {
          kind: 'report',
          text: '[REPORT-PREVIEW] Summary start...',
          data: {
            done: true,
            fullTexts: [{ field: 'text', id: 'att-report', name: 'report.txt', size: 12_000, sha256: 'abcd'.repeat(16) }],
          },
          by: { kind: 'agent', id: 'b1', name: 'Bruno' },
          at: '2026-11-05T12:20:00.000Z',
        },
      ],
    };

    const calls = stubFetchRoutes({
      'GET /api/org': { kind: 'json', status: 200, data: DEV_ORG },
      'GET /api/tasks/t12': { kind: 'json', status: 200, data: { task: taskWithReport } },
      'GET /api/attachments/att-report': () => {
        attempt += 1;
        if (attempt === 1) {
          return new Promise<MockReply>(resolve => {
            resolvePending = resolve;
          });
        }
        if (attempt === 2) {
          return { kind: 'json', status: 503, data: { error: { code: 'unavailable' } } };
        }
        return { kind: 'text', status: 200, text: fullReport };
      },
    });

    const user = userEvent.setup();
    renderIn(
      'en',
      <TaskPanel
        taskId="t12"
        onClose={vi.fn()}
        onOpen={vi.fn()}
        requests={[]}
        onRequestsChanged={vi.fn()}
        onOpenAgent={vi.fn()}
      />,
    );

    const panel = await screen.findByRole('complementary', { name: '#12 Checkout API' });
    await openTaskAction(user, panel, en.tasks.fullLog);
    const logItem = within(within(panel).getByRole('list', { name: en.tasks.fullLog })).getByRole('listitem');
    const readBtn = within(logItem).getByRole('button', { name: 'Read in full' });

    /* Rapid double-click triggers only a single fetch and disables button while loading. */
    fireEvent.click(readBtn);
    fireEvent.click(readBtn);
    expect(calls.filter(c => c.path === '/api/attachments/att-report')).toHaveLength(1);
    expect(within(logItem).getByRole('button', { name: en.common.loading })).toBeDisabled();

    /* First attempt fails with network error: preview stays intact and alert appears. */
    resolvePending({ kind: 'network' });
    expect(await within(logItem).findByRole('alert')).toHaveTextContent(en.errors.codes.network);
    expect(logItem.textContent).toContain('[REPORT-PREVIEW] Summary start...');
    const retryBtn = within(logItem).getByRole('button', { name: 'Read in full' });
    expect(retryBtn).toBeEnabled();
    expect(retryBtn).toHaveAttribute('aria-expanded', 'false');

    /* Second attempt fails with HTTP 503 JSON error: localized unavailable alert appears, preview stays intact. */
    await user.click(retryBtn);
    expect(await within(logItem).findByRole('alert')).toHaveTextContent(en.errors.codes.unavailable);
    expect(logItem.textContent).toContain('[REPORT-PREVIEW] Summary start...');

    /* Third attempt loads full 12,000-char report and clears the alert. */
    await user.click(within(logItem).getByRole('button', { name: 'Read in full' }));
    await within(logItem).findByRole('button', { name: 'Show less' });
    expect(logItem.textContent).toContain('[REPORT-RETRY:TAIL]');
    expect(within(logItem).queryByRole('alert')).not.toBeInTheDocument();
  });

  it('posts a 12,000-character comment in TaskPanel, blocks double submit, and preserves typed text on error', async () => {
    const comment12k = makeLongText('TASK-COMMENT', 12_000);
    let failComment = true;
    let resolveSecond!: (reply: MockReply) => void;

    const calls = stubFetchRoutes({
      'GET /api/org': { kind: 'json', status: 200, data: DEV_ORG },
      'GET /api/tasks/t12': { kind: 'json', status: 200, data: { task: { ...TASK_DETAIL, files: [] } } },
      'POST /api/tasks/t12/comments': () => {
        if (failComment) return { kind: 'json', status: 503, data: { error: { code: 'unavailable' } } };
        return new Promise<MockReply>(resolve => {
          resolveSecond = resolve;
        });
      },
    });

    const user = userEvent.setup();
    renderIn(
      'ru',
      <TaskPanel
        taskId="t12"
        onClose={vi.fn()}
        onOpen={vi.fn()}
        requests={[]}
        onRequestsChanged={vi.fn()}
        onOpenAgent={vi.fn()}
      />,
    );

    const panel = await screen.findByRole('complementary', { name: '#12 Checkout API' });
    /* TASK_DETAIL has no files, so Files section stays hidden. */
    expect(within(panel).queryByRole('region', { name: 'Файлы' })).not.toBeInTheDocument();

    await openTaskAction(user, panel, ru.tasks.comment);
    const box = within(panel).getByRole('textbox', { name: 'Комментарий' }) as HTMLTextAreaElement;
    await user.click(box);
    await user.paste(comment12k);
    expect(box.value.length).toBe(12_000);

    const addBtn = within(panel).getByRole('button', { name: 'Добавить комментарий' });
    await user.click(addBtn);

    expect(await within(panel).findByRole('alert')).toHaveTextContent(ru.errors.codes.unavailable);
    expect(box.value.length).toBe(12_000);
    expect(box.value).toBe(comment12k);

    failComment = false;
    fireEvent.click(addBtn);
    fireEvent.click(addBtn);
    fireEvent.submit(box.closest('form')!);
    expect(calls.filter(c => c.path === '/api/tasks/t12/comments')).toHaveLength(2);

    resolveSecond({ kind: 'json', status: 201, data: { task: TASK_DETAIL } });
    await waitFor(() => expect(box).not.toBeInTheDocument());
    await openTaskAction(user, panel, ru.tasks.comment);
    expect(within(panel).getByRole('textbox', { name: ru.tasks.comment })).toHaveValue('');
    expect(calls.filter(c => c.path === '/api/tasks/t12/comments')[1]?.body).toEqual({ text: comment12k });
  });

  it('keeps .req-link shrinkable and wrapping inside flex rows for narrow 375px panels', () => {
    expect(decl('.req-link', 'min-width')).toBe('0');
    expect(decl('.req-link', 'overflow-wrap')).toBe('anywhere');
  });

  it('formats byte boundaries and validates untrusted fullTexts boundary inputs strictly', () => {
    expect(formatFileSize(en, -10)).toBe('0 B');
    expect(formatFileSize(en, 0)).toBe('0 B');
    expect(formatFileSize(en, 1023)).toBe('1023 B');
    expect(formatFileSize(en, 1024)).toBe('1 KB');
    expect(formatFileSize(ru, 1025)).toBe('2 КБ');
    expect(formatFileSize(en, 1024 * 1024 - 1)).toBe('1024 KB');
    expect(formatFileSize(en, 1024 * 1024)).toBe('1.0 MB');
    expect(formatFileSize(ru, 1024 * 1024)).toBe('1.0 МБ');

    expect(fullTextOf(null, 'text')).toBeNull();
    expect(fullTextOf(undefined, 'text')).toBeNull();
    expect(fullTextOf('raw', 'text')).toBeNull();
    expect(fullTextOf(42, 'text')).toBeNull();
    expect(fullTextOf({}, 'text')).toBeNull();
    expect(fullTextOf({ fullTexts: 'not-array' }, 'text')).toBeNull();
    expect(
      fullTextOf(
        {
          fullTexts: [
            null,
            undefined,
            'str',
            { field: 'other', id: 'a', name: 'a.txt', size: 1 },
            { field: 'text', id: 123, name: 'a.txt', size: 1 },
            { field: 'text', id: '', name: 'a.txt', size: 1 },
            { field: 'text', id: 'a', name: 456, size: 1 },
            { field: 'text', id: 'a', name: '', size: 1 },
            { field: 'text', id: 'a', name: 'a.txt', size: '12' },
            { field: 'text', id: 'a', name: 'a.txt', size: -1 },
            { field: 'text', id: 'a', name: 'a.txt', size: Number.NaN },
            { field: 'text', id: 'a', name: 'a.txt', size: Number.POSITIVE_INFINITY },
            { field: 'evidence', id: 'ev-1', name: 'ev.txt', size: 12_000 },
          ],
        },
        'text',
      ),
    ).toBeNull();
    expect(
      fullTextOf(
        {
          fullTexts: [{ field: 'evidence', id: 'ev-0', name: 'empty.txt', size: 0 }],
        },
        'evidence',
      ),
    ).toEqual({ field: 'evidence', id: 'ev-0', name: 'empty.txt', size: 0 });
  });

  it('hides server [Full text] trailer and sha256 filename hashes, and shows plain file/oversized text errors instead of picture copy', async () => {
    const sha = 'a9'.repeat(32);
    const serverAutoName = `verdict-text-${sha}.txt`;
    const taskFromServer: TaskDetail = {
      ...TASK_DETAIL,
      files: [
        { id: 'att-hash', name: serverAutoName, size: 12_288, by: { id: 'g1', name: 'Gate Reviewer' }, at: '2026-11-05T18:20:00.000Z' },
        { id: 'att-notes', name: 'audit-notes.txt', size: 512, by: { id: 'g1', name: 'Gate Reviewer' }, at: '2026-11-05T18:21:00.000Z' },
      ],
      log: [
        {
          kind: 'verdict',
          text: 'Начало полного вердикта по задаче\n\n[Full text](/api/attachments/att-hash)',
          data: {
            pass: true,
            fullTexts: [{ field: 'text', id: 'att-hash', name: serverAutoName, size: 12_288, sha256: sha }],
          },
          by: { kind: 'agent', id: 'g1', name: 'Gate Reviewer' },
          at: '2026-11-05T18:20:00.000Z',
        },
      ],
    };

    stubFetchRoutes({
      'GET /api/org': { kind: 'json', status: 200, data: DEV_ORG },
      'GET /api/tasks/t12': { kind: 'json', status: 200, data: { task: taskFromServer } },
      'GET /api/attachments/att-hash': {
        kind: 'json',
        status: 404,
        data: { error: { code: 'not_found', reason: 'attachment_unknown', message: 'There is no such file.' } },
      },
      'POST /api/tasks/t12/comments': {
        kind: 'json',
        status: 413,
        data: { error: { code: 'validation', reason: 'attachment_invalid', message: 'The text is too large to send in one request.' } },
      },
      'POST /api/requests/r-choice-long': {
        kind: 'json',
        status: 413,
        data: { error: { code: 'validation', reason: 'attachment_invalid', message: 'The text is too large to send in one request.' } },
      },
    });

    const user = userEvent.setup();
    renderIn(
      'ru',
      <TaskPanel
        taskId="t12"
        onClose={vi.fn()}
        onOpen={vi.fn()}
        requests={[CHOICE]}
        onRequestsChanged={vi.fn()}
        onOpenAgent={vi.fn()}
      />,
    );

    const panel = await screen.findByRole('complementary', { name: '#12 Checkout API' });
    await openTaskAction(user, panel, ru.tracker.card.materials);
    const filesSection = within(panel).getByRole('region', { name: 'Файлы' });
    expect(within(filesSection).getByRole('link', { name: 'verdict-text.txt' })).toHaveAttribute('href', '/api/attachments/att-hash');
    expect(within(filesSection).getByRole('link', { name: 'audit-notes.txt' })).toHaveAttribute('href', '/api/attachments/att-notes');

    await openTaskAction(user, panel, ru.tasks.fullLog);
    expect(panel.textContent).toContain('Начало полного вердикта по задаче…');
    expect(panel.textContent).not.toContain('[Full text](/api/attachments/att-hash)');
    expect(panel.textContent).not.toContain(sha);

    const logItem = within(within(panel).getByRole('list', { name: ru.tasks.fullLog })).getByRole('listitem');
    expect(within(logItem).getByRole('link', { name: 'Открыть файл (verdict-text.txt, 12 КБ)' })).toHaveAttribute('href', '/api/attachments/att-hash');

    await user.click(within(logItem).getByRole('button', { name: 'Показать полностью' }));
    const fileAlert = await within(logItem).findByRole('alert');
    expect(fileAlert).toHaveTextContent('Файл недоступен.');
    expect(fileAlert.textContent).not.toMatch(/картин/i);

    await openTaskAction(user, panel, ru.tasks.comment);
    const commentBox = within(panel).getByRole('textbox', { name: 'Комментарий' }) as HTMLTextAreaElement;
    await user.type(commentBox, 'Очень большой текст');
    await user.click(within(panel).getByRole('button', { name: 'Добавить комментарий' }));
    const commentAlerts = await within(panel).findAllByRole('alert');
    expect(commentAlerts.some(a => a.textContent?.includes('Приложите его файлом к задаче'))).toBe(true);
    expect(commentAlerts.every(a => !/картин/i.test(a.textContent ?? ''))).toBe(true);
    expect(commentBox.value).toBe('Очень большой текст');

    const choiceBox = within(panel).getByLabelText(ru.tasks.choiceNote) as HTMLTextAreaElement;
    await user.type(choiceBox, 'Свободный отзыв по макету');
    await user.click(within(panel).getByRole('button', { name: ru.tasks.sendFeedback }));
    const requestAlerts = await within(panel).findAllByRole('alert');
    expect(requestAlerts.filter(a => a.textContent?.includes('Приложите его файлом к задаче'))).toHaveLength(2);
    expect(choiceBox.value).toBe('Свободный отзыв по макету');
  });
});
