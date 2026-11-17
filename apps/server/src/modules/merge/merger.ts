import { randomUUID } from 'node:crypto';
import type { Ctx } from '../../app.js';
import { GateBusy } from '../../db/gate.js';
import { loggable } from '../../errors.js';
import { readRestoreStatus } from '../backups/restore.js';
import { ANOTHER_COMPANY, MergeRefused, runMerge } from './apply.js';
import { DIFFERENT } from './facts.js';
import { readKeeperState } from '../keeper/state.js';
import { replicaPassword } from '../keeper/replica.js';
import { complete, fastWay } from './check.js';
import { dropChoice, readChoice, type KeptDatabases } from './kept.js';
import { queryOf } from './leader.js';
import { pendingChanged } from '../nodes/parked.js';
import { KEPT_NAME, MACHINE_SOURCE, MACHINE_SOURCE_SQL, peerSource, setAside, UPLOAD_NAME, type MergeSource } from './source.js';
import { taskFor } from './task.js';
import { timeWords } from './words.js';

/* How often the merges are looked at while the app leads, and the longest a failed one waits for its next try. */
export const MERGE_EVERY_MS = 60_000;
export const RETRY_MAX_MS = 3_600_000;
const KEPT = 'kept:';
const UPLOAD = 'upload:';
/* The database a merge of the leader's own Postgres reads, by its source; null for any other source. */
const databaseOf = (source: string): string | null => {
  const name = source.startsWith(KEPT) ? source.slice(KEPT.length) : source.startsWith(UPLOAD) ? source.slice(UPLOAD.length) : '';
  return (source.startsWith(KEPT) ? KEPT_NAME : UPLOAD_NAME).test(name) ? name : null;
};
/* The moment an upload's name carries, YYYYMMDDtHHMMSS in UTC. */
const stampTime = (stamp: string): Date => new Date(`${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}Z`);
const GONE = 'The database is not on this server any more, so nothing of it was brought back.';
const LEFT_OUT = (at: string): string => `Left out with the database from before the restore of ${at}.`;

/* How the old database of a copy on another machine is opened: through the door the keeper holds to it, by its port. */
type PeerDatabases = { open(port: number, label: string): Promise<MergeSource> };

/* The database set aside before a merge, or made of an upload, that is not saved as a bundle yet, for the data keeper
   to dump and seal: the oldest first. The bundle is asked for at once and the merge does not wait for it, as the
   database stays until both are done. */
export async function forkWanted(db: Ctx['db']): Promise<{ id: string; database: string } | null> {
  const rows = await queryOf(db)<{ fork: string; source: string }>(
    `SELECT m.fork, m.source FROM net.merges m WHERE m.status IN ('pending', 'applied', 'merged', 'removing') AND m.fork IS NOT NULL AND (m.source LIKE 'kept:%' OR m.source LIKE 'upload:%')
       AND NOT EXISTS (SELECT 1 FROM net.backups b WHERE b.id = m.fork) ORDER BY m.created_at, m.source`,
  );
  const row = rows.find(found => databaseOf(found.source));
  return row ? { id: row.fork, database: databaseOf(row.source)! } : null;
}

type MergeRow = { id: string; source: string; label: string; status: 'pending' | 'applied' | 'merged' | 'removing' | 'done'; fork: string | null; tries: number; tried_at: string | Date | null; machine: string | null };
type CopyMachine = { id: string; hostname: string; network_id: string | null; revoked_at: unknown; copy_old: number | null; role: string | null };

/* Runs the merges of the databases that came back, one at a time, while the app leads: it finds the databases restores
   set aside, applies each merge and then checks it, and drops a database once it is merged or left out and saved as a
   bundle. A merge that fails is tried again, each time after twice as long. */
export class Merger {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | null = null;

  constructor(
    private readonly ctx: Ctx,
    private readonly kept: KeptDatabases,
    private readonly opts: { everyMs?: number; now?: () => Date; peers?: PeerDatabases } = {},
  ) {}

  /* A copy's old database is read as the role that only reads, whose password every data machine can tell. */
  private peers(): PeerDatabases {
    return this.opts.peers ?? { open: (port, label) => peerSource(port, replicaPassword(this.ctx.config.secret), label) };
  }

  /* The network ids of the machines whose old copy a merge still has to read: the keeper opens a door to each. */
  async doors(): Promise<string[]> {
    const rows = await queryOf(this.ctx.db)<{ id: string }>(
      `SELECT DISTINCT m.network_id AS id FROM net.merges g JOIN public.machines m ON m.id = g.machine
        WHERE g.source LIKE 'machine:%' AND g.status IN ('pending', 'applied') AND m.revoked_at IS NULL AND m.role = 'data' AND m.network_id IS NOT NULL ORDER BY 1`,
    );
    return rows.map(row => row.id);
  }

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
    /* The old database of a copy on another machine holds no update up: it is read by its ids whatever the two
       schemas are, and its machine may be away for long. */
    const [row] = await queryOf(this.ctx.db)(
      "SELECT 1 AS found FROM net.merges WHERE status IN ('pending', 'applied') AND source NOT LIKE 'machine:%' AND error IS DISTINCT FROM $1 AND error IS DISTINCT FROM $2 LIMIT 1",
      [DIFFERENT, ANOTHER_COMPANY],
    );
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
    const waiting = await q<{ id: string; source: string; status: string; machine: string | null }>(
      "SELECT id, source, status, machine FROM net.merges WHERE status IN ('pending', 'applied', 'merged', 'removing') AND (source LIKE 'kept:%' OR source LIKE 'upload:%')",
    );
    for (const row of waiting.filter(found => !there.includes(found.source.slice(found.source.indexOf(':') + 1)))) await this.gone(row);
    for (const name of there) {
      /* Only ever a database a restore kept, or one made of an upload, whatever the list says. */
      if (!setAside(name) || known.has(`${KEPT_NAME.test(name) ? KEPT : UPLOAD}${name}`)) continue;
      try {
        if (KEPT_NAME.test(name)) await this.found(name);
        else await this.uploaded(name);
      } catch (err) {
        this.ctx.log.warn({ error: loggable(err) }, 'Could not look at a database a restore kept or a machine uploaded. Its merge waits.');
      }
    }
    await this.copies();
  }

  /* A merge whose database went. What a machine uploaded and the leader had not read yet is asked of it again; one that
     was read is as good as saved, and its machine may wipe. */
  private async gone(row: { id: string; source: string; status: string; machine: string | null }): Promise<void> {
    await this.ctx.db.transaction(async tx => {
      const q = queryOf(tx);
      await q("UPDATE net.merges SET status = 'done', done_at = now(), error = $2 WHERE id = $1::uuid", [row.id, GONE]);
      if (!row.source.startsWith(UPLOAD) || !row.machine) return;
      await q("UPDATE public.machines SET upload_state = $2 WHERE id = $1::uuid AND upload_state = 'received'", [row.machine, row.status === 'pending' || row.status === 'applied' ? 'waiting' : 'kept']);
    });
  }

  /* What a machine held when it stopped holding the data, loaded as a database of its own: its merge, with a bundle
     asked for as of a database a restore kept, and its machine told that the leader has it. */
  private async uploaded(name: string): Promise<void> {
    const [, prefix, stamp] = UPLOAD_NAME.exec(name)!;
    await this.ctx.db.transaction(async tx => {
      const q = queryOf(tx);
      const [machine] = await q<{ id: string; hostname: string }>('SELECT id, hostname FROM public.machines WHERE left(lower(network_id), 16) = $1 ORDER BY revoked_at NULLS FIRST, created_at DESC LIMIT 1', [prefix]);
      const label = `${machine?.hostname ? `${machine.hostname}'s copy` : 'A copy'}, uploaded ${timeWords(stampTime(stamp!), this.now())}`;
      await q('INSERT INTO net.merges (source, label, status, fork, machine) VALUES ($1, $2, $3, $4::uuid, $5::uuid) ON CONFLICT (source) DO NOTHING', [`${UPLOAD}${name}`, label, 'pending', randomUUID(), machine?.id ?? null]);
      if (machine) await q("UPDATE public.machines SET upload_state = 'received' WHERE id = $1::uuid AND upload_state = 'waiting'", [machine.id]);
    });
  }

  /* A copy that was made again says which attempt's old database waits on its machine, and under which term that
     database led, when it did: a merge for each that has none yet. One that was merged is done once its machine named
     another, or none, or left: the machine itself drops the database, and the leader drops nothing. Only a machine
     that holds the data is asked: no door leads to the database of one that stopped holding it. */
  private async copies(): Promise<void> {
    const q = queryOf(this.ctx.db);
    await q(
      `INSERT INTO net.merges (source, label, status, machine)
       SELECT ${MACHINE_SOURCE_SQL}, m.hostname || CASE WHEN m.copy_old_led IS NULL THEN '''s copy from before it was made again' ELSE '''s database from when it led' END, 'pending', m.id
         FROM public.machines m
        WHERE m.revoked_at IS NULL AND m.copy_old IS NOT NULL AND m.role = 'data'
       ON CONFLICT (source) DO NOTHING`,
    );
    await q(
      `UPDATE net.merges g SET status = 'done', done_at = now() WHERE g.source LIKE 'machine:%' AND g.status = 'merged'
         AND NOT EXISTS (SELECT 1 FROM public.machines m WHERE m.id = g.machine AND m.revoked_at IS NULL AND g.source = ${MACHINE_SOURCE_SQL})`,
    );
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
    await this.parked();
  }

  /* What nodes said of jobs whose rows a merge has brought since is applied now: at each look, so also right after a
     merge ended and at the first look of a machine that just took the server. */
  private async parked(): Promise<void> {
    try {
      pendingChanged(this.ctx.db);
      await this.ctx.applyParked();
    } catch (err) {
      this.ctx.log.warn({ error: loggable(err) }, 'Could not apply what nodes said of jobs while their database was away. Trying again in a minute.');
    }
  }

  private async open(row: MergeRow, port?: number): Promise<MergeSource> {
    if (MACHINE_SOURCE.test(row.source)) {
      if (port === undefined) throw new MergeRefused("The keeper holds no door to that machine's database now.");
      return this.peers().open(port, row.label);
    }
    const name = databaseOf(row.source);
    if (!name) throw new MergeRefused('This Hornhoof cannot read this source yet.');
    return this.kept.open(name, row.label);
  }

  /* The machine a merge of a copy's old database reads, and the port of the keeper's door to it; no port while the
     keeper holds none. */
  private async machineOf(row: MergeRow): Promise<{ machine: CopyMachine | undefined; port: number | undefined }> {
    const [machine] = await queryOf(this.ctx.db)<CopyMachine>('SELECT id, hostname, network_id, revoked_at, copy_old, role FROM public.machines WHERE id = $1::uuid', [row.machine]);
    const doors = readKeeperState(this.ctx.config.controlDir)?.doors ?? {};
    return { machine, port: machine?.network_id ? doors[machine.network_id] : undefined };
  }

  /* The oldest merge that waits and is due: applied when it is pending, then checked. A copy's old database waits for
     its door without a try being counted, and ends unread when its machine left the company or stopped holding its
     data. */
  private async next(): Promise<void> {
    const q = queryOf(this.ctx.db);
    const waiting = await q<MergeRow>("SELECT id, source, label, status, fork, tries, tried_at, machine FROM net.merges WHERE status IN ('pending', 'applied') ORDER BY created_at, source");
    const now = this.now();
    const due = waiting.filter(found => !found.tried_at || now.getTime() - new Date(found.tried_at).getTime() >= Math.min(MERGE_EVERY_MS * 2 ** Math.min(found.tries - 1, 20), RETRY_MAX_MS));
    let row: MergeRow | undefined;
    let port: number | undefined;
    for (const found of due) {
      if (!MACHINE_SOURCE.test(found.source)) {
        row = found;
        break;
      }
      const at = await this.machineOf(found);
      if (!at.machine || at.machine.revoked_at || at.machine.role !== 'data') {
        await q("UPDATE net.merges SET status = 'done', done_at = now(), error = $2 WHERE id = $1::uuid", [found.id, `${at.machine?.hostname || 'The machine'} left before its old copy was read.`]);
        continue;
      }
      if (at.port === undefined) continue;
      row = found;
      port = at.port;
      break;
    }
    if (!row) return;
    await q('UPDATE net.merges SET tried_at = $2::timestamptz, tries = tries + 1 WHERE id = $1::uuid', [row.id, now]);
    try {
      /* What a machine uploaded is a copy as much as one read on its machine. */
      /* A database that led wrote, so it is never taken by its ids alone. */
      const led = MACHINE_SOURCE.exec(row.source)?.[2] !== undefined;
      if (!led && (port !== undefined || row.source.startsWith(UPLOAD)) && (await this.byIds(row, port))) return;
      if (row.status === 'pending') await this.apply(row, port);
      await this.check(row, port);
    } catch (err) {
      const said = err instanceof Error ? err.message : String(err);
      const error = err instanceof MergeRefused || err instanceof GateBusy ? said : `The merge stopped: ${said}`;
      await q('UPDATE net.merges SET error = $2 WHERE id = $1::uuid', [row.id, error]);
      /* The message is Hornhoof's own or the database's, and names no value of a row. */
      this.ctx.log.warn({ merge: row.id }, `A merge did not go through: ${err instanceof MergeRefused || err instanceof GateBusy ? said : 'it stopped'}. It is tried again later.`);
    }
  }

  /* A copy that never wrote is merged by its ids alone, and one that holds only what the CEO left out is left out
     with it: whether either was so. Anything else goes the whole way. */
  private async byIds(row: MergeRow, port?: number): Promise<boolean> {
    const q = queryOf(this.ctx.db);
    const source = await this.open(row, port);
    let found: Awaited<ReturnType<typeof fastWay>>;
    try {
      found = await fastWay(this.ctx.db, source);
    } finally {
      await source.close();
    }
    if (found.way === 'fast') await q("UPDATE net.merges SET status = 'merged', merged_at = now(), error = NULL WHERE id = $1::uuid", [row.id]);
    else if (found.way === 'left_out') await q("UPDATE net.merges SET status = 'done', done_at = now(), error = $2 WHERE id = $1::uuid", [row.id, LEFT_OUT(timeWords(found.restoreAt!, this.now()))]);
    return found.way !== 'whole';
  }

  private async apply(row: MergeRow, port?: number): Promise<void> {
    const [company] = await queryOf(this.ctx.db)<{ id: string }>('SELECT id FROM public.companies LIMIT 1');
    if (!company) throw new MergeRefused('This Hornhoof has no company to bring anything back into.');
    const source = await this.open(row, port);
    try {
      await runMerge(this.ctx.db, { id: row.id, label: row.label, kept: row.source.startsWith(KEPT), companyId: company.id }, source, { log: line => this.ctx.log.info(line) });
    } finally {
      await source.close();
    }
    /* What the merge wrote woke nobody: the screens are told once to read again. */
    this.ctx.bus.publish(company.id, { type: 'org' });
  }

  private async check(row: MergeRow, port?: number): Promise<void> {
    const q = queryOf(this.ctx.db);
    const source = await this.open(row, port);
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

  /* A database that was merged, or is left out, goes once it is saved as a bundle, or holds nothing to save. The
     machine whose upload it was is told to wipe first: what it held is on the leader and in a bundle now. */
  private async drops(): Promise<void> {
    const q = queryOf(this.ctx.db);
    const ready = await q<{ id: string; source: string; machine: string | null }>(
      `SELECT m.id, m.source, m.machine FROM net.merges m WHERE m.status IN ('merged', 'removing') AND (m.source LIKE 'kept:%' OR m.source LIKE 'upload:%')
         AND (m.fork IS NULL OR EXISTS (SELECT 1 FROM net.backups b WHERE b.id = m.fork)) ORDER BY m.created_at`,
    );
    for (const row of ready) {
      const name = databaseOf(row.source);
      if (!name) continue;
      try {
        if (row.source.startsWith(UPLOAD) && row.machine) await q("UPDATE public.machines SET upload_state = 'kept' WHERE id = $1::uuid AND upload_state = 'received'", [row.machine]);
        await this.kept.drop(name);
        await q("UPDATE net.merges SET status = 'done', done_at = now() WHERE id = $1::uuid", [row.id]);
      } catch (err) {
        this.ctx.log.warn({ error: loggable(err) }, 'Could not remove a database a restore kept or a machine uploaded. Trying again in a minute.');
      }
    }
  }
}
