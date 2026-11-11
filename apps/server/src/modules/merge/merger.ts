import { randomUUID } from 'node:crypto';
import type { Ctx } from '../../app.js';
import { GateBusy } from '../../db/gate.js';
import { loggable } from '../../errors.js';
import { readRestoreStatus } from '../backups/restore.js';
import { ANOTHER_COMPANY, MergeRefused, runMerge } from './apply.js';
import { DIFFERENT } from './facts.js';
import { complete } from './check.js';
import { dropChoice, readChoice, type KeptDatabases } from './kept.js';
import { queryOf } from './leader.js';
import { KEPT_NAME, type MergeSource } from './source.js';
import { taskFor } from './task.js';
import { timeWords } from './words.js';

/* How often the merges are looked at while the app leads, and the longest a failed one waits for its next try. */
export const MERGE_EVERY_MS = 60_000;
export const RETRY_MAX_MS = 3_600_000;
const KEPT = 'kept:';
const GONE = 'The database is not on this server any more, so nothing of it was brought back.';

/* The database set aside before a merge that is not saved as a bundle yet, for the data keeper to dump and seal: the
   oldest first. The bundle is asked for at once and the merge does not wait for it, as the database stays until both
   are done. */
export async function forkWanted(db: Ctx['db']): Promise<{ id: string; database: string } | null> {
  const [row] = await queryOf(db)<{ fork: string; source: string }>(
    `SELECT m.fork, m.source FROM net.merges m WHERE m.status IN ('pending', 'applied', 'merged', 'removing') AND m.fork IS NOT NULL AND m.source LIKE 'kept:%'
       AND NOT EXISTS (SELECT 1 FROM net.backups b WHERE b.id = m.fork) ORDER BY m.created_at, m.source LIMIT 1`,
  );
  return row ? { id: row.fork, database: row.source.slice(KEPT.length) } : null;
}

type MergeRow = { id: string; source: string; label: string; status: 'pending' | 'applied' | 'merged' | 'removing' | 'done'; fork: string | null; tries: number; tried_at: string | Date | null };

/* Runs the merges of the databases that came back, one at a time, while the app leads: it finds the databases restores
   set aside, applies each merge and then checks it, and drops a database once it is merged or left out and saved as a
   bundle. A merge that fails is tried again, each time after twice as long. */
export class Merger {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | null = null;

  constructor(
    private readonly ctx: Ctx,
    private readonly kept: KeptDatabases,
    private readonly opts: { everyMs?: number; now?: () => Date } = {},
  ) {}

  start(): void {
    this.stop();
    this.timer = setInterval(() => void this.tick(), this.opts.everyMs ?? MERGE_EVERY_MS);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  private now(): Date {
    return this.opts.now?.() ?? new Date();
  }

  /* Whether a merge waits to be applied or checked, so that no update goes on meanwhile: migrations could part the
     shapes of the two databases. One that can never run, as its database is of another shape or another company
     already, holds no update: it waits for the CEO to leave it out. */
  async pending(): Promise<boolean> {
    const [row] = await queryOf(this.ctx.db)("SELECT 1 AS found FROM net.merges WHERE status IN ('pending', 'applied') AND error IS DISTINCT FROM $1 AND error IS DISTINCT FROM $2 LIMIT 1", [DIFFERENT, ANOTHER_COMPANY]);
    return Boolean(row);
  }

  /* A row for every database a restore set aside that has none yet. While a restore still runs nothing is told of the
     database it keeps: the updater says which one that is, and from when the restored one is, only when it is done. */
  async discover(): Promise<void> {
    const { db, config } = this.ctx;
    const q = queryOf(db);
    const status = readRestoreStatus(config.controlDir);
    if (status?.state === 'running') return;
    if (status?.state === 'done' && status.kept && status.dumpedAt) {
      await q(
        `INSERT INTO net.restores (attempt, backup, dumped_at, kept) VALUES ($1::uuid, $2::uuid, $3::timestamptz, $4)
         ON CONFLICT (attempt) DO UPDATE SET kept = EXCLUDED.kept WHERE net.restores.kept IS NULL`,
        [status.attempt, status.id, status.dumpedAt, status.kept],
      );
    }
    const known = new Set((await q<{ source: string }>('SELECT source FROM net.merges')).map(row => row.source));
    const there = await this.kept.list();
    /* A merge whose database is gone has nothing to bring back or to save, as when a backup restored later brings the
       record of a merge that still waited when it was made. */
    const waiting = await q<{ id: string; source: string }>("SELECT id, source FROM net.merges WHERE status IN ('pending', 'applied', 'merged', 'removing') AND source LIKE 'kept:%'");
    for (const row of waiting.filter(found => !there.includes(found.source.slice(KEPT.length)))) {
      await q("UPDATE net.merges SET status = 'done', done_at = now(), error = $2 WHERE id = $1::uuid", [row.id, GONE]);
    }
    for (const name of there) {
      /* Only ever a database a restore kept, whatever the list says. */
      if (!KEPT_NAME.test(name) || known.has(`${KEPT}${name}`)) continue;
      try {
        await this.found(name);
      } catch (err) {
        this.ctx.log.warn({ error: loggable(err) }, 'Could not look at a database a restore kept. Its merge waits.');
      }
    }
  }

  private async found(name: string): Promise<void> {
    const q = queryOf(this.ctx.db);
    const [restore] = await q<{ attempt: string; at: string | Date }>('SELECT attempt, dumped_at AS at FROM net.restores WHERE kept = $1 ORDER BY at DESC LIMIT 1', [name]);
    const label = restore ? `the database from before the restore of ${timeWords(new Date(restore.at), this.now())}` : `the database kept as ${name}`;
    const source = await this.kept.open(name, label);
    let holds: boolean;
    try {
      holds = (await source.query('SELECT 1 AS found FROM public.companies LIMIT 1')).length > 0;
    } finally {
      await source.close();
    }
    const choice = readChoice(this.ctx.config.controlDir);
    const chosen = Boolean(restore && choice?.attempt === restore.attempt);
    /* A database with no company in it holds nothing to bring back or to save. */
    const status = !holds || (chosen && !choice!.bringBack) ? 'removing' : 'pending';
    await q('INSERT INTO net.merges (source, label, status, fork) VALUES ($1, $2, $3, $4::uuid) ON CONFLICT (source) DO NOTHING', [`${KEPT}${name}`, label, status, holds ? randomUUID() : null]);
    /* The choice goes only now that the row that holds it is written. */
    if (chosen) dropChoice(this.ctx.config.controlDir);
  }

  /* One look at the merges: none while another runs, or while the app does not lead. */
  tick(): Promise<void> {
    this.running ??= this.look().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async look(): Promise<void> {
    if (this.ctx.mode.current() !== 'lead') return;
    try {
      await this.discover();
      await this.drops();
      await this.next();
      await this.tasks();
    } catch (err) {
      this.ctx.log.warn({ error: loggable(err) }, 'Could not look at the merges. Trying again in a minute.');
    }
  }

  private async open(row: MergeRow): Promise<MergeSource> {
    const name = row.source.slice(KEPT.length);
    if (!row.source.startsWith(KEPT) || !KEPT_NAME.test(name)) throw new MergeRefused('This Hornhoof cannot read this source yet.');
    return this.kept.open(name, row.label);
  }

  /* The oldest merge that waits and is due: applied when it is pending, then checked. */
  private async next(): Promise<void> {
    const q = queryOf(this.ctx.db);
    const waiting = await q<MergeRow>("SELECT id, source, label, status, fork, tries, tried_at FROM net.merges WHERE status IN ('pending', 'applied') ORDER BY created_at, source");
    const now = this.now();
    const row = waiting.find(found => !found.tried_at || now.getTime() - new Date(found.tried_at).getTime() >= Math.min(MERGE_EVERY_MS * 2 ** Math.min(found.tries - 1, 20), RETRY_MAX_MS));
    if (!row) return;
    await q('UPDATE net.merges SET tried_at = $2::timestamptz, tries = tries + 1 WHERE id = $1::uuid', [row.id, now]);
    try {
      if (row.status === 'pending') await this.apply(row);
      await this.check(row);
    } catch (err) {
      const said = err instanceof Error ? err.message : String(err);
      const error = err instanceof MergeRefused || err instanceof GateBusy ? said : `The merge stopped: ${said}`;
      await q('UPDATE net.merges SET error = $2 WHERE id = $1::uuid', [row.id, error]);
      /* The message is Hornhoof's own or the database's, and names no value of a row. */
      this.ctx.log.warn({ merge: row.id }, `A merge did not go through: ${err instanceof MergeRefused || err instanceof GateBusy ? said : 'it stopped'}. It is tried again later.`);
    }
  }

  private async apply(row: MergeRow): Promise<void> {
    const [company] = await queryOf(this.ctx.db)<{ id: string }>('SELECT id FROM public.companies LIMIT 1');
    if (!company) throw new MergeRefused('This Hornhoof has no company to bring anything back into.');
    const source = await this.open(row);
    try {
      await runMerge(this.ctx.db, { id: row.id, label: row.label, kept: row.source.startsWith(KEPT), companyId: company.id }, source, { log: line => this.ctx.log.info(line) });
    } finally {
      await source.close();
    }
    /* What the merge wrote woke nobody: the screens are told once to read again. */
    this.ctx.bus.publish(company.id, { type: 'org' });
  }

  private async check(row: MergeRow): Promise<void> {
    const q = queryOf(this.ctx.db);
    const source = await this.open(row);
    let checked: Awaited<ReturnType<typeof complete>>;
    try {
      checked = await complete(this.ctx.db, row.id, source);
    } finally {
      await source.close();
    }
    if (checked.ok) await q("UPDATE net.merges SET status = 'merged', merged_at = now(), error = NULL WHERE id = $1::uuid AND status = 'applied'", [row.id]);
    else await q('UPDATE net.merges SET error = $2 WHERE id = $1::uuid', [row.id, `Not complete yet: ${checked.missing.map(lost => `${lost.table} ${JSON.stringify(lost.key)}`).join(', ')}`]);
  }

  /* The orchestrator's task for each merge that left him something. A merge that left nothing wants none any more; with
     no orchestrator that can take one now it is asked again at the next look. Neither the drop of the database nor
     the CEO's conflicts wait for it. */
  private async tasks(): Promise<void> {
    const q = queryOf(this.ctx.db);
    const wanting = await q<{ id: string }>("SELECT id FROM net.merges WHERE task_wanted AND task_id IS NULL AND status IN ('applied', 'merged', 'done') ORDER BY created_at, source");
    for (const row of wanting) {
      try {
        const task = await taskFor(this.ctx, row.id);
        if (task) await q('UPDATE net.merges SET task_id = $2::uuid WHERE id = $1::uuid', [row.id, task]);
        else await q('UPDATE net.merges SET task_wanted = false WHERE id = $1::uuid', [row.id]);
      } catch (err) {
        this.ctx.log.warn({ error: loggable(err) }, 'Could not give the orchestrator the task of a merge. Trying again in a minute.');
      }
    }
  }

  /* A database that was merged, or is left out, goes once it is saved as a bundle, or holds nothing to save. */
  private async drops(): Promise<void> {
    const q = queryOf(this.ctx.db);
    const ready = await q<{ id: string; source: string }>(
      `SELECT m.id, m.source FROM net.merges m WHERE m.status IN ('merged', 'removing') AND m.source LIKE 'kept:%'
         AND (m.fork IS NULL OR EXISTS (SELECT 1 FROM net.backups b WHERE b.id = m.fork)) ORDER BY m.created_at`,
    );
    for (const row of ready) {
      if (!KEPT_NAME.test(row.source.slice(KEPT.length))) continue;
      try {
        await this.kept.drop(row.source.slice(KEPT.length));
        await q("UPDATE net.merges SET status = 'done', done_at = now() WHERE id = $1::uuid", [row.id]);
      } catch (err) {
        this.ctx.log.warn({ error: loggable(err) }, 'Could not remove a database a restore kept. Trying again in a minute.');
      }
    }
  }
}
