import { createHash } from 'node:crypto';
import { appendFile, open, type FileHandle } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isLinkName } from '@hornhoof/protocol/link';
import { and, eq } from 'drizzle-orm';
import { loadConfig, type Config } from './config.js';
import { APP_NAME, openDb, type Db } from './db/client.js';
import { companies, people } from './db/schema.js';
import { idOnly } from './db/selections.js';
import { ApiError } from './errors.js';
import { linkOf, publicUrl, saveLink, tunnelSettings, writeTunnelSettings } from './modules/link/link.js';
import { Relay } from './modules/link/relay.js';
import { reinvite } from './modules/people/routes.js';
import { setupLink } from './modules/setup/code.js';
import { checkThemeArchive } from './modules/themes/archive.js';
import { installedVersion, installTheme, themeBase } from './modules/themes/store.js';
import { webThemeCheck } from './modules/themes/web-check.js';
import { ArchiveRefused, fileSource } from './modules/themes/zip.js';

const USAGE = 'Usage: node apps/server/dist/cli.js owner-link | setup-link | link <name> < key-file | theme-install <archive.zip> --company <company id> [--log <file>]';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Deps = { db: Db; config: Config; print: (line: string) => void; read?: () => Promise<string>; now?: () => Date };

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
  print(`${await publicUrl(db, config)}/invite/${token}`);
  return 0;
}

/* The link with the code that sets a fresh Hornhoof up, alone on its line so install.sh can show it. */
async function printSetupLink({ db, config, print }: Deps): Promise<number> {
  const link = await setupLink(db, config);
  print(link ?? 'Hornhoof is set up already.');
  return link ? 0 : 1;
}

/* Takes over a link made before at hornhoof.org, by hand or by another install: its name comes as the argument and its
   key on the input, so the key stays out of the shell history. The relay is only asked whether it holds the name. */
async function takeLink(name: string | undefined, { db, config, print, read }: Deps): Promise<number> {
  const [company] = await db.select(idOnly(companies)).from(companies).limit(1);
  if (!company) {
    print('Hornhoof is not set up yet. Open it in the browser to set it up.');
    return 1;
  }
  const had = await linkOf(db);
  if (had) {
    print(`This Hornhoof has a link already: ${had.url}. Remove it under Share access first.`);
    return 1;
  }
  if (!name || !isLinkName(name)) {
    print(USAGE);
    return 1;
  }
  const key = ((await read?.()) ?? '').trim();
  if (key.length < 16) {
    print(`Give the key of the link on the input: node apps/server/dist/cli.js link ${name} < key-file`);
    return 1;
  }
  try {
    const found = await new Relay(config.relayUrl).check(name);
    if (found.reason !== 'taken') {
      print(`hornhoof.org has no link ${name}${found.reason === 'reserved' ? ': the name is kept or blocked there' : ''}.`);
      return 1;
    }
  } catch (err) {
    if (!(err instanceof ApiError)) throw err;
    print(err.message);
    return 1;
  }
  const relay = new URL(config.relayUrl);
  const url = `https://${name}.${relay.hostname}`;
  /* A hidden name Hornhoof took for the company's machines gives way to the link, and is let go at hornhoof.org so it
     does not stay taken there; a relay that does not answer now keeps it, which costs nothing but the name. */
  const hidden = await tunnelSettings(db, config);
  await saveLink(db, config, company.id, { name, url, key, tunnel: { serverAddr: relay.hostname, serverPort: Number(relay.port) || 443, protocol: 'wss' } });
  await writeTunnelSettings(db, config);
  if (hidden?.hidden) await new Relay(config.relayUrl).unbind(hidden.name, hidden.key).catch(() => undefined);
  print(`Hornhoof keeps the link ${url}, and the tunnel opens it in a few seconds.`);
  print('hornhoof.org carries one tunnel per link, so stop any other tunnel for this link first.');
  return 0;
}

/* The SHA-256 of a file, read a mebibyte at a time. */
async function sha256Of(handle: FileHandle): Promise<string> {
  const hash = createHash('sha256');
  const chunk = Buffer.alloc(1024 * 1024);
  for (let at = 0; ; ) {
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, at);
    if (bytesRead === 0) return hash.digest('hex');
    hash.update(chunk.subarray(0, bytesRead));
    at += bytesRead;
  }
}

const flagOf = (args: readonly string[], name: string) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};

/* Installs a theme archive for one named company by the same check and install as the store's upload (#1960), for
   when no screen does it. Every attempt is one JSON line appended to the log, theme-installs.log in the folder it runs
   in unless --log names another file: when, which company, the archive's SHA-256, and what came of it. */
async function themeInstall(args: string[], { db, print, now }: Deps): Promise<number> {
  const [path] = args;
  const companyId = flagOf(args, '--company');
  if (!path || path.startsWith('--') || !companyId || !UUID.test(companyId)) {
    print(USAGE);
    return 1;
  }
  const logFile = resolve(flagOf(args, '--log') ?? 'theme-installs.log');
  const record = async (entry: Record<string, unknown>) => {
    const line = JSON.stringify({ at: (now?.() ?? new Date()).toISOString(), companyId, archive: resolve(path), ...entry });
    await appendFile(logFile, `${line}\n`, { mode: 0o600 });
    print(`THEME_INSTALL ${line}`);
  };
  const [company] = await db.select({ id: companies.id }).from(companies).where(eq(companies.id, companyId));
  const [owner] = company ? await db.select({ id: people.id }).from(people).where(and(eq(people.companyId, company.id), eq(people.isOwner, true))) : [];
  if (!company || !owner) {
    await record({ result: 'refused', reason: company ? 'The company has no owner to install it in the name of.' : 'There is no such company.' });
    return 1;
  }
  const handle = await open(path, 'r');
  try {
    const sha256 = await sha256Of(handle);
    try {
      const theme = await checkThemeArchive(await fileSource(handle), await webThemeCheck(), manifest => themeBase(manifest.id, manifest.version));
      const { id, version } = theme.manifest;
      if ((await installedVersion(db, company.id, id)) === version) {
        await record({ sha256, result: 'refused', problem: { code: 'same_version', path: 'theme.json' }, theme: id, version });
        return 1;
      }
      await installTheme(db, company.id, owner.id, theme);
      await record({ sha256, result: 'installed', theme: id, version, files: theme.files.length, size: theme.size, installedBy: owner.id });
      return 0;
    } catch (err) {
      if (!(err instanceof ArchiveRefused)) throw err;
      await record({ sha256, result: 'refused', problem: err.problem });
      return 1;
    }
  } finally {
    await handle.close();
  }
}

export async function runCli(args: string[], deps: Deps): Promise<number> {
  if (args[0] === 'theme-install') return themeInstall(args.slice(1), deps);
  if (args[0] === 'owner-link') return ownerLink(deps);
  if (args[0] === 'setup-link') return printSetupLink(deps);
  if (args[0] === 'link') return takeLink(args[1], deps);
  deps.print(USAGE);
  return 1;
}

const entry = process.argv[1] ? realpathSync(process.argv[1]) : '';
if (entry === fileURLToPath(import.meta.url)) {
  const config = loadConfig(process.env);
  if (!config.databaseUrl) throw new Error('DATABASE_URL is not set.');
  const db = openDb(config.databaseUrl, APP_NAME, { fenced: config.keeper });
  const read = async () => {
    let text = '';
    for await (const chunk of process.stdin) text += String(chunk);
    return text;
  };
  process.exit(await runCli(process.argv.slice(2), { db, config, print: line => console.log(line), read }));
}
