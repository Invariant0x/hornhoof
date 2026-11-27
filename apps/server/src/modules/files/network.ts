import { rowsOf } from '../../db/result-rows.js';
import { sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import type { Db } from '../../db/client.js';
import { ApiError } from '../../errors.js';
import { keeperAsker } from '../network/via.js';
import { DEFAULT_AREA_BYTES } from './area.js';
import { countedNow, FRESH_MS, keptElsewhere } from './place.js';
import { type Challenge, Proof, sameMac } from './proof.js';
import { namedUnrecorded, SET_ASIDE } from './sweep.js';
import { backupView, takeBackupReport, type BackupView } from './backup.js';

/* How the files of the store go between the company's machines, as the leading app keeps it: what each machine is to
   take, give back or let go of, and what each said it keeps. Which machines keep which file is placed in ./place. Only
   keepers ask, through the peer link. */

/* A machine is given at most this many files to take in one answer, and as many to let go of or send back. */
export const VIEW_FILES = 200;
/* A machine that asks with wait gets its answer as soon as there is something for it, or after this long: within the
   ten seconds a keeper waits for an answer of the app. */
export const VIEW_WAIT_MS = 5_000;
const VIEW_LOOK_MS = 500;
/* A file the leading app missed is asked of the machines that hold it for this long. */
const WANTED_MS = 600_000;
/* How many machines that keep a file the leading machine lacks are asked to send it back at once. */
const WANT_FROM = 2;

type Tx = Pick<Db, 'execute'>;
const listOf = (values: string[]): string => `{${values.join(',')}}`;
const SHA = z.string().regex(/^[0-9a-f]{64}$/);

/* What a machine hears: whether it holds the company's files, the files to take with what their sealed bytes hash to,
   those to let go of, and those the leading app asks it to send back. */
export type FileView = { holds: boolean; hold: { sha256: string; sealedSha256: string; sealedSize: number }[]; drop: string[]; want: string[]; prove: Challenge[]; area: number; backup: BackupView };
/* A census names every file a machine keeps in a span of names, in their order: whatever it was said to keep in that
   span and does not name any more, it lost. The span runs after one name and through another; '' before the first, 'g'
   past the last. */
const Span = z.strictObject({ after: z.union([z.literal(''), SHA]), through: z.union([z.literal('g'), SHA]) });
/* What a machine says of its backup folder, as its view had a part of the backup: a keeper from before says none. */
const BackupReport = z.strictObject({ held: z.array(SHA).max(VIEW_FILES * 5), dropped: z.array(SHA).max(VIEW_FILES * 5), span: Span.optional() });
const Report = z.strictObject({
  held: z.array(SHA).max(VIEW_FILES * 5),
  dropped: z.array(SHA).max(VIEW_FILES * 5),
  span: Span.optional(),
  proofs: z.array(Proof).max(VIEW_FILES).optional(),
  backup: BackupReport.optional(),
});
export type FileReport = z.infer<typeof Report>;

/* Whether a machine keeps files of the store: it is one of the company's with a keeper and an area more than none. */
export async function keepsFiles(db: Tx, machineId: string): Promise<boolean> {
  const [row] = rowsOf<{ keeps: boolean }>(
    await db.execute(sql`SELECT EXISTS (SELECT 1 FROM machines m JOIN people p ON p.id = m.person_id WHERE m.id = ${machineId} AND m.revoked_at IS NULL
      AND m.network_id IS NOT NULL AND m.role IN ('data', 'worker') AND p.status = 'active' AND coalesce(m.file_store_limit_bytes, ${DEFAULT_AREA_BYTES}) > 0) AS keeps`),
  );
  return Boolean(row?.keeps);
}

/* Whether a machine is picked to keep a file, so the leading keeper gives it. */
export async function pickedFor(db: Tx, machineId: string, sha256: string): Promise<boolean> {
  const [row] = rowsOf<{ picked: boolean }>(await db.execute(sql`SELECT EXISTS (SELECT 1 FROM net.file_targets WHERE sha256 = ${sha256} AND machine_id = ${machineId}) AS picked`));
  return Boolean(row?.picked) && (await keepsFiles(db, machineId));
}

/* What a machine is to show it keeps: the copies it said it keeps of files it was given, which count only once it showed
   the slices the leading keeper asks of each. */
async function proveOf(db: Tx, machineId: string): Promise<Challenge[]> {
  return rowsOf<{ sha256: string; nonce: string; slices: Challenge['slices'] }>(
    await db.execute(sql`SELECT g.sha256, g.nonce, g.slices FROM net.file_gives g JOIN net.file_copies c ON c.sha256 = g.sha256 AND c.machine_id = g.machine_id
      WHERE g.machine_id = ${machineId} AND NOT c.verified ORDER BY g.at, g.sha256 LIMIT ${VIEW_FILES}`),
  ).map(row => ({ sha256: row.sha256, nonce: row.nonce, slices: row.slices }));
}

/* What a machine showed it keeps: a copy whose slices hash to what the leading keeper kept counts from now on; one that
   does not is no copy, and the machine fetches the file again as one it is picked for. */
async function takeProofs(db: Tx, machineId: string, proofs: Proof[]): Promise<void> {
  for (const proof of proofs) {
    const [kept] = rowsOf<{ mac: string }>(await db.execute(sql`SELECT mac FROM net.file_gives WHERE sha256 = ${proof.sha256} AND machine_id = ${machineId} AND nonce = ${proof.nonce}`));
    if (!kept) continue;
    if (sameMac(proof.mac, kept.mac)) await db.execute(sql`UPDATE net.file_copies SET verified = true WHERE sha256 = ${proof.sha256} AND machine_id = ${machineId}`);
    else await db.execute(sql`DELETE FROM net.file_copies WHERE sha256 = ${proof.sha256} AND machine_id = ${machineId} AND NOT verified`);
    await db.execute(sql`DELETE FROM net.file_gives WHERE sha256 = ${proof.sha256} AND machine_id = ${machineId}`);
  }
}

/* What a machine is to do with the files now: fetch those it is picked for, let go of those whose time came and those
   it is not picked for that the copies wanted keep elsewhere, and send back those the leading app missed. */
export async function fileView(db: Tx, machineId: string, now = new Date(), leader: string | null = null): Promise<FileView> {
  const holds = await keepsFiles(db, machineId);
  const hold = holds
    ? rowsOf<{ sha256: string; sealed_sha256: string; sealed_size: string }>(
        await db.execute(sql`SELECT f.sha256, f.sealed_sha256, f.sealed_size FROM net.file_targets t JOIN net.files f ON f.sha256 = t.sha256
          WHERE t.machine_id = ${machineId} AND f.drop_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM net.file_copies c WHERE c.sha256 = f.sha256 AND c.machine_id = ${machineId})
          ORDER BY t.at, f.sha256 LIMIT ${VIEW_FILES}`),
      ).map(row => ({ sha256: row.sha256, sealedSha256: row.sealed_sha256, sealedSize: Number(row.sealed_size) }))
    : [];
  const { ids, wanted } = await countedNow(db, leader, now);
  const due = sql`f.drop_at <= ${now.toISOString()}::timestamptz`;
  const notPicked = sql`(NOT EXISTS (SELECT 1 FROM net.file_targets t WHERE t.sha256 = c.sha256 AND t.machine_id = ${machineId})
    AND ${keptElsewhere(sql`c.sha256`, machineId, ids)} >= ${Math.max(1, wanted)})`;
  const drop = rowsOf<{ sha256: string }>(
    await db.execute(sql`SELECT c.sha256 FROM net.file_copies c JOIN net.files f ON f.sha256 = c.sha256 WHERE c.machine_id = ${machineId}
      AND (${due} OR ${notPicked}) ORDER BY c.sha256 LIMIT ${VIEW_FILES}`),
  ).map(row => row.sha256);
  /* A file the leading machine lacks is asked of two machines that keep it and are online, the first by id, not of all. */
  const fresh = sql`${new Date(now.getTime() - FRESH_MS).toISOString()}::timestamptz`;
  const want = rowsOf<{ sha256: string }>(
    await db.execute(sql`SELECT c.sha256 FROM net.file_copies c JOIN net.files f ON f.sha256 = c.sha256 WHERE c.machine_id = ${machineId}
      AND f.drop_at IS NULL AND f.wanted_at > ${new Date(now.getTime() - WANTED_MS).toISOString()}::timestamptz
      AND EXISTS (SELECT 1 FROM machines m WHERE m.id = c.machine_id AND m.report_at > ${fresh})
      AND c.verified AND (SELECT count(*) FROM net.file_copies o JOIN machines m ON m.id = o.machine_id WHERE o.sha256 = c.sha256 AND o.machine_id < c.machine_id
        AND o.verified AND o.machine_id IS DISTINCT FROM ${leader} AND m.report_at > ${fresh}) < ${WANT_FROM}
      ORDER BY f.wanted_at LIMIT ${VIEW_FILES}`),
  ).map(row => row.sha256);
  /* The area its owner gives the files, so it takes none past it whatever it is picked for. */
  const [limit] = rowsOf<{ area: string | number }>(await db.execute(sql`SELECT coalesce(file_store_limit_bytes, ${DEFAULT_AREA_BYTES}) AS area FROM machines WHERE id = ${machineId}`));
  return { holds, hold, drop, want, prove: await proveOf(db, machineId), area: limit ? Number(limit.area) : 0, backup: await backupView(db, machineId, leader) };
}

/* The files a machine says it keeps that count as its copies: those it was given, or any for a machine of the data,
   which keeps the database too. The rest it is to fetch again, so it is given them. */
async function givenOf(db: Tx, machineId: string, held: string[]): Promise<{ counted: string[]; again: string[]; data: boolean }> {
  const data = rowsOf<{ data: boolean }>(await db.execute(sql`SELECT EXISTS (SELECT 1 FROM machines m WHERE m.id = ${machineId} AND m.role = 'data' AND m.revoked_at IS NULL) AS data`))[0]?.data === true;
  const rows = rowsOf<{ sha256: string; picked: boolean; given: boolean }>(
    await db.execute(sql`SELECT f.sha256, EXISTS (SELECT 1 FROM net.file_targets t WHERE t.sha256 = f.sha256 AND t.machine_id = ${machineId}) AS picked,
      (${data} OR EXISTS (SELECT 1 FROM net.file_gives g WHERE g.sha256 = f.sha256 AND g.machine_id = ${machineId})) AS given
      FROM net.files f WHERE f.sha256 = ANY(${listOf(held)}::text[])
      AND NOT EXISTS (SELECT 1 FROM net.file_copies c WHERE c.sha256 = f.sha256 AND c.machine_id = ${machineId})`),
  );
  return { counted: rows.filter(row => row.given).map(row => row.sha256), again: rows.filter(row => row.picked && !row.given).map(row => row.sha256), data };
}

/* What a machine said it keeps now and what it let go of. A file let go of by every machine that kept it, once it is to
   go, is no file of the store any more. The answer names the files it keeps that no record knows, which it lets go of
   once they are a day old; those the leading app lacks, to send; those it is to fetch again before they count; and the
   slices it is to show of the copies it was given, so they count. */
export async function takeReport(db: Tx, machineId: string, report: FileReport): Promise<{ unknown: string[]; send: string[]; again: string[]; prove: Challenge[]; backupUnknown?: string[] }> {
  let unknown: string[] = [];
  let send: string[] = [];
  let again: string[] = [];
  if (report.proofs?.length) await takeProofs(db, machineId, report.proofs);
  if (report.span) {
    const { after, through } = report.span;
    await db.execute(sql`DELETE FROM net.file_copies WHERE machine_id = ${machineId} AND sha256 COLLATE "C" > ${after} AND sha256 COLLATE "C" <= ${through}
      AND NOT (sha256 = ANY(${listOf(report.held)}::text[]))`);
  }
  if (report.held.length) {
    const holds = await keepsFiles(db, machineId);
    const known = rowsOf<{ sha256: string }>(await db.execute(sql`SELECT sha256 FROM net.files WHERE sha256 = ANY(${listOf(report.held)}::text[])`)).map(row => row.sha256);
    if (holds && known.length) {
      const given = await givenOf(db, machineId, known);
      /* A data machine keeps the database and its key, and counts at once; another machine's copy counts once it showed
         it keeps the bytes, as the answer asks. */
      if (given.counted.length) {
        await db.execute(sql`INSERT INTO net.file_copies (sha256, machine_id, verified) SELECT unnest(${listOf(given.counted)}::text[]), ${machineId}::uuid, ${given.data} ON CONFLICT DO NOTHING`);
        if (given.data) await db.execute(sql`DELETE FROM net.file_gives WHERE machine_id = ${machineId} AND sha256 = ANY(${listOf(given.counted)}::text[])`);
      }
      again = given.again;
    }
    /* A content a row names, as a merge brings it or keeps refused, and no record describes, is no stranger: it is to
       come here. */
    const strangers = report.held.filter(sha256 => !known.includes(sha256));
    const named = strangers.length
      ? rowsOf<{ sha256: string }>(await db.execute(namedUnrecorded(sql`n.sha256 = ANY(${listOf(strangers)}::text[])`))).map(row => row.sha256)
      : [];
    /* While a database set aside may be merged back, a file no record here knows may be one its rows name: none is
       unknown then, so no machine lets it go. */
    const aside = rowsOf<{ aside: boolean }>(await db.execute(sql`SELECT ${SET_ASIDE} AS aside`))[0]?.aside === true;
    unknown = aside ? [] : strangers.filter(sha256 => !named.includes(sha256));
    send = holds ? named : [];
    if (send.length)
      await db.execute(sql`INSERT INTO net.file_wants (sha256, machine_id, until) SELECT unnest(${listOf(send)}::text[]), ${machineId}::uuid, ${new Date(Date.now() + WANTED_MS).toISOString()}::timestamptz
        ON CONFLICT (sha256, machine_id) DO UPDATE SET until = EXCLUDED.until`);
  }
  if (report.dropped.length) {
    await db.execute(sql`DELETE FROM net.file_copies WHERE machine_id = ${machineId} AND sha256 = ANY(${listOf(report.dropped)}::text[])`);
    await db.execute(sql`DELETE FROM net.files f WHERE f.sha256 = ANY(${listOf(report.dropped)}::text[]) AND f.drop_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM net.file_copies c WHERE c.sha256 = f.sha256)`);
  }
  const backupUnknown = report.backup ? await takeBackupReport(db, machineId, report.backup) : undefined;
  return { unknown, send, again, prove: await proveOf(db, machineId), ...(backupUnknown ? { backupUnknown } : {}) };
}

const hasWork = (view: FileView): boolean =>
  view.hold.length > 0 || view.drop.length > 0 || view.want.length > 0 || view.prove.length > 0 || view.backup.hold.length > 0 || view.backup.drop.length > 0 || view.backup.give.length > 0;
const Ask = z.object({ wait: z.enum(['0', '1']).optional() });

export function fileNetworkRoutes(app: FastifyInstance, ctx: Ctx): void {
  const { db, config } = ctx;
  /* Another machine's keeper, through the peer link, while this app leads. */
  const peerKeeper = async (req: FastifyRequest): Promise<string> => {
    const who = await keeperAsker(req, config);
    if (!who || who.own) throw new ApiError(403, 'forbidden', "Only another machine's keeper may ask this.", 'not_keeper');
    if (ctx.mode.current() !== 'lead') throw new ApiError(503, 'unavailable', 'This server does not lead the company now.');
    return who.machine;
  };

  app.get('/api/network/files', { logLevel: 'silent' }, async req => {
    const machine = await peerKeeper(req);
    const wait = Ask.parse(req.query).wait === '1';
    const leader = await ctx.files.machineId(db);
    let view = await fileView(db, machine, new Date(), leader);
    for (let waited = 0; wait && !hasWork(view) && waited < VIEW_WAIT_MS; waited += VIEW_LOOK_MS) {
      await new Promise(resolve => setTimeout(resolve, VIEW_LOOK_MS));
      view = await fileView(db, machine, new Date(), leader);
    }
    return view;
  });

  app.post('/api/network/files', { logLevel: 'silent', bodyLimit: 2 * 1024 * 1024 }, async (req, reply) => {
    const machine = await peerKeeper(req);
    return reply.send(await takeReport(db, machine, Report.parse(req.body)));
  });
}
