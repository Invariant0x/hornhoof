import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));

async function filesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  return entries.filter(e => e.isFile()).map(e => join(e.parentPath, e.name));
}

describe('naming', () => {
  it('calls the central agent the orchestrator in every source file', async () => {
    const sources = (await Promise.all(['apps/node/src', 'apps/server/src', 'apps/web/src', 'packages/protocol/src'].map(d => filesUnder(join(ROOT, d))))).flat();
    expect(sources.length).toBeGreaterThan(20);
    const offenders = [];
    for (const file of sources) if (/chief/i.test(await readFile(file, 'utf8'))) offenders.push(file.slice(ROOT.length));
    expect(offenders).toEqual([]);
  });
});
