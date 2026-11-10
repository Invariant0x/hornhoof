import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, onTestFinished } from 'vitest';
import { parse } from 'yaml';
import { loadConfig } from '../src/config.js';

type DependsOn = Record<string, { condition: string }> | string[];
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
  it('is published by front alone, and no other service names it', () => {
    expect(compose.services.tunnel).toBeUndefined();
    expect(front!.ports).toEqual(['${HORNHOOF_PORT:-8080}:8080']);
    expect(app!.ports).toBeUndefined();
    for (const [name, service] of Object.entries(compose.services)) {
      if (name !== 'front') expect(JSON.stringify(service)).not.toContain('HORNHOOF_PORT');
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
    expect(Object.keys(keeper!.environment!)).toEqual(['DATABASE_URL', 'HORNHOOF_SECRET', 'ACME_DIRECTORY', 'RELAY_URL', 'HORNHOOF_MACHINE_ID']);
    expect(keeper!.volumes).toEqual(['control:/control']);
    expect(JSON.stringify(keeper)).not.toContain('docker.sock');
    expect(keeper!.networks).toEqual(['default', 'internal']);
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
  /* The updater loads the new file with the .env of the build before, which has only these two required lines. */
  it('loads with a .env from before this build', () => {
    const required = ['HORNHOOF_SECRET', 'NODE_KEY'];
    for (const [, name, kind] of composeText.matchAll(/\$\{(\w+)(:[-?])?/g)) {
      expect(kind === ':-' || (kind === ':?' && required.includes(name!))).toBe(true);
    }
    for (const service of Object.values(compose.services)) expect(() => filled(service, REQUIRED)).not.toThrow();
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
