import type { ChildProcess } from 'node:child_process';
import { onTestFinished } from 'vitest';

/* The real client keeps its HTTP and process lifetime. Only its deadline clock is driven by the parent. */
export function hookClock(child: ChildProcess) {
  let next = 0;
  const ticks = new Map<number, { resolve(): void; reject(error: Error): void }>();
  const message = (data: unknown) => {
    if (typeof data !== 'object' || data === null) return;
    if ('advanced' in data && typeof data.advanced === 'number') {
      ticks.get(data.advanced)?.resolve();
      ticks.delete(data.advanced);
    }
  };
  const exited = () => {
    /* The final expired deadline may make hh-hook exit before its setImmediate acknowledgment. */
    for (const tick of ticks.values()) tick.resolve();
    ticks.clear();
  };
  child.on('message', message);
  child.on('exit', exited);
  onTestFinished(() => { child.off('message', message); child.off('exit', exited); });
  return {
    advance(ms: number) {
      const id = ++next;
      return new Promise<void>((resolve, reject) => {
        ticks.set(id, { resolve, reject });
        child.send!({ advance: ms, id }, error => { if (error) { ticks.delete(id); reject(error); } });
      });
    },
  };
}
