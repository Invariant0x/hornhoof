import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join, matchesGlob, relative, resolve, sep } from 'node:path';
import { Command, RepositoryPath } from '@hornhoof/protocol';
import { z } from 'zod';

/* The test services a repository declares for the checks run in it (#2091): each kept warm, one set per machine, and a
   piece of each given to one run, made and dropped by the commands declared here. Hornhoof knows no service: a SQL or other
   database, a queue or a cache is what its commands make it. In a file of its own, as test-environment.json is strict and a
   node before this one would refuse a key it does not know. */
export const WARM_SERVICES = '.hornhoof/warm-services.json';

const EnvName = z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/);
const Globs = z.array(RepositoryPath).max(1000);
export const WarmService = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/),
  /* Runs while the service is up: the node starts it once for the machine, and again when it ends. {state} is the folder
     the machine keeps for the service. None for one that is only what its build made, as files a run reads. */
  start: Command.optional(),
  /* Ends with 0 once the service answers; with start, and only with it. */
  ready: Command.optional(),
  /* What every piece is made from, as a migrated template database: made once for each digest of its inputs, {digest}. */
  build: z.strictObject({ inputs: Globs.min(1), command: Command }).optional(),
  /* One run's own piece, {piece}, made from the build of the run's own inputs. create prints the variables the run gets, one
     NAME=value a line, of those env names; list prints the pieces there are, one a line. */
  piece: z.strictObject({ create: Command, drop: Command, list: Command, env: z.array(EnvName).min(1).max(16) }),
  /* The runs that need it: of one of these programs, with a test file of these, or with none in a folder that has them. */
  uses: z.strictObject({ programs: z.array(z.string().regex(/^[A-Za-z0-9._-]{1,64}$/)).min(1).max(64), files: Globs.min(1), without: Globs.optional() }),
});
export type WarmService = z.infer<typeof WarmService>;
export const WarmServices = z.strictObject({ version: z.literal(1), services: z.array(WarmService).max(16) })
  .refine(value => new Set(value.services.map(service => service.id)).size === value.services.length, 'Service identifiers must be distinct.')
  .refine(value => value.services.every(service => !service.start === !service.ready), 'A service that starts says when it is ready, and only one that starts.');
export type WarmServices = z.infer<typeof WarmServices>;

/* The repository a check runs in, as the folder above its own that declares the services, or none. */
export function declaringRepository(cwd: string): string | null {
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    if (existsSync(join(dir, WARM_SERVICES))) return dir;
    if (existsSync(join(dir, '.git')) || dirname(dir) === dir) return null;
  }
}

export function readWarmServices(repository: string): WarmServices {
  const parsed = WarmServices.safeParse(JSON.parse(readFileSync(join(repository, WARM_SERVICES), 'utf8')));
  if (!parsed.success) throw new Error(`${WARM_SERVICES} is not valid: ${parsed.error.issues[0]?.message ?? 'unknown problem'}.`);
  return parsed.data;
}

/* The name a program goes by in a command: its file's, without a script's extension. */
const programName = (word: string) => basename(word).replace(/\.(?:c|m)?js$/, '');
const INTERPRETERS = new Set(['node', 'npx', 'npm', 'pnpm', 'yarn', 'bun', 'exec']);

/* The program a check runs, past node, npx and the like that start it; the words after it are its own. */
function program(command: readonly string[]): { name: string; rest: readonly string[] } | null {
  for (let i = 0; i < command.length; i++) {
    const word = command[i]!;
    if (word.startsWith('-')) continue;
    const name = programName(word);
    if (!INTERPRETERS.has(name)) return { name, rest: command.slice(i + 1) };
  }
  return null;
}

const inRepository = (path: string) => path !== '' && !path.startsWith('..') && !path.startsWith(sep);
const toPosix = (path: string) => path.split(sep).join('/');
const matches = (path: string, globs: readonly string[] | undefined) => (globs ?? []).some(glob => matchesGlob(path, glob));
/* Where a glob's files are: the folders before its first pattern. */
const globBase = (glob: string) => glob.split('/').filter((_part, i, parts) => !parts.slice(0, i + 1).some(part => /[*?[{]/.test(part))).join('/');

/* Whether a run in cwd of these words needs the service. A word that names a file counts for it when it is one of the
   service's test files, and against it when it is not; a word that only filters, as a part of a name does, cannot show the
   run keeps off the service's files, so it needs it. With no file named, a run in a folder that has some of them needs it. */
function usesService(service: WarmService, repository: string, cwd: string, words: readonly string[]): boolean {
  const here = toPosix(relative(repository, cwd));
  const named = words.filter(word => !word.startsWith('-') && !['run', 'watch', 'test', 'related'].includes(word));
  if (!named.length) return service.uses.files.some(glob => { const base = globBase(glob); return here === '' || base === here || base.startsWith(`${here}/`) || here.startsWith(`${base}/`); });
  return named.some(word => {
    const path = toPosix(relative(repository, resolve(cwd, word)));
    if (!inRepository(path) || !existsSync(join(repository, path))) return true;
    return matches(path, service.uses.files) && !matches(path, service.uses.without);
  });
}

/* The services of the declaration a check needs: none for a program none of them names. */
export function servicesNeeded(declaration: WarmServices, repository: string, cwd: string, command: readonly string[]): WarmService[] {
  const run = program(command);
  if (!run) return [];
  return declaration.services.filter(service => service.uses.programs.includes(run.name) && usesService(service, repository, cwd, run.rest));
}
