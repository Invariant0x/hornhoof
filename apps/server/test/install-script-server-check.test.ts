import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CODE, install } from './install-script-helpers.js';

describe('install.sh server by hand and the build it names', () => {
  const SHA = 'a'.repeat(40);

  it.each([
    ['a build named by its commit', { HORNHOOF_VERSION: SHA }, ['server'], SHA],
    ['a build named by its version', { HORNHOOF_VERSION: '0.8.4' }, ['server'], '0.8.4'],
    ['the latest build', {}, ['server'], 'latest'],
    ['a build named with --urgent', { HORNHOOF_VERSION: SHA }, ['server', '--urgent'], SHA],
  ] as const)('installs %s without running anything of it first', (_name, pin, args, tag) => {
    const r = install({ args: [...args], tty: '\n', env: pin });
    expect(r.code).toBe(0);
    expect(r.calls.some(c => c.includes('--entrypoint node'))).toBe(false);
    const env = readFileSync(join(r.dir, 'home', 'hornhoof', '.env'), 'utf8');
    expect(env).toMatch(new RegExp(`^HORNHOOF_VERSION=${tag}$`, 'm'));
    expect(env).toMatch(new RegExp(`^HORNHOOF_APP_REF=ghcr\\.io/invariant0x/hornhoof:${tag}$`, 'm'));
    expect(env).not.toContain('LIVE_CHECK');
  });

  it('starts the images a person names in HORNHOOF_APP_REF, HORNHOOF_NODE_REF and HORNHOOF_UPDATER_REF', () => {
    const refs = { HORNHOOF_APP_REF: 'ghcr.io/invariant0x/hornhoof:own', HORNHOOF_NODE_REF: 'ghcr.io/invariant0x/hornhoof-node:own', HORNHOOF_UPDATER_REF: 'ghcr.io/invariant0x/hornhoof-updater:own' };
    const r = install({ args: ['server'], tty: '\n', env: refs });
    expect(r.code).toBe(0);
    const env = readFileSync(join(r.dir, 'home', 'hornhoof', '.env'), 'utf8');
    for (const [name, image] of Object.entries(refs)) expect(env).toContain(`${name}=${image}\n`);
  });

  it('takes only the images of Hornhoof, whichever app image a person names', () => {
    for (const args of [['server'], ['--join', CODE]]) {
      const r = install({ args, tty: '\n', env: { HORNHOOF_APP_IMAGE: 'ghcr.io/acme/fork' } });
      expect(r.code).toBe(0);
      expect(r.calls.join('\n')).not.toContain('acme');
    }
  });

  it('starts no server from images it could not download, though they are on this computer', () => {
    const r = install({ args: ['server'], tty: '\n', env: { HORNHOOF_VERSION: SHA, STUB_PULL: 'fail', STUB_IMAGE_LOCAL: '1' } });
    expect(r.code).toBe(1);
    expect(r.out).toContain('Could not download');
    expect(r.calls.some(c => /^docker compose .*\b(up|pull)\b/.test(c))).toBe(false);
  });
});
