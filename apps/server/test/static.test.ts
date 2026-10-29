import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { testApp } from './helpers.js';

function fakeDist(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hornhoof-web-'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Hornhoof</title><div id="root"></div>');
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'assets', 'app-1a2b.js'), 'console.log(1)');
  return dir;
}

describe('web app serving', () => {
  it('answers app routes with the index page', async () => {
    const { app } = await testApp({ WEB_DIST: fakeDist() });
    for (const url of ['/', '/people', '/invite/abc123']) {
      const res = await app.inject({ url, headers: { accept: 'text/html' } });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      expect(res.body).toContain('<div id="root">');
      expect(res.headers['cache-control']).toBe('no-cache');
    }
  });

  it('serves hashed assets with a long cache', async () => {
    const { app } = await testApp({ WEB_DIST: fakeDist() });
    const res = await app.inject({ url: '/assets/app-1a2b.js' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('console.log(1)');
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
  });

  it('keeps JSON 404s for the API and for missing assets', async () => {
    const { app } = await testApp({ WEB_DIST: fakeDist() });
    for (const url of ['/api', '/api/', '/api/nope', '/assets/missing.js']) {
      const res = await app.inject({ url });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: { code: 'not_found', message: 'Not found.' } });
    }
    expect((await app.inject({ method: 'POST', url: '/people' })).statusCode).toBe(404);
  });

  it('works without a built web app', async () => {
    const { app } = await testApp({ WEB_DIST: join(tmpdir(), 'hornhoof-no-such-dir') });
    const res = await app.inject({ url: '/people', headers: { accept: 'text/html' } });
    expect(res.statusCode).toBe(404);
    expect((await app.inject({ url: '/api/health' })).json()).toEqual({ ok: true });
  });
});
