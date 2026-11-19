import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const dockerfile = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');
/* The packages of the last stage, the one agents run in. */
const runtime = dockerfile.slice(dockerfile.lastIndexOf('\nFROM '));
const installed = new Set([...runtime.matchAll(/apt-get install -y --no-install-recommends ([^\\\n]+)/g)].flatMap(m => m[1]!.split(/\s+/)));

describe('the node image', () => {
  it('installs the audited runtime tools and verifies their versions in the final stage', () => {
    for (const name of ['binutils', 'patch', 'iproute2', 'time']) expect(installed).toContain(name);
    for (const command of ['/usr/bin/time --version', 'strings --version', 'patch --version', 'ss --version', 'objdump --version']) {
      expect(runtime).toContain(`&& ${command}`);
    }
  });
  it('installs PostgreSQL 17 from the fingerprint-checked signed bookworm repository without a default cluster', () => {
    expect(installed).toContain('postgresql-17');
    expect(installed).toContain('postgresql-client-17');
    expect(runtime).toContain('https://www.postgresql.org/media/keys/ACCC4CF8.asc');
    expect(runtime).toContain('gpg --batch --show-keys --with-colons');
    expect(runtime).toContain('B97B0AFCAA1A47F044F244A07FCC7D46ACCC4CF8');
    expect(runtime).toContain('deb [arch=amd64,arm64 signed-by=/usr/share/keyrings/postgresql-pgdg.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main');
    expect(runtime).not.toMatch(/trusted=yes|allow-unauthenticated|AllowInsecureRepositories/);
    expect(runtime.indexOf('apt-get install -y --no-install-recommends postgresql-common')).toBeGreaterThan(0);
    expect(runtime.indexOf('apt-get install -y --no-install-recommends postgresql-common')).toBeLessThan(runtime.indexOf('create_main_cluster = false'));
    expect(runtime.indexOf('create_main_cluster = false')).toBeLessThan(runtime.indexOf('postgresql-17 postgresql-client-17'));
    expect(runtime).toContain('start_conf = manual');
    expect(runtime).toContain('exit 101');
    const layer = runtime.slice(runtime.indexOf('RUN apt-get update'), runtime.indexOf('\nCOPY --from=quality'));
    expect(layer).toContain('apt-get update -o APT::Update::Error-Mode=any');
    expect(layer.indexOf('rm -rf /var/lib/apt/lists/*')).toBeGreaterThan(layer.indexOf('postgresql-17 postgresql-client-17'));
  });

  it('exposes the PostgreSQL 17 tools in normal and login shells and runs their lifecycle smoke at build time', () => {
    expect(runtime).toContain('ENV PATH=/usr/lib/postgresql/17/bin:$PATH');
    const profile = runtime.slice(runtime.lastIndexOf('RUN printf'), runtime.indexOf('> /etc/profile.d/hornhoof-tools.sh'));
    expect(profile).toContain('PATH=/usr/lib/postgresql/17/bin:$PATH');
    expect(runtime).toContain('COPY apps/node/service-runtime-smoke.mjs /app/apps/node/service-runtime-smoke.mjs');
    expect(runtime).toContain('RUN node /app/apps/node/service-runtime-smoke.mjs');
    expect(runtime.indexOf('RUN node /app/apps/node/service-runtime-smoke.mjs')).toBeLessThan(runtime.indexOf('USER node'));
  });

  it('patches mutator worker modules before installation and runs its bootstrap regression in the quality stage', () => {
    const patch = 'patch --directory=$ub/mutator --strip=1 < /tmp/hornhoof-quality/mutator-worker-modules.patch';
    expect(dockerfile).toContain('COPY apps/node/quality/ /tmp/hornhoof-quality/');
    expect(dockerfile.indexOf(patch)).toBeGreaterThan(dockerfile.indexOf('fetch unclebob/mutator'));
    expect(dockerfile.indexOf(patch)).toBeLessThan(dockerfile.indexOf('for tool in crapper dryer mutator'));
    expect(dockerfile).toContain('$ub/mutator/.venv/bin/python /tmp/hornhoof-quality/test_mutator_workers.py;');
  });

  it("checks in the quality stage, with each tool's own Python, that the tools read a part of a run as a project", () => {
    const quality = dockerfile.slice(0, dockerfile.lastIndexOf('\nFROM '));
    expect(quality).toContain('$ub/crapper/.venv/bin/python /tmp/hornhoof-quality/test_part_paths.py CrapperPaths;');
    expect(quality).toContain('$ub/dryer/.venv/bin/python /tmp/hornhoof-quality/test_part_paths.py DryerPaths;');
    expect(quality).toContain('$ub/mutator/.venv/bin/python /tmp/hornhoof-quality/test_part_paths.py MutatorPaths;');
  });

  it('carries the everyday programs agents reach for in a shell', () => {
    for (const program of ['git', 'curl', 'ripgrep', 'tmux', 'procps', 'util-linux', 'jq', 'file', 'python3', 'python-is-python3', 'python3-pil']) expect(installed).toContain(program);
  });

  it('starts the node under tini, which ends the processes left without a parent, such as a closed view\'s tmux client', () => {
    expect(installed).toContain('tini');
    expect(runtime).toContain('ENTRYPOINT ["/usr/bin/tini", "--", "node", "/app/apps/node/dist/main.js"]');
    expect(runtime).toContain('CMD ["run"]');
  });

  it('installs unzip in the runtime and fails the build if unzip -v fails', () => {
    expect(installed).toContain('unzip');
    const layer = runtime.slice(runtime.indexOf('RUN apt-get update'), runtime.indexOf('\nCOPY --from=quality'));
    expect(layer).toContain('apt-get install -y --no-install-recommends');
    expect(layer).toContain('rm -rf /var/lib/apt/lists/*');
    expect(layer).toMatch(/&& unzip -v(?:\s|$)/);
  });

  it('installs zip beside unzip, and PyYAML, pip and pytest for Python, and fails the build if any of them does not run', () => {
    for (const name of ['zip', 'python3-yaml', 'python3-pip', 'python3-pytest']) expect(installed).toContain(name);
    const layer = runtime.slice(runtime.indexOf('RUN apt-get update'), runtime.indexOf('\nCOPY --from=quality'));
    for (const command of ['zip -v', "python3 -c 'import yaml'", 'python3 -m pip --version', 'python3 -m pytest --version']) {
      expect(layer).toContain(`&& ${command} `);
    }
  });

  it("lets agents send and read a mailbox's mail with the image's curl and Python, and fails the build when either loses its mail protocols", () => {
    for (const name of ['ca-certificates', 'curl', 'python3']) expect(installed).toContain(name);
    const check = runtime.slice(runtime.indexOf('RUN curl --version'));
    expect(check).toMatch(/^RUN curl --version \| grep -qw smtps && curl --version \| grep -qw imaps \\\n {2}&& python3 -c 'import email\.message, imaplib, mimetypes, smtplib, ssl'\n/);
    expect(runtime.indexOf('RUN curl --version')).toBeGreaterThan(runtime.indexOf('RUN apt-get update'));
    expect(runtime.indexOf('RUN curl --version')).toBeLessThan(runtime.indexOf('USER node'));
  });

  it("draws Arabic joined in the image's browsers with Noto Sans Arabic, and fails the build when sans-serif Arabic does not reach it", () => {
    expect(installed).toContain('fonts-noto-core');
    const conf = readFileSync(new URL('../fonts/66-noto-sans-arabic.conf', import.meta.url), 'utf8');
    expect(conf).toMatch(/<alias>\s*<family>sans-serif<\/family>\s*<prefer><family>Noto Sans Arabic<\/family><\/prefer>\s*<\/alias>/);
    const copy = 'COPY apps/node/fonts/66-noto-sans-arabic.conf /etc/fonts/conf.d/66-noto-sans-arabic.conf\n';
    expect(runtime).toContain(copy);
    const check = runtime.slice(runtime.indexOf(copy) + copy.length);
    expect(check).toMatch(/^RUN fc-cache \\\n {2}&& fc-list :lang=ar family \| grep -qx 'Noto Sans Arabic' \\\n {2}&& fc-match 'sans-serif:lang=ar' \| grep -q '\^NotoSansArabic-Regular'\n/);
    expect(runtime.indexOf(copy)).toBeGreaterThan(runtime.indexOf('RUN apt-get update'));
    expect(runtime.indexOf(copy)).toBeLessThan(runtime.indexOf('USER node'));
  });

  it('installs the GitHub CLI in the runtime stage at a pinned version with verified per-arch SHA-256 and checks gh --version', () => {
    const version = runtime.match(/ARG GH_VERSION=(\d+\.\d+\.\d+)\n/)?.[1];
    const amd64Sha = runtime.match(/ARG GH_AMD64_SHA256=([0-9a-f]{64})\n/)?.[1];
    const arm64Sha = runtime.match(/ARG GH_ARM64_SHA256=([0-9a-f]{64})\n/)?.[1];
    expect(version).toBe('2.103.3');
    expect(amd64Sha).toBe('4c806978ffce1cec70853302a56d70ac6da4f19bae7adca4e1a8ab00633dd91d');
    expect(arm64Sha).toBe('ee32df2323c8847f5fac6cb6b4b69ca75828e9329a8f22f677021f7b3306ce63');
    expect(amd64Sha).not.toBe(arm64Sha);
    expect(runtime).toContain('https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_${arch}.tar.gz');
    expect(runtime).toContain('sha256sum -c -');
    expect(runtime).toContain('gh --version');
    expect(runtime.indexOf('gh --version')).toBeLessThan(runtime.indexOf('USER node'));
  });

  it('installs ShellCheck in the runtime stage at a pinned version with verified per-arch SHA-256 and checks shellcheck --version', () => {
    const version = runtime.match(/ARG SHELLCHECK_VERSION=(\d+\.\d+\.\d+)\n/)?.[1];
    const amd64Sha = runtime.match(/ARG SHELLCHECK_AMD64_SHA256=([0-9a-f]{64})\n/)?.[1];
    const arm64Sha = runtime.match(/ARG SHELLCHECK_ARM64_SHA256=([0-9a-f]{64})\n/)?.[1];
    expect(version).toBe('0.11.0');
    expect(amd64Sha).toBe('b7af85e41cc99489dcc21d66c6d5f3685138f06d34651e6d34b42ec6d54fe6f6');
    expect(arm64Sha).toBe('68a8133197a50beb8803f8d42f9908d1af1c5540d4bb05fdfca8c1fa47decefc');
    expect(amd64Sha).not.toBe(arm64Sha);
    expect(runtime).toContain('https://github.com/koalaman/shellcheck/releases/download/v${SHELLCHECK_VERSION}/shellcheck-v${SHELLCHECK_VERSION}.linux.${sc_arch}.tar.gz');
    expect(runtime).toContain('echo "$sc_sha  /tmp/shellcheck.tar.gz" | sha256sum -c -');
    expect(runtime).toContain('shellcheck --version');
    expect(runtime.indexOf('shellcheck --version')).toBeLessThan(runtime.indexOf('USER node'));
  });

  it("keeps the agent programs on the PATH of a login shell, which Debian's /etc/profile sets again", () => {
    const profile = runtime.match(/> \/etc\/profile\.d\/([\w-]+\.sh)/);
    expect(profile).not.toBeNull();
    const line = runtime.slice(runtime.lastIndexOf('RUN ', profile!.index), profile!.index);
    expect(line).toContain('PATH=/data/tools/bin:$PATH');
    expect(line).toContain('export PATH');
    expect(runtime.indexOf(profile![0])).toBeLessThan(runtime.indexOf('USER node'));
  });

  it('carries no copy of obra/superpowers for the agents, neither its plugin nor its skills', () => {
    expect(dockerfile).not.toMatch(/superpowers/i);
  });

  it('names superpowers in the templates sources as a source we learned from, under MIT, and no longer as shipped', () => {
    const sources = readFileSync(new URL('../../../templates/SOURCES.md', import.meta.url), 'utf8');
    const credit = sources.split('\n').find(line => line.startsWith('| obra/superpowers |'))!;
    expect(credit).toContain('| MIT |');
    expect(credit).not.toMatch(/shipped|word for word|plugin|node image/i);
    expect(sources).not.toMatch(/carries obra\/superpowers/i);
  });

  it("gives every agent hh-browse, which drives the image's own Playwright and Chromium and installs nothing", () => {
    expect(runtime).toContain('COPY --chmod=755 apps/node/hh-browse.cjs /usr/local/bin/hh-browse');
    expect(runtime.indexOf('COPY --chmod=755 apps/node/hh-browse.cjs')).toBeGreaterThan(runtime.indexOf('COPY --from=build /app/apps/node/dist apps/node/dist'));
    const launcher = readFileSync(new URL('../hh-browse.cjs', import.meta.url), 'utf8');
    expect(launcher).toMatch(/^#!\/usr\/bin\/env node\n/);
    expect(launcher).toContain('/app/apps/node/dist/web-page/cli.js');
    expect(launcher).not.toMatch(/npm|npx|install/);
  });

  it('installs full Playwright Chromium, Firefox and WebKit at the lockfile version in the browser stage and points runtime browsers to /data/browsers', () => {
    const browserStage = dockerfile.slice(dockerfile.indexOf('AS browser\n'), dockerfile.indexOf('AS quality\n'));
    expect(browserStage).not.toContain('ARG PLAYWRIGHT_VERSION=');
    /* Only the version: a release, which moves the lockfile's own versions, downloads no browser again. */
    expect(browserStage).not.toContain('package-lock.json');
    expect(browserStage).toContain('COPY --from=manifests /playwright-version /tmp/playwright-version');
    expect(browserStage).toContain('npm install -g "playwright@$(cat /tmp/playwright-version)"');
    const manifestsStage = dockerfile.slice(dockerfile.indexOf('AS manifests\n'), dockerfile.indexOf('AS build\n'));
    expect(manifestsStage).toContain("packages['node_modules/@playwright/test'].version\" > /playwright-version");
    expect(browserStage).not.toContain('--only-shell');
    /* A design is checked in the three engines, so the image brings all three and a node downloads none. */
    expect(browserStage).toContain('PLAYWRIGHT_HOST_PLATFORM_OVERRIDE="$target" playwright install chromium firefox webkit \\\n');
    expect(browserStage).toContain('chmod -R a+rX /opt/ms-playwright');

    expect(runtime).toContain('$(cat /opt/browser-packages)');
    expect(runtime).toContain('COPY --from=browser /opt/ms-playwright /opt/ms-playwright');
    expect(runtime).toContain('COPY --from=browser /usr/local/lib/node_modules/playwright /usr/local/lib/node_modules/playwright');
    expect(runtime).toContain('ln -s ../lib/node_modules/playwright/cli.js /usr/local/bin/playwright');
    expect(runtime).toContain('PLAYWRIGHT_BROWSERS_PATH=/data/browsers');
    expect(runtime).toContain('PLAYWRIGHT_SKIP_BROWSER_GC=1');
    expect(runtime.indexOf('PLAYWRIGHT_BROWSERS_PATH=/data/browsers')).toBeLessThan(runtime.indexOf('USER node'));
  });
});

interface SmokeEvent { program: string; args: string[]; uid: number; config?: string; socket?: string; mode?: number; data?: string; dataMode?: number }
const fixtures: string[] = [];
afterEach(() => { for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true }); });

async function smokeFixture(options: { versions?: Record<string, string>; missing?: string; fail?: string; query?: string; rootAccount?: 'postgres' | 'node' | 'root-only' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'hh-smoke-fixture-'));
  fixtures.push(dir);
  chmodSync(dir, 0o755);
  const log = join(dir, 'events');
  writeFileSync(log, '');
  chmodSync(log, 0o666);
  for (const program of ['postgres', 'initdb', 'pg_ctl', 'psql']) {
    if (program === options.missing) continue;
    writeFileSync(join(dir, program), `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const program = ${JSON.stringify(program)};
const args = process.argv.slice(2);
const event = { program, args, uid: process.getuid() };
const data = args[args.indexOf('-D') + 1];
if (program === 'pg_ctl' && args.includes('start')) {
  event.config = fs.readFileSync(path.join(data, 'postgresql.conf'), 'utf8');
  event.socket = event.config.match(/unix_socket_directories = '([^']+)'/)[1];
  event.mode = fs.statSync(event.socket).mode & 0o777;
  event.data = data;
  event.dataMode = fs.statSync(data).mode & 0o777;
  fs.writeFileSync(path.join(data, 'postmaster.pid'), String(process.pid));
}
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(event) + '\\n');
if (args.includes('--version')) {
  process.stdout.write(program + ' (PostgreSQL) ${options.versions?.[program] ?? '17.6'}\\n');
} else if (program === 'initdb') {
  fs.mkdirSync(data, { mode: 0o700 });
  fs.writeFileSync(path.join(data, 'postgresql.conf'), '');
} else if (${JSON.stringify(options.fail ?? '')} === program && !args.includes('stop')) {
  process.stderr.write('controlled ' + program + ' failure\\n');
  process.exitCode = 1;
} else if (program === 'psql') {
  process.stdout.write(${JSON.stringify(options.query ?? '17|2|\n')});
} else if (program === 'pg_ctl' && args.includes('stop')) {
  fs.unlinkSync(path.join(data, 'postmaster.pid'));
}
`, { mode: 0o755 });
  }
  const args = [fileURLToPath(new URL('../service-runtime-smoke.mjs', import.meta.url))];
  if (options.rootAccount) {
    // Simulate the root build parent at the OS boundary; every executable still runs with a real unprivileged UID.
    const uid = process.getuid!() || 1000;
    const gid = process.getgid!() || 1000;
    const passwd = options.rootAccount === 'root-only' ? 'root:x:0:0::/root:/bin/sh' : `${options.rootAccount}:x:${uid}:${gid}::/tmp:/bin/sh`;
    const preload = join(dir, 'root-parent.mjs');
    writeFileSync(preload, `
import fs from 'node:fs';
import process from 'node:process';
import { syncBuiltinESMExports } from 'node:module';
const readFileSync = fs.readFileSync;
fs.readFileSync = (path, ...args) => path === '/etc/passwd' ? ${JSON.stringify(passwd)} : readFileSync(path, ...args);
process.getuid = () => 0;
syncBuiltinESMExports();
`);
    args.unshift('--import', preload);
  }
  /* The smoke runs to its end, however long that takes: the runner's limit for the test is the only limit. */
  const child = spawn(process.execPath, args, { env: { ...process.env, PATH: dir, PGHOST: 'outside.invalid', PGPORT: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const result = { status: null as number | null, stdout: '', stderr: '' };
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => { result.stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { result.stderr += chunk; });
  [result.status] = await once(child, 'close') as [number | null];
  const events = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as SmokeEvent);
  return { result, events };
}

describe('the PostgreSQL runtime smoke', () => {
  it.each(['postgres', 'node'] as const)('uses the trusted %s account for a root build parent', async rootAccount => {
    const { result, events } = await smokeFixture({ rootAccount });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(events.every(event => event.uid > 0)).toBe(true);
    expect(events.find(event => event.program === 'initdb' && event.args[0] !== '--version')).toBeDefined();
  });

  it('refuses to initialize as root when no trusted unprivileged account exists', async () => {
    const { result, events } = await smokeFixture({ rootAccount: 'root-only' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('requires a trusted unprivileged');
    expect(events).toEqual([]);
  });

  it.each(['postgres', 'initdb', 'pg_ctl', 'psql'])('rejects %s from another major before initializing a database', async program => {
    const { result, events } = await smokeFixture({ versions: { [program]: '18.1' } });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`PostgreSQL 17 required: ${program}`);
    expect(events.every(event => event.args[0] === '--version')).toBe(true);
  });

  it('rejects a missing PostgreSQL executable before initializing a database', async () => {
    const { result, events } = await smokeFixture({ missing: 'initdb' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('PostgreSQL 17 required: initdb');
    expect(events.every(event => event.args[0] === '--version')).toBe(true);
  });

  it('initializes as an unprivileged owner, queries its private socket without TCP and removes the stopped cluster', async () => {
    const { result, events } = await smokeFixture();
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('PostgreSQL 17 runtime smoke passed');
    expect(events.filter(event => event.args[0] === '--version').map(event => event.program)).toEqual(['postgres', 'initdb', 'pg_ctl', 'psql']);
    expect(events.every(event => event.uid > 0)).toBe(true);
    expect(events.find(event => event.program === 'initdb' && event.args[0] !== '--version')?.args).toContain('--locale=C.UTF-8');
    const start = events.find(event => event.program === 'pg_ctl' && event.args.includes('start'))!;
    expect(start.config).toContain("listen_addresses = ''");
    expect(start.config).toContain('unix_socket_permissions = 0700');
    expect(start.mode).toBe(0o700);
    expect(start.dataMode).toBe(0o700);
    expect(start.socket!.length).toBeLessThan(80);
    const query = events.find(event => event.program === 'psql' && event.args[0] !== '--version')!;
    expect(query.args).toContain(start.socket);
    expect(query.args).toContain('ON_ERROR_STOP=1');
    expect(query.args.join(' ')).toContain('SELECT');
    expect(events.at(-1)?.args).toEqual(['-D', start.data, '-m', 'fast', '-w', '-t', '20', 'stop']);
    expect(existsSync(start.data!)).toBe(false);
    expect(existsSync(start.socket!)).toBe(false);
  });

  it.each([{ fail: 'psql' }, { query: '16|2|\n' }, { fail: 'pg_ctl' }])('stops and removes the cluster when startup or the real query fails: %j', async options => {
    const { result, events } = await smokeFixture(options);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/controlled|Unexpected PostgreSQL smoke query/);
    const start = events.find(event => event.program === 'pg_ctl' && event.args.includes('start'))!;
    expect(events.at(-1)?.args).toContain('stop');
    expect(existsSync(start.data!)).toBe(false);
    expect(existsSync(start.socket!)).toBe(false);
  });
});
