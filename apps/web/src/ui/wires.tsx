import { useEffect, useState } from 'react';

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

/* A dot that runs along a path while something real is going on, or once for one message. */
export function Pulse({ pts, speed, bounce = false, once = false, tone = 'c', r = 3, phase = 0 }: PulseProps) {
  const dur = pulseSeconds(pts, speed, bounce);
  return (
    <circle className={`pt ${tone}`} r={r}>
      <animateMotion
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
