import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { followConfig } from '../src/modules/keeper/follow-config.js';
import { PEERS_FILE } from '../src/modules/keeper/worker.js';
import { TEST_SECRET } from './helpers-basic.js';

const ENV = { HORNHOOF_MACHINE_ID: 'a0'.repeat(16), HORNHOOF_SECRET: TEST_SECRET, DATABASE_URL: 'postgres://hornhoof@db:5432/hornhoof' };

function folder(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hh-follow-config-'));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe('what the keeper of a machine that keeps a copy is started with', () => {
  it('takes the server it joined through', () => {
    expect(followConfig({ ...ENV, HORNHOOF_JOIN_SERVER: 'https://acme.hornhoof.test/join' }, undefined, folder())).toMatchObject({ joinServer: 'https://acme.hornhoof.test', databaseUrl: ENV.DATABASE_URL });
  });

  it('follows without a join server', () => {
    /* A machine the company was installed on never joined: once it handed the server over, it reaches the new leader
       by the company's link, which the view it built for itself names. */
    const dir = folder();
    writeFileSync(join(dir, PEERS_FILE), JSON.stringify({ machine: 'm', role: 'data', link: { name: 'acme', url: 'https://acme.hornhoof.test' } }));
    expect(followConfig(ENV, undefined, dir).joinServer).toBe('https://acme.hornhoof.test');
    /* What the settings name comes first. */
    expect(followConfig({ ...ENV, HORNHOOF_JOIN_SERVER: 'http://192.168.1.5:8080' }, undefined, dir).joinServer).toBe('http://192.168.1.5:8080');
    /* With neither, as before. */
    const line = "HORNHOOF_JOIN_SERVER is not the address of the company's server. Run the join command from Hornhoof on this machine again.";
    expect(() => followConfig(ENV, undefined, folder())).toThrow(line);
    for (const view of ['{', JSON.stringify({ link: null }), JSON.stringify({ link: { url: 'ftp://acme' } })]) {
      const broken = folder();
      writeFileSync(join(broken, PEERS_FILE), view);
      expect(() => followConfig(ENV, undefined, broken)).toThrow(line);
    }
  });
});
