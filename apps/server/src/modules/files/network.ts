import { sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import type { Db } from '../../db/client.js';
import { ApiError } from '../../errors.js';
import { pickHolders } from '../backups/holders.js';
import { keeperAsker } from '../network/via.js';

/* How the files of the store go between the company's machines, as the leading app keeps it: which machines hold them,
   what each is to take, give back or let go of, and what each said it keeps. Only keepers ask, through the peer link. */

/* A machine is given at most this many files to take in one answer, and as many to let go of or send back. */
export const VIEW_FILES = 200;
/* A machine that asks with wait gets its answer as soon as there is something for it, or after this long: within the
   ten seconds a keeper waits for an answer of the app. */
export const VIEW_WAIT_MS = 5_000;
const VIEW_LOOK_MS = 500;
/* A file the leading app missed is asked of the machines that hold it for this long. */
const WANTED_MS = 600_000;
/* A machine that is no holder any more lets a file go once this many holders keep it. */
const KEPT_ELSEWHERE = 2;

const rowsOf = <T>(answer: unknown): T[] => (Array.isArray(answer) ? answer : (answer as { rows: T[] }).rows);
type Tx = Pick<Db, 'execute'>;
const listOf = (values: string[]): string => `{${values.join(',')}}`;
const SHA = z.string().regex(/^[0-9a-f]{64}$/);

/* What a machine hears: whether it holds the company's files, the files to take with what their sealed bytes hash to,
   those to let go of, and those the leading app asks it to send back. */
export type FileView = { holds: boolean; hold: { sha256: string; sealedSha256: string; sealedSize: number }[]; drop: string[]; want: string[] };
/* A census names every file a machine keeps in a span of names, in their order: whatever it was said to keep in that
   span and does not name any more, it lost. The span runs after one name and through another; '' before the first, 'g'
   past the last. */
const Span = z.strictObject({ after: z.union([z.literal(''), SHA]), through: z.union([z.literal('g'), SHA]) });
const Report = z.strictObject({ held: z.array(SHA).max(VIEW_FILES * 5), dropped: z.array(SHA).max(VIEW_FILES * 5), span: Span.optional() });
export type FileReport = z.infer<typeof Report>;

/* The machines that hold the files: every data machine, and those picked as backups are, among the machines that keep
   none of the data, with room for the store as it is. The ones picked before keep their places while they qualify. */
export async function refreshFileHolders(db: Db, now = new Date()): Promise<string[]> {
  const [total] = rowsOf<{ size: string }>(await db.execute(sql`SELECT coalesce(sum(sealed_size), 0) AS size FROM net.files WHERE drop_at IS NULL`));
  const kept = rowsOf<{ machine_id: string }>(await db.execute(sql`SELECT machine_id FROM net.file_holders ORDER BY since, machine_id`)).map(row => row.machine_id);
  const picked = await pickHolders(db, { size: Math.max(1, Number(total?.size ?? 0)), keep: kept, now });
  const gone = kept.filter(id => !picked.includes(id));
  if (gone.length) await db.execute(sql`DELETE FROM net.file_holders WHERE machine_id = ANY(${listOf(gone)}::uuid[])`);
  for (const id of picked.filter(id => !kept.includes(id))) await db.execute(sql`INSERT INTO net.file_holders (machine_id) VALUES (${id}) ON CONFLICT DO NOTHING`);
  return picked;
}

/* Whether a machine is to hold the files: it keeps the data, or it was picked for them. */
export async function holdsFiles(db: Tx, machineId: string): Promise<boolean> {
  const [row] = rowsOf<{ holds: boolean }>(
    await db.execute(sql`SELECT EXISTS (SELECT 1 FROM machines WHERE id = ${machineId} AND role = 'data' AND revoked_at IS NULL)
      OR EXISTS (SELECT 1 FROM net.file_holders WHERE machine_id = ${machineId}) AS holds`),
  );
  return Boolean(row?.holds);
}

/* What a machine is to do with the files now. */
export async function fileView(db: Tx, machineId: string, now = new Date()): Promise<FileView> {
  const holds = await holdsFiles(db, machineId);
  const hold = holds
    ? rowsOf<{ sha256: string; sealed_sha256: string; sealed_size: string }>(
        await db.execute(sql`SELECT f.sha256, f.sealed_sha256, f.sealed_size FROM net.files f WHERE f.drop_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM net.file_copies c WHERE c.sha256 = f.sha256 AND c.machine_id = ${machineId})
          ORDER BY f.made_at, f.sha256 LIMIT ${VIEW_FILES}`),
      ).map(row => ({ sha256: row.sha256, sealedSha256: row.sealed_sha256, sealedSize: Number(row.sealed_size) }))
    : [];
  /* A file goes from a machine once it is to go, or, from one that holds the files no more, once enough others keep it. */
  const drop = rowsOf<{ sha256: string }>(
    await db.execute(sql`SELECT c.sha256 FROM net.file_copies c JOIN net.files f ON f.sha256 = c.sha256 WHERE c.machine_id = ${machineId}
      AND (f.drop_at <= ${now.toISOString()}::timestamptz OR (${!holds} AND (SELECT count(*) FROM net.file_copies o WHERE o.sha256 = c.sha256 AND o.machine_id <> ${machineId}) >= ${KEPT_ELSEWHERE}))
      ORDER BY c.sha256 LIMIT ${VIEW_FILES}`),
  ).map(row => row.sha256);
  const want = rowsOf<{ sha256: string }>(
    await db.execute(sql`SELECT c.sha256 FROM net.file_copies c JOIN net.files f ON f.sha256 = c.sha256 WHERE c.machine_id = ${machineId}
      AND f.drop_at IS NULL AND f.wanted_at > ${new Date(now.getTime() - WANTED_MS).toISOString()}::timestamptz ORDER BY f.wanted_at LIMIT ${VIEW_FILES}`),
  ).map(row => row.sha256);
  return { holds, hold, drop, want };
}

/* What a machine said it keeps now and what it let go of. A file let go of by every machine that kept it, once it is to
   go, is no file of the store any more. The answer names the files it keeps that no record knows, which it lets go of
   once they are a day old. A machine that holds no files any more is recorded with none it keeps. */
export async function takeReport(db: Tx, machineId: string, report: FileReport): Promise<{ unknown: string[]; send: string[] }> {
  let unknown: string[] = [];
  let send: string[] = [];
  if (report.span) {
    const { after, through } = report.span;
    await db.execute(sql`DELETE FROM net.file_copies WHERE machine_id = ${machineId} AND sha256 COLLATE "C" > ${after} AND sha256 COLLATE "C" <= ${through}
      AND NOT (sha256 = ANY(${listOf(report.held)}::text[]))`);
  }
  if (report.held.length) {
    const holds = await holdsFiles(db, machineId);
    const known = rowsOf<{ sha256: string }>(await db.execute(sql`SELECT sha256 FROM net.files WHERE sha256 = ANY(${listOf(report.held)}::text[])`)).map(row => row.sha256);
    if (holds && known.length) {
      await db.execute(sql`INSERT INTO net.file_copies (sha256, machine_id) SELECT unnest(${listOf(known)}::text[]), ${machineId}::uuid ON CONFLICT DO NOTHING`);
    }
    /* A content a row names, as a merge brings it, and no record describes, is no stranger: it is to come here. */
    const strangers = report.held.filter(sha256 => !known.includes(sha256));
    const named = strangers.length
      ? rowsOf<{ sha256: string }>(await db.execute(sql`SELECT DISTINCT sha256 FROM attachments WHERE sha256 = ANY(${listOf(strangers)}::text[])`)).map(row => row.sha256)
      : [];
    unknown = strangers.filter(sha256 => !named.includes(sha256));
    send = holds ? named : [];
  }
  if (report.dropped.length) {
    await db.execute(sql`DELETE FROM net.file_copies WHERE machine_id = ${machineId} AND sha256 = ANY(${listOf(report.dropped)}::text[])`);
    await db.execute(sql`DELETE FROM net.files f WHERE f.sha256 = ANY(${listOf(report.dropped)}::text[]) AND f.drop_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM net.file_copies c WHERE c.sha256 = f.sha256)`);
  }
  return { unknown, send };
}

const hasWork = (view: FileView): boolean => view.hold.length > 0 || view.drop.length > 0 || view.want.length > 0;
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
    let view = await fileView(db, machine);
    for (let waited = 0; wait && !hasWork(view) && waited < VIEW_WAIT_MS; waited += VIEW_LOOK_MS) {
      await new Promise(resolve => setTimeout(resolve, VIEW_LOOK_MS));
      view = await fileView(db, machine);
    }
    return view;
  });

  app.post('/api/network/files', { logLevel: 'silent', bodyLimit: 2 * 1024 * 1024 }, async (req, reply) => {
    const machine = await peerKeeper(req);
    return reply.send(await takeReport(db, machine, Report.parse(req.body)));
  });
}
