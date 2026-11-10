/* A node told to go stays connected until Hornhoof has heard it, or Hornhoof keeps the key of a node that is gone. It has
   heard once removed left the outbox, confirmed or sent to a server that confirms nothing, or once it refuses the key,
   which is how a server that took removed and closed the socket answers the next connection. */
export function removalWatch(owed: () => boolean, over: () => void): { start(): void; settle(): void; refused(): void } {
  let waiting = false;
  const end = () => {
    if (!waiting) return;
    waiting = false;
    over();
  };
  const settle = () => {
    if (waiting && !owed()) end();
  };
  return {
    start() {
      waiting = true;
      settle();
    },
    settle,
    refused: end,
  };
}
