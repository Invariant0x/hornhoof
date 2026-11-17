import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { errorText, useT, type Messages } from '../i18n';
import { Markdown } from './Markdown';

type PdfPageView = {
  pageNumber: number;
  width: number;
  height: number;
  text: string;
  renderToCanvas: (canvas: HTMLCanvasElement) => Promise<void> | void;
};

type PdfDocumentHandle = {
  numPages: number;
  getPage: (pageNumber: number) => Promise<PdfPageView>;
  destroy: () => Promise<void>;
};

type PdfLoader = (bytes: Uint8Array) => Promise<PdfDocumentHandle>;

type PdfRawViewport = { width: number; height: number };
type PdfRawPage = {
  getViewport: (opts: { scale: number }) => PdfRawViewport;
  getTextContent: () => Promise<{ items: readonly unknown[] }>;
  render: (opts: { canvas: HTMLCanvasElement | null; viewport: PdfRawViewport; annotationMode: number }) => { promise: Promise<void> };
};
type PdfRawDocument = { numPages: number; getPage: (pageNumber: number) => Promise<PdfRawPage> };
type PdfRawModule = {
  GlobalWorkerOptions: { workerSrc: string };
  AnnotationMode: { DISABLE: number };
  getDocument: (params: Record<string, unknown>) => { promise: Promise<PdfRawDocument>; destroy: () => Promise<void> };
};

let customPdfLoader: PdfLoader | null = null;

export function setPdfLoaderForTests(loader: PdfLoader | null): void {
  customPdfLoader = loader;
}

function pdfItemText(item: unknown): string {
  const str = (item as { str?: unknown } | null)?.str;
  return typeof str === 'string' ? str.trim() : '';
}

export function extractPdfTextItems(items: readonly unknown[]): string {
  return items.map(pdfItemText).filter(Boolean).join(' ');
}

async function renderPdfPageSurface(
  page: PdfRawPage,
  viewport: PdfRawViewport,
  width: number,
  height: number,
  annotationDisable: number,
): Promise<HTMLCanvasElement> {
  const surface = document.createElement('canvas');
  surface.width = width;
  surface.height = height;
  await page.render({ canvas: surface, viewport, annotationMode: annotationDisable }).promise;
  return surface;
}

function copyCanvasSurface(source: HTMLCanvasElement, target: HTMLCanvasElement, width: number, height: number): void {
  target.width = width;
  target.height = height;
  const ctx = target.getContext('2d');
  if (ctx) ctx.drawImage(source, 0, 0);
}

async function loadPdfPage(doc: PdfRawDocument, annotationDisable: number, pageNumber: number): Promise<PdfPageView> {
  const page = await doc.getPage(pageNumber);
  const viewport = page.getViewport({ scale: 1.5 });
  const width = Math.max(1, Math.ceil(viewport.width));
  const height = Math.max(1, Math.ceil(viewport.height));
  const textContent = await page.getTextContent();
  const surface = await renderPdfPageSurface(page, viewport, width, height, annotationDisable);
  return {
    pageNumber,
    width,
    height,
    text: extractPdfTextItems(textContent.items),
    renderToCanvas: canvas => copyCanvasSurface(surface, canvas, width, height),
  };
}

async function defaultPdfLoader(bytes: Uint8Array): Promise<PdfDocumentHandle> {
  const pdfjs = (await import('pdfjs-dist/legacy/build/pdf.mjs')) as unknown as PdfRawModule;
  const workerAsset = (await import('pdfjs-dist/legacy/build/pdf.worker.mjs?url')) as { default: string };
  pdfjs.GlobalWorkerOptions.workerSrc = workerAsset.default;
  const task = pdfjs.getDocument({
    data: bytes.slice(),
    enableXfa: false,
    useWorkerFetch: false,
    disableAutoFetch: true,
    disableRange: true,
    disableStream: true,
    useSystemFonts: true,
    stopAtErrors: true,
  });
  const doc = await task.promise;
  return {
    numPages: doc.numPages,
    getPage: n => loadPdfPage(doc, pdfjs.AnnotationMode.DISABLE, n),
    destroy: () => task.destroy(),
  };
}

async function readAllPdfPages(handle: PdfDocumentHandle): Promise<PdfPageView[]> {
  const pages: PdfPageView[] = [];
  for (let p = 1; p <= handle.numPages; p += 1) pages.push(await handle.getPage(p));
  return pages;
}

type DocState =
  | { kind: 'loading' }
  | { kind: 'text'; text: string; complete: boolean; error: string | null }
  | { kind: 'incomplete'; message: string }
  | { kind: 'pdf'; pages: PdfPageView[] }
  | { kind: 'pdf-unavailable' }
  | { kind: 'error'; message: string };

async function fetchTextState(contentUrl: string, signal: AbortSignal, t: Messages): Promise<DocState> {
  const streamed = await api.streamBytes(contentUrl, signal);
  const text = new TextDecoder('utf-8').decode(streamed.bytes);
  const error = streamed.complete ? null : t.tasks.materials.loadFailed;
  return { kind: 'text', text, complete: streamed.complete, error };
}

async function parsePdfBytes(bytes: Uint8Array): Promise<DocState> {
  const loader = customPdfLoader ?? defaultPdfLoader;
  try {
    const handle = await loader(bytes);
    try {
      return { kind: 'pdf', pages: await readAllPdfPages(handle) };
    } finally {
      await handle.destroy();
    }
  } catch {
    return { kind: 'pdf-unavailable' };
  }
}

async function fetchPdfState(contentUrl: string, signal: AbortSignal, t: Messages): Promise<DocState> {
  const streamed = await api.streamBytes(contentUrl, signal);
  if (!streamed.complete) return { kind: 'incomplete', message: t.tasks.materials.loadFailed };
  return parsePdfBytes(streamed.bytes);
}

function paintPdfCanvas(el: HTMLCanvasElement | null, page: PdfPageView): void {
  if (!el) return;
  void Promise.resolve(page.renderToCanvas(el)).then(() => {
    el.dataset.rendered = 'true';
  });
}

function PdfCanvasPage({ page, label }: { page: PdfPageView; label: string }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    paintPdfCanvas(canvasRef.current, page);
  }, [page]);

  return (
    <section className="mv-page">
      <span className="mv-page-n">{label}</span>
      <canvas ref={canvasRef} width={page.width} height={page.height} style={{ maxInlineSize: '100%', blockSize: 'auto' }} />
      {page.text && <p className="mv-page-text">{page.text}</p>}
    </section>
  );
}

function PdfUnavailableCard({ downloadUrl }: { downloadUrl: string | null }) {
  const t = useT();
  if (!downloadUrl) {
    return (
      <div className="mv-card">
        <p>{t.tasks.materials.pdfUnavailableNoDownload}</p>
      </div>
    );
  }
  return (
    <div className="mv-card">
      <p>{t.tasks.materials.pdfUnavailable}</p>
      <div className="entry-actions">
        <a className="btn act" href={downloadUrl} download>
          {t.tasks.materials.downloadFile}
        </a>
      </div>
    </div>
  );
}

function RetryAlert({ message, onRetry }: { message: string; onRetry: () => void }) {
  const t = useT();
  return (
    <div className="mv-fail">
      <p className="alert" role="alert">
        {message}
      </p>
      <div className="entry-actions">
        <button className="btn small" type="button" onClick={onRetry}>
          {t.tasks.materials.tryAgain}
        </button>
      </div>
    </div>
  );
}

function TextBody({ format, text, complete, error, onRetry }: { format: 'text' | 'markdown' | 'pdf'; text: string; complete: boolean; error: string | null; onRetry: () => void }) {
  const t = useT();
  return (
    <div className="mv-doc">
      {!complete && <p className="mv-reading">{t.tasks.materials.incomplete}</p>}
      {format === 'markdown' ? <Markdown text={text} /> : <pre className="mv-plain">{text}</pre>}
      {error ? <RetryAlert message={error} onRetry={onRetry} /> : <p className="mv-end">{t.tasks.materials.endOfDocument}</p>}
    </div>
  );
}

type Props = {
  format: 'text' | 'markdown' | 'pdf';
  contentUrl: string;
  downloadUrl: string | null;
  onPdfFallbackChange?: (unavailable: boolean) => void;
};

function loadDocState(format: 'text' | 'markdown' | 'pdf', contentUrl: string, signal: AbortSignal, t: Messages): Promise<DocState> {
  return format === 'pdf' ? fetchPdfState(contentUrl, signal, t) : fetchTextState(contentUrl, signal, t);
}

function notifyPdfFallback(onPdfFallbackChange: ((unavailable: boolean) => void) | undefined, unavailable: boolean) {
  if (onPdfFallbackChange) onPdfFallbackChange(unavailable);
}

type LoadGuard = { live: boolean; signal: AbortSignal };

function isLoadGuardActive(guard: LoadGuard): boolean {
  return guard.live && !guard.signal.aborted;
}

function applyDocSuccess(
  guard: LoadGuard,
  next: DocState,
  setState: (s: DocState) => void,
  onPdfFallbackChange?: (unavailable: boolean) => void,
): void {
  if (!guard.live) return;
  setState(next);
  notifyPdfFallback(onPdfFallbackChange, next.kind === 'pdf-unavailable');
}

function applyDocError(guard: LoadGuard, err: unknown, t: Messages, setState: (s: DocState) => void): void {
  if (!isLoadGuardActive(guard)) return;
  setState({ kind: 'error', message: errorText(t, err) });
}

function useLoadedDocState(
  format: 'text' | 'markdown' | 'pdf',
  contentUrl: string,
  attempt: number,
  t: Messages,
  onPdfFallbackChange?: (unavailable: boolean) => void,
): DocState {
  const [state, setState] = useState<DocState>({ kind: 'loading' });

  useEffect(() => {
    const ctrl = new AbortController();
    const guard: LoadGuard = { live: true, signal: ctrl.signal };
    setState({ kind: 'loading' });
    notifyPdfFallback(onPdfFallbackChange, false);
    void loadDocState(format, contentUrl, ctrl.signal, t).then(
      next => applyDocSuccess(guard, next, setState, onPdfFallbackChange),
      err => applyDocError(guard, err, t, setState),
    );
    return () => {
      guard.live = false;
      ctrl.abort();
    };
  }, [contentUrl, format, attempt, t, onPdfFallbackChange]);

  return state;
}

function PdfPagesView({ pages }: { pages: PdfPageView[] }) {
  const t = useT();
  return (
    <div className="mv-doc">
      <div className="mv-pdf">
        {pages.map(p => (
          <PdfCanvasPage key={p.pageNumber} page={p} label={t.tasks.materials.pageOf(p.pageNumber, pages.length)} />
        ))}
      </div>
      <p className="mv-end">{t.tasks.materials.endOfDocument}</p>
    </div>
  );
}

function IncompleteDocView({ message, onRetry }: { message: string; onRetry: () => void }) {
  const t = useT();
  return (
    <div className="mv-doc">
      <p className="mv-reading">{t.tasks.materials.incomplete}</p>
      <RetryAlert message={message} onRetry={onRetry} />
    </div>
  );
}

function MaterialDocView({
  state,
  format,
  downloadUrl,
  onRetry,
}: {
  state: DocState;
  format: 'text' | 'markdown' | 'pdf';
  downloadUrl: string | null;
  onRetry: () => void;
}) {
  const t = useT();
  switch (state.kind) {
    case 'loading':
      return <p className="mv-reading" role="status">{t.common.loading}</p>;
    case 'error':
      return <RetryAlert message={state.message} onRetry={onRetry} />;
    case 'incomplete':
      return <IncompleteDocView message={state.message} onRetry={onRetry} />;
    case 'pdf-unavailable':
      return <PdfUnavailableCard downloadUrl={downloadUrl} />;
    case 'pdf':
      return <PdfPagesView pages={state.pages} />;
    case 'text':
      return <TextBody format={format} text={state.text} complete={state.complete} error={state.error} onRetry={onRetry} />;
  }
}

export function MaterialDocument({ format, contentUrl, downloadUrl, onPdfFallbackChange }: Props) {
  const t = useT();
  const [attempt, setAttempt] = useState(0);
  const state = useLoadedDocState(format, contentUrl, attempt, t, onPdfFallbackChange);
  return <MaterialDocView state={state} format={format} downloadUrl={downloadUrl} onRetry={() => setAttempt(a => a + 1)} />;
}
