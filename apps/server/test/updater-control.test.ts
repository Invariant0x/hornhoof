import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { UpdaterControl } from '../src/modules/updates/control.js';

const roots: string[] = [];
const STATUS = { id: 'requested-build', version: '0.5.0', state: 'running', step: 'pull', log: '', at: '2026-11-03T10:00:00Z' };

function control() {
  const dir = mkdtempSync(join(tmpdir(), 'updater-control-'));
  roots.push(dir);
  writeFileSync(join(dir, 'status.json'), JSON.stringify(STATUS));
  return { dir, control: new UpdaterControl(dir) };
}

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('the build an updater status describes', () => {
  it('reads the exact requested commit with the same id, even when the version is reused', () => {
    const c = control();
    const commit = 'a'.repeat(40);
    writeFileSync(join(c.dir, 'request.json'), JSON.stringify({ id: STATUS.id, version: STATUS.version, commit }));
    expect(c.control.status()).toEqual({ ...STATUS, commit });
  });

  it('does not attach a newer request to the preceding status', () => {
    const c = control();
    writeFileSync(join(c.dir, 'request.json'), JSON.stringify({ id: 'next-build', version: STATUS.version, commit: 'b'.repeat(40) }));
    expect(c.control.status()).toEqual(STATUS);
  });

  it.each([null, '{invalid', JSON.stringify({ id: STATUS.id, version: STATUS.version })])('keeps old statuses readable without request commit data: %s', data => {
    const c = control();
    if (data !== null) writeFileSync(join(c.dir, 'request.json'), data);
    expect(c.control.status()).toEqual(STATUS);
  });
});
