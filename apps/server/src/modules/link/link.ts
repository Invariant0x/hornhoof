import { renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { Config } from '../../config.js';
import { decryptSecret, encryptSecret } from '../../crypto/secrets.js';
import type { Db } from '../../db/client.js';
import { publicLinks } from '../../db/schema.js';
import { loggable } from '../../errors.js';
import { linkMode } from '../tls/store.js';
import { Relay, type Bound, type NameCheck } from './relay.js';

export type LinkView = { name: string; url: string };

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/* The tunnel container reads its settings from this file in the control folder and idles while there is none. */
export const TUNNEL_FILE = 'tunnel.json';

export async function linkOf(db: Db): Promise<LinkView | null> {
  const [row] = await db.select({ name: publicLinks.name, url: publicLinks.url }).from(publicLinks).limit(1);
  return row ?? null;
}

/* The address people and machines reach this Hornhoof at: its public link once it has one, PUBLIC_URL otherwise. */
export async function publicUrl(db: Db, config: Config): Promise<string> {
  return (await linkOf(db))?.url ?? config.publicUrl;
}

/* Keeps a link the relay just gave, in place of the one before. */
export async function saveLink(tx: Db | Tx, config: Config, companyId: string, bound: Bound): Promise<void> {
  const row = { name: bound.name, url: bound.url, keyEnc: encryptSecret(bound.key, config.secret), tunnelEnc: encryptSecret(JSON.stringify(bound.tunnel), config.secret) };
  await tx.insert(publicLinks).values({ companyId, ...row }).onConflictDoUpdate({ target: publicLinks.companyId, set: { ...row, createdAt: new Date() } });
}

/* Writes the tunnel's settings for the link the database holds, or takes them away, written whole and then moved so
   the tunnel never reads half a file. The link's key in them is for the tunnel container alone. */
export async function writeTunnelSettings(db: Db, config: Config): Promise<void> {
  const file = join(config.controlDir, TUNNEL_FILE);
  const [row] = await db.select().from(publicLinks).limit(1);
  if (!row) return rmSync(file, { force: true });
  const settings = { url: row.url, name: row.name, key: decryptSecret(row.keyEnc, config.secret), tunnel: JSON.parse(decryptSecret(row.tunnelEnc, config.secret)) as unknown, mode: await linkMode(db, config) };
  rmSync(`${file}.new`, { force: true });
  writeFileSync(`${file}.new`, JSON.stringify(settings), { mode: 0o600 });
  renameSync(`${file}.new`, file);
}

/* The company's link at hornhoof.org: asking the relay for it, changing and removing it, and the tunnel settings that
   follow it. Changes go one at a time, so two people renaming at once do not leave a link nobody keeps. */
export class PublicLinks {
  readonly relay: Relay;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly ctx: { db: Db; config: Config; log: FastifyBaseLogger }) {
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
     already changes nothing. */
  set(companyId: string, name?: string): Promise<LinkView> {
    return this.inTurn(async () => {
      const [old] = await this.ctx.db.select().from(publicLinks).where(eq(publicLinks.companyId, companyId));
      if (old && name === old.name) return { name: old.name, url: old.url };
      const bound = await this.relay.bind(name);
      try {
        await saveLink(this.ctx.db, this.ctx.config, companyId, bound);
      } catch (err) {
        await this.letGo(bound.name, bound.key);
        throw err;
      }
      await this.sync();
      if (old) await this.letGo(old.name, decryptSecret(old.keyEnc, this.ctx.config.secret));
      return { name: bound.name, url: bound.url };
    });
  }

  /* The relay lets the link go first, so a link it still holds is never forgotten here. */
  remove(companyId: string): Promise<void> {
    return this.inTurn(async () => {
      const [old] = await this.ctx.db.select().from(publicLinks).where(eq(publicLinks.companyId, companyId));
      if (!old) return;
      await this.relay.unbind(old.name, decryptSecret(old.keyEnc, this.ctx.config.secret));
      await this.ctx.db.delete(publicLinks).where(eq(publicLinks.companyId, companyId));
      await this.sync();
    });
  }

  /* A link Hornhoof no longer keeps is let go at the relay, when it answers; otherwise its name stays taken there. */
  async letGo(name: string, key: string): Promise<void> {
    await this.relay.unbind(name, key).catch(err => this.ctx.log.warn({ error: loggable(err), name }, 'Could not let the old public link go at the relay.'));
  }

  /* The tunnel's settings for the link the database holds. A control folder that cannot be written, as when Hornhoof
     runs outside compose, goes to the log: the link works once the tunnel reads the settings. */
  async sync(): Promise<void> {
    try {
      await writeTunnelSettings(this.ctx.db, this.ctx.config);
    } catch (err) {
      this.ctx.log.error({ error: loggable(err) }, 'Could not write the tunnel settings for the public link.');
    }
  }
}
