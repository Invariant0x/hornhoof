import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { keeperRole } from '../src/modules/keeper/role.js';

function folder(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hh-keeper-role-'));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function control(marker = false): string {
  const dir = folder();
  if (marker) writeFileSync(join(dir, 'replica.json'), '{}');
  return dir;
}

/* The keeper's own folder, with what it wrote down of a switch it takes or hands over, in that phase. */
function keeperDir(file?: 'taking.json' | 'handing.json', phase?: string): string {
  const dir = folder();
  if (file) writeFileSync(join(dir, file), JSON.stringify({ phase }));
  return dir;
}

describe('the keeper a machine runs', () => {
  it("is a worker's where the machine keeps no data, whatever else is there", async () => {
    let asked = 0;
    const subscribed = async () => (asked++, true);
    expect(await keeperRole({ HORNHOOF_ROLE: 'worker' }, control(true), keeperDir(), subscribed)).toBe('worker');
    expect(await keeperRole({ HORNHOOF_ROLE: 'worker' }, control(), keeperDir(), subscribed)).toBe('worker');
    expect(asked).toBe(0);
  });

  it('follows where the machine keeps a copy', async () => {
    expect(await keeperRole({ HORNHOOF_ROLE: 'data' }, control(true), keeperDir(), async () => false)).toBe('follow');
    /* Its control folder was lost, and its database still follows the leader's. */
    expect(await keeperRole({ HORNHOOF_ROLE: 'data' }, control(), keeperDir(), async () => true)).toBe('follow');
    expect(await keeperRole({}, control(), keeperDir(), async () => true)).toBe('follow');
  });

  it('takes the server over once it took the go', async () => {
    for (const phase of ['go', 'promoted']) {
      /* Also while the marker of its copy is still there: the promotion removes it. */
      expect([phase, await keeperRole({}, control(true), keeperDir('taking.json', phase), async () => false)]).toEqual([phase, 'taking']);
      expect([phase, await keeperRole({}, control(), keeperDir('taking.json', phase), async () => true)]).toEqual([phase, 'taking']);
    }
    /* An offer it only accepted, and a switch that was given up, leave it following. */
    for (const phase of ['offered', 'aborted']) {
      expect([phase, await keeperRole({}, control(true), keeperDir('taking.json', phase), async () => false)]).toEqual([phase, 'follow']);
    }
    expect(await keeperRole({ HORNHOOF_ROLE: 'worker' }, control(), keeperDir('taking.json', 'go'), async () => false)).toBe('worker');
  });

  it('hands the server over while it wrote that down', async () => {
    for (const phase of ['offered', 'stopped', 'go', 'followed']) {
      expect([phase, await keeperRole({}, control(), keeperDir('handing.json', phase), async () => false)]).toEqual([phase, 'handing']);
    }
    /* A switch it gave up: it leads again. */
    expect(await keeperRole({}, control(), keeperDir('handing.json', 'aborted'), async () => false)).toBe('lead');
  });

  it('takes a note it cannot read for a switch under way', async () => {
    /* Nobody knows then whether the server was given away or taken: the keeper that starts holds, as in the middle of
       a switch, and neither leads on its own word nor follows as if nothing were. */
    const handing = keeperDir();
    writeFileSync(join(handing, 'handing.json'), '{');
    expect(await keeperRole({}, control(), handing, async () => false)).toBe('handing');
    const taking = keeperDir();
    writeFileSync(join(taking, 'taking.json'), '{');
    expect(await keeperRole({}, control(true), taking, async () => true)).toBe('taking');
    /* So does a note that is there and cannot be opened. */
    const closed = keeperDir();
    mkdirSync(join(closed, 'taking.json'));
    expect(await keeperRole({}, control(true), closed, async () => true)).toBe('taking');
    /* A machine that keeps no data takes part in no switch, whatever lies in its folder. */
    expect(await keeperRole({ HORNHOOF_ROLE: 'worker' }, control(), taking, async () => false)).toBe('worker');
  });

  it('leads anywhere else', async () => {
    expect(await keeperRole({ HORNHOOF_ROLE: 'data' }, control(), keeperDir(), async () => false)).toBe('lead');
    expect(await keeperRole({}, control(), keeperDir(), async () => false)).toBe('lead');
    /* A database that does not answer follows nobody as far as anyone knows. */
    expect(await keeperRole({}, control(), keeperDir(), async () => { throw new Error('the database does not answer'); })).toBe('lead');
  });
});
