import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { errorText, useT, type Messages } from '../i18n';
import { Markdown } from './Markdown';

export type PdfPageView = {
  pageNumber: number;
  width: number;
  height: number;
  text: string;
  renderToCanvas: (canvas: HTMLCanvasElement) => Promise<void> | void;
};

export type PdfDocumentHandle = {
  numPages: number;
  getPage: (pageNumber: number) => Promise<PdfPageView>;
  destroy: () => Promise<void>;
};

export type PdfLoader = (bytes: Uint8Array) => Promise<PdfDocumentHandle>;

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

function extractPdfTextItems(items: readonly unknown[]): string {
  const parts: string[] = [];
  for (const item of items) {
    const str = (item as { str?: unknown } | null)?.str;
    if (typeof str === 'string' && str.trim()) parts.push(str);
  }
  return parts.join(' ');
}

async function loadPdfPage(doc: PdfRawDocument, annotationDisable: number, pageNumber: number): Promise<PdfPageView> {
  const page = await doc.getPage(pageNumber);
  const viewport = page.getViewport({ scale: 1.5 });
  const width = Math.max(1, Math.ceil(viewport.width));
  const height = Math.max(1, Math.ceil(viewport.height));
  const textContent = await page.getTextContent();
  return {
    pageNumber,
    width,
    height,
    text: extractPdfTextItems(textContent.items),
    renderToCanvas: async canvas => {
      canvas.width = width;
      canvas.height = height;
      await page.render({ canvas, viewport, annotationMode: annotationDisable }).promise;
    },
  };
}

async function defaultPdfLoader(bytes: Uint8Array): Promise<PdfDocumentHandle> {
  const pdfjs = (await import('pdfjs-dist/legacy/build/pdf.mjs')) as unknown as PdfRawModule;
  const workerAsset = (await import('pdfjs-dist/legacy/build/pdf.worker.mjs?url')) as { default: string };
  pdfjs.GlobalWorkerOptions.workerSrc = workerAsset.default;
  const task = pdfjs.getDocument({
    data: bytes.slice(),
    isEvalSupported: false,
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
  if (!streamed.complete) return { kind: 'text', text: '', complete: false, error: t.tasks.materials.loadFailed };
  return parsePdfBytes(streamed.bytes);
}

function PdfCanvasPage({ page, label }: { page: PdfPageView; label: string }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const el = canvasRef.current;
    if (el) void page.renderToCanvas(el);
  }, [page]);

  return (
    <section className="mv-page">
      <span className="mv-page-n">{label}</span>
      <canvas ref={canvasRef} width={page.width} height={page.height} />
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

export function MaterialDocument({ format, contentUrl, downloadUrl, onPdfFallbackChange }: Props) {
  const t = useT();
  const [state, setState] = useState<DocState>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const ctrl = new AbortController();
    let live = true;
    setState({ kind: 'loading' });
    onPdfFallbackChange?.(false);
    const load = format === 'pdf' ? fetchPdfState(contentUrl, ctrl.signal, t) : fetchTextState(contentUrl, ctrl.signal, t);
    void load.then(
      next => {
        if (!live) return;
        setState(next);
        onPdfFallbackChange?.(next.kind === 'pdf-unavailable');
      },
      err => {
        if (!live || ctrl.signal.aborted) return;
        setState({ kind: 'error', message: errorText(t, err) });
      },
    );
    return () => {
      live = false;
      ctrl.abort();
    };
  }, [contentUrl, format, attempt, t, onPdfFallbackChange]);

  const retry = () => setAttempt(a => a + 1);
  if (state.kind === 'loading') return <p className="mv-reading" role="status">{t.common.loading}</p>;
  if (state.kind === 'error') return <RetryAlert message={state.message} onRetry={retry} />;
  if (state.kind === 'pdf-unavailable') return <PdfUnavailableCard downloadUrl={downloadUrl} />;
  if (state.kind === 'pdf') {
    return (
      <div className="mv-doc">
        <div className="mv-pdf">
          {state.pages.map(p => (
            <PdfCanvasPage key={p.pageNumber} page={p} label={t.tasks.materials.pageOf(p.pageNumber, state.pages.length)} />
          ))}
        </div>
        <p className="mv-end">{t.tasks.materials.endOfDocument}</p>
      </div>
    );
  }
  return <TextBody format={format} text={state.text} complete={state.complete} error={state.error} onRetry={retry} />;
}
