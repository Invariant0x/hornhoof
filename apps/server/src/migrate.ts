import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrateDb } from './db/client.js';
import { loggable } from './errors.js';

/* A drizzle error only says which query failed; the reason is in the innermost cause, or its code when it has no message (a connect to localhost on two addresses). Both pass through loggable, which
   masks any password written into an address. */
function reasonOf(err: unknown): string {
  const messages: string[] = [];
  for (let step: Record<string, unknown> | undefined = loggable(err); step; step = step.cause as Record<string, unknown> | undefined) {
    const said = step.message || step.code;
    if (said) messages.push(String(said));
  }
  return [messages[0], messages.length > 1 ? messages[messages.length - 1] : undefined].filter(Boolean).join(': ');
}

/* The marker a keeper leaves in the control folder of a machine that keeps a copy; its name is the keeper's to change. */
const REPLICA_FILE = 'replica.json';
const FOLLOWS = 'This machine keeps a copy; its schema comes from the company server.';

/* A copy's schema is the company server's, brought over when the copy is made, and its own migrations would part the
   two. So where the marker is, nothing is run, and that counts as done: the app that waits for this service starts. */
export async function migrateOrFollow(env: NodeJS.ProcessEnv, run: () => Promise<void>, print: (line: string) => void): Promise<'migrated' | 'follows'> {
  if (existsSync(join(env.HORNHOOF_CONTROL_DIR || '/control', REPLICA_FILE))) {
    print(FOLLOWS);
    return 'follows';
  }
  await run();
  return 'migrated';
}

/* Brings the database up to this build and says so in one line. Nothing else starts the migrations, so the app and the
   keeper open the database knowing the schema is already there. */
export async function runMigrate(env: NodeJS.ProcessEnv, print: (line: string) => void): Promise<number> {
  if (!env.DATABASE_URL) {
    print('DATABASE_URL is not set.');
    return 1;
  }
  const url = env.DATABASE_URL;
  try {
    await migrateOrFollow(env, async () => print(`The database is up to this build: ${await migrateDb(url)} migrations.`), print);
    return 0;
  } catch (err) {
    print(`Could not bring the database up to this build: ${reasonOf(err)}`);
    return 1;
  }
}

/* Where a keeper runs, the migrate service has brought the database up before the app starts. An app started alone, as
   the image run by hand is, has nobody to do that for it, so it does it itself, as it did before there was a keeper. */
export async function migrateWhenAlone(config: { keeper: boolean }, url: string, migrate: (url: string) => Promise<unknown> = migrateDb): Promise<void> {
  if (!config.keeper) await migrate(url);
}

const entry = process.argv[1] ? realpathSync(process.argv[1]) : '';
if (entry === fileURLToPath(import.meta.url)) {
  process.exit(await runMigrate(process.env, line => console.log(line)));
}
