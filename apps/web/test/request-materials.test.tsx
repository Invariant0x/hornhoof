import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import { en } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import { Tasks } from '../src/screens/Tasks';
import type { ProposalDecision, WaitingRequest } from '../src/types';
import { extractPdfTextItems, setPdfLoaderForTests } from '../src/ui/MaterialDocument';
import { MaterialViewer } from '../src/ui/MaterialViewer';
import { readMaterialStamp, type MaterialManifestView } from '../src/ui/RequestMaterials';
import { Requests, forgetRequestDrafts } from '../src/ui/Requests';
import { DEV_ORG, ME, ROSTER, TASKS, TURN, decisions, mockApi } from './api-mock';

const DEV = { id: 'd-dev', name: 'Development' };
const REQ_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';
const ID_C = '33333333-3333-4333-8333-333333333333';
const ID_D = '44444444-4444-4444-8444-444444444444';
const ID_E = '55555555-5555-4555-8555-555555555555';
const ID_F = '66666666-6666-4666-8666-666666666666';

const LEGACY_CHOICE: WaitingRequest = {
  id: 'r-legacy-478',
  kind: 'choice',
  text: 'Raw technical note: layout comparison across widths.',
  explained: '**Plain summary**: compare the two layouts and pick one.',
  explaining: false,
  commit: null,
  commitUrl: null,
  images: ['att-common-1'],
  link: 'https://preview.acme.example/compare',
  options: [
    { label: 'Option A: compact single column with bottom action group', image: 'att-opt-a' },
    { label: 'Option B: wide two-column split with sticky bar', image: 'att-opt-b' },
  ],
  at: '2026-11-06T01:00:00.000Z',
  agent: { id: 'a-dsn', name: 'Head of Design' },
  task: { id: 't478', number: 478, title: 'Panel action layout', department: DEV },
  ownerPersonId: 'p1',
  canAnswer: true,
};

function renderWithAppShell(lang: 'en' | 'ru', ui: ReactNode, dir?: 'ltr' | 'rtl') {
  localStorage.setItem('hh-lang', lang);
  if (dir) document.documentElement.setAttribute('dir', dir);
  return render(
    <div data-testid="app-shell">
      <LanguageProvider>{ui}</LanguageProvider>
    </div>,
  );
}

function makeRequestsProps(overrides: Partial<Parameters<typeof Requests>[0]> = {}): Parameters<typeof Requests>[0] {
  return {
    requests: [LEGACY_CHOICE],
    onChanged: vi.fn(),
    onOpenTask: vi.fn(),
    onOpenAgent: vi.fn(),
    ...overrides,
  };
}

function chunkedStream(chunks: Uint8Array[], failAfter?: number): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (failAfter !== undefined && index >= failAfter) {
        controller.error(new Error('network stream interrupted'));
        return;
      }
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(chunks[index]!);
      index += 1;
    },
  });
}

describe('separate question materials preview and explicit answering', () => {
  afterEach(() => {
    cleanup();
    forgetRequestDrafts();
    setPdfLoaderForTests(null);
    localStorage.removeItem('hh-lang');
    document.documentElement.removeAttribute('dir');
    vi.restoreAllMocks();
  });

  it('separates legacy option.image, request.images, and request.link from answer buttons, preserves draft across viewer and remount, and never sends on preview', async () => {
    const calls: { method: string; path: string; body: unknown }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (path: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
      calls.push({ method, path, body });
      return new Response(JSON.stringify({ request: { id: 'r-legacy-478', status: 'answered', picked: 0 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }));

    const user = userEvent.setup();
    const props = makeRequestsProps();
    const view = renderWithAppShell('en', <Requests {...props} />);

    const card = screen.getByRole('article', { name: '#478 Panel action layout' });
    /* In detail stays above materials, and materials never nest inside answer buttons. */
    const details = card.querySelector('details.req-more')!;
    const commonZone = card.querySelector('.mat-zone')!;
    expect(details.compareDocumentPosition(commonZone) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    const matButtons = Array.from(card.querySelectorAll('button.mat'));
    expect(matButtons).toHaveLength(4);
    for (const m of matButtons) {
      expect(m.parentElement?.closest('button, .entry-actions, [data-answer]')).toBeNull();
      expect(m.querySelector('button, a, [data-answer]')).toBeNull();
    }
    /* Common image and both option images use large 16:10 cards; link shows visible URL and See the work. */
    expect(card.querySelectorAll('button.mat.mat-large')).toHaveLength(3);
    expect(within(card).getByText('See the work')).toBeInTheDocument();
    expect(within(card).getByText('https://preview.acme.example/compare')).toBeInTheDocument();

    const draftBox = within(card).getByLabelText(en.tasks.choiceNote);
    const draft = 'Keep compact layout, widen bottom padding by 4px';
    await user.type(draftBox, draft);

    /* Remounting Requests (as on SSE refresh) preserves the unsent draft by request id. */
    view.unmount();
    renderWithAppShell('en', <Requests {...props} />);
    const remountedCard = screen.getByRole('article', { name: '#478 Panel action layout' });
    expect(within(remountedCard).getByLabelText(en.tasks.choiceNote)).toHaveValue(draft);

    const optItems = remountedCard.querySelectorAll('ol.opts > li.opt');
    expect(optItems).toHaveLength(2);
    const opt1Card = optItems[0]!.querySelector<HTMLButtonElement>('button.mat.mat-large')!;
    await user.click(opt1Card);

    const dialog = await screen.findByRole('dialog', { name: 'Picture 1' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByTestId('app-shell')).toHaveAttribute('inert');
    expect(dialog.contains(document.activeElement)).toBe(true);

    /* Image track has 3 pictures (1 common + 2 options), skipping the link material. */
    expect(within(dialog).getByText('Picture 2 of 3')).toBeInTheDocument();

    /* Tab and Shift+Tab stay trapped inside the viewer dialog. */
    for (let i = 0; i < 8; i += 1) {
      await user.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
    await user.tab({ shift: true });
    expect(dialog.contains(document.activeElement)).toBe(true);

    /* Zoom in/out/fit via keyboard and double-click, and page across option images without sending any answer. */
    const stagePic = dialog.querySelector('.mv-pic')!;
    expect(stagePic).toHaveClass('fit');
    fireEvent.keyDown(window, { key: '+' });
    expect(within(dialog).getByText('×1.5')).toBeInTheDocument();
    expect(dialog.querySelector('.mv-pic')).not.toHaveClass('fit');
    fireEvent.dblClick(dialog.querySelector('.mv-pic')!);
    expect(within(dialog).getByText('×1')).toBeInTheDocument();
    fireEvent.dblClick(dialog.querySelector('.mv-pic')!);
    expect(within(dialog).getByText('×2')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Fit to window' }));
    expect(within(dialog).getByText('×1')).toBeInTheDocument();

    /* Horizontal swipe at fit zoom pages to Picture 3 of 3; when zoomed > 1 swipe pans instead of paging. */
    const stage = dialog.querySelector('.mv-stage')!;
    fireEvent.pointerDown(stage, { clientX: 280, clientY: 200, pointerId: 1 });
    fireEvent.pointerUp(stage, { clientX: 120, clientY: 202, pointerId: 1 });
    expect(within(dialog).getByText('Picture 3 of 3')).toBeInTheDocument();

    fireEvent.keyDown(window, { key: '+' });
    fireEvent.pointerDown(stage, { clientX: 120, clientY: 200, pointerId: 2 });
    fireEvent.pointerUp(stage, { clientX: 290, clientY: 200, pointerId: 2 });
    expect(within(dialog).getByText('Picture 3 of 3')).toBeInTheDocument();

    /* Escape closes the viewer, removes inert, restores focus to the exact opener card, and keeps 0 POST calls. */
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByTestId('app-shell')).not.toHaveAttribute('inert');
    expect(opt1Card).toHaveFocus();
    expect(within(remountedCard).getByLabelText(en.tasks.choiceNote)).toHaveValue(draft);
    expect(calls).toEqual([]);

    /* Explicit answer button sends exact pick: 0 with the preserved draft. */
    await user.click(within(optItems[0] as HTMLElement).getByRole('button', { name: 'Choose option 1' }));
    expect(calls).toEqual([
      {
        method: 'POST',
        path: '/api/requests/r-legacy-478',
        body: { pick: 0, answer: draft },
      },
    ]);
  });

  it('keeps materials openable in read-only and in-flight sending states while blocking duplicate answer submissions', async () => {
    const user = userEvent.setup();
    /* 1. Read-only: zero answer buttons, option images still open in viewer. */
    const roView = renderWithAppShell('ru', <Requests {...makeRequestsProps({ requests: [{ ...LEGACY_CHOICE, canAnswer: false }] })} />);
    const roCard = screen.getByRole('article', { name: '#478 Panel action layout' });
    expect(within(roCard).getByText(ru.tasks.decidedByCeo)).toBeInTheDocument();
    expect(within(roCard).queryByRole('button', { name: /Выбрать вариант/ })).not.toBeInTheDocument();
    expect(within(roCard).queryByRole('button', { name: ru.tasks.sendFeedback })).not.toBeInTheDocument();

    const roMat = roCard.querySelectorAll<HTMLButtonElement>('ol.opts button.mat.mat-large')[0]!;
    await user.click(roMat);
    const roDialog = await screen.findByRole('dialog', { name: 'Картинка 1' });
    expect(within(roDialog).getByText('Картинка 2 из 3')).toBeInTheDocument();
    await user.click(within(roDialog).getByRole('button', { name: 'Закрыть' }));
    roView.unmount();

    /* 2. In-flight sending: answer buttons disabled + role="status" Отправка, materials still open. */
    let resolvePost!: (res: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(r => { resolvePost = r; })));
    renderWithAppShell('ru', <Requests {...makeRequestsProps()} />);
    const liveCard = screen.getByRole('article', { name: '#478 Panel action layout' });
    await user.click(within(liveCard).getByRole('button', { name: 'Выбрать вариант 2' }));

    expect(liveCard).toHaveAttribute('aria-busy', 'true');
    expect(within(liveCard).getByRole('status')).toHaveTextContent('Отправка');
    expect(within(liveCard).getByRole('button', { name: 'Выбрать вариант 1' })).toBeDisabled();
    expect(liveCard.querySelector('.btn .spinner')).toBeNull();

    const matWhileSending = liveCard.querySelectorAll<HTMLButtonElement>('ol.opts button.mat.mat-large')[1]!;
    expect(matWhileSending).toBeEnabled();
    await user.click(matWhileSending);
    expect(await screen.findByRole('dialog', { name: 'Картинка 2' })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });

    resolvePost(new Response(JSON.stringify({ request: { id: 'r-legacy-478', status: 'answered' } }), { status: 200, headers: { 'content-type': 'application/json' } }));
  });

  it('renders scoped manifest states (available, denied, missing, unsupported), download icon rules, single-asset image retry, 12+ Show all focus, and RTL non-image paging', async () => {
    let failImageInViewer = true;
    const imgUrl = `/api/requests/${REQ_ID}/materials/${ID_A}/content`;
    const fileWithDlUrl = `/api/requests/${REQ_ID}/materials/${ID_B}/content`;
    const fileDownloadHref = `/api/requests/${REQ_ID}/materials/${ID_B}/download`;
    const fileNoDlUrl = `/api/requests/${REQ_ID}/materials/${ID_C}/content`;

    const manyItems = Array.from({ length: 14 }, (_, idx) => {
      const id = `${String(idx + 10).padStart(8, '0')}-1111-4111-8111-111111111111`;
      if (idx === 0) {
        return { id: ID_A, name: 'broken-shot.png', kind: 'image', state: 'available', contentUrl: imgUrl, downloadUrl: null, size: 2048, sha256: 'a'.repeat(64), mediaType: 'image/png' };
      }
      if (idx === 1) {
        return { id: ID_B, name: 'bundle.zip', kind: 'file', state: 'available', contentUrl: fileWithDlUrl, downloadUrl: fileDownloadHref, size: 1_572_864, sha256: 'b'.repeat(64), mediaType: 'application/zip' };
      }
      if (idx === 2) {
        return { id: ID_C, name: 'restricted-archive.bin', kind: 'file', state: 'available', contentUrl: fileNoDlUrl, downloadUrl: null, size: 512, sha256: 'c'.repeat(64), mediaType: 'application/octet-stream' };
      }
      if (idx === 3) {
        return { id: ID_D, name: 'Staging preview', kind: 'link', state: 'available', url: 'https://staging.acme.example/run/42' };
      }
      if (idx === 4) {
        return { id: ID_E, name: 'secret-audit.pdf', kind: 'document', format: 'pdf', state: 'denied' };
      }
      if (idx === 5) {
        return { id: ID_F, name: 'deleted-log.txt', kind: 'document', format: 'text', state: 'missing' };
      }
      if (idx === 6) {
        return { id, name: 'installer.exe', kind: 'file', state: 'unsupported' };
      }
      return { id, name: `extra-${idx}.png`, kind: 'image', state: 'available', contentUrl: `/api/requests/${REQ_ID}/materials/${id}/content`, downloadUrl: null, size: 1024, sha256: 'e'.repeat(64), mediaType: 'image/png' };
    });

    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (path: string) => {
      calls.push(path);
      if (path === `/api/requests/${REQ_ID}/materials`) {
        return new Response(JSON.stringify({ materialRevision: 1, materialDigest: 'f'.repeat(64), common: manyItems, options: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('not found', { status: 404 });
    }));

    const reqWithManifest = {
      ...LEGACY_CHOICE,
      id: REQ_ID,
      kind: 'question' as const,
      images: [],
      link: null,
      options: [],
      materialRevision: 1,
    } as unknown as WaitingRequest;

    const user = userEvent.setup();
    renderWithAppShell('en', <Requests {...makeRequestsProps({ requests: [reqWithManifest] })} />, 'rtl');

    /* Initially shows 5 items + Show all: 14 button. */
    const showAllBtn = await screen.findByRole('button', { name: 'Show all: 14' });
    const card = screen.getByRole('article', { name: '#478 Panel action layout' });
    expect(card.querySelectorAll('.mat')).toHaveLength(5);

    /* Download icon appears ONLY on bundle.zip (downloadUrl != null), NOT on restricted-archive.bin (downloadUrl == null). */
    const zipCard = within(card).getByRole('button', { name: /Open material: bundle\.zip/ });
    const binCard = within(card).getByRole('button', { name: /Open material: restricted-archive\.bin/ });
    expect(zipCard.querySelector('[data-icon="download"]')).not.toBeNull();
    expect(binCard.querySelector('[data-icon="download"]')).toBeNull();

    /* Unavailable denied item is a div.mat.mat-off, not a button, and says why in plain words. */
    const deniedEl = within(card).getByText('secret-audit.pdf').closest('.mat')!;
    expect(deniedEl.tagName).toBe('DIV');
    expect(deniedEl).toHaveClass('mat-off');
    expect(within(deniedEl as HTMLElement).getByText('No access to this material')).toBeInTheDocument();
    expect(card.textContent).not.toMatch(/Still uploading|Еще загружается/i);

    /* Clicking Show all: 14 reveals all 14 items in place and moves focus to the first newly revealed interactive card. */
    await user.click(showAllBtn);
    expect(card.querySelectorAll('.mat')).toHaveLength(14);
    expect(document.activeElement).toHaveClass('mat');
    expect(within(card).getByText('Material is not available')).toBeInTheDocument();
    expect(within(card).getByText('Format is not supported')).toBeInTheDocument();

    /* Single-asset image error in list: shows placeholder without any retry button in the list, card stays openable, retry works inside viewer. */
    const brokenCard = within(card).getByRole('button', { name: /Open material: broken-shot\.png/ });
    const thumbImg = brokenCard.querySelector('img');
    if (thumbImg) fireEvent.error(thumbImg);
    expect(within(brokenCard).queryByRole('button', { name: /Try again/i })).not.toBeInTheDocument();
    expect(brokenCard).toBeEnabled();

    await user.click(brokenCard);
    const imgDialog = await screen.findByRole('dialog', { name: 'broken-shot.png' });
    const viewerImg = imgDialog.querySelector('.mv-pic img')!;
    if (failImageInViewer) fireEvent.error(viewerImg);
    expect(await within(imgDialog).findByText(en.tasks.materials.loadFailed)).toBeInTheDocument();
    failImageInViewer = false;
    await user.click(within(imgDialog).getByRole('button', { name: 'Try again' }));
    const retriedImg = imgDialog.querySelector('.mv-pic img')!;
    fireEvent.load(retriedImg);
    expect(within(imgDialog).queryByText(en.tasks.materials.loadFailed)).not.toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });

    /* Open non-image track (bundle.zip -> restricted-archive.bin -> Staging preview): 3 available non-image items.
       In RTL, ArrowLeft advances to Next and ArrowRight goes to Previous. */
    await user.click(zipCard);
    const fileDialog = await screen.findByRole('dialog', { name: 'bundle.zip' });
    expect(within(fileDialog).getByText('Material 1 of 3')).toBeInTheDocument();
    expect(within(fileDialog).getByRole('link', { name: 'Download file' })).toHaveAttribute('href', fileDownloadHref);
    expect(fileDialog.querySelector('.mv-kind [data-icon="download"]')).not.toBeNull();

    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    expect(within(fileDialog).getByRole('heading', { name: 'restricted-archive.bin' })).toBeInTheDocument();
    expect(within(fileDialog).getByText('Material 2 of 3')).toBeInTheDocument();
    expect(within(fileDialog).queryByRole('link', { name: 'Download file' })).not.toBeInTheDocument();
    expect(fileDialog.querySelector('.mv-kind [data-icon="file"]')).not.toBeNull();

    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    expect(within(fileDialog).getByRole('heading', { name: 'Staging preview' })).toBeInTheDocument();
    expect(within(fileDialog).getByText('Material 3 of 3')).toBeInTheDocument();
    expect(within(fileDialog).getByText('https://staging.acme.example/run/42')).toBeInTheDocument();
    const extLink = within(fileDialog).getByRole('link', { name: 'Open link' });
    expect(extLink).toHaveAttribute('href', 'https://staging.acme.example/run/42');
    expect(extLink).toHaveAttribute('target', '_blank');
    expect(extLink).toHaveAttribute('rel', 'noopener noreferrer');
    /* Hornhoof never fetches external link URLs. */
    expect(calls.some(p => p.includes('staging.acme.example'))).toBe(false);

    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(within(fileDialog).getByText('Material 2 of 3')).toBeInTheDocument();
  });

  it('streams complete 120k+ UTF-8 text and safe Markdown to their exact end, flags incomplete streams with retry, and handles PDF pages plus honest no-PDF fallback', async () => {
    const txtUrl = `/api/requests/${REQ_ID}/materials/${ID_A}/content`;
    const mdUrl = `/api/requests/${REQ_ID}/materials/${ID_B}/content`;
    const pdfOkUrl = `/api/requests/${REQ_ID}/materials/${ID_C}/content`;
    const pdfOkDl = `/api/requests/${REQ_ID}/materials/${ID_C}/download`;
    const pdfFailUrl = `/api/requests/${REQ_ID}/materials/${ID_D}/content`;
    const pdfFailDl = `/api/requests/${REQ_ID}/materials/${ID_D}/download`;

    const longBody = 'Проверка строки UTF-8 без обрезки.\n'.repeat(3500) + 'TAIL_MARKER_120K_END';
    expect(longBody.length).toBeGreaterThan(120_000);
    const encodedTxt = new TextEncoder().encode(longBody);
    /* Split right in the middle of a multi-byte Cyrillic character to prove streaming UTF-8 decode. */
    const splitPoint = 17;
    const chunk1 = encodedTxt.slice(0, splitPoint);
    const chunk2 = encodedTxt.slice(splitPoint);

    const hostileMd = [
      '## Release Audit Summary',
      'Plain **bold** and `inline()` check with [Approved Docs](https://docs.acme.example/guide).',
      '### Unsafe Inputs Stay Inert',
      '- [Click XSS](javascript:alert(1))',
      '- [Data XSS](data:text/html,<script>alert(1)</script>)',
      '- <script>window.__xssExecuted = true;</script>',
      '- <img src="x" onerror="window.__imgExecuted = true" />',
      '- <iframe src="https://evil.example"></iframe>',
      '```ts',
      'const safeCodeBlock = "<not-html>";',
      '```',
      'MARKDOWN_FINAL_TAIL_OK',
    ].join('\n');

    let failTxtFirstAttempt = true;
    vi.stubGlobal('fetch', vi.fn(async (path: string) => {
      if (path === `/api/requests/${REQ_ID}/materials`) {
        return new Response(JSON.stringify({
          materialRevision: 1,
          materialDigest: '1'.repeat(64),
          common: [
            { id: ID_A, name: 'full-run.log', kind: 'document', format: 'text', state: 'available', contentUrl: txtUrl, downloadUrl: null, size: encodedTxt.byteLength, sha256: '2'.repeat(64), mediaType: 'text/plain' },
            { id: ID_B, name: 'audit-notes.md', kind: 'document', format: 'markdown', state: 'available', contentUrl: mdUrl, downloadUrl: null, size: hostileMd.length, sha256: '3'.repeat(64), mediaType: 'text/markdown' },
            { id: ID_C, name: 'architecture.pdf', kind: 'document', format: 'pdf', state: 'available', contentUrl: pdfOkUrl, downloadUrl: pdfOkDl, size: 4096, sha256: '4'.repeat(64), mediaType: 'application/pdf' },
            { id: ID_D, name: 'encrypted-scan.pdf', kind: 'document', format: 'pdf', state: 'available', contentUrl: pdfFailUrl, downloadUrl: pdfFailDl, size: 4096, sha256: '5'.repeat(64), mediaType: 'application/pdf' },
          ],
          options: [],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (path === txtUrl) {
        if (failTxtFirstAttempt) {
          return new Response(chunkedStream([chunk1], 1), {
            status: 200,
            headers: { 'content-type': 'text/plain; charset=utf-8', 'content-length': String(encodedTxt.byteLength) },
          });
        }
        return new Response(chunkedStream([chunk1, chunk2]), {
          status: 200,
          headers: { 'content-type': 'text/plain; charset=utf-8', 'content-length': String(encodedTxt.byteLength) },
        });
      }
      if (path === mdUrl) {
        return new Response(hostileMd, { status: 200, headers: { 'content-type': 'text/markdown; charset=utf-8' } });
      }
      if (path === pdfOkUrl) {
        return new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]), { status: 200, headers: { 'content-type': 'application/pdf' } });
      }
      if (path === pdfFailUrl) {
        return new Response(new Uint8Array([0x00, 0x01, 0x02]), { status: 200, headers: { 'content-type': 'application/pdf' } });
      }
      return new Response('not found', { status: 404 });
    }));

    setPdfLoaderForTests(async bytes => {
      if (bytes[0] !== 0x25) throw new Error('Invalid PDF structure');
      return {
        numPages: 2,
        getPage: async pageNumber => ({
          pageNumber,
          width: 600,
          height: 800,
          text: pageNumber === 1 ? 'PDF Page One Intro' : 'PDF Page Two Final Conclusion',
          renderToCanvas: () => {},
        }),
        destroy: async () => {},
      };
    });

    const req = {
      ...LEGACY_CHOICE,
      id: REQ_ID,
      kind: 'question' as const,
      images: [],
      link: null,
      options: [],
      materialRevision: 1,
    } as unknown as WaitingRequest;

    const user = userEvent.setup();
    renderWithAppShell('en', <Requests {...makeRequestsProps({ requests: [req] })} />);

    /* 1. Incomplete stream on first attempt: shows sticky incomplete notice + Try again, NO End of document claim. */
    await user.click(await screen.findByRole('button', { name: /Open material: full-run\.log/ }));
    const dialog = await screen.findByRole('dialog', { name: 'full-run.log' });
    expect(await within(dialog).findByText('Not all of the document is loaded yet.')).toBeInTheDocument();
    expect(within(dialog).queryByText('End of document. Shown in full.')).not.toBeInTheDocument();

    /* Retry loads all 120k+ UTF-8 bytes including multi-byte split and tail marker. */
    failTxtFirstAttempt = false;
    await user.click(within(dialog).getByRole('button', { name: 'Try again' }));
    expect(await within(dialog).findByText('End of document. Shown in full.')).toBeInTheDocument();
    const plainPre = dialog.querySelector('pre.mv-plain')!;
    expect(plainPre.textContent).toContain('Проверка строки UTF-8 без обрезки.');
    expect(plainPre.textContent?.endsWith('TAIL_MARKER_120K_END')).toBe(true);

    /* 2. Next -> Markdown document: safe headings, code fence, https link, zero script/img/iframe/javascript: execution. */
    await user.click(within(dialog).getByRole('button', { name: /Next/ }));
    expect(await within(dialog).findByRole('heading', { name: 'Release Audit Summary' })).toBeInTheDocument();
    expect(within(dialog).getByRole('heading', { name: 'Unsafe Inputs Stay Inert' })).toBeInTheDocument();
    const safeDocLink = within(dialog).getByRole('link', { name: 'Approved Docs' });
    expect(safeDocLink).toHaveAttribute('href', 'https://docs.acme.example/guide');
    expect(safeDocLink).toHaveAttribute('rel', 'noopener noreferrer');
    expect(dialog.querySelector('pre code')?.textContent).toContain('const safeCodeBlock = "<not-html>";');
    expect(dialog.querySelector('script')).toBeNull();
    expect(dialog.querySelector('iframe')).toBeNull();
    expect(dialog.querySelector('img')).toBeNull();
    expect(Array.from(dialog.querySelectorAll('a')).map(a => a.getAttribute('href'))).toEqual(['https://docs.acme.example/guide']);
    expect(within(dialog).getByText(/MARKDOWN_FINAL_TAIL_OK/)).toBeInTheDocument();
    expect(within(dialog).getByText('End of document. Shown in full.')).toBeInTheDocument();

    /* 3. Next -> Valid 2-page PDF: renders every page to its end. */
    await user.click(within(dialog).getByRole('button', { name: /Next/ }));
    expect(await within(dialog).findByText('Page 1 of 2')).toBeInTheDocument();
    expect(within(dialog).getByText('Page 2 of 2')).toBeInTheDocument();
    expect(within(dialog).getByText('PDF Page Two Final Conclusion')).toBeInTheDocument();
    expect(within(dialog).getByText('End of document. Shown in full.')).toBeInTheDocument();

    /* 4. Next -> Malformed/unavailable PDF: honest fallback with Download file link, ZERO fake .mv-page elements. */
    await user.click(within(dialog).getByRole('button', { name: /Next/ }));
    expect(await within(dialog).findByText('PDF preview is not available right now. Download the file.')).toBeInTheDocument();
    expect(dialog.querySelectorAll('.mv-page')).toHaveLength(0);
    expect(within(dialog).queryByText('End of document. Shown in full.')).not.toBeInTheDocument();
    expect(within(dialog).getByRole('link', { name: 'Download file' })).toHaveAttribute('href', pdfFailDl);
    fireEvent.keyDown(window, { key: 'Escape' });

    /* 5. Answering a versioned request binds { materialRevision, materialDigest }, and a 409 stale response preserves the draft. */
    const postPayloads: unknown[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_path: string, init: RequestInit = {}) => {
      postPayloads.push(typeof init.body === 'string' ? JSON.parse(init.body) : undefined);
      return new Response(JSON.stringify({ error: { code: 'conflict', message: 'Materials changed since you opened this question.' } }), {
        status: 409,
        headers: { 'content-type': 'application/json' },
      });
    }));

    const card = screen.getByRole('article', { name: '#478 Panel action layout' });
    const answerBox = within(card).getByLabelText(en.tasks.yourAnswer);
    await user.type(answerBox, 'Reviewed all four materials');
    await user.click(within(card).getByRole('button', { name: 'Send answer' }));

    expect(postPayloads).toEqual([
      {
        materialRevision: 1,
        materialDigest: '1'.repeat(64),
        answer: 'Reviewed all four materials',
      },
    ]);
    expect(await within(card).findByRole('alert')).toHaveTextContent('Materials changed since you opened this question.');
    expect(within(card).getByLabelText(en.tasks.yourAnswer)).toHaveValue('Reviewed all four materials');
  });

  it('keeps unstamped canonical decisions free of derived manifest stamps while binding stamps on versioned DTOs and rendering null department tasks', () => {
    const derivedLegacyManifest: MaterialManifestView = {
      materialRevision: 1,
      materialDigest: 'a'.repeat(64),
      common: [],
      options: [],
    };
    expect(readMaterialStamp(LEGACY_CHOICE, derivedLegacyManifest)).toEqual({});
    expect(readMaterialStamp({ id: 'r-null-rev', materialRevision: null }, derivedLegacyManifest)).toEqual({});
    expect(readMaterialStamp({ id: 'r-zero-rev', materialRevision: 0 }, derivedLegacyManifest)).toEqual({});
    expect(readMaterialStamp({ id: 'r-v1', materialRevision: 1, materialDigest: 'b'.repeat(64) }, null)).toEqual({
      materialRevision: 1,
      materialDigest: 'b'.repeat(64),
    });
    expect(readMaterialStamp({ id: 'r-v1', materialRevision: 1 }, derivedLegacyManifest)).toEqual({
      materialRevision: 1,
      materialDigest: 'a'.repeat(64),
    });
    expect(readMaterialStamp({ id: 'r-v1', materialRevision: 1 }, null)).toEqual({});
    expect(extractPdfTextItems([{ str: 'First' }, { str: '   ' }, { other: 1 }, null, { str: 'Second' }])).toBe('First Second');

    renderWithAppShell(
      'en',
      <Requests
        {...makeRequestsProps({
          requests: [{ ...LEGACY_CHOICE, id: 'r-company-wide', task: { id: 't479', number: 479, title: 'Whole company check', department: null } }],
        })}
      />,
    );
    expect(screen.getByRole('article', { name: '#479 Whole company check' })).toBeInTheDocument();
  });

  it('guards empty viewer items, blocks unsafe link protocols, and handles HTTP 403, interrupted PDF streams, and no-download PDF fallbacks cleanly', async () => {
    const emptySelect = vi.fn();
    const emptyClose = vi.fn();
    const emptyRender = renderWithAppShell('en', <MaterialViewer items={[]} activeId="missing" opener={null} onSelect={emptySelect} onClose={emptyClose} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    emptyRender.unmount();

    const deniedDocUrl = `/api/requests/${REQ_ID}/materials/${ID_A}/content`;
    const partialPdfUrl = `/api/requests/${REQ_ID}/materials/${ID_B}/content`;
    const noDlPdfUrl = `/api/requests/${REQ_ID}/materials/${ID_C}/content`;
    const imgUrl = `/api/requests/${REQ_ID}/materials/${ID_E}/content`;

    let denyDoc = true;
    let truncatePdf = true;
    vi.stubGlobal('fetch', vi.fn(async (path: string) => {
      if (path === `/api/requests/${REQ_ID}/materials`) {
        return new Response(JSON.stringify({
          materialRevision: 1,
          materialDigest: '9'.repeat(64),
          common: [
            { id: ID_A, name: 'revoked-note.txt', kind: 'document', format: 'text', state: 'available', contentUrl: deniedDocUrl, downloadUrl: null, size: 64, sha256: 'a'.repeat(64), mediaType: 'text/plain' },
            { id: ID_B, name: 'cut-report.pdf', kind: 'document', format: 'pdf', state: 'available', contentUrl: partialPdfUrl, downloadUrl: null, size: 128, sha256: 'b'.repeat(64), mediaType: 'application/pdf' },
            { id: ID_C, name: 'locked-scan.pdf', kind: 'document', format: 'pdf', state: 'available', contentUrl: noDlPdfUrl, downloadUrl: null, size: 128, sha256: 'c'.repeat(64), mediaType: 'application/pdf' },
            { id: ID_D, name: 'Hostile link', kind: 'link', state: 'available', url: 'javascript:alert(1)' },
            { id: ID_E, name: 'single-diagram.png', kind: 'image', state: 'available', contentUrl: imgUrl, downloadUrl: null, size: 256, sha256: 'e'.repeat(64), mediaType: 'image/png' },
          ],
          options: [],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (path === deniedDocUrl) {
        if (denyDoc) {
          return new Response(JSON.stringify({ error: { code: 'forbidden', message: 'Access revoked.' } }), {
            status: 403,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response('Restored plain text content', { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' } });
      }
      if (path === partialPdfUrl) {
        if (truncatePdf) {
          return new Response(chunkedStream([new Uint8Array([0x25, 0x50])], 1), {
            status: 200,
            headers: { 'content-type': 'application/pdf', 'content-length': '64' },
          });
        }
        return new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46]), { status: 200, headers: { 'content-type': 'application/pdf' } });
      }
      if (path === noDlPdfUrl) {
        return new Response(new Uint8Array([0x00, 0x01]), { status: 200, headers: { 'content-type': 'application/pdf' } });
      }
      return new Response('not found', { status: 404 });
    }));

    setPdfLoaderForTests(async bytes => {
      if (bytes[0] !== 0x25) throw new Error('Malformed PDF');
      return {
        numPages: 1,
        getPage: async pageNumber => ({
          pageNumber,
          width: 400,
          height: 500,
          text: 'Recovered PDF Page Text',
          renderToCanvas: () => {},
        }),
        destroy: async () => {},
      };
    });

    const req = {
      ...LEGACY_CHOICE,
      id: REQ_ID,
      kind: 'question' as const,
      images: [],
      link: null,
      options: [],
      materialRevision: 1,
    } as unknown as WaitingRequest;

    const user = userEvent.setup();
    renderWithAppShell('en', <Requests {...makeRequestsProps({ requests: [req] })} />);

    const card = screen.getByRole('article', { name: '#478 Panel action layout' });
    const answerBox = within(card).getByLabelText(en.tasks.yourAnswer);
    await user.type(answerBox, 'Keep my draft safe');

    /* 1. HTTP 403 on document content shows error alert + retry without losing draft; ArrowLeft at index 0 stays put. */
    await user.click(await screen.findByRole('button', { name: /Open material: revoked-note\.txt/ }));
    const dialog = await screen.findByRole('dialog', { name: 'revoked-note.txt' });
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Access revoked.');
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    expect(within(dialog).getByRole('heading', { name: 'revoked-note.txt' })).toBeInTheDocument();

    denyDoc = false;
    await user.click(within(dialog).getByRole('button', { name: 'Try again' }));
    expect(await within(dialog).findByText('Restored plain text content')).toBeInTheDocument();
    expect(within(dialog).getByText('End of document. Shown in full.')).toBeInTheDocument();

    /* 2. Interrupted PDF stream shows error alert + retry with zero plain-text pre blocks and zero fake pages. */
    await user.click(within(dialog).getByRole('button', { name: /Next/ }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Could not load this material.');
    expect(dialog.querySelector('pre.mv-plain')).toBeNull();
    expect(dialog.querySelectorAll('.mv-page')).toHaveLength(0);

    truncatePdf = false;
    await user.click(within(dialog).getByRole('button', { name: 'Try again' }));
    expect(await within(dialog).findByText('Page 1 of 1')).toBeInTheDocument();
    expect(within(dialog).getByText('Recovered PDF Page Text')).toBeInTheDocument();

    /* 3. Unavailable PDF with downloadUrl === null renders honest message and zero download link. */
    await user.click(within(dialog).getByRole('button', { name: /Next/ }));
    expect(await within(dialog).findByText('PDF preview is not available right now.')).toBeInTheDocument();
    expect(within(dialog).queryByRole('link', { name: 'Download file' })).not.toBeInTheDocument();

    /* 4. Hostile javascript: link renders warning text and zero clickable anchor; ArrowRight at end stays put. */
    await user.click(within(dialog).getByRole('button', { name: /Next/ }));
    expect(await within(dialog).findByText('javascript:alert(1)')).toBeInTheDocument();
    expect(within(dialog).queryByRole('link')).not.toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(within(dialog).getByRole('heading', { name: 'Hostile link' })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });

    /* 5. Single image zoom controls (+, -, 0) clamp cleanly and draft remains untouched. */
    await user.click(within(card).getByRole('button', { name: /Open material: single-diagram\.png/ }));
    const imgDialog = await screen.findByRole('dialog', { name: 'single-diagram.png' });
    await user.click(within(imgDialog).getByRole('button', { name: 'Zoom in' }));
    expect(within(imgDialog).getByText('×1.5')).toBeInTheDocument();
    await user.click(within(imgDialog).getByRole('button', { name: 'Zoom out' }));
    expect(within(imgDialog).getByText('×1')).toBeInTheDocument();
    fireEvent.keyDown(window, { key: '=' });
    expect(within(imgDialog).getByText('×1.5')).toBeInTheDocument();
    fireEvent.keyDown(window, { key: '-' });
    expect(within(imgDialog).getByText('×1')).toBeInTheDocument();
    fireEvent.keyDown(window, { key: '+' });
    fireEvent.keyDown(window, { key: '0' });
    expect(within(imgDialog).getByText('×1')).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });

    expect(within(card).getByLabelText(en.tasks.yourAnswer)).toHaveValue('Keep my draft safe');
  });

  it('connects Tasks ProposalDecision stamps for structure and staff to the real MaterialViewer without triggering build or hire until submitted', async () => {
    const structId = 'prop-struct-1';
    const staffId = 'prop-staff-1';
    const structDocId = '77777777-7777-4777-8777-777777777777';
    const staffDocId = '88888888-8888-4888-8888-888888888888';
    const structDigest = 'd'.repeat(64);
    const staffDigest = 'e'.repeat(64);

    const proposals: ProposalDecision[] = [
      {
        id: structId,
        kind: 'structure',
        agent: { id: 'a1', name: 'Orchestrator' },
        department: null,
        brief: 'Add Support and Finance departments.',
        items: [
          { template: 'support', checked: true, note: 'Customer helpdesk' },
          { template: 'finance', checked: true, note: 'Budgets and invoices' },
        ],
        materialRevision: 2,
        materialDigest: structDigest,
        at: '2026-11-06T09:00:00.000Z',
        ownerPersonId: 'p1',
        canAnswer: true,
      },
      {
        id: staffId,
        kind: 'staff',
        agent: { id: 'a1', name: 'Orchestrator' },
        department: { id: 'd2', name: 'Development' },
        brief: 'Hire Backend engineer.',
        items: [{ role: 'DEV-BE', name: 'Bruno', subscription: 's-key', checked: true }],
        materialRevision: 3,
        materialDigest: staffDigest,
        at: '2026-11-06T09:01:00.000Z',
        ownerPersonId: 'p1',
        canAnswer: true,
      },
    ];

    const calls: { method: string; path: string; body: unknown }[] = [];
    mockApi({});
    vi.stubGlobal('fetch', vi.fn(async (path: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
      calls.push({ method, path, body });
      if (method === 'GET' && path === '/api/org') return new Response(JSON.stringify(DEV_ORG), { status: 200, headers: { 'content-type': 'application/json' } });
      if (method === 'GET' && path === '/api/turns') return new Response(JSON.stringify({ turns: [TURN] }), { status: 200, headers: { 'content-type': 'application/json' } });
      if (method === 'GET' && path === '/api/task-departments') return new Response(JSON.stringify({ whole: true, departments: [{ id: 'd2', name: null, templateKey: 'development', mine: true }] }), { status: 200, headers: { 'content-type': 'application/json' } });
      if (method === 'GET' && path === '/api/tasks?status=all') return new Response(JSON.stringify({ tasks: TASKS }), { status: 200, headers: { 'content-type': 'application/json' } });
      if (method === 'GET' && path === '/api/departments/d2/roster') return new Response(JSON.stringify(ROSTER), { status: 200, headers: { 'content-type': 'application/json' } });
      if (method === 'GET' && path === `/api/proposals/${structId}/materials`) {
        return new Response(JSON.stringify({
          materialRevision: 2,
          materialDigest: structDigest,
          common: [{
            id: structDocId,
            name: 'Structure plan.md',
            kind: 'document',
            format: 'markdown',
            state: 'available',
            contentUrl: `/api/proposals/${structId}/materials/${structDocId}/content`,
            downloadUrl: null,
            size: 128,
            sha256: '1'.repeat(64),
            mediaType: 'text/markdown',
          }],
          options: [],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (method === 'GET' && path === `/api/proposals/${structId}/materials/${structDocId}/content`) {
        return new Response('## Sealed Structure\n\nIncludes Support and Finance before edits.', { status: 200, headers: { 'content-type': 'text/markdown; charset=utf-8' } });
      }
      if (method === 'GET' && path === `/api/proposals/${staffId}/materials`) {
        return new Response(JSON.stringify({
          materialRevision: 3,
          materialDigest: staffDigest,
          common: [{
            id: staffDocId,
            name: 'Staffing plan.md',
            kind: 'document',
            format: 'markdown',
            state: 'available',
            contentUrl: `/api/proposals/${staffId}/materials/${staffDocId}/content`,
            downloadUrl: null,
            size: 128,
            sha256: '2'.repeat(64),
            mediaType: 'text/markdown',
          }],
          options: [],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (method === 'GET' && path === `/api/proposals/${staffId}/materials/${staffDocId}/content`) {
        return new Response('## Sealed Roster\n\nHire Bruno on Team key.', { status: 200, headers: { 'content-type': 'text/markdown; charset=utf-8' } });
      }
      if (method === 'POST') return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
      return new Response(JSON.stringify({ error: { code: 'not_found', message: 'Not found.' } }), { status: 404, headers: { 'content-type': 'application/json' } });
    }));

    const user = userEvent.setup();
    renderWithAppShell(
      'en',
      <Tasks
        me={ME}
        place={{ show: 'waits' }}
        onPlace={vi.fn()}
        decisions={decisions([], { proposals })}
        onDecisionsChanged={vi.fn()}
        selected={null}
        onOpenTask={vi.fn()}
        onOpenGoal={vi.fn()}
        onOpenAgent={vi.fn()}
        onOpenOrchestrator={vi.fn()}
      />,
    );

    /* Open structure proposal sealed document in MaterialViewer, verify zero business actions inside viewer and zero POSTs.
       WaitingQueue shows one card at a time, so the second proposal starts collapsed in the queue strip. */
    const openStruct = await screen.findByRole('button', { name: /Open material: Structure plan\.md/ });
    expect(screen.getByRole('button', { name: /Hire Backend engineer\./, expanded: false })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Open material: Staffing plan\.md/ })).not.toBeInTheDocument();
    await user.click(openStruct);
    const dialog = await screen.findByRole('dialog', { name: 'Structure plan.md' });
    expect(await within(dialog).findByText('Includes Support and Finance before edits.')).toBeInTheDocument();
    expect(within(dialog).getByText(en.tasks.materials.proposalNote)).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: /Create|Hire|Correct/ })).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: en.tasks.materials.close }));
    expect(calls.filter(c => c.method === 'POST')).toEqual([]);

    /* Human edits Finance checkbox in StructureCard; reopening viewer still shows original sealed Support + Finance text. */
    const financeBox = screen.getByRole('checkbox', { name: /Finance/ });
    await user.click(financeBox);
    await user.click(screen.getByRole('button', { name: /Open material: Structure plan\.md/ }));
    const reopened = await screen.findByRole('dialog', { name: 'Structure plan.md' });
    expect(await within(reopened).findByText('Includes Support and Finance before edits.')).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(calls.filter(c => c.method === 'POST')).toEqual([]);

    /* Submitting structure sends its exact stamp and advances WaitingQueue to the staff proposal card. */
    await user.click(screen.getByRole('button', { name: en.card.create(1) }));

    /* Open staff proposal sealed document too, then close without sending any staff POST. */
    await user.click(await screen.findByRole('button', { name: /Open material: Staffing plan\.md/ }));
    const staffDialog = await screen.findByRole('dialog', { name: 'Staffing plan.md' });
    expect(await within(staffDialog).findByText('Hire Bruno on Team key.')).toBeInTheDocument();
    expect(within(staffDialog).getByText(en.tasks.materials.proposalNote)).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(calls.filter(c => c.method === 'POST')).toHaveLength(1);

    /* Submitting staff sends its exact { materialRevision, materialDigest } stamp and empties the queue. */
    await user.click(await screen.findByRole('button', { name: en.staff.hire(1) }));
    await screen.findByText(en.tasks.queue.empty);

    const postCalls = calls.filter(c => c.method === 'POST');
    expect(postCalls).toEqual([
      {
        method: 'POST',
        path: '/api/departments/build',
        body: {
          proposalId: structId,
          materialRevision: 2,
          materialDigest: structDigest,
          items: [{ template: 'support', note: 'Customer helpdesk', staff: true }],
        },
      },
      {
        method: 'POST',
        path: '/api/departments/d2/staff',
        body: {
          proposalId: staffId,
          materialRevision: 3,
          materialDigest: staffDigest,
          people: [expect.objectContaining({ role: 'DEV-BE', name: 'Bruno', subscription: 's-key' })],
        },
      },
    ]);
  });
});
