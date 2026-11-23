import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { useT, type Messages } from '../i18n';
import type { WaitingRequest } from '../types';
import { MaterialGlyph, MaterialViewer, materialKindLabel, materialMetaLine, type MaterialGlyphKind, type ViewerAvailableMaterial } from './MaterialViewer';
import { displayFileName, proseErrorText } from './TaskAttachments';

type MaterialState = 'available' | 'denied' | 'missing' | 'unsupported';

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

const isAvailableMaterial = (item: MaterialItem): item is ViewerAvailableMaterial => item.state === 'available';

function collectAvailableMaterials(manifest: MaterialManifestView): ViewerAvailableMaterial[] {
  const all = [...manifest.common, ...manifest.options.flatMap(o => o.materials)];
  return all.filter(isAvailableMaterial);
}

function legacyRequestMaterials(request: WaitingRequest, t: Messages): MaterialManifestView {
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

function useSourceMaterials(sourceKind: 'requests' | 'proposals', sourceId: string | undefined, materialRevision: number | null) {
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
      next => live && next && setManifest(next),
      err => live && setFailure(err),
    );
    return () => {
      live = false;
    };
  }, [sourceKind, sourceId, materialRevision]);

  return { manifest, failure };
}

function useViewerCursor() {
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
  heading,
}: {
  items: MaterialItem[];
  failure?: unknown;
  onOpen: (id: string, opener: HTMLElement | null) => void;
  heading?: string;
}) {
  const t = useT();
  const { expanded, listRef, expand } = useExpandFocus();
  const showError = hasError(failure);
  if (!items.length && !showError) return null;
  const collapsed = !expanded && items.length >= COLLAPSE_THRESHOLD;
  const shown = visibleMaterials(items, collapsed);
  const title = heading ?? t.tasks.materials.heading;

  return (
    <section className="mat-zone" aria-label={title}>
      <div className="mat-head">
        <span className="mat-title">{title}</span>
        <bdi className="mat-hint">{t.tasks.materials.hint}</bdi>
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
