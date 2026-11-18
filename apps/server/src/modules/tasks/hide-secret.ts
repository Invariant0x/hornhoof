import { createHash } from 'node:crypto';
import { HIDDEN, MIN_SECRET_LENGTH } from '@hornhoof/protocol/redaction';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Ctx } from '../../app.js';
import type { Db } from '../../db/client.js';
import { writeGate } from '../../db/gate.js';
import { attachments, people, secretRedactions, taskEvents, tasks } from '../../db/schema.js';
import type { Person } from '../../auth/session.js';
import { runsDepartment } from '../../auth/departments.js';
import { ApiError } from '../../errors.js';
import { factsOf, type Facts, type Query, type TableFacts } from '../merge/facts.js';
import { queryOf, quote } from '../merge/leader.js';
import { loadTask, taskSpot, type Task } from './state.js';
import { note } from './events.js';

type Row = Record<string, unknown>;
/* What a mask does to one text: the hidden value, wherever it stands, becomes HIDDEN. */
export type Mask = (text: string) => string;
/* What a company keeps of a hidden value: never the value, only enough to find it again in an old copy's rows. */
export type Fingerprint = { fingerprint: string; characters: number; window_hash: number };

/* Prose: what people and agents write, wherever it is kept. Service state, identities and keys are never prose. */
const PROSE = ['text', 'body', 'title', 'brief', 'prompt', 'requested_prompt', 'result', 'tail', 'question', 'answer', 'note', 'evidence',
  'description', 'goal', 'messages', 'data', 'options', 'summary', 'details', 'failure', 'interruption', 'sent_report', 'message'];
const PROSE_OF: Record<string, string[]> = {
  tasks: ['external_wait', 'paused'],
  outbound_catalog_revisions: ['value'],
  turn_releases: ['tasks'],
  briefings: ['files'],
  program_operator_cases: ['resolution'],
};
const TEXT_TYPE = /^(text|character varying(\(\d+\))?|jsonb|json)$/;
/* Inside stored JSON: names that are kept as they are, and values that are service state. */
const KEPT_NAMES = ['text', 'data', 'body', 'title', 'brief', 'evidence', 'message', 'messages', '_message', 'kind', 'status', 'type', 'id', 'name', 'direction', 'at', 'seq', 'number'];
const KEPT_VALUES = ['kind', 'status', 'type', 'id', 'direction', 'at', 'seq', 'number', 'code'];
const SERVICE = /(_id|Id|_hash|_digest)$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BATCH = 500;

export const proseColumns = (t: TableFacts): string[] =>
  t.name === 'secret_redactions' ? [] : t.columns.filter(c => (PROSE.includes(c.name) || PROSE_OF[t.name]?.includes(c.name)) && TEXT_TYPE.test(c.type)).map(c => c.name);
const textFile = (mediaType: unknown): boolean => typeof mediaType === 'string' && (mediaType.startsWith('text/') || mediaType === 'application/json');

/* Each piece between masks alone, so a mask is never cut, and two pieces never join into a new match. */
const piecewise = (text: string, piece: (part: string) => string): string => (text.includes(HIDDEN) ? text.split(HIDDEN).map(piece).join(HIDDEN) : piece(text));

/* The value itself, held in memory for one request: every occurrence, left to right, without overlaps. */
export const valueMask = (value: string): Mask => text => (text.includes(value) ? piecewise(text, part => part.split(value).join(HIDDEN)) : text);

/* A polynomial hash of each window of code points, modulo the Mersenne prime 2^31 - 1, rolled one character at a time.
   Every product stays below 2^53, so plain numbers keep it exact. */
const P = 2147483647;
const B = 1000003;
const mulmod = (a: number, b: number): number => (((a * Math.floor(b / 65536)) % P) * 65536 + a * (b % 65536)) % P;
const windowOf = (points: number[], from: number, length: number): number => {
  let h = 0;
  for (let i = from; i < from + length; i += 1) h = (h * B + points[i]!) % P;
  return h;
};
const powerOf = (length: number): number => {
  let top = 1;
  for (let i = 1; i < length; i += 1) top = (top * B) % P;
  return top;
};
const pointsOf = (chars: string[]): number[] => chars.map(c => c.codePointAt(0)!);
const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

export const windowHashOf = (value: string): number => {
  const chars = [...value];
  return windowOf(pointsOf(chars), 0, chars.length);
};
export const fingerprintOf = (value: string): Fingerprint => ({ fingerprint: sha(value), characters: [...value].length, window_hash: windowHashOf(value) });

/* One pass over the text for one length: a full hash only where the rolling hash of the window is a hidden one. */
function maskWindows(part: string, length: number, byWindow: Map<number, Set<string>>): string {
  const chars = [...part];
  if (chars.length < length) return part;
  const points = pointsOf(chars);
  const top = powerOf(length);
  const out: string[] = [];
  let found = false;
  let i = 0;
  let h = windowOf(points, 0, length);
  while (i + length <= chars.length) {
    const hashes = byWindow.get(h);
    if (hashes?.has(sha(chars.slice(i, i + length).join('')))) {
      out.push(HIDDEN);
      found = true;
      i += length;
      if (i + length <= chars.length) h = windowOf(points, i, length);
      continue;
    }
    out.push(chars[i]!);
    if (i + length < chars.length) h = (((h - mulmod(points[i]!, top) + P) % P) * B + points[i + length]!) % P;
    i += 1;
  }
  if (!found) return part;
  for (; i < chars.length; i += 1) out.push(chars[i]!);
  return out.join('');
}

/* The company's hidden values found again by their fingerprints alone, the longest first, as the value would have
   been. Linear in the text for each length; null when there is nothing to find. */
export function fingerprintMask(hidden: Fingerprint[]): Mask | null {
  const groups = new Map<number, Map<number, Set<string>>>();
  for (const f of hidden) {
    const byWindow = groups.get(f.characters) ?? new Map<number, Set<string>>();
    groups.set(f.characters, byWindow.set(Number(f.window_hash), (byWindow.get(Number(f.window_hash)) ?? new Set()).add(f.fingerprint)));
  }
  if (groups.size === 0) return null;
  const lengths = [...groups.keys()].sort((a, b) => b - a);
  return text => lengths.reduce((result, length) => piecewise(result, part => maskWindows(part, length, groups.get(length)!)), text);
}

/* Stored JSON: every string and every name of its own, never the service state in it. */
export function maskJson(value: unknown, mask: Mask): unknown {
  if (typeof value === 'string') return mask(value);
  if (Array.isArray(value)) return value.map(item => maskJson(item, mask));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [
      KEPT_NAMES.includes(name) || SERVICE.test(name) ? name : mask(name),
      KEPT_VALUES.includes(name) || SERVICE.test(name) ? item : maskJson(item, mask),
    ]));
  }
  return value;
}

/* The prose of a row, whole or as a journal keeps part of it, as the mask leaves it: only what changed, or null. A text
   file's bytes come as to_jsonb gives them, \x and hex. */
export function maskRow(t: TableFacts, row: Row, mask: Mask): Row | null {
  const changed: Row = {};
  for (const name of proseColumns(t)) {
    const was = row[name];
    if (was === null || was === undefined) continue;
    const now = maskJson(was, mask);
    if (JSON.stringify(now) !== JSON.stringify(was)) changed[name] = now;
  }
  if (t.name === 'attachments' && textFile(row.media_type) && typeof row.bytes === 'string' && row.bytes.startsWith('\\x')) {
    const bytes = Buffer.from(row.bytes.slice(2), 'hex');
    const text = bytes.toString('utf8');
    const masked = Buffer.from(text, 'utf8').equals(bytes) ? mask(text) : text;
    if (masked !== text) {
      const out = Buffer.from(masked, 'utf8');
      Object.assign(changed, { bytes: `\\x${out.toString('hex')}`, size: out.length });
    }
  }
  return Object.keys(changed).length > 0 ? changed : null;
}

/* Which rows are the company's: by its column, the company itself, or the company's jobs. Null: never touched here. */
function scopeOf(t: TableFacts, company: string): { rows: string; image: (json: string) => string } | null {
  const names = t.columns.map(c => c.name);
  const jobs = `SELECT id FROM public.jobs WHERE company_id = '${company}'::uuid`;
  if (names.includes('company_id')) return { rows: `t.company_id = '${company}'::uuid`, image: json => `${json}->>'company_id' = '${company}'` };
  if (t.name === 'companies') return { rows: `t.id = '${company}'::uuid`, image: json => `${json}->>'id' = '${company}'` };
  if (names.includes('job_id')) return { rows: `t.job_id IN (${jobs})`, image: json => `${json}->>'job_id' IN (SELECT id::text FROM public.jobs WHERE company_id = '${company}'::uuid)` };
  return null;
}

/* Rows read in batches through one cursor, so a company's rows are read once whatever their order. */
async function eachBatch(q: Query, select: string, work: (rows: Row[]) => Promise<void>): Promise<void> {
  await q(`DECLARE hide_secret NO SCROLL CURSOR FOR ${select}`);
  for (;;) {
    const rows = (await q<{ row: Row }>(`FETCH ${BATCH} FROM hide_secret`)).map(r => r.row);
    if (rows.length === 0) break;
    await work(rows);
  }
  await q('CLOSE hide_secret');
}

const jsonOf = (columns: string[], alias: string): string => `jsonb_build_object(${columns.map(name => `'${name}', ${alias}.${quote(name)}`).join(', ')})`;

/* A frozen record allows exactly these columns to lose a hidden value, from this connection, in this transaction. */
const allow = (q: Query, columns: string[]) => q("SELECT set_config('hornhoof.hiding_secret', $1, true)", [JSON.stringify(columns)]);

/* Every row of the company's prose as the mask leaves it, then every copy of it the journal and the merges kept. Nothing
   of another company is read, and nothing of the value goes to SQL: only text it has already left. */
export async function maskCompanyRows(q: Query, facts: Facts, company: string, mask: Mask): Promise<number> {
  if (!UUID.test(company)) throw new Error('A company id is a uuid.');
  let changed = 0;
  const tables = [...facts.tables.values()].filter(t => t.key.length > 0 && (proseColumns(t).length > 0 || t.name === 'attachments') && scopeOf(t, company));
  for (const t of tables) {
    const prose = proseColumns(t);
    const files = t.name === 'attachments';
    const wanted = [...new Set([...t.key, ...prose, ...(files ? ['media_type', 'bytes'] : [])])];
    await allow(q, [...prose, ...(files ? ['bytes', 'size'] : [])]);
    const only = files ? " AND (t.media_type LIKE 'text/%' OR t.media_type = 'application/json')" : '';
    await eachBatch(q, `SELECT ${jsonOf(wanted, 't')} AS row FROM public.${quote(t.name)} t WHERE ${scopeOf(t, company)!.rows}${only}`, async rows => {
      for (const row of rows) {
        const now = maskRow(t, row, mask);
        if (!now) continue;
        await q(
          `UPDATE public.${quote(t.name)} t SET ${Object.keys(now).map(name => `${quote(name)} = r.${quote(name)}`).join(', ')}
           FROM jsonb_populate_record(NULL::public.${quote(t.name)}, $1::jsonb) r WHERE ${t.key.map(k => `t.${quote(k)} = r.${quote(k)}`).join(' AND ')}`,
          [JSON.stringify({ ...Object.fromEntries(t.key.map(k => [k, row[k]])), ...now })],
        );
        changed += 1;
      }
    });
  }
  await allow(q, []);
  for (const t of tables) changed += await maskCopies(q, t, company, mask);
  changed += await maskParked(q, company, mask);
  return changed;
}

/* A partial image keeps only the columns it had: the mask changes their text and adds none. */
const patched = (t: TableFacts, image: Row | null, mask: Mask, also: Row = {}): Row | null => {
  if (!image) return null;
  const now = maskRow(t, { ...also, ...image }, mask);
  const kept = now && Object.fromEntries(Object.entries(now).filter(([name]) => name in image));
  return kept && Object.keys(kept).length > 0 ? { ...image, ...kept } : null;
};

/* The journal's old values of the company's rows, here or deleted since, and what merges kept of them. */
async function maskCopies(q: Query, t: TableFacts, company: string, mask: Mask): Promise<number> {
  const scope = scopeOf(t, company)!;
  const name = t.name.replaceAll("'", "''");
  const keys = `SELECT ${jsonOf(t.key, 't')} FROM public.${quote(t.name)} t WHERE ${scope.rows}
    UNION ALL SELECT d.key FROM net.journal d WHERE d.tbl = '${name}' AND d.op = 'delete' AND ${scope.image('d.old')}`;
  const media = t.name === 'attachments' ? ", 'media_type', (SELECT a.media_type FROM public.attachments a WHERE a.id = (j.key->>'id')::uuid)" : '';
  let changed = 0;
  await eachBatch(q, `SELECT jsonb_build_object('id', j.id, 'old', j.old${media}) AS row FROM net.journal j
    WHERE j.tbl = '${name}' AND j.old IS NOT NULL AND (${scope.image('j.old')} OR j.key IN (${keys}))`, async rows => {
    for (const row of rows) {
      const old = patched(t, row.old as Row, mask, { media_type: row.media_type });
      if (!old) continue;
      await q('UPDATE net.journal SET old = $1::jsonb WHERE id = $2::uuid', [JSON.stringify(old), row.id]);
      changed += 1;
    }
  });
  await eachBatch(q, `SELECT jsonb_build_object('merge', m.merge, 'key', m.key, 'was', m.was, 'here', m.here) AS row FROM net.merge_rows m
    WHERE m.tbl = '${name}' AND (m.key IN (${keys}) OR ${scope.image('m.was')} OR ${scope.image('m.here')})`, async rows => {
    for (const row of rows) {
      const [was, here] = [patched(t, row.was as Row | null, mask), patched(t, row.here as Row | null, mask)];
      if (!was && !here) continue;
      await q('UPDATE net.merge_rows SET was = coalesce($1::jsonb, was), here = coalesce($2::jsonb, here) WHERE merge = $3::uuid AND tbl = $4 AND key = $5::jsonb',
        [was && JSON.stringify(was), here && JSON.stringify(here), row.merge, t.name, JSON.stringify(row.key)]);
      changed += 1;
    }
  });
  await eachBatch(q, `SELECT jsonb_build_object('id', c.id, 'here', c.here, 'there', c.there, 'value', c.value, 'why', c.why) AS row FROM net.merge_conflicts c
    WHERE c.tbl = '${name}' AND (c.key IN (${keys}) OR ${scope.image('c.here')} OR ${scope.image('c.there')}
      OR c.task_id IN (SELECT id FROM public.tasks WHERE company_id = '${company}'::uuid))`, async rows => {
    for (const row of rows) {
      const [here, there, value] = [patched(t, row.here as Row | null, mask), patched(t, row.there as Row | null, mask), patched(t, row.value as Row | null, mask)];
      const why = typeof row.why === 'string' && mask(row.why) !== row.why ? mask(row.why) : null;
      if (!here && !there && !value && !why) continue;
      await q('UPDATE net.merge_conflicts SET here = coalesce($1::jsonb, here), there = coalesce($2::jsonb, there), value = coalesce($3::jsonb, value), why = coalesce($4, why) WHERE id = $5::uuid',
        [here && JSON.stringify(here), there && JSON.stringify(there), value && JSON.stringify(value), why, row.id]);
      changed += 1;
    }
  });
  return changed;
}

/* What nodes said of the company's jobs while their rows were away. */
async function maskParked(q: Query, company: string, mask: Mask): Promise<number> {
  let changed = 0;
  await eachBatch(q, `SELECT jsonb_build_object('id', p.id, 'body', p.body) AS row FROM net.parked p
    WHERE p.job_id IN (SELECT id FROM public.jobs WHERE company_id = '${company}'::uuid)`, async rows => {
    for (const row of rows) {
      const body = maskJson(row.body, mask);
      if (JSON.stringify(body) === JSON.stringify(row.body)) continue;
      await q('UPDATE net.parked SET body = $1::jsonb WHERE id = $2::uuid', [JSON.stringify(body), row.id]);
      changed += 1;
    }
  });
  return changed;
}

/* The value goes out of every row of the company, and its fingerprint stays for old copies. The caller holds the
   write gate and the transaction; the value is in memory only for this call. */
export async function hideSecretIn(db: Db, companyId: string, personId: string, value: string): Promise<number> {
  const { fingerprint, characters, window_hash } = fingerprintOf(value);
  await db.insert(secretRedactions).values({ companyId, fingerprint, characters, windowHash: window_hash, personId }).onConflictDoNothing();
  const q = queryOf(db);
  return maskCompanyRows(q, await factsOf(q), companyId, valueMask(value));
}

const invalid = () => new ApiError(400, 'validation', `Select a secret of at least ${MIN_SECRET_LENGTH} characters in this task or its log.`);

/* Only validation, hashing and the replacement in this process see the value. No SQL text, parameter or entry carries it. */
export async function hideTaskSecret(ctx: Pick<Ctx, 'db' | 'bus'>, person: Person, task: Task, value: string): Promise<Task> {
  if (task.companyId !== person.companyId || person.via || person.assistant || !(await runsDepartment(ctx.db, person, task.departmentId))) {
    throw new ApiError(403, 'forbidden', 'Only the CEO, the CEO delegate and people running this department may hide a secret.');
  }
  /* A short or common value would be hidden in every text of the company. */
  if (!value.trim() || [...value].length < MIN_SECRET_LENGTH || value.includes(HIDDEN)) throw invalid();
  /* This server's writers wait while the company's rows change; other companies' rows are neither read nor locked. */
  await writeGate.exclusive(() => ctx.db.transaction(async tx => {
    const current = await loadTask(tx, task.id);
    const [actor] = await tx.select().from(people).where(and(eq(people.id, person.id), eq(people.companyId, person.companyId)));
    if (!actor || actor.status !== 'active' || !(await runsDepartment(tx, actor, current.departmentId))) {
      throw new ApiError(403, 'forbidden', 'Your access changed.');
    }
    const log = await tx.select({ text: taskEvents.text, data: taskEvents.data }).from(taskEvents).where(and(eq(taskEvents.taskId, task.id), eq(taskEvents.companyId, person.companyId)));
    const evidence = log.flatMap(e => typeof e.data?.evidence === 'string' ? [e.data.evidence] : []);
    const archiveIds = log.flatMap(e => Array.isArray(e.data?.fullTexts) ? e.data.fullTexts.flatMap((ref: unknown) => ref && typeof ref === 'object' && 'id' in ref && typeof ref.id === 'string' ? [ref.id] : []) : []);
    const archives = archiveIds.length ? await tx.select({ bytes: attachments.bytes }).from(attachments).where(and(eq(attachments.companyId, person.companyId), eq(attachments.taskId, task.id), eq(attachments.mediaType, 'text/plain'), inArray(attachments.id, archiveIds))) : [];
    const texts = [current.title, current.brief, current.body, ...log.map(e => e.text), ...evidence, ...archives.map(file => Buffer.from(file.bytes).toString('utf8'))];
    if (!texts.some(text => text.includes(value))) throw invalid();
    await hideSecretIn(tx as unknown as Db, person.companyId, person.id, value);
    await note(tx, task, { actor: { personId: person.id }, kind: 'comment', text: 'Secret hidden.', data: { secretHidden: true } });
    await tx.update(tasks).set({ version: sql`${tasks.version} + 1`, updatedAt: new Date() }).where(eq(tasks.id, task.id));
  }));
  const changed = await loadTask(ctx.db, task.id);
  ctx.bus.publish(task.companyId, { type: 'task', id: task.id, spot: taskSpot(task) });
  return changed;
}
