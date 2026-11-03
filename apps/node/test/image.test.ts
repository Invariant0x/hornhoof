import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const dockerfile = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');
/* The packages of the last stage, the one agents run in. */
const runtime = dockerfile.slice(dockerfile.lastIndexOf('\nFROM '));
const installed = new Set([...runtime.matchAll(/apt-get install -y --no-install-recommends ([^\\\n]+)/g)].flatMap(m => m[1]!.split(/\s+/)));

describe('the node image', () => {
  it('carries the everyday programs agents reach for in a shell', () => {
    for (const program of ['git', 'curl', 'ripgrep', 'tmux', 'procps', 'jq', 'file', 'python3', 'python-is-python3', 'python3-pil']) expect(installed).toContain(program);
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
