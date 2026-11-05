import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

type Service = { image?: string; command?: string[]; volumes?: string[]; environment?: Record<string, string>; security_opt?: string[] };
const compose = parse(readFileSync(fileURLToPath(new URL('../../../compose.yaml', import.meta.url)), 'utf8')) as { services: Record<string, Service> };

describe('the tunnel service', () => {
  it("carries the public link with the app's own image, reading only the control folder", () => {
    const { tunnel, app } = compose.services;
    expect(tunnel!.image).toBe(app!.image);
    expect(tunnel!.command).toEqual(['node', 'apps/server/dist/tunnel.js']);
    expect(tunnel!.volumes).toEqual(['control:/control:ro']);
    expect(JSON.stringify(tunnel)).not.toContain('docker.sock');
  });

  it('is the one container the app believes about https', () => {
    expect(compose.services.app!.environment!.TUNNEL_HOST).toBe('tunnel');
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
});
