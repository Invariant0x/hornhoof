import { realpathSync } from 'node:fs';
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

/* Brings the database up to this build and says so in one line. Nothing else starts the migrations, so the app and the
   keeper open the database knowing the schema is already there. */
export async function runMigrate(env: NodeJS.ProcessEnv, print: (line: string) => void): Promise<number> {
  if (!env.DATABASE_URL) {
    print('DATABASE_URL is not set.');
    return 1;
  }
  try {
    print(`The database is up to this build: ${await migrateDb(env.DATABASE_URL)} migrations.`);
    return 0;
  } catch (err) {
    print(`Could not bring the database up to this build: ${reasonOf(err)}`);
    return 1;
  }
}

const entry = process.argv[1] ? realpathSync(process.argv[1]) : '';
if (entry === fileURLToPath(import.meta.url)) {
  process.exit(await runMigrate(process.env, line => console.log(line)));
}
