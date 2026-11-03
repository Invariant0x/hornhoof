import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const dockerfile = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');
/* The packages of the last stage, the one agents run in. */
const runtime = dockerfile.slice(dockerfile.lastIndexOf('\nFROM '));
const installed = new Set([...runtime.matchAll(/apt-get install -y --no-install-recommends ([^\\\n]+)/g)].flatMap(m => m[1]!.split(/\s+/)));

describe('the node image', () => {
  it('patches mutator worker modules before installation and runs its bootstrap regression in the quality stage', () => {
    const patch = 'patch --directory=$ub/mutator --strip=1 < /tmp/hornhoof-quality/mutator-worker-modules.patch';
    expect(dockerfile).toContain('COPY apps/node/quality/ /tmp/hornhoof-quality/');
    expect(dockerfile.indexOf(patch)).toBeGreaterThan(dockerfile.indexOf('fetch unclebob/mutator'));
    expect(dockerfile.indexOf(patch)).toBeLessThan(dockerfile.indexOf('for tool in crapper dryer mutator'));
    expect(dockerfile).toContain('$ub/mutator/.venv/bin/python /tmp/hornhoof-quality/test_mutator_workers.py;');
  });

  it('carries the everyday programs agents reach for in a shell', () => {
    for (const program of ['git', 'curl', 'ripgrep', 'tmux', 'procps', 'jq', 'file', 'python3', 'python-is-python3', 'python3-pil']) expect(installed).toContain(program);
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

  it("keeps the agent programs on the PATH of a login shell, which Debian's /etc/profile sets again", () => {
    const profile = runtime.match(/> \/etc\/profile\.d\/([\w-]+\.sh)/);
    expect(profile).not.toBeNull();
    const line = runtime.slice(runtime.lastIndexOf('RUN ', profile!.index), profile!.index);
    expect(line).toContain('PATH=/data/tools/bin:$PATH');
    expect(line).toContain('export PATH');
    expect(runtime.indexOf(profile![0])).toBeLessThan(runtime.indexOf('USER node'));
  });

  it('carries superpowers at a pinned commit where the node looks for it, readable by every agent', () => {
    expect(dockerfile).toMatch(/ARG SUPERPOWERS_COMMIT=[0-9a-f]{40}\n/);
    expect(dockerfile).toContain('fetch obra/superpowers /opt/hornhoof/superpowers $SUPERPOWERS_COMMIT');
    expect(runtime).toContain('COPY --from=quality /opt/hornhoof/superpowers /opt/hornhoof/superpowers');
  });

  it('credits superpowers in the templates sources at the commit it pins, as shipped word for word under MIT', () => {
    const commit = dockerfile.match(/ARG SUPERPOWERS_COMMIT=([0-9a-f]{40})/)![1]!;
    const credit = readFileSync(new URL('../../../templates/SOURCES.md', import.meta.url), 'utf8').split('\n').find(line => line.startsWith('| obra/superpowers |'))!;
    expect(credit).toContain('| MIT |');
    expect(credit).toContain(`word for word at commit ${commit}`);
  });
});
