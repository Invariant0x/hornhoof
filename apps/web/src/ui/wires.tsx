import { useEffect, useRef, useState } from 'react';
import { useLight } from '../guard';

export type Point = [number, number];

export const toD = (pts: Point[]) => pts.map((p, i) => `${i ? 'L' : 'M'} ${p[0]} ${p[1]}`).join(' ');

export const lengthOf = (pts: Point[]) => pts.slice(1).reduce((sum, p, i) => sum + Math.hypot(p[0] - pts[i]![0], p[1] - pts[i]![1]), 0);

const REDUCE = '(prefers-reduced-motion: reduce)';

/* True while the person asks the system for less motion. */
export function useReducedMotion(): boolean {
  const [reduce, setReduce] = useState(() => window.matchMedia?.(REDUCE).matches ?? false);
  useEffect(() => {
    const query = window.matchMedia?.(REDUCE);
    if (!query) return;
    const update = () => setReduce(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return reduce;
}

type PulseProps = {
  pts: Point[];
  /* World pixels per second. */
  speed: number;
  /* Goes to the end and back instead of starting over. */
  bounce?: boolean;
  /* Runs one time, for one message; whoever shows it takes it away after pulseSeconds. */
  once?: boolean;
  tone?: 'c' | 'a' | 'k';
  r?: number;
  /* Where on its way a running dot is when it appears, from 0 to 1, so several on one path keep apart. */
  phase?: number;
};

/* Where the signals that keep running along a live way are when they appear: two, half a way apart. */
export const SIGNALS = [0, 0.5];

export const pulseSeconds = (pts: Point[], speed: number, bounce = false) => (lengthOf(pts) * (bounce ? 2 : 1)) / speed;

/* Work still travels under reduced motion, at a quarter of its usual speed. */
export const motionSpeed = (speed: number, reduce: boolean) => reduce ? speed / 4 : speed;

/* Start after the animation is connected to its SVG clock, keeping the initial phase. */
function beginMotion(node: SVGAnimateMotionElement | null): void {
  node?.beginElementAt?.(parseFloat(node.getAttribute('begin') ?? '0'));
}

/* A dot that runs along a path while something real is going on, or once for one message. */
export function Pulse({ pts, speed, bounce = false, once = false, tone = 'c', r = 3, phase = 0 }: PulseProps) {
  const dur = pulseSeconds(pts, speed, bounce);
  const animation = useRef<SVGAnimateMotionElement>(null);
  useEffect(() => { beginMotion(animation.current); }, []);
  /* A page the guard turned light moves nothing: the way itself still shows where work goes. */
  if (useLight()) return null;
  return (
    <circle className={`pt ${tone}`} r={r}>
      <animateMotion
        ref={animation}
        path={toD(pts)}
        dur={`${dur.toFixed(2)}s`}
        repeatCount={once ? '1' : 'indefinite'}
        {...(phase ? { begin: `-${(phase * dur).toFixed(2)}s` } : {})}
        fill={once ? 'freeze' : 'remove'}
        {...(bounce ? { keyPoints: '0;1;0', keyTimes: '0;0.5;1', calcMode: 'linear' } : {})}
      />
    </circle>
  );
}

type LiveWayProps = { pts: Point[]; speed: number; tone: 'c' | 'a'; still: boolean; data?: Record<`data-${string}`, string> };

/* Two signals carry work along the way; reduced motion slows them while CSS stops the dashes. */
export function LiveWay({ pts, speed, tone, still, data }: LiveWayProps) {
  return (
    <g>
      <path className={`tr live ${tone}`} d={toD(pts)} {...data} />
      {SIGNALS.map(phase => <Pulse key={phase} pts={pts} speed={motionSpeed(speed, still)} tone={tone} phase={phase} />)}
    </g>
  );
}
