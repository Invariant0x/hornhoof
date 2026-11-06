import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { useT, type Messages } from '../i18n';
import type { WaitingRequest } from '../types';
import { MaterialGlyph, MaterialViewer, materialKindLabel, materialMetaLine, type MaterialGlyphKind, type ViewerAvailableMaterial } from './MaterialViewer';
import { displayFileName, proseErrorText } from './TaskAttachments';

export type MaterialState = 'available' | 'denied' | 'missing' | 'unsupported';

export type MaterialItem = {
  id: string;
  name: string;
  kind: 'image' | 'document' | 'file' | 'link';
  format?: 'text' | 'markdown' | 'pdf';
  state: MaterialState;
  contentUrl?: string;
  downloadUrl?: string | null;
  size?: number | null;
  sha256?: string | null;
  mediaType?: string | null;
  url?: string;
};

export type MaterialManifestView = {
  materialRevision: number;
  materialDigest: string;
  common: MaterialItem[];
  options: { id: string; materials: MaterialItem[] }[];
};

const COLLAPSE_THRESHOLD = 12;
const INITIAL_VISIBLE = 5;

const attachmentUrl = (id: string) => `/api/attachments/${encodeURIComponent(id)}`;

export const isAvailableMaterial = (item: MaterialItem): item is ViewerAvailableMaterial => item.state === 'available';

export function collectAvailableMaterials(manifest: MaterialManifestView): ViewerAvailableMaterial[] {
  const all = [...manifest.common, ...manifest.options.flatMap(o => o.materials)];
  return all.filter(isAvailableMaterial);
}

export function legacyRequestMaterials(request: WaitingRequest, t: Messages): MaterialManifestView {
  const common: MaterialItem[] = request.images.map((id, i) => ({
    id: `legacy-common-img-${i}`,
    name: t.tasks.picture(i + 1),
    kind: 'image',
    state: 'available',
    contentUrl: attachmentUrl(id),
    downloadUrl: attachmentUrl(id),
  }));
  if (request.link) {
    common.push({ id: 'legacy-common-link', name: t.tasks.seeWork, kind: 'link', state: 'available', url: request.link });
  }
  const options = request.options.map((opt, i) => ({
    id: `legacy-opt-${i}`,
    materials: opt.image
      ? [{ id: `legacy-opt-${i}-img`, name: t.tasks.picture(i + 1), kind: 'image' as const, state: 'available' as const, contentUrl: attachmentUrl(opt.image), downloadUrl: attachmentUrl(opt.image) }]
      : [],
  }));
  return { materialRevision: 0, materialDigest: '', common, options };
}

const isPositiveRevision = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0;
const isHexDigest = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);

function readMaterialRevision(holder: unknown): number | null {
  const rev = (holder as { materialRevision?: unknown } | null | undefined)?.materialRevision;
  return isPositiveRevision(rev) ? rev : null;
}

function readMaterialDigest(holder: unknown): string | null {
  const digest = (holder as { materialDigest?: unknown } | null | undefined)?.materialDigest;
  return isHexDigest(digest) ? digest : null;
}

function stampPair(holder: unknown): { materialRevision: number; materialDigest: string } | null {
  const rev = readMaterialRevision(holder);
  const digest = readMaterialDigest(holder);
  return rev !== null && digest !== null ? { materialRevision: rev, materialDigest: digest } : null;
}

export function readMaterialStamp(
  source: unknown,
  manifest?: MaterialManifestView | null,
): { materialRevision: number; materialDigest: string } | Record<string, never> {
  if (readMaterialRevision(source) === null) return {};
  return stampPair(manifest) ?? stampPair(source) ?? {};
}

export function useSourceMaterials(sourceKind: 'requests' | 'proposals', sourceId: string | undefined, materialRevision: number | null) {
  const [manifest, setManifest] = useState<MaterialManifestView | null>(null);
  const [failure, setFailure] = useState<unknown>(null);

  useEffect(() => {
    if (!sourceId || materialRevision === null) {
      setManifest(null);
      setFailure(null);
      return;
    }
    let live = true;
    setFailure(null);
    void api.get<MaterialManifestView>(`/api/${sourceKind}/${encodeURIComponent(sourceId)}/materials`).then(
      next => live && setManifest(next),
      err => live && setFailure(err),
    );
    return () => {
      live = false;
    };
  }, [sourceKind, sourceId, materialRevision]);

  return { manifest, failure };
}

const FALLBACK_STYLE_ID = 'hh-materials-fallback';

const MATERIALS_FALLBACK_CSS = `
.req { border-left-width: 1px; border-left-color: var(--line); border-inline-start: 3px solid var(--amber); }
.req-approval { border-left-color: var(--line); border-inline-start-color: var(--pink); }
.req header .req-term { min-height: 44px; padding: 8px 12px; white-space: normal; overflow-wrap: break-word; }
.entry-actions { box-sizing: border-box; display: flex; flex-wrap: wrap; justify-content: flex-end; align-items: stretch; gap: 8px; inline-size: 100%; min-width: 0; margin: 0; padding: 0; }
.entry-actions > :is(.act, .btn) { flex: 0 1 auto; min-inline-size: 0; max-inline-size: 100%; box-sizing: border-box; height: auto; min-height: 44px; margin: 0; padding: 8px 12px; border-radius: 0; appearance: none; display: inline-flex; align-items: center; justify-content: center; text-align: center; white-space: normal; overflow-wrap: break-word; line-height: 1.4; }
.choice-list > .req-option { min-height: 44px; }
.mat-zone { display: grid; gap: 8px; min-width: 0; margin: 0; }
.mat-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0 8px; margin: 0; }
.mat-title { margin: 0; font-family: var(--f-display); font-size: 13px; font-weight: 600; }
.mat-hint { margin: 0; font-size: 12px; color: var(--muted); }
.mat-list { display: grid; gap: 8px; margin: 0; padding: 0; list-style: none; min-width: 0; }
.answer-zone { display: grid; gap: 8px; min-width: 0; padding-block-start: 16px; border-block-start: 1px solid var(--line); }
.mat { box-sizing: border-box; display: grid; grid-template-columns: 64px minmax(0, 1fr); gap: 4px 12px; align-items: center; inline-size: 100%; min-height: 64px; margin: 0; padding: 8px; border: 1px solid var(--line2); border-radius: 0; appearance: none; background: var(--surface2); color: var(--ink); font-family: var(--f-body); font-size: 14px; font-weight: 400; line-height: 1.45; text-align: start; overflow-wrap: break-word; cursor: pointer; }
button.mat:hover { border-color: var(--cyan); box-shadow: 0 0 0 3px var(--glow); }
.mat-thumb { box-sizing: border-box; display: grid; place-items: center; inline-size: 64px; block-size: 48px; overflow: hidden; border: 1px solid var(--line); background: var(--bg); color: var(--muted); }
.mat-thumb img { display: block; inline-size: 100%; block-size: 100%; object-fit: cover; }
.mat-thumb svg, .mv-kind svg { inline-size: 24px; block-size: 24px; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
.mat-text { display: grid; gap: 2px; min-width: 0; }
.mat-name { font-weight: 500; overflow-wrap: anywhere; }
.mat-meta { display: flex; flex-wrap: wrap; gap: 0 8px; font-size: 12px; color: var(--muted); }
.mat-open { font-size: 12px; font-weight: 600; color: var(--cyan-ink); }
.mat-large { grid-template-columns: minmax(0, 1fr); padding: 0; }
.mat-large .mat-thumb { inline-size: 100%; block-size: auto; aspect-ratio: 16 / 10; border: 0; border-block-end: 1px solid var(--line); }
.mat-large .mat-thumb img { object-fit: contain; }
.mat-large .mat-thumb svg { inline-size: 40px; block-size: 40px; }
.mat-large .mat-text { padding: 4px 8px 8px; }
.mat-off { background: var(--surface); cursor: default; border-style: dashed; }
.mat-state { display: flex; flex-wrap: nowrap; align-items: center; gap: 4px 8px; font-size: 12px; font-weight: 600; color: var(--muted); }
.mat-state.bad { color: var(--pink-ink); }
.mat-row { display: grid; gap: 4px; min-width: 0; }
.mat-more { box-sizing: border-box; inline-size: 100%; min-height: 44px; margin: 0; padding: 8px 12px; border: 1px solid var(--line2); border-radius: 0; appearance: none; background: none; color: var(--cyan-ink); font-family: var(--f-body); font-size: 14px; font-weight: 500; line-height: 1.4; text-align: center; cursor: pointer; }
.mat-more:hover { border-color: var(--cyan); box-shadow: 0 0 0 3px var(--glow); }
.mat-retry { box-sizing: border-box; justify-self: end; height: auto; min-height: 44px; margin: 0; padding: 8px 12px; border-radius: 0; appearance: none; font-family: var(--f-display); font-size: 14px; font-weight: 600; line-height: 1.4; white-space: normal; }
.opts { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 280px), 1fr)); gap: 16px; min-width: 0; margin: 0; padding: 0; list-style: none; }
.opt { display: grid; gap: 8px; align-content: start; min-width: 0; padding-block-start: 16px; border-block-start: 1px solid var(--line); }
.opt-name { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 8px; align-items: baseline; margin: 0; font-weight: 600; overflow-wrap: anywhere; }
.opt-n { font-family: var(--f-display); font-size: 18px; font-weight: 600; line-height: 1.15; color: var(--cyan-ink); }
.req-note { margin: 0; }
.mv-back { position: fixed; inset: 0; z-index: 40; display: grid; grid-template: minmax(0, 1fr) / minmax(0, 1fr); background: var(--surface); }
.mv { box-sizing: border-box; display: grid; grid-template-rows: auto minmax(0, 1fr) auto; min-width: 0; inline-size: 100%; block-size: 100%; background: var(--surface); color: var(--ink); font-family: var(--f-body); font-size: 14px; line-height: 1.45; overflow-wrap: anywhere; }
.mv:focus { outline: none; }
.mv-bar { display: flex; flex-wrap: wrap; align-items: flex-start; gap: 8px 12px; padding: 8px 12px; border-block-start: 2px solid var(--cyan); border-block-end: 1px solid var(--line); }
.mv-id { flex: 1 1 200px; display: grid; gap: 2px; min-width: 0; }
.mv-name { margin: 0; font-family: var(--f-display); font-size: 15px; font-weight: 600; line-height: 1.35; overflow-wrap: anywhere; }
.mv-meta { display: flex; flex-wrap: wrap; gap: 0 8px; margin: 0; font-size: 12px; color: var(--muted); }
.mv-acts { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; margin-inline-start: auto; }
.mv-acts > .act, .mv-foot .act, .mv-card .btn, .mv-card .act, .mv-note .act { box-sizing: border-box; height: auto; min-height: 44px; min-inline-size: 44px; margin: 0; padding: 8px 12px; border-radius: 0; appearance: none; justify-content: center; gap: 8px; font-family: var(--f-display); font-size: 14px; font-weight: 600; line-height: 1.4; white-space: normal; text-align: center; }
.mv-acts svg, .mv-foot svg { flex: none; inline-size: 18px; block-size: 18px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
.mv-stage { position: relative; min-height: 0; overflow: auto; background: var(--bg); overscroll-behavior: contain; }
.mv-stage:focus-visible { outline: 2px solid var(--cyan-ink); outline-offset: -2px; }
.mv-pic { box-sizing: border-box; display: grid; place-items: center; min-inline-size: 100%; min-block-size: 100%; inline-size: max-content; padding: 8px; touch-action: pan-x pan-y pinch-zoom; }
.mv-pic.fit, .mv-doc, .mv-card { touch-action: pan-y pinch-zoom; }
.mv-pic img { display: block; max-inline-size: none; max-block-size: none; }
.mv-pic.fit { position: absolute; inset: 0; inline-size: auto; min-inline-size: 0; min-block-size: 0; grid-template: minmax(0, 1fr) / minmax(0, 1fr); }
.mv-pic.fit img { inline-size: 100%; block-size: 100%; min-inline-size: 0; min-block-size: 0; object-fit: contain; }
.mv-doc { box-sizing: border-box; display: grid; gap: 12px; inline-size: 100%; max-inline-size: 760px; margin-inline: auto; padding: 16px 18px 24px; background: var(--surface); min-block-size: 100%; align-content: start; }
.mv-doc h2 { font-size: 18px; line-height: 1.35; }
.mv-doc .md { display: grid; gap: 8px; min-width: 0; }
.mv-doc h3 { font-size: 15px; line-height: 1.35; margin-block-start: 12px; }
.mv-doc h2, .mv-doc h3, .mv-doc p, .mv-doc ul { margin-block-end: 0; }
.mv-doc ul { margin-block-start: 0; padding-inline-start: 20px; }
.mv-doc pre, .mv-plain { margin: 0; font-family: var(--f-mono); font-size: 12.5px; line-height: 1.55; white-space: pre-wrap; overflow-wrap: anywhere; }
.mv-doc pre { padding: 10px 12px; background: var(--surface2); border: 1px solid var(--line); }
.mv-pdf { display: grid; gap: 16px; min-width: 0; }
.mv-page { display: grid; gap: 8px; padding: 18px; border: 1px solid var(--line2); background: var(--surface); min-width: 0; }
.mv-page-n { font-size: 12px; color: var(--muted); }
.mv-reading { position: sticky; inset-block-start: 0; z-index: 1; display: flex; flex-wrap: nowrap; align-items: center; gap: 4px 8px; margin: 0; padding: 8px 12px; border: 1px solid var(--line2); background: var(--surface2); font-size: 13px; font-weight: 600; }
.mat-state > .spinner, .mv-reading > .spinner { flex: none; }
.mv-fail { display: grid; gap: 8px; margin: 0; padding-block-start: 12px; border-block-start: 1px solid var(--line); }
.mv-fail p { margin: 0; }
.mv-end { display: flex; flex-wrap: wrap; gap: 4px 8px; margin: 0; padding-block-start: 12px; border-block-start: 1px solid var(--line); font-size: 12px; font-weight: 600; color: var(--muted); }
.mv-card { box-sizing: border-box; display: grid; gap: 12px; align-content: center; justify-items: start; inline-size: 100%; max-inline-size: 560px; min-block-size: 100%; margin-inline: auto; padding: 24px 18px; }
.mv-card p { margin: 0; }
.mv-card > .entry-actions { justify-content: flex-end; }
.mv-kind { display: grid; place-items: center; inline-size: 64px; block-size: 64px; border: 1px solid var(--line2); background: var(--surface); color: var(--muted); }
.mv-url { font-family: var(--f-mono); font-size: 12.5px; overflow-wrap: anywhere; }
.mv-foot { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 12px; padding: 8px 12px; border-block-start: 1px solid var(--line); }
.mv-nav, .mv-zoom { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; min-width: 0; }
.mv-pos { font-size: 12px; color: var(--muted); }
.mv-level { min-inline-size: 48px; font-size: 12px; font-weight: 600; text-align: center; }
.mv-note { flex: 1 1 100%; margin: 0; font-size: 12px; color: var(--muted); }
.mv-arrow { display: inline-flex; }
[dir="rtl"] .mv-arrow { transform: scaleX(-1); }
.mv-status { margin: 0; }
.mv-status:empty { display: none; }
.mv-gesture { display: none; }
@media (pointer: coarse), (max-width: 760px) { .mv-gesture { display: block; } }
@media (max-width: 760px) {
  .mv-foot { justify-content: stretch; }
  .mv-nav { flex: 1 1 100%; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 4px 8px; }
  .mv-pos { grid-column: 1 / -1; grid-row: 1; text-align: center; }
}
.mat:focus-visible, .mat-more:focus-visible, .mat-retry:focus-visible { outline: 2px solid var(--cyan-ink); outline-offset: 2px; box-shadow: none; }
`;

function ensureMaterialsFallbackStyles(): void {
  if (document.getElementById(FALLBACK_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = FALLBACK_STYLE_ID;
  style.textContent = MATERIALS_FALLBACK_CSS;
  document.head.prepend(style);
}

export function useViewerCursor() {
  const [viewer, setViewer] = useState<{ id: string; opener: HTMLElement | null } | null>(null);
  useEffect(() => {
    ensureMaterialsFallbackStyles();
  }, []);
  const openViewer = useCallback((id: string, opener: HTMLElement | null) => setViewer({ id, opener }), []);
  const selectViewer = useCallback((id: string) => setViewer(prev => (prev ? { ...prev, id } : null)), []);
  const closeViewer = useCallback(() => setViewer(null), []);
  return { viewer, openViewer, selectViewer, closeViewer };
}

export function useRequestMaterials(request: WaitingRequest, t: Messages) {
  const revision = readMaterialRevision(request);
  const { manifest: fetched, failure } = useSourceMaterials('requests', request.id, revision);
  const manifest = fetched ?? legacyRequestMaterials(request, t);
  const availableItems = collectAvailableMaterials(manifest);
  const cursor = useViewerCursor();
  return { manifest, availableItems, failure, ...cursor };
}

function unavailableReason(t: Messages, state: Exclude<MaterialState, 'available'>): string {
  if (state === 'denied') return t.tasks.materials.denied;
  if (state === 'missing') return t.tasks.materials.missing;
  return t.tasks.materials.unsupported;
}

function iconKindFor(item: MaterialItem): MaterialGlyphKind {
  if (item.state === 'available' && item.kind === 'file' && Boolean(item.downloadUrl)) return 'download';
  return item.kind;
}

function MaterialThumb({ item, imgFailed, onImageError }: { item: MaterialItem; imgFailed: boolean; onImageError: () => void }) {
  const showPhoto = item.state === 'available' && item.kind === 'image' && Boolean(item.contentUrl) && !imgFailed;
  if (showPhoto) {
    return (
      <span className="mat-thumb">
        <img src={item.contentUrl} alt="" loading="lazy" onError={onImageError} />
      </span>
    );
  }
  return (
    <span className="mat-thumb mat-thumb-placeholder">
      <MaterialGlyph icon={iconKindFor(item)} />
    </span>
  );
}

function MaterialMeta({ item }: { item: MaterialItem }) {
  const t = useT();
  if (item.kind === 'link' && item.url) {
    return (
      <span className="mat-meta">
        <span>{materialKindLabel(t, item)}</span>
        <span className="mat-url" dir="ltr">
          {item.url}
        </span>
      </span>
    );
  }
  return <span className="mat-meta">{materialMetaLine(t, item)}</span>;
}

function MaterialCard({ item, onOpen }: { item: MaterialItem; onOpen: (id: string, opener: HTMLElement | null) => void }) {
  const t = useT();
  const [imgFailed, setImgFailed] = useState(false);
  const cardClass = item.kind === 'image' ? 'mat mat-large' : 'mat';
  const name = displayFileName(item.name);

  if (item.state !== 'available') {
    return (
      <div className="mat-row">
        <div className={`${cardClass} mat-off`}>
          <MaterialThumb item={item} imgFailed onImageError={() => {}} />
          <span className="mat-text">
            <span className="mat-name">{name}</span>
            <MaterialMeta item={item} />
            <span className="mat-state bad">{unavailableReason(t, item.state)}</span>
          </span>
        </div>
      </div>
    );
  }

  const ariaLabel = t.tasks.materials.openMaterial(name, materialKindLabel(t, item));
  return (
    <button className={cardClass} type="button" data-open={item.id} aria-label={ariaLabel} onClick={e => onOpen(item.id, e.currentTarget)}>
      <MaterialThumb item={item} imgFailed={imgFailed} onImageError={() => setImgFailed(true)} />
      <span className="mat-text">
        <span className="mat-name">{name}</span>
        <MaterialMeta item={item} />
        {imgFailed && <span className="mat-state">{t.tasks.materials.previewUnavailable}</span>}
        <span className="mat-open">{t.tasks.materials.open}</span>
      </span>
    </button>
  );
}

export function OptionMaterialItems({ items, onOpen }: { items: MaterialItem[]; onOpen: (id: string, opener: HTMLElement | null) => void }) {
  if (!items.length) return null;
  return (
    <div className="mat-list">
      {items.map(item => (
        <MaterialCard key={item.id} item={item} onOpen={onOpen} />
      ))}
    </div>
  );
}

const hasError = (failure: unknown): boolean => failure !== undefined && failure !== null;

function focusFirstRevealedMaterial(container: HTMLDivElement | null) {
  if (!container) return;
  const cards = Array.from(container.querySelectorAll<HTMLElement>('.mat')).slice(INITIAL_VISIBLE);
  const firstInteractive = cards.find((el): el is HTMLButtonElement => el.tagName === 'BUTTON');
  firstInteractive?.focus();
}

function useExpandFocus() {
  const [expanded, setExpanded] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);
  const shouldFocus = useRef(false);

  useEffect(() => {
    if (!expanded || !shouldFocus.current) return;
    shouldFocus.current = false;
    focusFirstRevealedMaterial(listRef.current);
  }, [expanded]);

  const expand = () => {
    shouldFocus.current = true;
    setExpanded(true);
  };

  return { expanded, listRef, expand };
}

function visibleMaterials(items: MaterialItem[], collapsed: boolean): MaterialItem[] {
  return collapsed ? items.slice(0, INITIAL_VISIBLE) : items;
}

export function RequestMaterialsZone({
  items,
  failure,
  onOpen,
}: {
  items: MaterialItem[];
  failure?: unknown;
  onOpen: (id: string, opener: HTMLElement | null) => void;
}) {
  const t = useT();
  const { expanded, listRef, expand } = useExpandFocus();
  const showError = hasError(failure);
  if (!items.length && !showError) return null;
  const collapsed = !expanded && items.length >= COLLAPSE_THRESHOLD;
  const shown = visibleMaterials(items, collapsed);

  return (
    <section className="mat-zone" aria-label={t.tasks.materials.heading}>
      <div className="mat-head">
        <span className="mat-title">{t.tasks.materials.heading}</span>
        <span className="mat-hint">{t.tasks.materials.hint}</span>
      </div>
      {showError && (
        <p className="alert" role="alert">
          {proseErrorText(t, failure)}
        </p>
      )}
      <div ref={listRef} className="mat-list">
        {shown.map(item => (
          <MaterialCard key={item.id} item={item} onOpen={onOpen} />
        ))}
      </div>
      {collapsed && (
        <button className="act mat-more" type="button" onClick={expand}>
          {t.tasks.materials.showAll(items.length)}
        </button>
      )}
    </section>
  );
}

const emptyManifest = (): MaterialManifestView => ({ materialRevision: 0, materialDigest: '', common: [], options: [] });

export function useProposalCardPost(onDone?: () => void) {
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);

  async function postProposal(path: string, body: unknown) {
    setBusy(true);
    setFailure(null);
    try {
      await api.post(path, body);
      setSent(true);
      onDone?.();
    } catch (err) {
      setFailure(err);
    } finally {
      setBusy(false);
    }
  }

  return { busy, sent, failure, setFailure, postProposal };
}

export function useProposalMaterials(proposal: { id: string } | undefined) {
  const revision = readMaterialRevision(proposal);
  const { manifest, failure } = useSourceMaterials('proposals', proposal?.id, revision);
  const cursor = useViewerCursor();
  const stamp = readMaterialStamp(proposal, manifest);
  return { enabled: Boolean(proposal) && revision !== null, manifest, failure, stamp, ...cursor };
}

export function ProposalMaterialsSection({ state }: { state: ReturnType<typeof useProposalMaterials> }) {
  if (!state.enabled) return null;
  const resolved = state.manifest ?? emptyManifest();
  return (
    <>
      <RequestMaterialsZone items={resolved.common} failure={state.failure} onOpen={state.openViewer} />
      {state.viewer && (
        <MaterialViewer
          items={collectAvailableMaterials(resolved)}
          activeId={state.viewer.id}
          opener={state.viewer.opener}
          proposalSource
          onSelect={state.selectViewer}
          onClose={state.closeViewer}
        />
      )}
    </>
  );
}
