/* Builds the PGlite template a machine keeps for the server's tests (#2091), as .hornhoof/warm-services.json declares it:
   once for each digest of the migrations and what they run on, into {state}/pglite/{digest}. It holds the migrated dump with
   its READY.json (prepare-environment.ts), the description of that dump the test databases read, and the dump of a database
   just made by initdb for the migration tests. Every run reads them in place (global-setup.ts, global-initdb.ts), so no run
   makes its own. Usage: pglite-build.ts BUILDS DIGEST, run from apps/server. */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { initdbDump } from '../global-initdb.js';
import { databaseMetadata, encodeDatabaseMetadata } from '../helpers-db-metadata.js';
import { preparePgliteTemplate } from '../prepare-environment.js';

/* The builds of other digests a machine keeps: a worktree on an older branch may still read one. */
const KEPT = 4;
const DIGEST = /^[0-9a-f]{16,128}$/;

async function metadataOf(dump: Buffer): Promise<string> {
  const client = new PGlite({ loadDataDir: new Blob([dump]) });
  try {
    await client.waitReady;
    return await encodeDatabaseMetadata(await databaseMetadata(client), dump);
  } finally { await client.close(); }
}

/* The oldest builds beyond KEPT go; the one just made stays whatever its age. */
function prune(builds: string, made: string): void {
  const others = readdirSync(builds).filter(name => DIGEST.test(name) && name !== made)
    .map(name => ({ name, at: statSync(join(builds, name)).mtimeMs })).sort((a, b) => b.at - a.at);
  for (const { name } of others.slice(KEPT)) rmSync(join(builds, name), { recursive: true, force: true });
}

export async function buildTemplate(builds: string, digest: string): Promise<string> {
  if (!DIGEST.test(digest)) throw new Error(`Not a digest: ${digest}.`);
  const output = join(builds, digest);
  if (existsSync(join(output, 'READY.json'))) return output;
  mkdirSync(builds, { recursive: true, mode: 0o700 });
  /* Made aside and moved in whole, so a run never reads half a template. */
  const part = `${output}.part-${process.pid}`;
  rmSync(part, { recursive: true, force: true });
  try {
    await preparePgliteTemplate(part);
    writeFileSync(join(part, 'metadata.json'), await metadataOf(readFileSync(join(part, 'migrated.tar'))));
    writeFileSync(join(part, 'initdb.tar'), await initdbDump());
    if (existsSync(output)) rmSync(part, { recursive: true, force: true });
    else renameSync(part, output);
  } catch (error) {
    rmSync(part, { recursive: true, force: true });
    throw error;
  }
  prune(builds, digest);
  return output;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [builds, digest] = process.argv.slice(2);
  if (!builds || !digest) throw new Error('Usage: pglite-build.ts BUILDS DIGEST');
  await buildTemplate(resolve(builds), digest);
}
