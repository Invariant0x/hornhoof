import type { Duplex, Readable } from 'node:stream';

/* Keep the stream's idle limit on the same scheduler as the keeper's other deadlines. Listening for data must not
   start consuming its body before the caller receives it. */
export function streamDeadline(stream: Duplex, ms: number, expire: () => void, body?: Readable): void {
  if (ms === 0) return;
  let timer: NodeJS.Timeout;
  const restart = () => {
    clearTimeout(timer);
    timer = setTimeout(expire, ms);
    timer.unref();
  };
  stream.on('data', restart);
  stream.pause();
  stream.once('response', restart);
  body?.on('data', restart);
  stream.once('close', () => {
    clearTimeout(timer);
    stream.off('data', restart);
    stream.off('response', restart);
    body?.off('data', restart);
  });
  restart();
}
