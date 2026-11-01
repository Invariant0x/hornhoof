import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

type Service = { image?: string; command?: string[]; volumes?: string[]; environment?: Record<string, string> };
const compose = parse(readFileSync(fileURLToPath(new URL('../../../compose.yaml', import.meta.url)), 'utf8')) as { services: Record<string, Service> };

describe('the tunnel service', () => {
  it("carries the public link with the app's own image, reading only the control folder", () => {
    const { tunnel, app } = compose.services;
    expect(tunnel!.image).toBe(app!.image);
    expect(tunnel!.command).toEqual(['node', 'apps/server/dist/tunnel.js']);
    expect(tunnel!.volumes).toEqual(['control:/control:ro']);
    expect(JSON.stringify(tunnel)).not.toContain('docker.sock');
  });

  it('is the one container the app believes about https', () => {
    expect(compose.services.app!.environment!.TUNNEL_HOST).toBe('tunnel');
  });
});
