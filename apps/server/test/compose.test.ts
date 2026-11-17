import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, onTestFinished } from 'vitest';
import { parse } from 'yaml';
import { loadConfig } from '../src/config.js';

type DependsOn = Record<string, { condition: string; required?: boolean }> | string[];
type Service = {
  image?: string;
  command?: string[];
  restart?: string;
  ports?: string[];
  volumes?: string[];
  networks?: string[];
  depends_on?: DependsOn;
  environment?: Record<string, string>;
  security_opt?: string[];
};
function hasCompose(): boolean {
  try {
    execFileSync('docker', ['compose', 'version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const composePath = fileURLToPath(new URL('../../../compose.yaml', import.meta.url));
const composeText = readFileSync(composePath, 'utf8');
const compose = parse(composeText) as { services: Record<string, Service> };
const { front, keeper, migrate, app, db } = compose.services as Record<string, Service>;

/* Compose fills `${NAME:-default}` when NAME is unset or empty, and stops on `${NAME:?message}` then. */
function fill(value: string, env: Record<string, string>): string {
  return value.replace(/\$\{(\w+):([-?])([^}]*)\}/g, (_all, name: string, kind: string, rest: string) => {
    const set = env[name];
    if (set) return set;
    if (kind === '-') return rest;
    throw new Error(`${name} is required`);
  });
}

const filled = (service: Service, env: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.entries(service.environment ?? {}).map(([key, value]) => [key, fill(String(value), env)]));

const REQUIRED = { HORNHOOF_SECRET: Buffer.alloc(32, 7).toString('base64'), NODE_KEY: 'k'.repeat(40) };
const FULL_ENV = {
  ...REQUIRED,
  POSTGRES_PASSWORD: 'pw',
  ACME_DIRECTORY: 'https://acme.hornhoof.test/directory',
  RELAY_URL: 'https://relay.hornhoof.test',
  HORNHOOF_MACHINE_ID: 'a1b2c3d4'.repeat(4),
};

describe('the web port', () => {
  it('is published by front alone: the keeper only hears its number, to report it', () => {
    expect(compose.services.tunnel).toBeUndefined();
    expect(front!.ports).toEqual(['${HORNHOOF_PORT:-8080}:8080']);
    expect(app!.ports).toBeUndefined();
    for (const [name, service] of Object.entries(compose.services)) {
      if (name !== 'front') expect(JSON.stringify(service.ports ?? []), name).not.toContain('HORNHOOF_PORT');
      if (name !== 'front' && name !== 'keeper') expect(JSON.stringify(service), name).not.toMatch(/HORNHOOF_PORT\b/);
    }
  });

  /* A new .env holds an empty HORNHOOF_PORT= through the pull, and only `:-` reads an empty value as unset. */
  it('falls back to its default when .env holds the name empty', () => {
    const ports = Object.values(compose.services).flatMap(service => service.ports ?? []);
    for (const port of ports) expect(port).toMatch(/^"?\$\{\w+:-\d+\}:\d+$/);
    expect(fill(front!.ports![0]!, { HORNHOOF_PORT: '' })).toBe('8080:8080');
    expect(fill(keeper!.ports![0]!, { HORNHOOF_PEER_PORT: '' })).toBe('8180:7070');
  });
});

describe('front, keeper and migrate', () => {
  it("run from the app's own image, each with its own entry point", () => {
    for (const [name, service] of Object.entries({ front, keeper, migrate })) {
      expect(service!.image).toBe(app!.image);
      expect(service!.command).toEqual(['node', `apps/server/dist/${name}.js`]);
      expect(existsSync(fileURLToPath(new URL(`../src/${name}.ts`, import.meta.url)))).toBe(true);
    }
  });

  it('gives the keeper the peer port, the database, the control folder and nothing of Docker', () => {
    expect(keeper!.ports).toEqual(['${HORNHOOF_PEER_PORT:-8180}:7070']);
    expect(Object.keys(keeper!.environment!)).toEqual([
      'DATABASE_URL', 'HORNHOOF_SECRET', 'ACME_DIRECTORY', 'RELAY_URL', 'HORNHOOF_MACHINE_ID', 'HORNHOOF_PORT', 'HORNHOOF_PEER_PORT',
      'HORNHOOF_ROLE', 'HORNHOOF_JOIN_SERVER', 'HORNHOOF_JOIN_TICKET', 'HORNHOOF_ADDRESSES', 'HORNHOOF_HOSTNAME', 'HORNHOOF_OWNER_KEY', 'HORNHOOF_HOST_OS',
      'HORNHOOF_NODE_KEY', 'HORNHOOF_SURVIVOR_S', 'HORNHOOF_LINK_PROBE',
    ]);
    /* The node's key goes into each backup under a name of the keeper's own: a NODE_KEY that is set but empty, as on a
       machine with no node of the server's, would stop the keeper as it starts. */
    expect(keeper!.environment).toMatchObject({ HORNHOOF_NODE_KEY: '${NODE_KEY:-}', HORNHOOF_SURVIVOR_S: '${HORNHOOF_SURVIVOR_S:-}', HORNHOOF_LINK_PROBE: '${HORNHOOF_LINK_PROBE:-}' });
    /* Its own volume holds the machine's key, which no other service reads. */
    expect(keeper!.volumes).toEqual(['control:/control', 'keeper:/keeper']);
    expect(Object.keys((parse(composeText) as { volumes: Record<string, unknown> }).volumes)).toContain('keeper');
    for (const [name, service] of Object.entries(compose.services)) if (name !== 'keeper') expect(JSON.stringify(service.volumes ?? []), name).not.toContain('keeper:');
    /* It hears which ports the machine publishes, to report them, and publishes the web port no more than before. */
    expect(filled(keeper!, { ...FULL_ENV, HORNHOOF_PORT: '8081', HORNHOOF_PEER_PORT: '8181' })).toMatchObject({ HORNHOOF_PORT: '8081', HORNHOOF_PEER_PORT: '8181' });
    expect(filled(keeper!, FULL_ENV)).toMatchObject({ HORNHOOF_PORT: '8080', HORNHOOF_PEER_PORT: '8180' });
    expect(JSON.stringify(keeper)).not.toContain('docker.sock');
    expect(keeper!.networks).toEqual(['default', 'internal']);
  });

  it("prepares the keeper's folder in the image as the control folder is, so a new volume is the node user's", () => {
    const dockerfile = readFileSync(fileURLToPath(new URL('../../../Dockerfile', import.meta.url)), 'utf8');
    expect(dockerfile).toMatch(/mkdir [^\n]*\/control[^\n]* \/keeper/);
    expect(dockerfile).toContain('COPY --from=deps --chown=node:node /keeper /keeper');
  });

  /* The keeper reads the link with the app's own functions, so these Config fields must come out the same in both. */
  it("gives the keeper the app's value of every setting the link is read with", () => {
    for (const env of [FULL_ENV, REQUIRED]) {
      const ofApp = loadConfig(filled(app!, env));
      const ofKeeper = loadConfig(filled(keeper!, env));
      for (const field of ['databaseUrl', 'secret', 'acmeDirectory', 'relayUrl'] as const) expect(ofKeeper[field]).toEqual(ofApp[field]);
      expect(ofKeeper.controlDir).toBe('/control');
    }
  });

  it('puts migrate ahead of the app, on the internal network alone and without a restart', () => {
    expect(app!.depends_on).toMatchObject({ migrate: { condition: 'service_completed_successfully' } });
    expect(migrate!.restart).toBe('no');
    expect(migrate!.networks).toEqual(['internal']);
  });
});

describe('the app', () => {
  it('believes only the keeper, and takes its mode from it', () => {
    expect(app!.environment!.TUNNEL_HOST).toBe('keeper');
    expect(app!.environment!.HORNHOOF_KEEPER).toBe('on');
  });

  it('starts after the database is healthy, migrate has ended well and the keeper has started', () => {
    expect(app!.depends_on).toEqual({
      db: { condition: 'service_healthy' },
      migrate: { condition: 'service_completed_successfully' },
      keeper: { condition: 'service_started' },
    });
  });
});

describe('the updater', () => {
  /* The installer's take-over runs `compose up updater` without --no-deps, which would start whatever it waited for. */
  it('waits for nothing', () => {
    expect(compose.services.updater!.depends_on).toBeUndefined();
  });
});

describe('the database', () => {
  it('starts with what logical copies need', () => {
    expect(db!.command).toEqual(['postgres', '-c', 'wal_level=logical', '-c', 'max_replication_slots=10', '-c', 'max_wal_senders=10', '-c', 'max_prepared_transactions=0']);
  });
});

describe('the compose file', () => {
  /* The updater loads the new file with the .env of the build before, and a worker's .env has no secret at all: compose
     fills every name in every service, whatever runs, so none may stop it. */
  it('loads with any .env: every name it reads has a default', () => {
    for (const [, name, kind] of composeText.matchAll(/\$\{(\w+)(:[-?])?/g)) expect(kind, name).toBe(':-');
    for (const service of Object.values(compose.services)) expect(() => filled(service, {})).not.toThrow();
  });

  it('keeps every service for a server, and the data services out on a worker', () => {
    const overlayText = readFileSync(fileURLToPath(new URL('../../../compose.worker.yaml', import.meta.url)), 'utf8');
    const overlay = parse(overlayText) as { services: Record<string, unknown> };
    expect(composeText).not.toMatch(/^\s*profiles:/m);
    /* A machine that keeps a copy turns the data services on, and still runs no built-in node: no setting names the
       profile that one is in. */
    expect(overlay.services).toEqual({ db: { profiles: ['data'] }, migrate: { profiles: ['data'] }, app: { profiles: ['data'] }, node: { profiles: ['builtin'] } });
    /* The migrate service sees whether the machine keeps a copy, and can write nothing there. */
    expect(migrate!.volumes).toEqual(['control:/control:ro']);
    expect(migrate!.environment).toMatchObject({ HORNHOOF_CONTROL_DIR: '/control' });
    /* What is left on a worker depends on nothing that is out: front on the keeper, and the keeper on the database only
       where there is one. */
    expect(front!.depends_on).toEqual(['keeper']);
    expect(keeper!.depends_on).toEqual({ db: { condition: 'service_healthy', required: false } });
    expect(compose.services.updater!.depends_on).toBeUndefined();
  });

  /* The updater takes the installers and the compose files of the build it moves to from the image, the server its
     migrations, templates and version, and the orchestrator reads the source to see how Hornhoof is made. */
  it("carries Hornhoof's files as they are in the server's image, the source with them, but the README's animations", () => {
    const dockerfile = readFileSync(fileURLToPath(new URL('../../../Dockerfile', import.meta.url)), 'utf8');
    expect(dockerfile).toMatch(/^COPY --exclude=\.github\/assets \. \.$/m);
    const ignored = readFileSync(fileURLToPath(new URL('../../../.dockerignore', import.meta.url)), 'utf8').split('\n').map(line => line.trim());
    for (const kept of ['apps', 'packages', 'templates', 'docs', 'guide', 'scripts', 'compose.yaml', 'compose.worker.yaml']) expect(ignored, kept).not.toContain(kept);
  });

  it("tells the keeper and the updater what the machine is, and the keeper where it joined", () => {
    expect(filled(keeper!, {})).toMatchObject({ HORNHOOF_ROLE: 'data', HORNHOOF_JOIN_SERVER: '', HORNHOOF_JOIN_TICKET: '', HORNHOOF_ADDRESSES: '', HORNHOOF_HOSTNAME: '', HORNHOOF_SECRET: '' });
    const worker = { HORNHOOF_ROLE: 'worker', HORNHOOF_JOIN_SERVER: 'http://192.168.1.7:8080', HORNHOOF_JOIN_TICKET: 't'.repeat(43), HORNHOOF_HOST_OS: 'linux', HORNHOOF_HEALTH_URL: 'http://keeper:7080/api/keeper' };
    expect(filled(keeper!, worker)).toMatchObject({ HORNHOOF_ROLE: 'worker', HORNHOOF_JOIN_SERVER: 'http://192.168.1.7:8080', HORNHOOF_JOIN_TICKET: 't'.repeat(43) });
    const updater = compose.services.updater!;
    expect(filled(updater, {})).toMatchObject({ HORNHOOF_ROLE: 'data', HORNHOOF_HOST_OS: '', HORNHOOF_HEALTH_URL: '' });
    expect(filled(updater, worker)).toMatchObject({ HORNHOOF_ROLE: 'worker', HORNHOOF_HOST_OS: 'linux', HORNHOOF_HEALTH_URL: 'http://keeper:7080/api/keeper' });
  });

  /* The other machines of the company dial these ports on the machine's local network, on a Mac as on Linux. */
  it('publishes its ports on every interface', () => {
    const published = Object.values(compose.services).flatMap(service => service.ports ?? []);
    expect(published).toEqual(['${HORNHOOF_PORT:-8080}:8080', '${HORNHOOF_PEER_PORT:-8180}:7070']);
  });

  /* The services compose itself lists, where Docker is there to ask. */
  it.runIf(hasCompose())('lists the core alone with both files, and every service with one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hh-compose-'));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    for (const name of ['compose.yaml', 'compose.worker.yaml']) writeFileSync(join(dir, name), readFileSync(fileURLToPath(new URL(`../../../${name}`, import.meta.url))));
    writeFileSync(join(dir, '.env'), '');
    const services = (...files: string[]) => execFileSync('docker', ['compose', ...files.flatMap(file => ['-f', file]), 'config', '--services'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n').sort();
    expect(services('compose.yaml', 'compose.worker.yaml')).toEqual(['front', 'keeper', 'updater']);
    /* A machine that keeps a copy: the database and the app with it, and no built-in node. */
    writeFileSync(join(dir, '.env'), 'COMPOSE_PROFILES=data\n');
    expect(services('compose.yaml', 'compose.worker.yaml')).toEqual(['app', 'db', 'front', 'keeper', 'migrate', 'updater']);
    writeFileSync(join(dir, '.env'), '');
    expect(services('compose.yaml')).toEqual(['app', 'db', 'front', 'keeper', 'migrate', 'node', 'updater']);
  });
});

describe("the link's certificate", () => {
  it('comes from the directory .env names, and from nothing else when that is empty', () => {
    expect(compose.services.app!.environment!.ACME_DIRECTORY).toBe('${ACME_DIRECTORY:-}');
  });
});

describe('the computer the server runs on', () => {
  it('is known to the app by the hash install.sh writes, not by the key a machine joins with', () => {
    expect(compose.services.app!.environment!.HORNHOOF_HOST_ID).toBe('${HORNHOOF_HOST_ID:-}');
  });
});

describe('the built-in node', () => {
  it("hears what the computer has from .env, as Docker on a Mac runs in a smaller system", () => {
    expect(compose.services.node!.environment).toMatchObject({
      HORNHOOF_HOST_CPU: '${HORNHOOF_HOST_CPU:-}',
      HORNHOOF_HOST_CPUS: '${HORNHOOF_HOST_CPUS:-}',
      HORNHOOF_HOST_MEMORY: '${HORNHOOF_HOST_MEMORY:-}',
    });
  });

  it('reaches the server through front, as the key of its machine', () => {
    const { node } = compose.services;
    expect(node!.environment!.HORNHOOF_SERVER).toBe('http://front:8080');
    expect(filled(node!, FULL_ENV).HORNHOOF_MACHINE_ID).toBe(FULL_ENV.HORNHOOF_MACHINE_ID);
    expect(filled(node!, REQUIRED).HORNHOOF_MACHINE_ID).toBe('');
    expect(node!.depends_on).toEqual(['front']);
  });

  it('is known to the app by the same machine id', () => {
    expect(filled(app!, FULL_ENV).HORNHOOF_MACHINE_ID).toBe(FULL_ENV.HORNHOOF_MACHINE_ID);
  });

  /* Docker's AppArmor profile on newer Linux, as Debian 13, keeps the node from stopping the programs of its jobs. */
  it('runs outside AppArmor, and still gains no new privileges', () => {
    expect(compose.services.node!.security_opt).toEqual(['no-new-privileges:true', 'apparmor:unconfined']);
  });
});

describe('the updater', () => {
  /* The orchestrator's commands on the computer run in a container of the updater's own image, which is on the computer already. */
  it('runs commands on the computer in its own image', () => {
    const { updater } = compose.services;
    expect(updater!.environment!.HORNHOOF_COMPUTER_IMAGE).toBe(updater!.image);
  });
});

describe('the real tests', () => {
  /* The two must not drift apart: what passes there has to hold on the database a company runs. Each -c of db's command
     is held to run.sh from the moment compose has one. */
  it("starts the real tests' Postgres as compose starts db", () => {
    const runScript = readFileSync(fileURLToPath(new URL('./real/run.sh', import.meta.url)), 'utf8');
    const { image, command = [] } = compose.services.db!;
    expect(runScript).toContain(image);
    for (const setting of command.join(' ').match(/-c \S+/g) ?? []) expect(runScript).toContain(setting);
  });

  /* Stands in for docker, curl and npx: what a run asks docker for, and what it hears, goes to a file beside it. */
  const STAND_IN = `#!/bin/sh
case "$*" in
  'port '*) echo 127.0.0.1:5432 ;;
  'run '*postgres*) echo "\${POSTGRES_PASSWORD:+heard}" >> "$CALLS"; echo "$*" >> "$CALLS" ;;
esac
`;

  it("gives Postgres its password by name, so that the value is on no command line", () => {
    const dir = mkdtempSync(join(tmpdir(), 'hh-run-sh-'));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    for (const name of ['docker', 'curl', 'npx']) {
      writeFileSync(join(dir, name), STAND_IN);
      chmodSync(join(dir, name), 0o755);
    }
    const calls = join(dir, 'calls');
    const script = fileURLToPath(new URL('./real/run.sh', import.meta.url));

    execFileSync('sh', [script], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, CALLS: calls, HH_REAL_PG: '', POSTGRES_PASSWORD: '' } });

    const [heard, commandLine] = readFileSync(calls, 'utf8').split('\n');
    expect(heard).toBe('heard');
    expect(commandLine!.includes('POSTGRES_PASSWORD=')).toBe(false);
  });
});
