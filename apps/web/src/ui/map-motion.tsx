import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useLight } from '../guard';
import { mergeGaps, type Gap, type WireGap } from '../map-people-bridges';
import type { CutShape } from '../skins/roles';
import { lookOf, skinsState, subscribeSkins } from '../skins/store';
import { lengthOf, motionSpeed, pulseSeconds, SIGNALS, toD, type Point } from './wires';

type GapRange = Gap;
type DashSegment = { x: number; y: number; len: number; deg: number; offset: number };

const pausedByMap = new WeakSet<Animation>();

function pauseSvg(svg: SVGSVGElement): () => void {
  svg.pauseAnimations?.();
  return () => svg.unpauseAnimations?.();
}

function pauseRunning(anims: Animation[]): Animation[] {
  const held = anims.filter(a => a.playState === 'running');
  for (const anim of held) {
    anim.pause();
    pausedByMap.add(anim);
  }
  return held;
}

function resumeHeld(anims: Iterable<Animation>): void {
  for (const anim of anims) {
    if (pausedByMap.delete(anim)) anim.play();
  }
}

/* Pauses hidden SVG timelines and running Web Animations while a department covers the map, and resumes them on return. */
export function pauseMapAnimations(root: HTMLElement): () => void {
  const resumeSvg = [...root.querySelectorAll('svg')].map(pauseSvg);
  const held = pauseRunning(root.getAnimations?.({ subtree: true }) ?? []);
  return () => {
    for (const fn of resumeSvg) fn();
    resumeHeld(new Set([...held, ...(root.getAnimations?.({ subtree: true }) ?? [])]));
  };
}

function overlapOnAxis(a0: number, a1: number, g0: number, g1: number): [number, number] | null {
  const dir = a1 > a0 ? 1 : -1;
  const span = Math.abs(a1 - a0);
  const d0 = (g0 - a0) * dir;
  const d1 = (g1 - a0) * dir;
  const lo = Math.max(0, Math.min(d0, d1));
  const hi = Math.min(span, Math.max(d0, d1));
  return hi > lo ? [lo, hi] : null;
}

function segmentGap(a: Point, b: Point, ga: Point, gb: Point): [number, number] | null {
  if (a[1] === b[1] && ga[1] === a[1] && gb[1] === a[1] && a[0] !== b[0]) return overlapOnAxis(a[0], b[0], ga[0], gb[0]);
  if (a[0] === b[0] && ga[0] === a[0] && gb[0] === a[0] && a[1] !== b[1]) return overlapOnAxis(a[1], b[1], ga[1], gb[1]);
  return null;
}

/* Bridge gaps along a polyline in cumulative path units, regardless of which direction the signal runs. */
export function gapsAlongPath(pts: Point[], gaps: WireGap[]): GapRange[] {
  if (!gaps.length || pts.length < 2) return [];
  const found: GapRange[] = [];
  let offset = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]!, b = pts[i + 1]!;
    for (const gap of gaps) {
      for (let j = 0; j < gap.pts.length - 1; j++) {
        const hit = segmentGap(a, b, gap.pts[j]!, gap.pts[j + 1]!);
        if (hit) found.push({ start: offset + hit[0], end: offset + hit[1] });
      }
    }
    offset += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  return mergeGaps(found);
}

function dedupePoints(pts: Point[]): Point[] {
  return pts.filter((p, i) => i === 0 || p[0] !== pts[i - 1]![0] || p[1] !== pts[i - 1]![1]);
}

function pointAtDistance(pts: Point[], target: number): Point {
  let along = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]!, b = pts[i + 1]!;
    const seg = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (along + seg >= target || i === pts.length - 2) {
      const d = Math.min(seg, Math.max(0, target - along));
      return [a[0] + (d * (b[0] - a[0])) / seg, a[1] + (d * (b[1] - a[1])) / seg];
    }
    along += seg;
  }
  return pts[0]!;
}

const translateFrame = (p: Point, offset: number, opacity?: number): Keyframe =>
  opacity === undefined
    ? { transform: `translate(${p[0]}px, ${p[1]}px)`, offset }
    : { transform: `translate(${p[0]}px, ${p[1]}px)`, opacity, offset };

function gappedKeyframes(pts: Point[], total: number, ranges: GapRange[]): Keyframe[] {
  const stops: { at: number; opacity: number }[] = [];
  const inside = (at: number) => ranges.some(r => at > r.start && at < r.end);
  let along = 0;
  for (let i = 0; i < pts.length; i++) {
    if (i > 0) along += Math.hypot(pts[i]![0] - pts[i - 1]![0], pts[i]![1] - pts[i - 1]![1]);
    stops.push({ at: along, opacity: inside(along) ? 0 : 1 });
  }
  for (const r of ranges) {
    const s = Math.max(0, Math.min(total, r.start));
    const e = Math.max(0, Math.min(total, r.end));
    if (s > 0.02) stops.push({ at: s - 0.01, opacity: 1 });
    stops.push({ at: s, opacity: 0 }, { at: e, opacity: 0 });
    if (e < total - 0.02) stops.push({ at: e + 0.01, opacity: 1 });
  }
  stops.sort((a, b) => a.at - b.at);
  return stops.map(s => translateFrame(pointAtDistance(pts, s.at), s.at / total, s.opacity));
}

/* Composited translate keyframes along a polyline, stepping opacity to 0 across any wire bridge gaps. */
export function pulseKeyframes(pts: Point[], gaps?: WireGap[]): Keyframe[] {
  const clean = dedupePoints(pts);
  if (!clean.length) return [];
  if (clean.length === 1) return [translateFrame(clean[0]!, 0), translateFrame(clean[0]!, 1)];
  const total = lengthOf(clean);
  const ranges = gaps?.length ? gapsAlongPath(clean, gaps) : [];
  if (ranges.length) return gappedKeyframes(clean, total, ranges);
  let along = 0;
  return clean.map((p, i) => {
    if (i > 0) along += Math.hypot(p[0] - clean[i - 1]![0], p[1] - clean[i - 1]![1]);
    return translateFrame(p, i === clean.length - 1 ? 1 : along / total);
  });
}

function clearSubIntervals(start: number, end: number, ranges: GapRange[]): GapRange[] {
  const pieces: GapRange[] = [];
  let cursor = start;
  for (const r of ranges) {
    if (r.end <= cursor || r.start >= end) continue;
    if (r.start > cursor) pieces.push({ start: cursor, end: Math.min(end, r.start) });
    cursor = Math.max(cursor, r.end);
  }
  if (cursor < end) pieces.push({ start: cursor, end });
  return pieces.filter(p => p.end - p.start > 0.5);
}

/* Straight dash strips along a polyline, preserving dash phase across corners and leaving bridge gaps clear. */
export function dashSegments(pts: Point[], gaps?: WireGap[]): DashSegment[] {
  const clean = dedupePoints(pts);
  if (clean.length < 2) return [];
  const ranges = gaps?.length ? gapsAlongPath(clean, gaps) : [];
  const out: DashSegment[] = [];
  let segStart = 0;
  for (let i = 0; i < clean.length - 1; i++) {
    const a = clean[i]!, b = clean[i + 1]!;
    const segLen = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const deg = (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;
    for (const part of clearSubIntervals(segStart, segStart + segLen, ranges)) {
      const d = part.start - segStart;
      out.push({
        x: a[0] + (d * (b[0] - a[0])) / segLen,
        y: a[1] + (d * (b[1] - a[1])) / segLen,
        len: part.end - part.start,
        deg,
        offset: part.start,
      });
    }
    segStart += segLen;
  }
  return out;
}

const CORNER_SPAN = 22;

function formatVertices(pts: Point[], corner: boolean): string {
  const all = corner ? [...pts, [0.5, CORNER_SPAN] as Point] : pts;
  return all.map(p => `${p[0]},${p[1]}`).join(' ');
}

function steppedVertices(w: number, h: number, s: number, x0: number): Point[] {
  return [
    [x0, 0.5], [w - 2 * s - 0.5, 0.5], [w - 2 * s - 0.5, s + 0.5], [w - s - 0.5, s + 0.5],
    [w - s - 0.5, 2 * s + 0.5], [w - 0.5, 2 * s + 0.5], [w - 0.5, h - 0.5], [2 * s + 0.5, h - 0.5],
    [2 * s + 0.5, h - s - 0.5], [s + 0.5, h - s - 0.5], [s + 0.5, h - 2 * s - 0.5], [0.5, h - 2 * s - 0.5],
  ];
}

/* 1px border vertices matching .edge in square, bevel and pixel-stepped skins; corner leaves the 22px cyan bracket clear. */
export function framePolygonPoints(w: number, h: number, cut: number, cutK: number, shape: CutShape, corner = false): string {
  const x0 = corner ? CORNER_SPAN : 0.5;
  if (shape === 'steps' && cutK > 0) return formatVertices(steppedVertices(w, h, 2 * cutK, x0), corner);
  const c = cut * cutK;
  if (c <= 0) return formatVertices([[x0, 0.5], [w - 0.5, 0.5], [w - 0.5, h - 0.5], [0.5, h - 0.5]], corner);
  return formatVertices([[x0, 0.5], [w - c - 0.2, 0.5], [w - 0.5, c + 0.2], [w - 0.5, h - 0.5], [c + 0.2, h - 0.5], [0.5, h - c - 0.2]], corner);
}

function useSkinShape(): { cutK: number; shape: CutShape } {
  const [, bump] = useState(0);
  useEffect(() => subscribeSkins(() => bump(n => n + 1)), []);
  const look = lookOf(skinsState().active)!;
  return { cutK: look.cut, shape: look.shape };
}

/* Composited root-SVG border overlay that breathes or flashes via opacity outside .edge's polygon clip-path. */
export function FrameBreathe({ w, h, cut, corner = false }: { w: number; h: number; cut: number; corner?: boolean }) {
  const light = useLight();
  const { cutK, shape } = useSkinShape();
  if (light) return null;
  const points = framePolygonPoints(w, h, cut, cutK, shape, corner);
  return (
    <svg className="frame-breathe" viewBox={`0 0 ${w} ${h}`} aria-hidden="true">
      {corner ? <polyline points={points} /> : <polygon points={points} />}
    </svg>
  );
}

export function pulseTiming(baseDur: number, bounce: boolean, once: boolean, phase: number): KeyframeAnimationOptions {
  return {
    duration: bounce ? (baseDur * 1000) / 2 : baseDur * 1000,
    iterations: once ? 1 : Infinity,
    direction: bounce ? 'alternate' : 'normal',
    easing: 'linear',
    fill: once ? 'forwards' : 'none',
    delay: -phase * baseDur * 1000,
  };
}

function startPulse(el: SVGSVGElement | null, pts: Point[], speed: number, bounce: boolean, once: boolean, phase: number, gaps?: WireGap[]): Animation | null {
  const baseDur = pulseSeconds(pts, speed, bounce);
  const frames = baseDur > 0 ? pulseKeyframes(pts, gaps) : [];
  if (!el?.animate || frames.length < 2) return null;
  const anim = el.animate(frames, pulseTiming(baseDur, bounce, once, phase));
  if (el.closest('[inert]')) {
    anim.pause();
    pausedByMap.add(anim);
  }
  return anim;
}

function syncPlaybackRate(anim: Animation, rate: number): void {
  if (rate <= 0 || anim.playbackRate === rate) return;
  if (anim.updatePlaybackRate) anim.updatePlaybackRate(rate);
  else anim.playbackRate = rate;
}

type MapPulseProps = {
  pts: Point[];
  speed: number;
  bounce?: boolean;
  once?: boolean;
  tone?: 'c' | 'a' | 'k';
  r?: number;
  phase?: number;
  gaps?: WireGap[];
  mask?: string;
};

function pulseDataset(d: string, dur: number, once: boolean, phase: number, bounce: boolean, mask?: string) {
  return {
    'data-path': d,
    'data-dur': dur.toFixed(2),
    'data-once': once ? '1' : undefined,
    'data-phase': phase ? `-${(phase * dur).toFixed(2)}s` : undefined,
    'data-bounce': bounce ? '1' : undefined,
    'data-mask': mask,
  };
}

const gapFingerprint = (gaps?: WireGap[]) => (gaps ? gaps.map(g => toD(g.pts)).join('|') : '');

/* Composited root-SVG dot animated with WAAPI transform: translate(x, y) instead of SVG-internal SMIL animateMotion. */
export function MapPulse({ pts, speed, bounce = false, once = false, tone = 'c', r = 3, phase = 0, gaps, mask }: MapPulseProps) {
  const light = useLight();
  const ref = useRef<SVGSVGElement>(null);
  const runRef = useRef<{ anim: Animation; baseSpeed: number } | null>(null);
  const latest = useRef({ pts, speed, gaps });
  latest.current = { pts, speed, gaps };
  const d = toD(pts);
  const dur = pulseSeconds(pts, speed, bounce);
  const gapKey = gapFingerprint(gaps);

  useLayoutEffect(() => {
    if (light) return;
    const baseSpeed = latest.current.speed;
    const anim = startPulse(ref.current, latest.current.pts, baseSpeed, bounce, once, phase, latest.current.gaps);
    if (!anim) return;
    runRef.current = { anim, baseSpeed };
    return () => {
      runRef.current = null;
      pausedByMap.delete(anim);
      anim.cancel();
    };
  }, [light, d, bounce, once, phase, gapKey]);

  useLayoutEffect(() => {
    if (!light && runRef.current) syncPlaybackRate(runRef.current.anim, speed / runRef.current.baseSpeed);
  }, [light, speed]);

  if (light) return null;
  const half = r + 1;
  const size = half * 2;
  return (
    <svg
      ref={ref}
      className="pt-box"
      width={size}
      height={size}
      viewBox={`${-half} ${-half} ${size} ${size}`}
      aria-hidden="true"
      {...pulseDataset(d, dur, once, phase, bounce, mask)}
      style={{ left: -half, top: -half }}
    >
      <circle className={`pt ${tone}`} r={r} />
    </svg>
  );
}

type MapWayOverlayProps = { pts: Point[]; speed: number; tone: 'c' | 'a'; still: boolean; k: number; gaps?: WireGap[] };

/* Composited running dash strips and two signal dots for an active map way. */
export function MapWayOverlay({ pts, speed, tone, still, k, gaps }: MapWayOverlayProps) {
  const light = useLight();
  if (light) return null;
  const safeK = k > 0 ? k : 1;
  const period = 12 / safeK;
  const halfH = Math.max(4, Math.ceil(4 / safeK));
  const h = halfH * 2;
  const segments = still ? [] : dashSegments(pts, gaps);
  return (
    <>
      {segments.map((seg, i) => {
        const shift = seg.offset % period;
        const svgW = seg.len + 4 * period;
        return (
          <span
            key={i}
            className="way-seg"
            style={{ left: seg.x, top: seg.y - halfH, width: seg.len, height: h, transform: seg.deg ? `rotate(${seg.deg}deg)` : undefined }}
          >
            <svg className="way-run-svg" width={svgW} height={h} viewBox={`0 0 ${svgW} ${h}`} style={{ left: -3 * period }}>
              <line className={`tr live ${tone}`} x1={period - shift} y1={halfH} x2={svgW} y2={halfH} />
            </svg>
          </span>
        );
      })}
      {SIGNALS.map(phase => (
        <MapPulse key={phase} pts={pts} speed={motionSpeed(speed, still)} tone={tone} phase={phase} gaps={gaps} />
      ))}
    </>
  );
}
