import { useEffect, useState } from 'react';

export type Point = [number, number];

export const toD = (pts: Point[]) => pts.map((p, i) => `${i ? 'L' : 'M'} ${p[0]} ${p[1]}`).join(' ');

const lengthOf = (pts: Point[]) => pts.slice(1).reduce((sum, p, i) => sum + Math.hypot(p[0] - pts[i]![0], p[1] - pts[i]![1]), 0);

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
  tone?: 'c' | 'a' | 'k';
  r?: number;
};

/* A dot that keeps running along a path while something real is going on. */
export function Pulse({ pts, speed, bounce = false, tone = 'c', r = 3 }: PulseProps) {
  const dur = (lengthOf(pts) * (bounce ? 2 : 1)) / speed;
  return (
    <circle className={`pt ${tone}`} r={r}>
      <animateMotion
        path={toD(pts)}
        dur={`${dur.toFixed(2)}s`}
        repeatCount="indefinite"
        {...(bounce ? { keyPoints: '0;1;0', keyTimes: '0;0.5;1', calcMode: 'linear' } : {})}
      />
    </circle>
  );
}
