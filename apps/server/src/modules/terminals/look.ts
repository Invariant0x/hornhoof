import { TERM_CHUNK } from '@hornhoof/protocol';
import type { WebSocket } from 'ws';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import type { NodeIdentity } from '../nodes/hub.js';
import { CLOSE } from './relay.js';

export const cols = z.coerce.number().int().min(10).max(500);
export const rows = z.coerce.number().int().min(4).max(200);
const FromBrowser = z.discriminatedUnion('type', [
  z.object({ type: z.literal('input'), data: z.string().min(1).max(TERM_CHUNK) }),
  z.object({ type: z.literal('resize'), cols, rows }),
]);
export type BrowserFrame = z.infer<typeof FromBrowser>;

type Close = readonly [number, string];

/* Keys and sizes do not wait for a change of access to be told, nor for the next look. */
const KEYS_LOOK_MS = 1000;

/* An open view goes on only as long as what let it open still holds. It looks on every ping and at once when anyone's access
   changes, and ends with nothing more going out: why says how it ends, or nothing while it may go on. What comes back tells
   whether a frame of the browser may still go to the node. */
export function keepLooking(ctx: Ctx, socket: WebSocket, { termId, node, companyId }: { termId: string; node: NodeIdentity; companyId: string }, why: () => Promise<Close | null>): () => Promise<boolean> {
  let open = true;
  let looked = Date.now();
  const closeOnNode = () => {
    if (ctx.terminals.remove(termId)) ctx.hub.send(node, { type: 'term.close', termId });
  };
  const look = async () => {
    looked = Date.now();
    const close: Close | null = await why().catch((): Close => CLOSE.noAccess);
    if (!close || !open) return;
    open = false;
    closeOnNode();
    socket.close(close[0], close[1]);
  };
  const check = setInterval(() => void look(), ctx.config.streamPingMs);
  const stopLooking = ctx.bus.onAccessChange(companyId, () => void look());
  socket.on('close', () => {
    open = false;
    clearInterval(check);
    stopLooking();
    closeOnNode();
  });
  return async () => {
    if (open && Date.now() - looked >= KEYS_LOOK_MS) await look();
    return open;
  };
}

const parsed = (raw: unknown): unknown => {
  try {
    return JSON.parse(String(raw));
  } catch {
    return null;
  }
};

/* What a browser sends goes on in the order it came, as one frame may wait for what comes before the keys. Anything else is dropped. */
export function followFrames(ctx: Ctx, socket: WebSocket, frame: (data: BrowserFrame) => Promise<void>): void {
  let frames = Promise.resolve();
  socket.on('message', raw => {
    const msg = FromBrowser.safeParse(parsed(raw));
    if (!msg.success) return;
    frames = frames.then(() => frame(msg.data)).catch(err => ctx.log.error({ error: String(err) }, 'What a browser sent to a terminal could not go on.'));
  });
}
