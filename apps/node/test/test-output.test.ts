import { createHash } from 'node:crypto';
import { chmod, link, mkdir, mkdtemp, open, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_RUN_FILES, RUN_FILE_BYTES } from '@hornhoof/protocol';
import { describe, expect, it, onTestFinished } from 'vitest';
import { readOutputFiles } from '../src/test-output.js';

const uid = process.getuid!();
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'hh-test-output-'));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const out = join(root, 'out'); await mkdir(out);
  return { root, out };
}
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

describe('declared test output bytes', () => {
  it('reads only the declared files and hashes the actual bytes without exporting them', async () => {
    const { out } = await fixture();
    await writeFile(join(out, 'geometry.json'), '{"width":100}');
    await writeFile(join(out, 'full.log'), 'abc');
    await writeFile(join(out, 'not-declared.txt'), 'not requested');
    const result = await readOutputFiles(out, ['full.log', 'geometry.json'], uid);
    expect(result).toEqual([
      { path: 'full.log', status: 'read', bytes: Buffer.from('abc'), size: 3, sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' },
      { path: 'geometry.json', status: 'read', bytes: Buffer.from('{"width":100}'), size: 13, sha256: sha256(Buffer.from('{"width":100}')) },
    ]);
  });

  it('reports a missing declared diagnostic without losing a file that was saved', async () => {
    const { out } = await fixture(); await writeFile(join(out, 'full.log'), 'saved');
    expect(await readOutputFiles(out, ['missing.png', 'full.log'], uid)).toEqual([
      { path: 'missing.png', status: 'refused', reason: 'output_unavailable' },
      { path: 'full.log', status: 'read', bytes: Buffer.from('saved'), size: 5, sha256: sha256(Buffer.from('saved')) },
    ]);
  });

  it.each(['../secret', '/absolute', 'sub/file', 'sub\\file', '.', '..', 'nul\0byte', 'line\nfeed', ''])('refuses a non-basename declaration %j before opening files', async path => {
    const { root, out } = await fixture(); await writeFile(join(root, 'secret'), 'private');
    await expect(readOutputFiles(out, [path], uid)).rejects.toThrow('Invalid output declarations');
  });

  it('rejects duplicate declarations and more than twenty declared files', async () => {
    const { out } = await fixture();
    await expect(readOutputFiles(out, ['full.log', 'full.log'], uid)).rejects.toThrow('Invalid output declarations');
    await expect(readOutputFiles(out, Array.from({ length: MAX_RUN_FILES + 1 }, (_, index) => `file-${index}.log`), uid)).rejects.toThrow('Invalid output declarations');
  });

  it('reads all twenty declared files without including an extra file', async () => {
    const { out } = await fixture(), names = Array.from({ length: 20 }, (_, index) => `${index}.log`);
    for (const name of [...names, 'extra.log']) await writeFile(join(out, name), name);
    const result = await readOutputFiles(out, names, uid);
    expect(result.map(file => [file.path, file.status])).toEqual(names.map(name => [name, 'read']));
  });

  it('refuses a file larger than the existing per-file limit before reading its bytes', async () => {
    const { out } = await fixture(), file = await open(join(out, 'huge.log'), 'wx');
    await file.truncate(RUN_FILE_BYTES + 1); await file.close();
    expect(await readOutputFiles(out, ['huge.log'], uid)).toEqual([{ path: 'huge.log', status: 'refused', reason: 'output_too_large' }]);
  });

  it.each(['directory', 'symlink', 'hardlink'] as const)('refuses a %s without exposing the foreign bytes', async kind => {
    const { root, out } = await fixture(), source = join(root, 'private'), target = join(out, 'full.log');
    await writeFile(source, 'private');
    if (kind === 'directory') await mkdir(target);
    if (kind === 'symlink') await symlink(source, target);
    if (kind === 'hardlink') await link(source, target);
    expect(await readOutputFiles(out, ['full.log'], uid)).toEqual([{ path: 'full.log', status: 'refused', reason: 'output_unavailable' }]);
    expect(await readFile(source, 'utf8')).toBe('private');
  });

  it('refuses an output folder replaced by a symlink', async () => {
    const { root, out } = await fixture(), foreign = join(root, 'foreign');
    await mkdir(foreign); await writeFile(join(foreign, 'full.log'), 'private');
    await rename(out, join(root, 'old-out')); await symlink(foreign, out);
    expect(await readOutputFiles(out, ['full.log'], uid)).toEqual([{ path: 'full.log', status: 'refused', reason: 'output_unavailable' }]);
  });

  it('refuses files and the output folder that do not belong to the job user', async () => {
    const { out } = await fixture(); await writeFile(join(out, 'full.log'), 'private');
    expect(await readOutputFiles(out, ['full.log'], uid + 1)).toEqual([{ path: 'full.log', status: 'refused', reason: 'output_unavailable' }]);
  });

  it('does not require diagnostics to be writable after their command settled', async () => {
    const { out } = await fixture(); await writeFile(join(out, 'full.log'), 'saved'); await chmod(join(out, 'full.log'), 0o400);
    expect(await readOutputFiles(out, ['full.log'], uid)).toMatchObject([{ status: 'read', bytes: Buffer.from('saved') }]);
  });

  it('returns no bytes when the output folder was never created', async () => {
    const { root } = await fixture();
    expect(await readOutputFiles(join(root, 'missing'), ['full.log'], uid)).toEqual([{ path: 'full.log', status: 'refused', reason: 'output_unavailable' }]);
  });
});
