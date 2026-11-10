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

  /* Every company updates to :latest, so no build, of main or of a branch, may move it: only the publish job does, after the
     tests passed on main, and scripts/test/images-workflow.test.mjs holds that job to it. */
  it('pushes a build under its commit tag alone', () => {
    const tags = read('.github/workflows/images.yml').split('\n').filter(l => /^\s+tags: /.test(l)).map(l => l.trim());
    expect(tags).toEqual(['tags: ghcr.io/invariant0x/${{ matrix.name }}:${{ github.sha }}']);
  });

  /* A tag can point at another image tomorrow; a digest is the one image the build was checked with. */
  it('builds every image from a base image pinned by digest', () => {
    const from = ['Dockerfile', 'apps/node/Dockerfile', 'apps/updater/Dockerfile'].flatMap(f => read(f).split('\n').filter(l => l.startsWith('FROM ')));
    expect(from).toHaveLength(11);
    for (const line of from) expect(line).toMatch(/ [\w.-]+:[\w.-]+@sha256:[0-9a-f]{64}( AS \w+)?$/);
  });

  /* The lab's machines are computers with a Docker of their own: the one every run starts from. */
  it("builds the lab's machine from a Docker pinned by digest", () => {
    const from = read('apps/server/test/lab/machine.Dockerfile').split('\n').filter(l => l.startsWith('FROM '));
    expect(from).toHaveLength(1);
    expect(from[0]).toMatch(/^FROM docker:28\.\d+\.\d+-dind@sha256:[0-9a-f]{64}$/);
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
    const app = 'image: ${HORNHOOF_APP_REF:-ghcr.io/invariant0x/hornhoof:latest}';
    /* Front, the keeper and migrate run the app's own image, so they move with the app. */
    expect(images).toEqual([
      app,
      app,
      app,
      app,
      expect.stringMatching(/^image: postgres:/),
      'image: ${HORNHOOF_NODE_REF:-ghcr.io/invariant0x/hornhoof-node:latest}',
      'image: ${HORNHOOF_UPDATER_REF:-ghcr.io/invariant0x/hornhoof-updater:latest}',
    ]);
  });

  /* An unchanged node image keeps the same digest across releases so running agent programs stay up during an update. */
  it('builds the node image reproducibly without per-commit labels, timestamps or provenance', () => {
    const workflow = read('.github/workflows/images.yml');
    for (const label of ['org.opencontainers.image.version', 'org.opencontainers.image.revision', 'io.hornhoof.title', 'io.hornhoof.migrations']) {
      const line = workflow.split('\n').find(l => l.includes(label));
      expect(line).toContain("matrix.name != 'hornhoof-node'");
    }
    for (const arg of ['HORNHOOF_VERSION=', 'HORNHOOF_COMMIT=']) {
      const line = workflow.split('\n').find(l => l.includes(arg));
      expect(line).toContain("matrix.name == 'hornhoof'");
    }
    expect(workflow).toMatch(/matrix\.name == 'hornhoof-node' && 'SOURCE_DATE_EPOCH=\d+'/);
    /* One export pushes the node image with its timestamps rewritten, not a second push next to it. */
    expect(workflow).toContain("push: ${{ matrix.name != 'hornhoof-node' }}");
    expect(workflow).toContain("outputs: ${{ matrix.name == 'hornhoof-node' && 'type=registry,rewrite-timestamp=true' || '' }}");
    expect(workflow).toContain("provenance: ${{ matrix.name != 'hornhoof-node' }}");

    const nodeDockerfile = read('apps/node/Dockerfile');
    expect(nodeDockerfile).not.toMatch(/\bHORNHOOF_(VERSION|COMMIT)\b/);
    expect(nodeDockerfile).toMatch(/^ARG SOURCE_DATE_EPOCH=\d+$/m);
    expect(nodeDockerfile).toContain('rm -rf node_modules/.package-lock.json node_modules/@hornhoof/server node_modules/@hornhoof/web');
    expect(nodeDockerfile).not.toContain('COPY --from=deps /app /app');
    expect(nodeDockerfile).toContain('COPY --from=deps /app/node_modules node_modules');
  });

  /* The server marks nodes of another build than its own nodes: it needs the build each of them is, which a node image
     carries only as the last commit that changed its files, so an unchanged node image keeps its digest. */
  it('gives the node image and the server the same node build, the last commit that changed what the node image is made of', () => {
    const workflow = read('.github/workflows/images.yml');
    /* The images job alone, up to the next job: another job may check out the whole history for reasons of its own. */
    const images = workflow.split(/\n(?= {2}[\w-]+:\n)/).find(part => part.startsWith('  images:'))!;
    /* git log finds the last commit that changed a file only in the whole history: a shallow clone has one commit. */
    expect(images).toMatch(/uses: actions\/checkout@[0-9a-f]{40} # v[\d.]+\n {8}with:\n {10}fetch-depth: 0\n/);
    /* Its own line, so a failing script fails the step instead of passing an empty build on. */
    expect(images).toContain('node=$(bash scripts/node-build.sh)\n');
    expect(images).toContain('echo "node=$node" >> "$GITHUB_OUTPUT"');
    const arg = images.split('\n').find(l => l.includes('HORNHOOF_NODE_BUILD='));
    expect(arg).toContain("matrix.name != 'hornhoof-updater' && format('HORNHOOF_NODE_BUILD={0}', steps.build.outputs.node)");
    expect(read('Dockerfile')).toMatch(/^ARG HORNHOOF_NODE_BUILD=\n/m);
    expect(read('Dockerfile')).toMatch(/^ENV .*HORNHOOF_NODE_BUILD=\$HORNHOOF_NODE_BUILD/m);
    const nodeDockerfile = read('apps/node/Dockerfile');
    expect(nodeDockerfile).toMatch(/^ARG HORNHOOF_NODE_BUILD=\nENV HORNHOOF_NODE_BUILD=\$HORNHOOF_NODE_BUILD\n/m);
  });

  /* Coverage for crapper comes from vitest's provider, and a provider of another version than vitest refuses to load. */
  it('installs the coverage provider with every part that runs vitest, at the version of vitest', () => {
    const json = (path: string) => JSON.parse(read(path));
    const root = json('package.json');
    expect(root.scripts?.prepare).toContain('node_modules/@vitest/coverage-v8');
    for (const part of ['packages/protocol', 'apps/server', 'apps/web', 'apps/node']) {
      const dev = json(`${part}/package.json`).devDependencies;
      expect(dev['@vitest/coverage-v8'], part).toBe(dev.vitest);
      expect(json(`${part}/node_modules/@vitest/coverage-v8/package.json`).version, part).toBe(json('node_modules/vitest/package.json').version);
    }
    const lock = json('package-lock.json').packages;
    expect(lock['node_modules/@vitest/coverage-v8']).toMatchObject({ version: lock['node_modules/vitest'].version, dev: true });
  });

  /* @resvg/resvg-js ships prebuilt Alpine binaries per CPU; deps runs on the builder platform and must pick TARGETARCH. */
  it('installs server production modules for the target CPU and copies bundled operator fonts on build', () => {
    const dockerfile = read('Dockerfile');
    expect(dockerfile).toContain('FROM --platform=$BUILDPLATFORM node:22.23.4-alpine@');
    expect(dockerfile).toMatch(/AS deps\nARG TARGETARCH\n/);
    expect(dockerfile).toContain('npm ci --omit=dev --cpu="$cpu" --workspace apps/server --workspace packages/protocol');
    const serverPkg = JSON.parse(read('apps/server/package.json'));
    expect(serverPkg.scripts.build).toContain('dist/modules/program-operator/fonts');
    expect(read('THIRD_PARTY.md')).toContain('DejaVu Sans Mono');
    expect(read('THIRD_PARTY.md')).toContain('@resvg/resvg-js');
    expect(read('apps/server/src/modules/program-operator/fonts/LICENSE')).toContain('Bitstream Vera Fonts Copyright');
  });
});
