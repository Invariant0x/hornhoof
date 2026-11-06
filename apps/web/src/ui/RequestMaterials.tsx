import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { useT, type Messages } from '../i18n';
import type { WaitingRequest } from '../types';
import { MaterialViewer, materialKindLabel, materialMetaLine, type ViewerAvailableMaterial } from './MaterialViewer';
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

function readMaterialRevision(source: unknown): number | null {
  const rev = (source as { materialRevision?: unknown } | null | undefined)?.materialRevision;
  return isPositiveRevision(rev) ? rev : null;
}

export function readMaterialStamp(
  source: unknown,
  manifest?: MaterialManifestView | null,
): { materialRevision: number; materialDigest: string } | Record<string, never> {
  const rev = manifest?.materialRevision || (source as { materialRevision?: unknown } | undefined)?.materialRevision;
  const digest = manifest?.materialDigest || (source as { materialDigest?: unknown } | undefined)?.materialDigest;
  return isPositiveRevision(rev) && isHexDigest(digest) ? { materialRevision: rev, materialDigest: digest } : {};
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

export function useViewerCursor() {
  const [viewer, setViewer] = useState<{ id: string; opener: HTMLElement | null } | null>(null);
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

function MaterialGlyph({ icon }: { icon: 'download' | 'image' | 'document' | 'file' | 'link' }) {
  if (icon === 'download') {
    return (
      <svg data-icon="download" viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
        <path d="M10 3v9m0 0l-3.5-3.5M10 12l3.5-3.5M4 15.5h12" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (icon === 'link') {
    return (
      <svg data-icon="link" viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
        <path d="M8 12l4-4M6.5 13.5l-1.3 1.3a2.8 2.8 0 01-4-4L2.5 9.5m11-3l1.3-1.3a2.8 2.8 0 014 4l-1.3 1.3" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <svg data-icon={icon} viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
      <rect x="4" y="3" width="12" height="14" rx="2" />
      <path d="M7 7h6M7 10.5h6M7 14h4" strokeLinecap="round" />
    </svg>
  );
}

function iconKindFor(item: MaterialItem): 'download' | 'image' | 'document' | 'file' | 'link' {
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
  const [expanded, setExpanded] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);
  const shouldFocus = useRef(false);

  useEffect(() => {
    if (!expanded || !shouldFocus.current) return;
    shouldFocus.current = false;
    focusFirstRevealedMaterial(listRef.current);
  }, [expanded]);

  const showError = hasError(failure);
  if (!items.length && !showError) return null;
  const collapsed = !expanded && items.length >= COLLAPSE_THRESHOLD;
  const shown = collapsed ? items.slice(0, INITIAL_VISIBLE) : items;

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
        <button
          className="act mat-more"
          type="button"
          onClick={() => {
            shouldFocus.current = true;
            setExpanded(true);
          }}
        >
          {t.tasks.materials.showAll(items.length)}
        </button>
      )}
    </section>
  );
}

const emptyManifest = (): MaterialManifestView => ({ materialRevision: 0, materialDigest: '', common: [], options: [] });

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
