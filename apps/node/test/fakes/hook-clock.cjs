/* Only AbortSignal deadlines use logical time; HTTP, ownership and child process exit stay real. */
let now = 0;
const pending = new Set();
AbortSignal.timeout = ms => {
  const controller = new AbortController();
  pending.add({ at: now + ms, controller });
  return controller.signal;
};
process.on('message', ({ advance, id }) => {
  now += advance;
  for (const timer of pending) {
    if (timer.at > now) continue;
    pending.delete(timer);
    timer.controller.abort(new DOMException('The operation timed out', 'TimeoutError'));
  }
  /* Fetch gets a real event-loop turn to process an aborted socket before the parent continues. */
  setImmediate(() => process.send({ advanced: id }));
});
