import { rateMeter, type Clock } from './guard';

/* What a screen asks for again when the stream says it changed. A few changes a second are each fetched at once, as they
   come, and the newest answer wins. Past that one request is on its way at a time, with one more after it for what came
   meanwhile: a burst of the stream costs a few requests, not one a message. What the stream hands on in the same task as
   the request that just went out, as a burst handed on at once, was said before it and is in its answer. */
type Refetcher = { run(): void; inAnswer(): boolean; forget(): void };

export function refetcher(fetch: () => Promise<unknown>, quiet = 2, windowMs = 1000, now: Clock = Date.now): Refetcher {
  const meter = rateMeter(quiet, windowMs, now);
  let flight = 0;
  let flights = 0;
  let again = false;
  let sameTask = false;
  const run = () => {
    const busy = meter.hit();
    if (flight && busy) {
      again ||= !sameTask;
      return;
    }
    const mine = (flight = ++flights);
    sameTask = true;
    queueMicrotask(() => {
      sameTask = false;
    });
    void fetch().finally(() => {
      if (flight !== mine) return;
      flight = 0;
      if (!again) return;
      again = false;
      run();
    });
  };
  return {
    run,
    inAnswer: () => flight !== 0 && sameTask,
    /* What is on its way is no longer asked for: its end starts nothing, and the next change starts with no burst behind it. */
    forget() {
      flight = 0;
      again = false;
      meter.reset();
    },
  };
}
