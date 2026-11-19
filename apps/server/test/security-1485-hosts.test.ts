import { mkdtempSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SERVER, install } from './install-script-helpers.js';

/* Probe of #1485 for #1473: the installer reads a node's --add-host words with docker inspect. These stubs are the usual
   ones, except that the inspect of a container's host mappings fails, as a Docker that cannot answer it would. */
const STUBS = fileURLToPath(new URL('./install-stubs/', import.meta.url));

function stubsWithoutHostMappings(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hh-1485-stubs-'));
  for (const file of readdirSync(STUBS)) if (file !== '_log.sh') symlinkSync(join(STUBS, file), join(dir, file));
  writeFileSync(
    join(dir, '_log.sh'),
    [
      `. ${JSON.stringify(join(STUBS, '_log.sh'))}`,
      'if [ "$(basename "$0")" = docker ] && [ "${1:-}" = inspect ]; then',
      '  case "$*" in *HostConfig.ExtraHosts*) echo "Error response from daemon: a fault of the fixture" >&2; exit 1 ;; esac',
      'fi',
      '',
    ].join('\n'),
  );
  return dir;
}

describe('a core-here node whose host mappings cannot be read', () => {
  const name = 'hornhoof-claude-1c07dac4';
  const env = { STUB_CONTAINERS: `${name}=${SERVER}`, STUB_EXTRA_HOSTS: `${name}=host.docker.internal:host-gateway` };
  const started = (calls: string[]) => calls.find(call => call.startsWith('docker run -d') && call.includes(`--name ${name}`));

  it('keeps its --add-host when docker inspect answers', () => {
    const r = install({ args: [], env });
    expect(r.code).toBe(0);
    expect(started(r.calls)).toContain('--add-host host.docker.internal:host-gateway');
  });

  it('is replaced without its --add-host, the old container removed, and the update still ends well', () => {
    const r = install({ args: [], env: { ...env, STUB_SRC: stubsWithoutHostMappings() } });
    expect(r.code).toBe(0);
    expect(started(r.calls)).toBeDefined();
    expect(started(r.calls)).not.toContain('--add-host');
    expect(r.calls.some(call => call.startsWith(`docker rm -f ${name}-old-`))).toBe(true);
  });
});
