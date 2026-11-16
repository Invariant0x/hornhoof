import { hkdfSync, timingSafeEqual } from 'node:crypto';
import type { Config } from '../../config.js';
import type { Db } from '../../db/client.js';
import { companies } from '../../db/schema.js';
import { idOnly } from '../../db/selections.js';
import { publicUrl } from '../link/link.js';

/* The code in the setup link: only whoever has it creates the company and its owner. It is derived from
   HORNHOOF_SECRET, so it stays the same across restarts without being stored anywhere, and only someone who reads the
   server's log or .env learns it. Once a company exists it opens nothing. */
export function setupCode(secret: Buffer): string {
  return Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), 'hornhoof setup code', 18)).toString('base64url');
}

export function isSetupCode(secret: Buffer, given: string): boolean {
  const want = Buffer.from(setupCode(secret));
  const got = Buffer.from(given);
  return got.length === want.length && timingSafeEqual(got, want);
}

export async function setupNeeded(db: Db): Promise<boolean> {
  const [company] = await db.select(idOnly(companies)).from(companies).limit(1);
  return !company;
}

/* The link that sets this Hornhoof up, while it is not set up yet. */
export async function setupLink(db: Db, config: Config): Promise<string | null> {
  return (await setupNeeded(db)) ? `${await publicUrl(db, config)}/setup?code=${setupCode(config.secret)}` : null;
}
