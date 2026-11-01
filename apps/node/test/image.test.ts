import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const dockerfile = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');
/* The packages of the last stage, the one agents run in. */
const runtime = dockerfile.slice(dockerfile.lastIndexOf('\nFROM '));
const installed = new Set([...runtime.matchAll(/apt-get install -y --no-install-recommends ([^\\\n]+)/g)].flatMap(m => m[1]!.split(/\s+/)));

describe('the node image', () => {
  it('carries the everyday programs agents reach for in a shell', () => {
    for (const program of ['git', 'curl', 'ripgrep', 'tmux', 'procps', 'jq', 'file', 'python3']) expect(installed).toContain(program);
  });
});
