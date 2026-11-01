import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(fileURLToPath(new URL(`../../../${path}`, import.meta.url)), 'utf8');

describe('what the build runs', () => {
  /* The workflow can write packages, so a moved tag of an action would publish whatever that action now does. */
  it('pins every GitHub action to a full commit and names its version', () => {
    const uses = read('.github/workflows/images.yml').split('\n').filter(l => /^\s*-?\s*uses:/.test(l));
    expect(uses.length).toBeGreaterThanOrEqual(7);
    for (const line of uses) expect(line).toMatch(/uses: [\w.-]+\/[\w.-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/);
  });

  /* Every company updates to :latest, so a run started by hand from a branch would hand them all that branch. */
  it('moves the latest and version tags only for a build of main, and a branch build pushes its commit tag alone', () => {
    const lines = read('.github/workflows/images.yml').split('\n');
    const start = lines.findIndex(l => /^\s+tags: \|$/.test(l));
    expect(start).toBeGreaterThan(0);
    const indent = lines[start + 1]!.search(/\S/);
    const tags: string[] = [];
    for (const line of lines.slice(start + 1)) {
      if (line.search(/\S/) < indent) break;
      tags.push(line.trim());
    }
    const moved = tags.filter(t => t.includes(':latest') || t.includes('steps.build.outputs.version'));
    expect(moved).toHaveLength(2);
    for (const tag of moved) expect(tag).toMatch(/^\$\{\{ github\.ref == 'refs\/heads\/main' && format\('ghcr\.io\/invariant0x\/\{0\}:[^']+', matrix\.name[^)]*\) \|\| '' \}\}$/);
    expect(tags).toContain('ghcr.io/invariant0x/${{ matrix.name }}:${{ github.sha }}');
    expect(tags).toHaveLength(3);
  });

  /* A tag can point at another image tomorrow; a digest is the one image the build was checked with. */
  it('builds every image from a base image pinned by digest', () => {
    const from = ['Dockerfile', 'apps/node/Dockerfile', 'apps/updater/Dockerfile'].flatMap(f => read(f).split('\n').filter(l => l.startsWith('FROM ')));
    expect(from).toHaveLength(9);
    for (const line of from) expect(line).toMatch(/ [\w.-]+:[\w.-]+@sha256:[0-9a-f]{64}( AS \w+)?$/);
  });

  it('takes the tunnel client from an image pinned by digest', () => {
    const copies = read('Dockerfile').split('\n').filter(l => /^COPY --from=[\w.-]+[/:]/.test(l));
    expect(copies.some(l => l.includes(' /usr/bin/frpc '))).toBe(true);
    for (const line of copies) expect(line).toMatch(/^COPY --from=[\w./-]+:[\w.-]+@sha256:[0-9a-f]{64} /);
  });

  it('runs the database from an image pinned by digest', () => {
    expect(read('compose.yaml')).toMatch(/^ {4}image: postgres:17\.\d+@sha256:[0-9a-f]{64}$/m);
  });

  /* install.sh writes them into .env: by digest from the updater, which checked them, or by the build's tag. */
  it("runs Hornhoof's own images as .env names them", () => {
    const images = read('compose.yaml').split('\n').filter(l => /^ {4}image: /.test(l)).map(l => l.trim());
    expect(images).toEqual([
      'image: ${HORNHOOF_APP_REF:-ghcr.io/invariant0x/hornhoof:latest}',
      expect.stringMatching(/^image: postgres:/),
      'image: ${HORNHOOF_NODE_REF:-ghcr.io/invariant0x/hornhoof-node:latest}',
      /* The tunnel runs the app's own image, so it moves with the app. */
      'image: ${HORNHOOF_APP_REF:-ghcr.io/invariant0x/hornhoof:latest}',
      'image: ${HORNHOOF_UPDATER_REF:-ghcr.io/invariant0x/hornhoof-updater:latest}',
    ]);
  });
});
