import { randomBytes } from 'node:crypto';
import { renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { Config } from '../../config.js';
import { decryptSecret, encryptSecret } from '../../crypto/secrets.js';
import type { Db } from '../../db/client.js';
import { machines, publicLinks } from '../../db/schema.js';
import { idOnly } from '../../db/selections.js';
import { loggable } from '../../errors.js';
import { linkMode, readLinkMode } from '../tls/store.js';
import { Relay, type Bound, type NameCheck } from './relay.js';
import { Settings, type TunnelSettings } from './tunnel.js';

export type LinkView = { name: string; url: string };

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/* The tunnel's settings in the control folder: the updater keeps a copy with each backup, and the installer reads the
   link's address from it. frpc itself goes by what the keeper reads from the database. */
export const TUNNEL_FILE = 'tunnel.json';

/* The company's link as people have it. A hidden name, which Hornhoof took by itself so the company's machines can
   keep copies, is no link to anyone: no page is served under it, and Settings offers to turn a link on. */
export async function linkOf(db: Db): Promise<LinkView | null> {
  const [row] = await db.select({ name: publicLinks.name, url: publicLinks.url, hidden: publicLinks.hidden }).from(publicLinks).limit(1);
  return row && !row.hidden ? { name: row.name, url: row.url } : null;
}

/* The address people and machines reach this Hornhoof at: its public link once it has one, PUBLIC_URL otherwise. */
export async function publicUrl(db: Db, config: Config): Promise<string> {
  return (await linkOf(db))?.url ?? config.publicUrl;
}

/* Keeps a link the relay just gave, in place of the one before. hidden: a name the machines use and people do not. */
export async function saveLink(tx: Db | Tx, config: Config, companyId: string, bound: Bound, hidden = false): Promise<void> {
  const row = { name: bound.name, url: bound.url, hidden, keyEnc: encryptSecret(bound.key, config.secret), tunnelEnc: encryptSecret(JSON.stringify(bound.tunnel), config.secret) };
  /* A new link has a key no machine that left ever knew, so a change of key that was under way has nothing left to do. */
  await tx.insert(publicLinks).values({ companyId, ...row }).onConflictDoUpdate({ target: publicLinks.companyId, set: { ...row, nextKeyEnc: null, createdAt: new Date() } });
}

async function settingsWith(db: Db, config: Config, modeOf: typeof linkMode): Promise<TunnelSettings | null> {
  const [row] = await db.select().from(publicLinks).limit(1);
  if (!row) return null;
  return Settings.parse({
    url: row.url, name: row.name, key: decryptSecret(row.keyEnc, config.secret), tunnel: JSON.parse(decryptSecret(row.tunnelEnc, config.secret)) as unknown, mode: await modeOf(db, config),
    hidden: row.hidden,
  });
}

/* What the keeper runs frpc with. A failed read of any table throws and never reads as a change, so frpc stays as it is. */
export function tunnelSettings(db: Db, config: Config): Promise<TunnelSettings | null> {
  return settingsWith(db, config, readLinkMode);
}

/* Writes the tunnel's settings for the link the database holds, or takes them away, written whole and then moved so
   nobody reads half a file. It holds the link's key, so only this container's user reads it. */
export async function writeTunnelSettings(db: Db, config: Config, log?: FastifyBaseLogger): Promise<void> {
  const file = join(config.controlDir, TUNNEL_FILE);
  const settings = await settingsWith(db, config, (from, settingsOf) => linkMode(from, settingsOf, log));
  if (!settings) return rmSync(file, { force: true });
  rmSync(`${file}.new`, { force: true });
  writeFileSync(`${file}.new`, JSON.stringify(settings), { mode: 0o600 });
  renameSync(`${file}.new`, file);
}

/* The company's link at hornhoof.org: asking the relay for it, changing and removing it, and the tunnel settings that
   follow it. Changes go one at a time, so two people renaming at once do not leave a link nobody keeps. */
export class PublicLinks {
  readonly relay: Relay;
  private queue: Promise<unknown> = Promise.resolve();
  private hiddenFails = false;

  constructor(private readonly ctx: { db: Db; config: Config; log: FastifyBaseLogger; tls?: { kick(): void } }) {
    this.relay = new Relay(ctx.config.relayUrl);
  }

  /* What a link's address ends in, as people see it before they have one. */
  domain(): string {
    return new URL(this.ctx.config.relayUrl).hostname;
  }

  check(name: string): Promise<NameCheck> {
    return this.relay.check(name);
  }

  private inTurn<T>(run: () => Promise<T>): Promise<T> {
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => {});
    return next;
  }

  /* A link with this name, or a random one: the new link comes first, then the old one goes. A name the company has
     already changes nothing. A name over a hidden one replaces it, as any rename does. */
  set(companyId: string, name?: string): Promise<LinkView> {
    return this.inTurn(() => this.change(companyId, name, false));
  }

  /* A hidden name for a company that has no link at all: the relay picks it, and nobody but the company's machines
     ever uses it. True once the company has a link row, hidden or not; false while the relay does not give one. */
  ensureHidden(companyId: string): Promise<boolean> {
    return this.inTurn(async () => {
      const [old] = await this.ctx.db.select({ name: publicLinks.name }).from(publicLinks).where(eq(publicLinks.companyId, companyId));
      if (old) return true;
      try {
        await this.change(companyId, undefined, true);
        this.hiddenFails = false;
        return true;
      } catch (err) {
        /* Said once an outage: the ranking asks again each minute. */
        if (!this.hiddenFails) this.ctx.log.warn({ error: loggable(err) }, "Could not make the company's hidden name at the relay yet. Each ranking tries again.");
        this.hiddenFails = true;
        return false;
      }
    });
  }

  /* Asks the relay for the new name, keeps it, and lets the old one go. In turn with every other change. first: the
     old name is let go before the new one is kept, and a relay that does not take that changes nothing: for a link a
     person removes, whose name must not stay taken with a key nobody holds. */
  private async change(companyId: string, name: string | undefined, hidden: boolean, first = false): Promise<LinkView> {
    const [old] = await this.ctx.db.select().from(publicLinks).where(eq(publicLinks.companyId, companyId));
    if (old && !hidden && !old.hidden && name === old.name) return { name: old.name, url: old.url };
    const bound = await this.relay.bind(hidden ? undefined : name);
    try {
      if (old && first) await this.relay.unbind(old.name, decryptSecret(old.keyEnc, this.ctx.config.secret));
      await saveLink(this.ctx.db, this.ctx.config, companyId, bound, hidden);
    } catch (err) {
      await this.letGo(bound.name, bound.key);
      throw err;
    }
    await this.writeSettings();
    this.ctx.tls?.kick();
    if (old && !first) await this.letGo(old.name, decryptSecret(old.keyEnc, this.ctx.config.secret));
    return { name: bound.name, url: bound.url };
  }

  /* The relay lets the link go first, so a link it still holds is never forgotten here. While another machine keeps a
     copy, the copies and the server tell each other through a name at the relay who holds the latest changes: a
     hidden name is taken, the public one is let go, and only then is the hidden one kept in its place. A hidden name
     stays while it is needed. */
  remove(companyId: string): Promise<void> {
    return this.inTurn(async () => {
      const [old] = await this.ctx.db.select().from(publicLinks).where(eq(publicLinks.companyId, companyId));
      if (!old) return;
      const { db, config } = this.ctx;
      const others = sql`${machines.networkId} IS DISTINCT FROM ${config.machineId}`;
      const [copy] = await db.select(idOnly(machines)).from(machines).where(and(eq(machines.role, 'data'), isNull(machines.revokedAt), others)).limit(1);
      if (copy) {
        if (!old.hidden) await this.change(companyId, undefined, true, true);
        return;
      }
      await this.relay.unbind(old.name, decryptSecret(old.keyEnc, this.ctx.config.secret));
      await this.ctx.db.delete(publicLinks).where(eq(publicLinks.companyId, companyId));
      await this.writeSettings();
      this.ctx.tls?.kick();
    });
  }

  /* Starts a change of the link's key, in the transaction that makes it needed: the new key is kept beside the old one,
     sealed the same way, before the relay is asked, so an answer lost on the way never leaves the company with no key
     that works. One that is under way already is the one that goes on. */
  async startKey(tx: Db | Tx): Promise<void> {
    const [row] = await tx.select({ companyId: publicLinks.companyId, nextKeyEnc: publicLinks.nextKeyEnc }).from(publicLinks).limit(1).for('update');
    if (!row || row.nextKeyEnc) return;
    await tx.update(publicLinks).set({ nextKeyEnc: encryptSecret(randomBytes(32).toString('base64url'), this.ctx.config.secret) }).where(eq(publicLinks.companyId, row.companyId));
  }

  /* One try to finish a change of key. The relay is asked with the new key first: when it takes it, an earlier ask went
     through and only its answer was lost. When it refuses it, the change is asked for with the key the link has.
     none: no change is under way. later: the relay did not answer, and the next try does the same. */
  finishKey(): Promise<'done' | 'none' | 'later'> {
    return this.inTurn(async () => {
      const { db, config } = this.ctx;
      const [row] = await db.select().from(publicLinks).limit(1);
      if (!row?.nextKeyEnc) return 'none';
      const next = decryptSecret(row.nextKeyEnc, config.secret);
      const taken = await this.relay.route(row.name, next);
      if (!taken.known) {
        if (taken.why !== 'refused') return 'later';
        const changed = await this.relay.changeKey(row.name, decryptSecret(row.keyEnc, config.secret), next).then(() => true, () => false);
        if (!changed) return 'later';
      }
      await db.update(publicLinks).set({ keyEnc: row.nextKeyEnc, nextKeyEnc: null }).where(and(eq(publicLinks.companyId, row.companyId), eq(publicLinks.nextKeyEnc, row.nextKeyEnc)));
      await this.writeSettings();
      return 'done';
    });
  }

  /* A link Hornhoof no longer keeps is let go at the relay, when it answers; otherwise its name stays taken there. */
  async letGo(name: string, key: string): Promise<void> {
    await this.relay.unbind(name, key).catch(err => this.ctx.log.warn({ error: loggable(err), name }, 'Could not let the old public link go at the relay.'));
  }

  /* The tunnel's settings for the link the database holds, true once they are written. In turn with the changes of the
     link, so a write that read the link before a change cannot land after the change's own. */
  sync(): Promise<boolean> {
    return this.inTurn(() => this.writeSettings());
  }

  /* A control folder that cannot be written, as when Hornhoof runs outside compose, goes to the log: the keeper reads the
     link from the database, so the link works on. */
  private async writeSettings(): Promise<boolean> {
    try {
      await writeTunnelSettings(this.ctx.db, this.ctx.config, this.ctx.log);
      return true;
    } catch (err) {
      this.ctx.log.error({ error: loggable(err) }, 'Could not write the tunnel settings for the public link.');
      return false;
    }
  }
}
