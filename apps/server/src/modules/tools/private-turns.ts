import { ToolPrivacy } from '@hornhoof/protocol';
import type { Db } from '../../db/client.js';

/* No value is written or recovered from replay. Every ending path drops the turn's values. */
const turns = new WeakMap<Db, Map<string, ToolPrivacy>>();
export const privateTurn = (db: Db, jobId: string): ToolPrivacy | undefined => turns.get(db)?.get(jobId);
export const forgetPrivateTurn = (db: Db, jobId: string): void => { turns.get(db)?.delete(jobId); };

export function rememberPrivateTurn(db: Db, jobId: string): ToolPrivacy {
  let state = privateTurn(db, jobId);
  if (!state) {
    state = new ToolPrivacy();
    if (!turns.has(db)) turns.set(db, new Map());
    turns.get(db)!.set(jobId, state);
  }
  return state;
}
