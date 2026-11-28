import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { WARM_SERVICES, type WarmServices as Declaration } from '../src/warm-declaration.js';
import { WarmServices } from '../src/warm-services.js';
import { eventually } from '../../../test-support/eventually.mjs';

/* #2091: the services a repository declares for its tests, kept warm once for the machine, and a piece of each for a run. */

const FAKE = fileURLToPath(new URL('./fakes/warm-service.mjs', import.meta.url));
const OWNER = fileURLToPath(new URL('./fakes/warm-owner.ts', import.meta.url));
const fake = (what: string, ...args: string[]) => ({ program: process.execPath, args: [FAKE, what, '{state}', ...args], cwd: '.' });
const VITEST = ['node', '/repo/node_modules/vitest/vitest.mjs', 'run'];

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const clean of cleanups.splice(0).reverse()) await clean(); });

function declaration(over: Partial<Declaration['services'][number]> = {}): Declaration {
  return { version: 1, services: [{
    id: 'db', start: fake('start'), ready: fake('ready'),
    build: { inputs: ['apps/server/drizzle/**'], command: fake('build', '{digest}') },
    piece: { create: fake('create', '{digest}', '{piece}'), drop: fake('drop', '{piece}'), list: fake('list'), env: ['FAKE_PIECE', 'FAKE_URL'] },
    uses: { programs: ['vitest'], files: ['apps/server/test/**/*.test.ts'], without: ['apps/server/test/pure/**'] },
    ...over,
  }] };
}

/* A repository that declares the fake service, with a test file that needs it, one that does not, and its inputs. */
function repository(declared = declaration()) {
  const dir = mkdtempSync(join(tmpdir(), 'hh-warm-repo-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  for (const file of ['apps/server/test/a.test.ts', 'apps/server/test/pure/b.test.ts', 'apps/server/drizzle/0001.sql', 'apps/node/test/c.test.ts']) {
    mkdirSync(join(dir, file, '..'), { recursive: true });
    writeFileSync(join(dir, file), `// ${file}\n`);
  }
  mkdirSync(join(dir, '.git'));
  mkdirSync(join(dir, '.hornhoof'));
  writeFileSync(join(dir, WARM_SERVICES), JSON.stringify(declared));
  return { dir, server: join(dir, 'apps/server') };
}

/* The machine's folder for warm services, and the node's services in it. */
function machine(options: Partial<ConstructorParameters<typeof WarmServices>[0]> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'hh-warm-machine-'));
  const warm = new WarmServices({ root, user: null, sweepMs: 0, ...options });
  cleanups.push(async () => { await warm.close({ stopServices: true }); rmSync(root, { recursive: true, force: true }); });
  /* The service's own folder, {state}, in the node's records of it. */
  const state = () => { const [name] = readdirSync(root).filter(entry => entry.startsWith('db-')); return join(root, name!, 'service'); };
  const lines = (file: string) => existsSync(join(state(), file)) ? readFileSync(join(state(), file), 'utf8').split('\n').filter(Boolean) : [];
  const pieces = () => existsSync(join(state(), 'pieces')) ? readdirSync(join(state(), 'pieces')).sort() : [];
  return { root, warm, state, lines, pieces };
}

const signal = () => new AbortController().signal;

describe('warm test services (#2091)', () => {
  it.skipIf(process.getuid?.() !== 0)('runs with a separate job uid and keeps supervisor records private', async () => {
    const repo = repository();
    chmodSync(repo.dir, 0o755);
    const m = machine({ user: { uid: 1000, gid: 1000 } });
    const piece = await m.warm.pieceFor(repo.server, [...VITEST, 'test/a.test.ts'], 'lease-uid', AbortSignal.timeout(8000));
    expect(piece?.env.FAKE_PIECE).toBeTruthy();
    expect(statSync(m.state()).uid).toBe(1000);
    expect(statSync(join(dirname(m.state()), 'service.json')).mode & 0o077).toBe(0);
    await piece?.drop();
  });

  it('gives two runs at once their own pieces of one service it starts once', async () => {
    const repo = repository(), m = machine();
    const [one, two] = await Promise.all([
      m.warm.pieceFor(repo.server, [...VITEST, 'test/a.test.ts'], 'lease-1', signal()),
      m.warm.pieceFor(repo.server, [...VITEST, 'test/a.test.ts'], 'lease-2', signal()),
    ]);
    expect(one?.env.FAKE_PIECE).toMatch(/^hh_[0-9a-f]{12}$/);
    expect(two?.env.FAKE_PIECE).toMatch(/^hh_[0-9a-f]{12}$/);
    expect(one!.env.FAKE_PIECE).not.toBe(two!.env.FAKE_PIECE);
    expect(one!.env.FAKE_URL).toBe(`fake://${one!.env.FAKE_PIECE}`);
    expect(m.lines('starts')).toHaveLength(1);
    expect(m.pieces()).toEqual([one!.env.FAKE_PIECE, two!.env.FAKE_PIECE].sort());
  });

  it('drops a run\'s piece when the run ends, and keeps the service warm for the next one', async () => {
    const repo = repository(), m = machine();
    const piece = await m.warm.pieceFor(repo.server, [...VITEST, 'test/a.test.ts'], 'lease-1', signal());
    await piece!.drop();
    expect(m.pieces()).toEqual([]);
    expect(m.lines('dropped')).toEqual([piece!.env.FAKE_PIECE]);
    const next = await m.warm.pieceFor(repo.server, [...VITEST], 'lease-2', signal());
    expect(next?.env.FAKE_PIECE).toMatch(/^hh_/);
    expect(m.lines('starts')).toHaveLength(1);
  });

  it('gives a run only the variables the service declares, and drops a piece whose making printed others', async () => {
    const repo = repository(declaration({ piece: { ...declaration().services[0]!.piece, env: ['FAKE_PIECE'] } })), m = machine();
    await expect(m.warm.pieceFor(repo.server, [...VITEST, 'test/a.test.ts'], 'lease-1', signal())).rejects.toThrow(/FAKE_URL is not a variable db declares/);
    expect(m.pieces()).toEqual([]);
  });

  it('needs no service for a program or test file the declaration does not name, and starts none', async () => {
    const repo = repository(), m = machine();
    expect(await m.warm.pieceFor(repo.server, ['node', '/repo/node_modules/typescript/bin/tsc', '--noEmit'], 'lease-1', signal())).toBeNull();
    expect(await m.warm.pieceFor(repo.server, [...VITEST, 'test/pure/b.test.ts'], 'lease-2', signal())).toBeNull();
    expect(await m.warm.pieceFor(join(repo.dir, 'apps/node'), [...VITEST], 'lease-3', signal())).toBeNull();
    expect(await m.warm.pieceFor(tmpdir(), [...VITEST], 'lease-4', signal())).toBeNull();
    expect(readdirSync(m.root)).toEqual([]);
  });

  it('answers a run that needs no service at once while the service is still coming up', async () => {
    const never = { program: process.execPath, args: ['-e', 'process.exit(1)'], cwd: '.' };
    const repo = repository(declaration({ ready: never })), m = machine({ readyMs: 5_000 });
    const waiting = m.warm.pieceFor(repo.server, [...VITEST, 'test/a.test.ts'], 'lease-1', signal());
    void waiting.catch(() => {});
    const at = Date.now();
    expect(await m.warm.pieceFor(repo.server, ['node', '/repo/node_modules/typescript/bin/tsc', '--noEmit'], 'lease-2', signal())).toBeNull();
    expect(await m.warm.pieceFor(repo.server, [...VITEST, 'test/pure/b.test.ts'], 'lease-3', signal())).toBeNull();
    expect(Date.now() - at).toBeLessThan(1_000);
    await expect(waiting).rejects.toThrow(/did not answer/);
  });

  it('gives pieces of a service with nothing to start from its build alone', async () => {
    const made = { program: process.execPath, args: ['-e', 'process.stdout.write(`FAKE_PIECE=${process.argv[1]}\\nFAKE_URL=file://${process.argv[2]}\\n`)', '{piece}', '{state}/{digest}'], cwd: '.' };
    const none = { program: process.execPath, args: ['-e', ''], cwd: '.' };
    const repo = repository(declaration({ start: undefined, ready: undefined, piece: { create: made, drop: none, list: none, env: ['FAKE_PIECE', 'FAKE_URL'] } })), m = machine();
    const piece = await m.warm.pieceFor(repo.server, [...VITEST, 'test/a.test.ts'], 'lease-1', signal());
    const [digest] = m.lines('builds');
    expect(piece?.env.FAKE_URL).toBe(`file://${m.state()}/${digest}`);
    expect(m.lines('starts')).toEqual([]);
  });

  it('builds once for a digest however many runs ask, and once more when an input changes', async () => {
    const repo = repository(), m = machine();
    const first = await Promise.all([1, 2, 3].map(n => m.warm.pieceFor(repo.server, [...VITEST, 'test/a.test.ts'], `lease-${n}`, signal())));
    expect(m.lines('builds')).toHaveLength(1);
    await Promise.all(first.map(piece => piece!.drop()));
    writeFileSync(join(repo.dir, 'apps/server/drizzle/0002.sql'), 'create table t();\n');
    await Promise.all([4, 5].map(n => m.warm.pieceFor(repo.server, [...VITEST, 'test/a.test.ts'], `lease-${n}`, signal())));
    const builds = m.lines('builds');
    expect(builds).toHaveLength(2);
    expect(builds[0]).not.toBe(builds[1]);
    expect(builds.every(digest => /^[0-9a-f]{64}$/.test(digest))).toBe(true);
  });

  it('builds from an input named as a plain file, and again when that file changes', async () => {
    const repo = repository(declaration({ build: { inputs: ['apps/server/drizzle/0001.sql', 'apps/server/missing.json'], command: fake('build', '{digest}') } }));
    const m = machine();
    await (await m.warm.pieceFor(repo.server, [...VITEST, 'test/a.test.ts'], 'lease-1', signal()))!.drop();
    writeFileSync(join(repo.dir, 'apps/server/drizzle/0001.sql'), 'create table t();\n');
    await (await m.warm.pieceFor(repo.server, [...VITEST, 'test/a.test.ts'], 'lease-2', signal()))!.drop();
    const builds = m.lines('builds');
    expect(builds).toHaveLength(2);
    expect(builds[0]).not.toBe(builds[1]);
  });

  it('starts the service again when it dies', async () => {
    const repo = repository(), m = machine();
    await m.warm.pieceFor(repo.server, [...VITEST], 'lease-1', signal());
    const [pid] = m.lines('starts');
    process.kill(Number(pid), 'SIGKILL');
    await eventually(() => m.lines('starts').length === 2);
    const piece = await m.warm.pieceFor(repo.server, [...VITEST], 'lease-2', signal());
    expect(piece?.env.FAKE_PIECE).toMatch(/^hh_/);
  });

  it('fails a run whose service does not answer in time, and makes no piece of it', async () => {
    const never = { program: process.execPath, args: ['-e', 'process.exit(1)'], cwd: '.' };
    const repo = repository(declaration({ ready: never })), m = machine({ readyMs: 300 });
    await expect(m.warm.pieceFor(repo.server, [...VITEST], 'lease-1', signal())).rejects.toThrow(/db did not answer within 0\.3 s/);
    expect(m.pieces()).toEqual([]);
  });

  it('sweeps the piece of a run whose node was killed, and keeps live pieces and what is not its own', async () => {
    const repo = repository(), m = machine();
    const live = await m.warm.pieceFor(repo.server, [...VITEST], 'lease-live', signal());
    /* Another node on the machine makes a piece and is killed before its run ends. */
    const other = spawn(process.execPath, ['--import', 'tsx', OWNER, m.root, repo.server], { stdio: ['ignore', 'pipe', 'inherit'] });
    let said = '';
    other.stdout.on('data', chunk => { said += String(chunk); });
    await eventually(() => /^hh_[0-9a-f]{12}\n/.test(said));
    const orphan = said.trim();
    expect(m.pieces()).toContain(orphan);
    other.kill('SIGKILL');
    await new Promise(resolve => other.once('exit', resolve));

    expect(await m.warm.sweep()).toBe(1);
    expect(m.pieces()).toEqual([live!.env.FAKE_PIECE]);
    expect(m.lines('dropped')).toEqual([orphan]);
  });

  it('sweeps on start what a node before it left on the machine', async () => {
    const repo = repository(), m = machine();
    await m.warm.pieceFor(repo.server, [...VITEST], 'lease-1', signal());
    await m.warm.close({ stopServices: false });
    const again = new WarmServices({ root: m.root, user: null, sweepMs: 0 });
    cleanups.push(() => again.close({ stopServices: true }));
    await again.start();
    expect(m.pieces()).toEqual([]);
  });

  it('sweeps on a timer a piece its own run could not drop', async () => {
    const repo = repository(), m = machine({ sweepMs: 50 });
    await m.warm.start();
    const piece = await m.warm.pieceFor(repo.server, [...VITEST], 'lease-1', signal());
    writeFileSync(join(m.state(), 'drop-fails'), '');
    await expect(piece!.drop()).rejects.toThrow(/could not be dropped/);
    expect(m.pieces()).toEqual([piece!.env.FAKE_PIECE]);
    rmSync(join(m.state(), 'drop-fails'));
    await eventually(() => m.lines('dropped').includes(piece!.env.FAKE_PIECE));
    expect(m.pieces()).toEqual([]);
  });
});
