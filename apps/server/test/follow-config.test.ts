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

  it("never follows a hidden link's address", () => {
    /* At a hidden name only who holds the lease is answered: the server is reached at a machine that holds the data. */
    const dir = folder();
    const link = { name: 'x9', url: 'https://x9.hornhoof.test', hidden: true };
    const data = [
      { machine: 'm0', networkId: ENV.HORNHOOF_MACHINE_ID, addresses: ['192.168.1.9'], webPort: 8080 },
      { machine: 'm1', networkId: 'b0'.repeat(16), addresses: [], webPort: 8080 },
      { machine: 'm2', networkId: 'c0'.repeat(16), addresses: ['192.168.1.7', '10.0.0.7'], webPort: 8081 },
    ];
    writeFileSync(join(dir, PEERS_FILE), JSON.stringify({ machine: 'm0', role: 'data', link, data }));
    expect(followConfig(ENV, undefined, dir).joinServer).toBe('http://192.168.1.7:8081');
    /* With no link at all, the same. */
    writeFileSync(join(dir, PEERS_FILE), JSON.stringify({ machine: 'm0', role: 'data', link: null, data }));
    expect(followConfig(ENV, undefined, dir).joinServer).toBe('http://192.168.1.7:8081');
    /* And a link people use still comes first. */
    writeFileSync(join(dir, PEERS_FILE), JSON.stringify({ machine: 'm0', role: 'data', link: { ...link, hidden: false }, data }));
    expect(followConfig(ENV, undefined, dir).joinServer).toBe('https://x9.hornhoof.test');
    /* Nobody but itself to reach: as with no server. */
    writeFileSync(join(dir, PEERS_FILE), JSON.stringify({ machine: 'm0', role: 'data', link, data: data.slice(0, 2) }));
    expect(() => followConfig(ENV, undefined, dir)).toThrow("HORNHOOF_JOIN_SERVER is not the address of the company's server.");
  });
});
