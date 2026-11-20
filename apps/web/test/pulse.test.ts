import { describe, expect, it } from 'vitest';
import { PULSE_MS, syncPulses } from '../src/ui/pulse';

/* A stand-in for an animation an engine runs on a dot: its name, the layer it runs on and the time it started. */
const animation = (animationName: string, pseudoElement: string | null | undefined, startTime: number | null = 123) => ({ animationName, effect: { pseudoElement }, startTime });

/* Design #1628, section 6: every working-now dot breathes in one phase, the wall clock modulo 2.6 s, so a row that comes
   later, a second list or a second window joins the same breath, and nothing restarts on a new render. */
describe("the working-now dots' one breath", () => {
  it("starts the core's breath at the last whole 2.6 s of the wall clock, and leaves other animations their own time", () => {
    const core = animation('dbreathe', '::after');
    const unnamed = animation('dbreathe', undefined);
    const other = animation('dglow', '::after');
    const below = animation('dbreathe', '::before');
    const dot = { getAnimations: (options?: GetAnimationsOptions) => (options?.subtree ? [core, unnamed, other, below] : []) } as unknown as Element;
    syncPulses(dot, 10_000);
    expect(PULSE_MS).toBe(2600);
    expect([core.startTime, unnamed.startTime, other.startTime, below.startTime]).toEqual([-2200, -2200, 123, 123]);
  });

  it('does nothing where the page runs no animations, as in jsdom', () => {
    expect(() => syncPulses(document.createElement('span'), 10_000)).not.toThrow();
  });
});
