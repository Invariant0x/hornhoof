import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { loadConfig, type Config } from './config.js';
import { createDb, type Db } from './db/client.js';
import { people } from './db/schema.js';
import { reinvite } from './modules/people/routes.js';

const USAGE = 'Usage: node apps/server/dist/cli.js owner-link';

type Deps = { db: Db; config: Config; print: (line: string) => void };

/* The way back in for an owner who lost the password: a one-time link that sets a new one. */
async function ownerLink({ db, config, print }: Deps): Promise<number> {
  const [owner] = await db.select({ id: people.id, companyId: people.companyId, name: people.name, email: people.email }).from(people).where(eq(people.isOwner, true));
  if (!owner) {
    print('Hornhoof is not set up yet. Open it in the browser to set it up.');
    return 1;
  }
  const { token } = await reinvite(db, owner.id, owner);
  print(`A one-time link for ${owner.name} (${owner.email}). It works for 7 days and sets a new password.`);
  print('The old password and every open session stop working now.');
  print(`${config.publicUrl}/invite/${token}`);
  return 0;
}

export async function runCli(args: string[], deps: Deps): Promise<number> {
  if (args[0] === 'owner-link') return ownerLink(deps);
  deps.print(USAGE);
  return 1;
}

const entry = process.argv[1] ? realpathSync(process.argv[1]) : '';
if (entry === fileURLToPath(import.meta.url)) {
  const config = loadConfig(process.env);
  if (!config.databaseUrl) throw new Error('DATABASE_URL is not set.');
  const db = await createDb(config.databaseUrl);
  process.exit(await runCli(process.argv.slice(2), { db, config, print: line => console.log(line) }));
}
