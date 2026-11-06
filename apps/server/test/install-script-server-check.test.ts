import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CODE, SERVER, indexOf, install } from './install-script-helpers.js';

describe('install.sh server by hand and the live check', () => {
  const SHA = 'a'.repeat(40);
  const NEW = { STUB_IMAGE_VERSION: '0.7.1', STUB_IMAGE_COMMIT: SHA };
  const gateOf = (tag: string) => `docker run --rm --entrypoint node ghcr.io/invariant0x/hornhoof:${tag} apps/server/dist/live-check-gate.js --image ghcr.io/invariant0x/hornhoof --commit ${SHA} --tag ${tag}`;
  const WORKING = 'HORNHOOF_SECRET=keep-me\nNODE_KEY=k\nPUBLIC_URL=http://localhost:8080\nHORNHOOF_VERSION=0.6.1\nHORNHOOF_APP_REF=ghcr.io/invariant0x/hornhoof:0.6.1\nHORNHOOF_NODE_REF=ghcr.io/invariant0x/hornhoof-node:0.6.1\n';
  const working = () => {
    const dir = mkdtempSync(join(tmpdir(), 'hh-server-'));
    writeFileSync(join(dir, '.env'), WORKING);
    return dir;
  };

  it.each([
    ['a build named by its commit', { HORNHOOF_VERSION: SHA }, ['server'], SHA],
    ['a build named by its version', { HORNHOOF_VERSION: '0.7.1' }, ['server'], '0.7.1'],
    ['the latest build', {}, ['server'], 'latest'],
    ['a build named with --urgent', { HORNHOOF_VERSION: SHA }, ['server', '--urgent'], SHA],
  ] as const)('changes nothing on a working server for %s with no live check', (_name, pin, args, tag) => {
    const dir = working();
    const r = install({ args: [...args], tty: '', env: { ...NEW, ...pin, HORNHOOF_SERVER_DIR: dir, STUB_LIVE_CHECK: 'no' } });
    expect(r.code).toBe(1);
    expect(r.calls).toContain(gateOf(tag));
    expect(r.out).toContain('This build has no live check');
    expect(r.out).toContain('stays as it is');
    expect(readFileSync(join(dir, '.env'), 'utf8')).toBe(WORKING);
    expect(r.calls.some(c => /^docker compose .*\b(up|pull|stop)\b/.test(c))).toBe(false);
    expect(r.calls.some(c => /^docker (stop|rm)\b/.test(c))).toBe(false);
  });

  it('leaves no folder behind on a computer it starts nothing on', () => {
    const r = install({ args: ['server'], tty: '', env: { ...NEW, HORNHOOF_VERSION: SHA, STUB_LIVE_CHECK: 'no' } });
    expect(r.code).toBe(1);
    expect(existsSync(join(r.dir, 'home', 'hornhoof', '.env'))).toBe(false);
  });

  it('installs a build its live check speaks of, by the same tag it asked of', () => {
    const r = install({ args: ['server'], tty: '\n', env: { ...NEW, HORNHOOF_VERSION: '0.7.1' } });
    expect(r.code).toBe(0);
    expect(r.calls).toContain(gateOf('0.7.1'));
    const env = readFileSync(join(r.dir, 'home', 'hornhoof', '.env'), 'utf8');
    expect(env).toMatch(/^HORNHOOF_VERSION=0\.7\.1$/m);
    expect(env).not.toContain('HORNHOOF_LIVE_CHECK_STAND');
    expect(indexOf(r.calls, 'docker run --rm --entrypoint node')).toBeLessThan(r.calls.findIndex(c => /^docker compose .*\bpull\b/.test(c)));
  });

  it('refuses 0.7.0, which went out without a check and has no way to answer', () => {
    const r = install({ args: ['server'], tty: '', env: { HORNHOOF_VERSION: '0.7.0', STUB_IMAGE_VERSION: '0.7.0', STUB_IMAGE_COMMIT: SHA, STUB_LIVE_CHECK: 'no answer' } });
    expect(r.code).toBe(1);
    expect(r.out).toContain('stays as it is');
    expect(r.out).toContain('cannot say');
    expect(r.out).not.toContain('Cannot find module');
  });

  it('goes by the last line of the answer, whatever Docker said before it', () => {
    const r = install({ args: ['server'], tty: '', env: { ...NEW, STUB_LIVE_CHECK: 'warned' } });
    expect(r.code).toBe(1);
    expect(r.out).toContain('This build has no live check');
    expect(r.out).not.toContain('WARNING');
  });

  it('says it could not read the registry, and not that the build has no answer', () => {
    const r = install({ args: ['server'], tty: '', env: { ...NEW, STUB_LIVE_CHECK: 'unread' } });
    expect(r.code).toBe(1);
    expect(r.out).toContain('Could not read the live check of this build');
    expect(r.out).not.toContain('cannot say');
    expect(r.out).not.toContain('429');
  });

  it('asks only the images of Hornhoof, whichever a person names', () => {
    for (const args of [['server'], ['--join', CODE]]) {
      const r = install({ args, tty: '\n', env: { ...NEW, HORNHOOF_APP_IMAGE: 'ghcr.io/acme/fork', STUB_LIVE_CHECK: 'no' } });
      expect(r.code).toBe(1);
      expect(r.calls.join('\n')).not.toContain('acme');
    }
  });

  it('gives nobody but a stand the images on this computer: they answer for nothing', () => {
    const r = install({ args: ['server'], tty: '\n', env: { ...NEW, HORNHOOF_VERSION: SHA, STUB_PULL: 'fail', STUB_IMAGE_LOCAL: '1' } });
    expect(r.code).toBe(1);
    expect(r.out).toContain('Could not download');
    expect(r.calls.some(c => /^docker compose .*\b(up|pull)\b/.test(c))).toBe(false);
  });

  it('goes back to a version from before live checks, which has none to show', () => {
    for (const version of ['0.6.1', '0.4.1']) {
      const r = install({ args: ['server'], tty: '\n', env: { HORNHOOF_VERSION: version } });
      expect(r.code).toBe(0);
      expect(r.calls.some(c => c.includes('live-check-gate'))).toBe(false);
    }
  });

  it.each([
    ['HORNHOOF_APP_REF', 'ghcr.io/invariant0x/hornhoof:unchecked'],
    ['HORNHOOF_NODE_REF', 'ghcr.io/invariant0x/hornhoof-node:unchecked'],
    ['HORNHOOF_UPDATER_REF', 'ghcr.io/invariant0x/hornhoof-updater:unchecked'],
    ['HORNHOOF_NODE_IMAGE', 'ghcr.io/invariant0x/hornhoof-node:unchecked'],
  ])('does not take %s from a person: no check speaks of what it names', (name, image) => {
    const dir = working();
    const r = install({ args: ['server'], tty: '', env: { ...NEW, HORNHOOF_SERVER_DIR: dir, [name]: image } });
    expect(r.code).toBe(1);
    expect(r.out).toContain(name);
    expect(readFileSync(join(dir, '.env'), 'utf8')).toBe(WORKING);
  });

  it('asks nothing of a build the updater brings: its server asked before it let the update go', () => {
    const dir = working();
    const r = install({ args: ['server'], tty: '', env: { ...NEW, HORNHOOF_SERVER_DIR: dir, HORNHOOF_FROM_UPDATER: '1', HORNHOOF_VERSION: '0.7.1', STUB_LIVE_CHECK: 'no' } });
    expect(r.code).toBe(0);
    expect(r.calls.some(c => c.includes('live-check-gate'))).toBe(false);
  });

  describe('a live check stand', () => {
    const STAND = { ...NEW, HORNHOOF_VERSION: SHA, HORNHOOF_LIVE_CHECK_STAND: '1', STUB_LIVE_CHECK: 'no' };

    it('is a new server of its own, named, that says what it is and runs the build it checks', () => {
      const r = install({ args: ['server', '--name', 'live-check'], tty: '\n', env: STAND });
      expect(r.code).toBe(0);
      expect(r.calls.some(c => c.includes('live-check-gate'))).toBe(false);
      const env = readFileSync(join(r.dir, 'home', 'hornhoof-live-check', '.env'), 'utf8');
      expect(env).toMatch(/^HORNHOOF_LIVE_CHECK_STAND=1$/m);
      expect(env).toMatch(/^COMPOSE_PROJECT_NAME=hornhoof-live-check$/m);
      expect(env).toMatch(new RegExp(`^HORNHOOF_NODE_REF=ghcr\\.io/invariant0x/hornhoof-node:${SHA}$`, 'm'));
    });

    it('is no way to put a build on the default server', () => {
      const r = install({ args: ['server'], tty: '\n', env: STAND });
      expect(r.code).toBe(1);
      expect(r.out).toContain('--name');
      expect(existsSync(join(r.dir, 'home', 'hornhoof', '.env'))).toBe(false);
    });

    it('never becomes one out of a server that already has its settings', () => {
      const dir = working();
      const r = install({ args: ['server', '--name', 'acme'], tty: '', env: { ...STAND, HORNHOOF_SERVER_DIR: dir } });
      expect(r.code).toBe(1);
      expect(r.out).toContain('new server');
      expect(readFileSync(join(dir, '.env'), 'utf8')).toBe(WORKING);
    });

    it('runs a candidate built on this computer, with nothing of it published', () => {
      const r = install({ args: ['server', '--name', 'live-check'], tty: '\n', env: { ...STAND, STUB_PULL: 'fail', STUB_IMAGE_LOCAL: '1' } });
      expect(r.code).toBe(0);
      expect(r.out).toContain('Using the images on this computer.');
      expect(r.calls.some(c => /^docker compose .*\bup\b/.test(c))).toBe(true);
    });

    it('downloads all of a candidate once it is published, over what was built on this computer', () => {
      const r = install({ args: ['server', '--name', 'live-check'], tty: '\n', env: { ...STAND, STUB_IMAGE_LOCAL: '1' } });
      expect(r.code).toBe(0);
      expect(r.calls.some(c => /^docker compose .*\bpull\b/.test(c))).toBe(true);
      expect(r.out).not.toContain('Using the images on this computer.');
    });

    it('starts no part of a candidate: what is neither published nor here stops it', () => {
      const r = install({ args: ['server', '--name', 'live-check'], tty: '\n', env: { ...STAND, STUB_PULL: 'node', STUB_IMAGE_LOCAL: 'app' } });
      expect(r.code).toBe(1);
      expect(r.out).toContain('Could not download the images');
      expect(r.calls.some(c => /^docker compose .*\bup\b/.test(c))).toBe(false);
    });

    it('stops when that candidate is neither here nor published', () => {
      const r = install({ args: ['server', '--name', 'live-check'], tty: '\n', env: { ...STAND, STUB_PULL: 'fail' } });
      expect(r.code).toBe(1);
      expect(r.out).toContain('Could not download');
    });

    it('stays one when it runs again, and moves nodes only of its own', () => {
      const first = install({ args: ['server', '--name', 'live-check'], tty: '\n', env: STAND });
      const dir = join(first.dir, 'home', 'hornhoof-live-check');
      const again = install({ args: ['server', '--name', 'live-check'], tty: '', env: { ...NEW, HORNHOOF_SERVER_DIR: dir, HORNHOOF_VERSION: SHA, STUB_LIVE_CHECK: 'no', STUB_CONTAINERS: `hornhoof-claude-1c07dac4=${SERVER}` } });
      expect(again.code).toBe(0);
      expect(again.calls.some(c => c.includes('live-check-gate'))).toBe(false);
      expect(again.calls.some(c => c.startsWith('docker stop') && c.includes('hornhoof-claude-1c07dac4'))).toBe(false);
    });
  });
});
