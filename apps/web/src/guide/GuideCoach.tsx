import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { useLanguage, useT, type Messages } from '../i18n';
import { takeEscape } from '../ui/escape';
import {
  attachAnchorDecoration,
  computeCoachPlacement,
  findGuideAnchor,
  focusTargetOf,
  hasBlockingOverlay,
  readSafeTop,
  type PlacementResult,
  type Rect,
  type ViewportBox,
} from './placement';
import type { GuideCompanionKind, GuidePhase, GuideStep } from './types';
import { guideCompanionKind, resolveGuideVoice, useActiveGuideSkin } from './voices';

export type GuideCoachProps = {
  visible: boolean;
  step: GuideStep;
  phase: GuidePhase;
  confirmedStep?: GuideStep | null;
  anchors: readonly string[];
  /* Renders in document flow when inline (e.g. inside Setup Card on mobile) instead of bottom-docked. */
  flowInline?: boolean;
  /* Counter incremented when the user explicitly clicks Resume guide to scroll & focus once. */
  focusRequest?: number;
  /* Trigger button to restore focus to if the active anchor isn't focusable when closing from coach. */
  fallbackFocusRef?: { current: HTMLElement | null };
  onSkip: () => void;
  onFinish?: () => void;
  onOpenTask?: () => void;
};

/* Decorative 20x20 theme companion mark (aria-hidden, never role="img"). */
function CompanionIcon({ kind }: { kind: GuideCompanionKind }) {
  return (
    <span className="guide-companion" data-companion={kind} aria-hidden="true">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {kind === 'reed' ? (
          <path d="M4 18h16M12 18V5m0 9c-5 0-6-3-6-5 4 0 6 2 6 5Zm0-3c3 0 6-3 6-6-4 0-6 3-6 6Z" />
        ) : (
          <>
            <circle cx="12" cy="12" r="3" />
            <path d="M5 5h4M5 5v4m14-4h-4m4 0v4M5 19h4m-4 0v-4m14 4h-4m4 0v-4" />
          </>
        )}
      </svg>
    </span>
  );
}

type CoachCopy = {
  confirmed: string;
  body: string;
  status: string;
  busy: boolean;
  recover: boolean;
  finished: boolean;
};

const PHASE_STATUS_KEYS: Partial<Record<GuidePhase, keyof Messages['guide']>> = {
  loading: 'connecting',
  waiting_machine: 'waitMachine',
  needs_login: 'waitLogin',
  needs_setup: 'needsSetup',
  created: 'created',
  queued: 'queued',
  unavailable: 'unavailable',
  working: 'started',
};

function statusLabelFor(phase: GuidePhase, t: Messages): { status: string; busy: boolean } {
  const key = PHASE_STATUS_KEYS[phase];
  const value = key ? t.guide[key] : '';
  return { status: typeof value === 'string' ? value : '', busy: phase === 'loading' };
}

function confirmedLineFor(step: GuideStep, phase: GuidePhase, confirmedStep: GuideStep | null | undefined, skinId: string, language: 'en' | 'ru', t: Messages): string {
  if (step === 'work' && phase === 'working') return resolveGuideVoice(skinId, language, 'work', t)[1];
  if (!confirmedStep || (step === 'work' && phase === 'created')) return '';
  return resolveGuideVoice(skinId, language, confirmedStep, t)[1];
}

function bodyLineFor(step: GuideStep, phase: GuidePhase, skinId: string, language: 'en' | 'ru', t: Messages): string {
  if (phase === 'link_ready') return t.guide.linkReadyNote;
  if (step === 'work' && phase === 'created') return resolveGuideVoice(skinId, language, 'task', t)[1];
  if ((step === 'work' && (phase === 'working' || phase === 'unavailable')) || (step === 'plan' && phase === 'loading')) return '';
  const voice = resolveGuideVoice(skinId, language, step, t);
  return phase === 'recovery' ? voice[2] : voice[0];
}

function buildCopy(step: GuideStep, phase: GuidePhase, confirmedStep: GuideStep | null | undefined, skinId: string, language: 'en' | 'ru', t: Messages): CoachCopy {
  const { status, busy } = statusLabelFor(phase, t);
  const finished = step === 'work' && phase === 'working';
  const confirmed = confirmedLineFor(step, phase, confirmedStep, skinId, language, t);
  const body = bodyLineFor(step, phase, skinId, language, t);
  return { confirmed, body, status, busy, recover: phase === 'recovery', finished };
}

function toRelativeRect(r: DOMRect, ox: number, oy: number): Rect {
  return { left: r.left - ox, right: r.right - ox, top: r.top - oy, bottom: r.bottom - oy, width: r.width, height: r.height };
}

function readOrigin(screenRect: DOMRect | undefined): { ox: number; oy: number } {
  if (!screenRect) return { ox: 0, oy: 0 };
  return { ox: screenRect.left, oy: screenRect.top };
}

function readViewportBox(screenRect: DOMRect | undefined): ViewportBox {
  const { ox, oy } = readOrigin(screenRect);
  const vv = window.visualViewport;
  if (vv) return { left: vv.offsetLeft - ox, top: vv.offsetTop - oy, width: vv.width, height: vv.height };
  const width = screenRect && screenRect.width > 0 ? screenRect.width : window.innerWidth || 1024;
  const height = screenRect && screenRect.height > 0 ? screenRect.height : window.innerHeight || 768;
  return { left: -ox, top: -oy, width, height };
}

function readCardSize(coachEl: HTMLElement | null): { width: number; height: number } {
  if (!coachEl) return { width: 320, height: 168 };
  return { width: coachEl.offsetWidth || 320, height: coachEl.offsetHeight || 168 };
}

function measurePlacement(anchor: HTMLElement, coachEl: HTMLElement | null): PlacementResult {
  const panel = anchor.closest<HTMLElement>('.card:not(.wide), .acard, .tp-panel');
  const screenEl = document.querySelector<HTMLElement>('.app-screen');
  const screenRect = screenEl ? screenEl.getBoundingClientRect() : undefined;
  const { ox, oy } = readOrigin(screenRect);
  const dir: 'ltr' | 'rtl' = document.documentElement.dir === 'rtl' ? 'rtl' : 'ltr';
  return computeCoachPlacement({
    anchor: toRelativeRect(anchor.getBoundingClientRect(), ox, oy),
    frame: toRelativeRect((panel ?? anchor).getBoundingClientRect(), ox, oy),
    viewport: readViewportBox(screenRect),
    card: readCardSize(coachEl),
    dir,
    safeTop: readSafeTop(),
    coachFocused: Boolean(coachEl && coachEl.contains(document.activeElement)),
  });
}

function scrollAndFocusOnce(anchor: HTMLElement): void {
  const target = focusTargetOf(anchor);
  const reduced = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  target.scrollIntoView?.({ block: 'nearest', behavior: reduced ? 'auto' : 'smooth' });
  target.focus({ preventScroll: true });
}

function observeDom(sync: () => void, coachEl: HTMLElement | null): () => void {
  const mo = typeof MutationObserver !== 'undefined' ? new MutationObserver(sync) : null;
  if (mo) mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'aria-hidden', 'open', 'class', 'dir'] });
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(sync) : null;
  if (ro) {
    ro.observe(document.body);
    if (coachEl) ro.observe(coachEl);
  }
  return () => {
    if (mo) mo.disconnect();
    if (ro) ro.disconnect();
  };
}

function watchLayoutEvents(sync: () => void, coachEl: HTMLElement | null): () => void {
  let alive = true;
  const stopDom = observeDom(sync, coachEl);
  const vv = window.visualViewport;
  window.addEventListener('resize', sync);
  window.addEventListener('scroll', sync, true);
  if (vv) {
    vv.addEventListener('resize', sync);
    vv.addEventListener('scroll', sync);
  }
  if (document.fonts) void document.fonts.ready.then(() => { if (alive) sync(); });
  return () => {
    alive = false;
    stopDom();
    window.removeEventListener('resize', sync);
    window.removeEventListener('scroll', sync, true);
    if (vv) {
      vv.removeEventListener('resize', sync);
      vv.removeEventListener('scroll', sync);
    }
  };
}

const DEFAULT_PLACEMENT: PlacementResult = { mode: 'inline', hidden: false, side: 'inline', left: 0, top: 0 };

/* Tracks the active anchor, attaches highlight/aria-describedby, yields to overlays, and computes placement. */
function useCoachAnchor(visible: boolean, anchorsKey: string, anchors: readonly string[], coachRef: { current: HTMLElement | null }, focusRequest: number) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [overlayBlocked, setOverlayBlocked] = useState(false);
  const [placement, setPlacement] = useState<PlacementResult>(DEFAULT_PLACEMENT);
  const lastFocusRequest = useRef(focusRequest);

  useLayoutEffect(() => {
    if (!visible) {
      setAnchor(null);
      return;
    }
    const sync = () => {
      const blocked = hasBlockingOverlay();
      setOverlayBlocked(blocked);
      const found = blocked ? null : findGuideAnchor(anchors);
      setAnchor(found);
      if (found) setPlacement(measurePlacement(found, coachRef.current));
    };
    sync();
    return watchLayoutEvents(sync, coachRef.current);
  }, [visible, anchorsKey, coachRef]);

  useEffect(() => {
    if (!visible || overlayBlocked || !anchor) return;
    return attachAnchorDecoration(anchor);
  }, [visible, overlayBlocked, anchor]);

  useEffect(() => {
    if (focusRequest === lastFocusRequest.current || !visible || overlayBlocked || !anchor) return;
    lastFocusRequest.current = focusRequest;
    scrollAndFocusOnce(anchor);
  }, [focusRequest, visible, overlayBlocked, anchor]);

  return { anchor, overlayBlocked, placement };
}

function usePoliteAnnouncement(visible: boolean, text: string): string {
  const [said, setSaid] = useState('');
  const prev = useRef('');
  useEffect(() => {
    if (!visible || !text || text === prev.current) return;
    prev.current = text;
    setSaid(text);
  }, [visible, text]);
  return said;
}

function useCoachEscape(shown: boolean, coachRef: { current: HTMLElement | null }, onDismiss: () => void): void {
  const latest = useRef(onDismiss);
  latest.current = onDismiss;
  useEffect(() => {
    if (!shown) return;
    const onKey = (e: KeyboardEvent) => {
      if (coachRef.current?.contains(document.activeElement) && takeEscape(e)) latest.current();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [shown, coachRef]);
}

function coachClasses(isFloating: boolean, flowInline: boolean, side: PlacementResult['side']): string {
  const modeClass = isFloating ? 'is-floating' : flowInline ? 'is-flow' : 'is-inline';
  return isFloating && side === 'start' ? `guide-coach ${modeClass} is-before` : `guide-coach ${modeClass}`;
}

function CoachBody({ copy }: { copy: CoachCopy }) {
  return (
    <div id="guide-coach-text" className="guide-coach-body">
      {copy.confirmed && <p className="guide-confirmed"><bdi>{copy.confirmed}</bdi></p>}
      {copy.status && (
        <p className={`guide-status${copy.finished ? ' is-ok' : ''}`}>
          {copy.busy && <span className="spinner" aria-hidden="true" />}
          <bdi>{copy.status}</bdi>
        </p>
      )}
      {copy.body && <p className={copy.recover ? 'guide-recover' : undefined}><bdi>{copy.body}</bdi></p>}
    </div>
  );
}

function CoachActions({ finished, onOpenTask, onDismiss }: { finished: boolean; onOpenTask?: () => void; onDismiss: () => void }) {
  const t = useT();
  return (
    <div className="entry-actions guide-coach-actions">
      {finished && onOpenTask && <button className="btn ghost" type="button" onClick={onOpenTask}>{t.guide.openTask}</button>}
      <button className="btn ghost guide-quiet" type="button" onClick={onDismiss}>{finished ? t.guide.finish : t.guide.skip}</button>
    </div>
  );
}

export function GuideCoach({
  visible,
  step,
  phase,
  confirmedStep,
  anchors,
  flowInline = false,
  focusRequest = 0,
  fallbackFocusRef,
  onSkip,
  onFinish,
  onOpenTask,
}: GuideCoachProps) {
  const t = useT();
  const { language } = useLanguage();
  const skinId = useActiveGuideSkin();
  const coachRef = useRef<HTMLElement | null>(null);
  const { anchor, overlayBlocked, placement } = useCoachAnchor(visible, anchors.join('|'), anchors, coachRef, focusRequest);
  const shown = visible && !overlayBlocked && !placement.hidden;
  const copy = buildCopy(step, phase, confirmedStep, skinId, language, t);
  const announcement = usePoliteAnnouncement(shown, [copy.confirmed, copy.status, copy.body].filter(Boolean).join(' '));

  const dismissAndReturnFocus = () => {
    const returnTo = anchor ? focusTargetOf(anchor) : fallbackFocusRef?.current ?? null;
    (copy.finished && onFinish ? onFinish : onSkip)();
    requestAnimationFrame(() => returnTo?.focus({ preventScroll: true }));
  };

  useCoachEscape(shown, coachRef, dismissAndReturnFocus);

  const isFloating = placement.mode === 'floating' && anchor !== null;
  const style: CSSProperties | undefined = isFloating ? { left: `${placement.left}px`, top: `${placement.top}px` } : undefined;

  return (
    <>
      <div className="sr" role="status" aria-live="polite" aria-atomic="true">{announcement}</div>
      {shown && (
        <aside ref={coachRef} className={coachClasses(isFloating, flowInline, placement.side)} style={style} aria-labelledby="guide-coach-title">
          <div className="guide-coach-head">
            <CompanionIcon kind={guideCompanionKind(skinId)} />
            <h2 id="guide-coach-title">{t.guide.title}</h2>
          </div>
          <CoachBody copy={copy} />
          <CoachActions finished={copy.finished} onOpenTask={onOpenTask} onDismiss={dismissAndReturnFocus} />
        </aside>
      )}
    </>
  );
}
