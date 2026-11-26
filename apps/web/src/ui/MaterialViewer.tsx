import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useT, type Messages } from '../i18n';
import { MaterialDocument } from './MaterialDocument';
import { useServiceView } from './ServiceRoad';
import { displayFileName, formatFileSize } from './TaskAttachments';

export type ViewerAvailableMaterial = {
  id: string;
  name: string;
  kind: 'image' | 'document' | 'file' | 'link';
  format?: 'text' | 'markdown' | 'pdf';
  state: 'available';
  contentUrl?: string;
  downloadUrl?: string | null;
  size?: number | null;
  mediaType?: string | null;
  url?: string;
};

const ZOOM_MIN = 1;
const ZOOM_MAX = 4;
const ZOOM_STEP = 0.5;
const SWIPE_MIN_PX = 48;
const ALLOWED_LINK_PROTOCOLS = new Set(['http:', 'https:']);

const clampZoom = (next: number): number => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(next * 2) / 2));

function safeExternalHttpUrl(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const parsed = new URL(raw.trim());
    return ALLOWED_LINK_PROTOCOLS.has(parsed.protocol) ? raw.trim() : null;
  } catch {
    return null;
  }
}

export function materialKindLabel(t: Messages, item: { kind: 'image' | 'document' | 'file' | 'link'; format?: 'text' | 'markdown' | 'pdf' }): string {
  if (item.kind === 'document') return t.tasks.materials.kinds[item.format ?? 'text'];
  return t.tasks.materials.kinds[item.kind];
}

export function materialMetaLine(t: Messages, item: { kind: 'image' | 'document' | 'file' | 'link'; format?: 'text' | 'markdown' | 'pdf'; size?: number | null }): string {
  const kind = materialKindLabel(t, item);
  return typeof item.size === 'number' ? `${kind} · ${formatFileSize(t, item.size)}` : kind;
}

export type MaterialGlyphKind = 'download' | 'image' | 'document' | 'file' | 'link';

const GLYPH_ELEMENTS: Record<MaterialGlyphKind, ReactNode> = {
  download: <path d="M12 4v11M8 11l4 4 4-4M5 20h14" />,
  image: (
    <>
      <rect x="3" y="5" width="18" height="14" />
      <circle cx="9" cy="10" r="1.6" />
      <path d="M4 18l5-5 4 4 3-3 4 4" />
    </>
  ),
  document: (
    <>
      <path d="M6 3h8l4 4v14H6z" />
      <path d="M14 3v4h4M9 12h6M9 16h6" />
    </>
  ),
  file: (
    <>
      <path d="M6 3h8l4 4v14H6z" />
      <path d="M14 3v4h4" />
    </>
  ),
  link: (
    <>
      <path d="M10 14a4 4 0 0 0 6 0l3-3a4 4 0 0 0-6-6l-1 1" />
      <path d="M14 10a4 4 0 0 0-6 0l-3 3a4 4 0 0 0 6 6l1-1" />
    </>
  ),
};

export function MaterialGlyph({ icon }: { icon: MaterialGlyphKind }) {
  return (
    <svg data-icon={icon} viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {GLYPH_ELEMENTS[icon]}
    </svg>
  );
}

function addFreshInert(targets: HTMLElement[], el: Element | null) {
  if (el instanceof HTMLElement && !el.hasAttribute('inert')) targets.push(el);
}

function collectInertSiblings(portalRoot: HTMLElement | null): HTMLElement[] {
  const targets: HTMLElement[] = [];
  for (const child of Array.from(document.body.children)) {
    if (child === portalRoot) continue;
    addFreshInert(targets, child);
    if (child.children.length === 1) addFreshInert(targets, child.firstElementChild);
  }
  return targets;
}

function resolveInitialOpener(opener: HTMLElement | null): HTMLElement | null {
  if (opener) return opener;
  return document.activeElement instanceof HTMLElement ? document.activeElement : null;
}

function useInertBackground(portalRef: { current: HTMLDivElement | null }, opener: HTMLElement | null, active: boolean) {
  useLayoutEffect(() => {
    if (!active) return;
    const previousFocus = resolveInitialOpener(opener);
    const siblings = collectInertSiblings(portalRef.current);
    for (const el of siblings) el.setAttribute('inert', '');
    return () => {
      for (const el of siblings) el.removeAttribute('inert');
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [portalRef, opener, active]);
}

function shouldWrapTab(dialog: HTMLElement, boundary: HTMLElement, active: Element | null): boolean {
  return active === boundary || !dialog.contains(active);
}

function focusWrappedBoundary(dialog: HTMLElement, focusables: HTMLElement[], shiftKey: boolean, e: ReactKeyboardEvent<HTMLDivElement>) {
  const boundary = shiftKey ? focusables[0]! : focusables[focusables.length - 1]!;
  const target = shiftKey ? focusables[focusables.length - 1]! : focusables[0]!;
  if (!shouldWrapTab(dialog, boundary, document.activeElement)) return;
  e.preventDefault();
  target.focus();
}

function trapDialogTab(dialog: HTMLElement | null, e: ReactKeyboardEvent<HTMLDivElement>) {
  if (e.key !== 'Tab' || !dialog) return;
  const focusables = Array.from(dialog.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'));
  if (focusables.length) focusWrappedBoundary(dialog, focusables, e.shiftKey, e);
}

const scrollRatio = (offset: number, view: number, total: number): number => (total > 0 ? (offset + view / 2) / total : 0.5);

function preserveStageCenter(stage: HTMLDivElement | null, applyZoom: () => void) {
  const rx = stage ? scrollRatio(stage.scrollLeft, stage.clientWidth, stage.scrollWidth) : 0.5;
  const ry = stage ? scrollRatio(stage.scrollTop, stage.clientHeight, stage.scrollHeight) : 0.5;
  applyZoom();
  requestAnimationFrame(() => {
    if (!stage) return;
    stage.scrollLeft = Math.max(0, rx * stage.scrollWidth - stage.clientWidth / 2);
    stage.scrollTop = Math.max(0, ry * stage.scrollHeight - stage.clientHeight / 2);
  });
}

function ImageStage({ item, zoom, onToggleDoubleClick }: { item: ViewerAvailableMaterial; zoom: number; onToggleDoubleClick: () => void }) {
  const t = useT();
  const [failed, setFailed] = useState(false);
  const [retrySeq, setRetrySeq] = useState(0);

  useEffect(() => {
    setFailed(false);
    setRetrySeq(0);
  }, [item.id]);

  if (failed || !item.contentUrl) {
    return (
      <div className="mv-card mv-fail">
        <p className="alert" role="alert">
          {t.tasks.materials.loadFailed}
        </p>
        <div className="entry-actions">
          <button
            className="btn"
            type="button"
            onClick={() => {
              setFailed(false);
              setRetrySeq(n => n + 1);
            }}
          >
            {t.tasks.materials.tryAgain}
          </button>
        </div>
      </div>
    );
  }

  const picStyle = zoom > 1 ? { inlineSize: `${zoom * 100}%`, blockSize: `${zoom * 100}%` } : undefined;
  const imgStyle = zoom > 1 ? { inlineSize: '100%', blockSize: '100%', objectFit: 'contain' as const } : undefined;
  return (
    <div className={zoom === 1 ? 'mv-pic fit' : 'mv-pic'} style={picStyle} onDoubleClick={onToggleDoubleClick}>
      <img key={retrySeq} src={item.contentUrl} alt={displayFileName(item.name)} style={imgStyle} onLoad={() => setFailed(false)} onError={() => setFailed(true)} />
    </div>
  );
}

function FileStage({ item }: { item: ViewerAvailableMaterial }) {
  const t = useT();
  const downloadHref = item.downloadUrl ?? null;
  return (
    <div className="mv-card">
      <span className="mv-kind">
        <MaterialGlyph icon={downloadHref ? 'download' : 'file'} />
      </span>
      <p>{downloadHref ? t.tasks.materials.noFilePreview : t.tasks.materials.noFileDownload}</p>
      {downloadHref && (
        <div className="entry-actions">
          <a className="btn act" href={downloadHref} download>
            {t.tasks.materials.downloadFile}
          </a>
        </div>
      )}
    </div>
  );
}

function LinkStage({ item }: { item: ViewerAvailableMaterial }) {
  const t = useT();
  const safeHref = safeExternalHttpUrl(item.url);
  return (
    <div className="mv-card">
      <span className="mv-kind">
        <MaterialGlyph icon="link" />
      </span>
      {item.url && (
        <p className="mv-url" dir="ltr">
          {item.url}
        </p>
      )}
      <p>{t.tasks.materials.linkNotice}</p>
      {safeHref && (
        <div className="entry-actions">
          <a className="btn act" href={safeHref} target="_blank" rel="noopener noreferrer">
            {t.tasks.materials.openLink}
          </a>
        </div>
      )}
    </div>
  );
}

function DocumentStage({ item, onPdfFallbackChange }: { item: ViewerAvailableMaterial; onPdfFallbackChange: (unavailable: boolean) => void }) {
  return <MaterialDocument format={item.format ?? 'text'} contentUrl={item.contentUrl ?? ''} downloadUrl={item.downloadUrl ?? null} onPdfFallbackChange={onPdfFallbackChange} />;
}

function StageContent({
  item,
  zoom,
  onToggleDoubleClick,
  onPdfFallbackChange,
}: {
  item: ViewerAvailableMaterial;
  zoom: number;
  onToggleDoubleClick: () => void;
  onPdfFallbackChange: (unavailable: boolean) => void;
}) {
  if (item.kind === 'image') return <ImageStage item={item} zoom={zoom} onToggleDoubleClick={onToggleDoubleClick} />;
  if (item.kind === 'file') return <FileStage item={item} />;
  if (item.kind === 'link') return <LinkStage item={item} />;
  return <DocumentStage item={item} onPdfFallbackChange={onPdfFallbackChange} />;
}

function ZoomControls({ zoom, onStep, onReset }: { zoom: number; onStep: (delta: number) => void; onReset: () => void }) {
  const t = useT();
  return (
    <div className="mv-zoom" role="group" aria-label={t.tasks.materials.kinds.image}>
      <button className="act" type="button" aria-label={t.tasks.materials.zoomOut} disabled={zoom <= ZOOM_MIN} onClick={() => onStep(-ZOOM_STEP)}>
        -
      </button>
      <span className="mv-level" aria-live="polite">{`×${zoom}`}</span>
      <button className="act" type="button" aria-label={t.tasks.materials.zoomIn} disabled={zoom >= ZOOM_MAX} onClick={() => onStep(ZOOM_STEP)}>
        +
      </button>
      <button className="act" type="button" disabled={zoom === ZOOM_MIN} onClick={onReset}>
        {t.tasks.materials.fitWindow}
      </button>
    </div>
  );
}

function ViewerHeader({
  titleId,
  item,
  pdfUnavailable,
  closeBtnRef,
  onClose,
}: {
  titleId: string;
  item: ViewerAvailableMaterial;
  pdfUnavailable: boolean;
  closeBtnRef: { current: HTMLButtonElement | null };
  onClose: () => void;
}) {
  const t = useT();
  const downloadHref = item.kind !== 'file' && !pdfUnavailable ? item.downloadUrl : null;
  return (
    <header className="mv-bar">
      <div className="mv-id">
        <h2 className="mv-name" id={titleId}>
          {displayFileName(item.name)}
        </h2>
        <p className="mv-meta">{materialMetaLine(t, item)}</p>
      </div>
      <div className="mv-acts">
        {downloadHref && (
          <a className="act" href={downloadHref} download>
            {t.tasks.materials.downloadFile}
          </a>
        )}
        <button ref={closeBtnRef} className="act mv-close" type="button" onClick={onClose}>
          {t.tasks.materials.close}
        </button>
      </div>
    </header>
  );
}

function ViewerFooter({
  isImage,
  index,
  total,
  zoom,
  proposalSource,
  onStepTrack,
  onStepZoom,
  onResetZoom,
}: {
  isImage: boolean;
  index: number;
  total: number;
  zoom: number;
  proposalSource: boolean;
  onStepTrack: (delta: number) => void;
  onStepZoom: (delta: number) => void;
  onResetZoom: () => void;
}) {
  const t = useT();
  const posText = isImage ? t.tasks.materials.picturePos(index + 1, total) : t.tasks.materials.materialPos(index + 1, total);
  return (
    <footer className="mv-foot">
      <div className="mv-nav">
        <button className="act" type="button" disabled={index <= 0} onClick={() => onStepTrack(-1)}>
          {t.tasks.materials.previous}
        </button>
        <span className="mv-pos" aria-live="polite">
          {posText}
        </span>
        <button className="act" type="button" disabled={index >= total - 1} onClick={() => onStepTrack(1)}>
          {t.tasks.materials.next}
        </button>
      </div>
      {isImage && <ZoomControls zoom={zoom} onStep={onStepZoom} onReset={onResetZoom} />}
      <p className="mv-note">
        {proposalSource ? t.tasks.materials.proposalNote : `${t.tasks.materials.viewerNote} `}
        {!proposalSource && <span className="mv-gesture">{t.tasks.materials.gestureHint}</span>}
      </p>
    </footer>
  );
}

const arrowDirection = (key: string): number => (key === 'ArrowLeft' ? -1 : key === 'ArrowRight' ? 1 : 0);
const rtlMultiplier = (): number => (document.documentElement.getAttribute('dir') === 'rtl' ? -1 : 1);

function dispatchImageZoomKey(key: string, stepZoom: (d: number) => void, resetZoom: () => void): boolean {
  if (key === '+' || key === '=') {
    stepZoom(ZOOM_STEP);
    return true;
  }
  if (key === '-' || key === '_') {
    stepZoom(-ZOOM_STEP);
    return true;
  }
  if (key === '0') {
    resetZoom();
    return true;
  }
  return false;
}

function swipeStepDelta(dx: number, dy: number): number {
  if (Math.abs(dx) < SWIPE_MIN_PX || Math.abs(dx) <= Math.abs(dy) * 1.5) return 0;
  return (dx < 0 ? 1 : -1) * rtlMultiplier();
}

function canSwipeImage(start: { id: number } | null, pointerId: number, kind: string | undefined, zoom: number): boolean {
  if (!start || start.id !== pointerId) return false;
  return kind === 'image' && zoom === 1;
}

function trackForKind(items: ViewerAvailableMaterial[], kind: string | undefined): ViewerAvailableMaterial[] {
  return kind === 'image' ? items.filter(m => m.kind === 'image') : items.filter(m => m.kind !== 'image');
}

type Props = {
  items: ViewerAvailableMaterial[];
  activeId: string;
  opener: HTMLElement | null;
  proposalSource?: boolean;
  onSelect: (id: string) => void;
  onClose: () => void;
};

function resolveActiveViewerItem(items: ViewerAvailableMaterial[], activeId: string): ViewerAvailableMaterial | undefined {
  return items.find(m => m.id === activeId) ?? items[0];
}

function activeTrackIndex(track: ViewerAvailableMaterial[], active: ViewerAvailableMaterial | undefined): number {
  return active ? track.findIndex(m => m.id === active.id) : -1;
}

function handleViewerKeyEvent(
  e: KeyboardEvent,
  activeKind: string | undefined,
  onClose: () => void,
  stepTrack: (d: number) => void,
  stepZoom: (d: number) => void,
  resetZoom: () => void,
) {
  if (e.key === 'Escape') {
    e.preventDefault();
    onClose();
    return;
  }
  const dir = arrowDirection(e.key);
  if (dir !== 0) {
    e.preventDefault();
    stepTrack(dir * rtlMultiplier());
    return;
  }
  if (activeKind === 'image' && dispatchImageZoomKey(e.key, stepZoom, resetZoom)) e.preventDefault();
}

function useViewerKeyboard(
  active: boolean,
  activeKind: string | undefined,
  onClose: () => void,
  stepTrack: (d: number) => void,
  stepZoom: (d: number) => void,
  resetZoom: () => void,
) {
  useEffect(() => {
    if (!active) return;
    const listener = (e: KeyboardEvent) => handleViewerKeyEvent(e, activeKind, onClose, stepTrack, stepZoom, resetZoom);
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, [active, activeKind, onClose, stepTrack, stepZoom, resetZoom]);
}

function finishSwipeGesture(
  swipeStart: { current: { x: number; y: number; id: number } | null },
  e: ReactPointerEvent<HTMLDivElement>,
  activeKind: string | undefined,
  zoom: number,
  stepTrack: (d: number) => void,
) {
  const start = swipeStart.current;
  swipeStart.current = null;
  if (!canSwipeImage(start, e.pointerId, activeKind, zoom)) return;
  const step = swipeStepDelta(e.clientX - start!.x, e.clientY - start!.y);
  if (step !== 0) stepTrack(step);
}

function toggleDoubleClickZoom(stage: HTMLDivElement | null, setZoom: (updater: (z: number) => number) => void) {
  preserveStageCenter(stage, () => setZoom(z => (z === 1 ? 2 : 1)));
}

function focusElement(el: HTMLElement | null): void {
  if (el) el.focus();
}

function ActiveMaterialViewer({
  items,
  active,
  opener,
  proposalSource = false,
  onSelect,
  onClose,
}: Omit<Props, 'activeId'> & { active: ViewerAvailableMaterial }) {
  const titleId = useId();
  const portalRef = useRef<HTMLDivElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeBtnRef = useRef<HTMLButtonElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const swipeStart = useRef<{ x: number; y: number; id: number } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pdfUnavailable, setPdfUnavailable] = useState(false);
  const servicePlace = useServiceView()?.place;
  const covered = servicePlace === 'window' || servicePlace === 'boot';

  const track = trackForKind(items, active.kind);
  const index = activeTrackIndex(track, active);

  useInertBackground(portalRef, opener, !covered);

  useEffect(() => {
    if (!covered && !dialogRef.current?.contains(document.activeElement)) focusElement(closeBtnRef.current);
  }, [covered]);

  useEffect(() => {
    setZoom(1);
    setPdfUnavailable(false);
  }, [active.id]);

  const stepTrack = useCallback(
    (delta: number) => {
      const nextItem = track[index + delta];
      if (nextItem) onSelect(nextItem.id);
    },
    [track, index, onSelect],
  );

  const stepZoom = useCallback((delta: number) => preserveStageCenter(stageRef.current, () => setZoom(z => clampZoom(z + delta))), []);
  const resetZoom = useCallback(() => preserveStageCenter(stageRef.current, () => setZoom(1)), []);

  useViewerKeyboard(!covered, active.kind, onClose, stepTrack, stepZoom, resetZoom);

  return createPortal(
    <div ref={portalRef} className="mv-back" hidden={covered}>
      <div ref={dialogRef} className="mv" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onKeyDown={e => trapDialogTab(dialogRef.current, e)}>
        <ViewerHeader titleId={titleId} item={active} pdfUnavailable={pdfUnavailable} closeBtnRef={closeBtnRef} onClose={onClose} />
        <div
          ref={stageRef}
          className="mv-stage"
          tabIndex={0}
          aria-label={displayFileName(active.name)}
          onPointerDown={e => {
            swipeStart.current = { x: e.clientX, y: e.clientY, id: e.pointerId };
          }}
          onPointerUp={e => finishSwipeGesture(swipeStart, e, active.kind, zoom, stepTrack)}
        >
          <StageContent
            item={active}
            zoom={zoom}
            onToggleDoubleClick={() => toggleDoubleClickZoom(stageRef.current, setZoom)}
            onPdfFallbackChange={setPdfUnavailable}
          />
        </div>
        <ViewerFooter
          isImage={active.kind === 'image'}
          index={index}
          total={track.length}
          zoom={zoom}
          proposalSource={proposalSource}
          onStepTrack={stepTrack}
          onStepZoom={stepZoom}
          onResetZoom={resetZoom}
        />
      </div>
    </div>,
    document.body,
  );
}

export function MaterialViewer({ items, activeId, opener, proposalSource = false, onSelect, onClose }: Props) {
  const active = resolveActiveViewerItem(items, activeId);
  if (!active) return null;
  return (
    <ActiveMaterialViewer
      items={items}
      active={active}
      opener={opener}
      proposalSource={proposalSource}
      onSelect={onSelect}
      onClose={onClose}
    />
  );
}
