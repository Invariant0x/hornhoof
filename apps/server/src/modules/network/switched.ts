import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../../app.js';
import { requirePerson } from '../../auth/session.js';
import { enqueueTurn } from '../conversation/queue.js';
import { NoSubscription, orchestratorOf } from '../conversation/turn-records.js';
import { queryOf } from '../merge/leader.js';
import { findThisMachine } from './store.js';

/* For a day after the server moved, the app says where the company runs now and how it got there; and after a
   takeover, or the CEO's choice of a copy, it has the orchestrator tell the CEO so, once. */

const SHOWN_MS = 24 * 3_600_000;

export type Switched = { id: string; kind: 'planned' | 'takeover' | 'ceo'; reason: string | null; from: string; to: string; heard: string | null; reach: string | null; at: string };

type Newest = {
  id: string; kind: Switched['kind']; reason: string | null; from_host: string | null; to_host: string | null; to_id: string; company: string | null;
  heard: Date | string | null; reach: Date | string | null; at: Date | string; noted: Date | string | null;
};

const NEWEST = `SELECT h.id::text AS id, h.kind, h.reason, f.hostname AS from_host, t.hostname AS to_host, h.to_machine_id::text AS to_id, t.company_id::text AS company,
    h.heard_at AS heard, h.reach, h.at, h.noted_at AS noted
  FROM net.handovers h LEFT JOIN public.machines f ON f.id = h.from_machine_id LEFT JOIN public.machines t ON t.id = h.to_machine_id`;

const iso = (at: Date | string | null): string | null => (at === null ? null : new Date(at).toISOString());
/* A machine that never said its name is one all the same. */
const named = (host: string | null): string => host || 'a machine with no name';

export function switchedRoutes(app: FastifyInstance, ctx: Ctx): void {
  /* Where the company moves is the keeper's to say, at its own doors. Where no keeper stands before the app, nothing
     ever moves, and the page that asks gets that answer here. */
  app.get('/api/network/switch', async req => {
    await requirePerson(req, ctx.db);
    return { self: null, moving: false, from: null, to: null, since: null, cut: false, question: false };
  });

  /* The newest move of the server, while it is no older than a day. */
  app.get('/api/network/switched', async (req): Promise<{ switched: Switched | null }> => {
    await requirePerson(req, ctx.db);
    const [row] = await queryOf(ctx.db)<Newest>(`${NEWEST} ORDER BY h.at DESC, h.id DESC LIMIT 1`);
    if (!row || Date.now() - new Date(row.at).getTime() > SHOWN_MS) return { switched: null };
    return { switched: { id: row.id, kind: row.kind, reason: row.reason, from: named(row.from_host), to: named(row.to_host), heard: iso(row.heard), reach: iso(row.reach), at: iso(row.at)! } };
  });
}

/* A time as the orchestrator reads it: UTC, to the minute. */
const timeWords = (at: Date | string | null): string => (at === null ? 'a time nobody wrote down' : `${new Date(at).toISOString().slice(0, 16).replace('T', ' ')} UTC`);

function promptOf(row: Newest): string {
  const [from, to] = [named(row.from_host), named(row.to_host)];
  if (row.kind === 'ceo') {
    return `Hornhoof runs on ${to} now, from what it had at ${timeWords(row.reach)}, as the CEO chose after ${from} stopped answering at ${timeWords(row.heard)}. `
      + `Tell the CEO so in your window in a sentence or two, and that what ${from} did after ${timeWords(row.reach)} comes back, merged, once ${from} is back.`;
  }
  /* A leader whose disk filled up said so itself and gave the server up: it did not stop answering. */
  const why = row.reason === 'disk_full' ? `the disk of ${from} filled up, so it gave the server up` : `${from} stopped answering at ${timeWords(row.heard)}`;
  return `Hornhoof runs on ${to} now: ${why}, and ${to} had every change it confirmed. `
    + `Tell the CEO so in your window in a sentence or two, and that jobs ${from} started that still run carry on; their results arrive once ${from} is back and merged.`;
}

/* At the app's first lead on a machine that took the server over, or that the CEO chose to go on from: the
   orchestrator is told once, and tells the CEO in his window. The mark is written first, so a second start never tells
   it twice; a company whose orchestrator has no plan to run on hears nothing. */
export async function noteSwitch(ctx: Ctx): Promise<void> {
  const own = await findThisMachine(ctx.db, ctx.config);
  if (!own) return;
  const q = queryOf(ctx.db);
  const [row] = await q<Newest>(`${NEWEST} WHERE h.kind IN ('takeover', 'ceo') AND h.at > now() - interval '24 hours' ORDER BY h.at DESC, h.id DESC LIMIT 1`);
  if (!row || row.to_id !== own.id || row.noted !== null || !row.company) return;
  const [marked] = await q<{ id: string }>('UPDATE net.handovers SET noted_at = now() WHERE id = $1::uuid AND noted_at IS NULL RETURNING id::text AS id', [row.id]);
  if (!marked) return;
  const orchestrator = await orchestratorOf(ctx, row.company);
  if (!orchestrator) return;
  const text = promptOf(row);
  const message = { personId: null, text, notification: { source: 'machine' as const, tasks: [], detail: { en: named(row.to_host), ru: row.to_host || 'машина без имени' } } };
  await enqueueTurn(ctx, { companyId: row.company, agentId: orchestrator.id, prompt: text, createdBy: null, answersCeo: true, message }).catch((err: unknown) => {
    if (!(err instanceof NoSubscription)) throw err;
  });
}
