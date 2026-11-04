import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { testApp } from './helpers.js';

const root = (path: string) => new URL(`../../../${path}`, import.meta.url);
const migrations = readdirSync(root('apps/server/drizzle')).filter(f => f.endsWith('.sql')).length;

describe('version', () => {
  it('reports its version and build', async () => {
    const { app } = await testApp({ HORNHOOF_VERSION: '9.9.9', HORNHOOF_COMMIT: 'abc1234def' });
    const version = await app.inject({ method: 'GET', url: '/api/version' });
    expect(version.statusCode).toBe(200);
    expect(version.json()).toEqual({ version: '9.9.9', commit: 'abc1234def', migrations });
    const health = await app.inject({ method: 'GET', url: '/api/health' });
    expect(health.json()).toEqual({ ok: true, version: '9.9.9', commit: 'abc1234def', mode: 'lead' });
  });

  it('falls back to the product version and a local build', async () => {
    const { app } = await testApp();
    const product = JSON.parse(readFileSync(root('package.json'), 'utf8')).version;
    expect((await app.inject({ method: 'GET', url: '/api/version' })).json()).toMatchObject({ version: product, commit: 'local' });
  });

  it("keeps the node's version in step with the product's", () => {
    const product = JSON.parse(readFileSync(root('package.json'), 'utf8')).version;
    const node = JSON.parse(readFileSync(root('apps/node/package.json'), 'utf8')).version;
    expect(product).toMatch(/^\d+\.\d+\.\d+$/);
    expect(node).toBe(product);
  });
});
