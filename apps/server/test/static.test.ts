import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
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

  it('tells browsers not to show Hornhoof inside another page or guess what a file is', async () => {
    const { app } = await testApp({ WEB_DIST: fakeDist() });
    for (const url of ['/', '/people', '/assets/app-1a2b.js', '/api/health', '/api/nope']) {
      const res = await app.inject({ url, headers: { accept: 'text/html' } });
      expect(res.headers['x-frame-options']).toBe('DENY');
      expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
      expect(res.headers['content-security-policy']).toContain("script-src 'self';");
      /* A picture at the line shows from the browser's memory until it goes. */
      expect(res.headers['content-security-policy']).toContain("img-src 'self' data: blob:;");
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['referrer-policy']).toBe('no-referrer');
      expect(res.headers['x-robots-tag']).toBe('noindex, nofollow');
    }
  });

  /* The page answered, then a 404 tried to follow it, and the warning wrote the whole address, an invite's token with it. */
  it('opens a screen link with nothing in the log, so an invite link stays out of it', async () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _encoding, done) {
        lines.push(String(chunk));
        done();
      },
    });
    const { app } = await testApp({ WEB_DIST: fakeDist() }, { level: 'warn', stream });
    for (const url of ['/invite/tok-marker', '/people', '/setup?code=code-marker']) {
      const res = await app.inject({ url, headers: { accept: 'text/html' } });
      expect(res.statusCode, url).toBe(200);
      expect(res.body, url).toContain('<div id="root">');
    }
    expect(lines.join('')).toBe('');
  });

  it('works without a built web app', async () => {
    const { app } = await testApp({ WEB_DIST: join(tmpdir(), 'hornhoof-no-such-dir') });
    const res = await app.inject({ url: '/people', headers: { accept: 'text/html' } });
    expect(res.statusCode).toBe(404);
    expect((await app.inject({ url: '/api/health' })).json()).toMatchObject({ ok: true });
  });
});


describe('screen deep links', () => {
  it('serves the same uncached index for GET and HEAD on screen and nested paths', async () => {
    const { app } = await testApp({ WEB_DIST: fakeDist() });
    const paths = [
      '/tasks', '/tasks/301', '/people/p1', '/departments/d1', '/machines/m1', '/subscriptions',
      '/improvements', '/versions', '/profile', '/settings', '/about', '/tasks/301/review/comment', '/tasks/301?person=p1',
    ];
    for (const path of paths) {
      const get = await app.inject({ method: 'GET', url: path, headers: { accept: 'text/html' } });
      const head = await app.inject({ method: 'HEAD', url: path, headers: { accept: 'text/html' } });
      expect(get.statusCode, path).toBe(200);
      expect(get.headers['content-type'], path).toMatch(/text\/html/);
      expect(get.headers['cache-control'], path).toBe('no-cache');
      expect(get.body, path).toBe('<!doctype html><title>Hornhoof</title><div id="root"></div>');
      expect(head.statusCode, path).toBe(200);
      expect(head.headers['content-type'], path).toMatch(/text\/html/);
      expect(head.headers['cache-control'], path).toBe('no-cache');
      expect(head.body, path).toBe('');
    }
  });
});
