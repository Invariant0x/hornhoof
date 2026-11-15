import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { prepareServiceArtifacts, type ServiceDefinitions } from '../src/test-services.js';

const race = vi.hoisted(() => ({ protectedRoot: '', stopped: '', fired: false }));
vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>();
  return { ...fs, openSync: new Proxy(fs.openSync, { apply(target, receiver, args) {
    const fd = Reflect.apply(target, receiver, args) as number;
    const source = String(args[0]);
    if (!race.fired && fs.existsSync(race.stopped) && source.startsWith('/proc/self/fd/') && source.endsWith('/data')) {
      const actual = realpathSync(source);
      if (actual.startsWith('/tmp/hhsp-') && actual.endsWith('/worker/data')) {
        renameSync(actual, actual + '-before-race');
        symlinkSync(race.protectedRoot, actual);
        race.fired = true;
      }
    }
    return fd;
  } }), cpSync: new Proxy(fs.cpSync, { apply(target, receiver, args) {
    const source = String(args[0]);
    // This is the root copy after payloadFiles checked the job-owned source.
    if (source.startsWith('/tmp/hhsp-') && source.endsWith('/worker/data/nested')) {
      const parent = dirname(source);
      renameSync(parent, parent + '-before-race');
      symlinkSync(race.protectedRoot, parent);
      race.fired = true;
    }
    return Reflect.apply(target, receiver, args);
  } }) };
});
let root: string | undefined;
/* The longest a timer waits: a stop grace and a deadline that never run out in a test. */
const NEVER_MS = 2_147_483_647;
afterEach(() => { vi.restoreAllMocks(); if (root) rmSync(root, { recursive: true, force: true }); });

it('never publishes node-only bytes when the job swaps a checked source ancestor before copying', async () => {
  root = mkdtempSync(join(tmpdir(), 'hh-symlink-security-'));
  const outside = join(root, 'node-only');
  mkdirSync(join(outside, 'nested'), { recursive: true, mode: 0o700 });
  writeFileSync(join(outside, 'nested', 'private.txt'), 'FICTIONAL_NODE_ONLY_VALUE', { mode: 0o600 });
  race.protectedRoot = outside; race.stopped = join(root, 'stopped'); race.fired = false;
  const server = join(root, 'server.cjs');
  writeFileSync(server, "const fs=require('node:fs'),p=require('node:path');fs.writeFileSync(p.join(process.env.HH_SERVICE_STATE,'data/nested/private.txt'),'PUBLIC_SERVICE_STATE');process.on('SIGTERM',()=>{fs.writeFileSync(" + JSON.stringify(race.stopped) + ",'yes');process.exit(0)});setInterval(()=>{},100)");
  chmodSync(server, 0o600);
  const uid = process.getuid!(), gid = process.getgid!();
  vi.spyOn(process, 'getuid').mockReturnValue(0);
  const definitions: ServiceDefinitions = { services: [{ id: 'worker', driver: 'process', runtime: 'node', profiles: ['final'], options: {
    start: { program: process.execPath, args: [server], cwd: '.' },
    readiness: { program: process.execPath, args: ['-e', "const fs=require('node:fs'),p=require('node:path');setInterval(()=>{if(fs.existsSync(p.join(process.env.HH_SERVICE_STATE,'data/nested/private.txt')))process.exit(0)},5)"], cwd: '.' },
    /* The server stops at once; its grace never runs out. */
    stop: { signal: 'SIGTERM', graceMs: NEVER_MS }, statePaths: ['data/nested'],
  } }] };
  const artifacts = await prepareServiceArtifacts(definitions, root, { nodeOwner: { uid: 0, gid: 0 }, jobUser: { uid, gid },
    cacheRoot: join(root, 'cache'), envKey: 'a'.repeat(64), inputDigest: 'b'.repeat(64),
    signal: new AbortController().signal, deadline: Date.now() + NEVER_MS, log: () => {}, registerSecrets: () => {},
  });
  expect(race.fired).toBe(true);
  const published = readFileSync(join(artifacts.paths.worker!, 'data', 'nested', 'private.txt'), 'utf8');
  expect(published).not.toContain('FICTIONAL_NODE_ONLY_VALUE');
  expect(published).toBe('PUBLIC_SERVICE_STATE');
});
