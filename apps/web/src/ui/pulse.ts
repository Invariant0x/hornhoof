/* The breath of the tracker's working-now dots: the product's dbreathe, 2.6 s (style book 1.6, section 4 "Working now";
   Design #1628, spec sections 5 and 6). It equals --tracker-pulse-time. */
export const PULSE_MS = 2600;

/* A working-now dot's breath: dbreathe on the core's top layer, ::after, where an engine names the layer at all. */
function isPulse(animation: Animation): boolean {
  const layer = (animation.effect as KeyframeEffect | null)?.pseudoElement ?? '::after';
  return (animation as CSSAnimation).animationName === 'dbreathe' && layer === '::after';
}

/* Sets a dot's breath to the one phase of every working-now dot: the wall clock modulo 2.6 s, so a dot that comes later, a
   second list or a second window breathes with the others, and a new render restarts nothing. Where the page runs no
   animations, as in jsdom, there is nothing to set. origin: the wall clock's time at the page's timeline zero. */
export function syncPulses(dot: Element, origin = performance.timeOrigin): void {
  const start = -(origin % PULSE_MS);
  for (const animation of dot.getAnimations?.({ subtree: true }) ?? []) if (isPulse(animation) && animation.startTime !== start) animation.startTime = start;
}
