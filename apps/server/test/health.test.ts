import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

const SECRET = Buffer.alloc(32, 7).toString('base64');

describe('loadConfig', () => {
  it('throws when HORNHOOF_SECRET is missing', () => {
    expect(() => loadConfig({})).toThrow(/HORNHOOF_SECRET/);
  });

  it('throws when the secret is not 32 bytes', () => {
    expect(() => loadConfig({ HORNHOOF_SECRET: Buffer.alloc(16).toString('base64') })).toThrow(/32 bytes/);
  });

  it('uses defaults for a plain local setup', () => {
    const config = loadConfig({ HORNHOOF_SECRET: SECRET });
    expect(config.port).toBe(8080);
    expect(config.publicUrl).toBe('http://localhost:8080');
    expect(config.secureCookies).toBe(false);
    expect(config.secret.length).toBe(32);
  });

  it('turns on secure cookies for an https public url', () => {
    const config = loadConfig({ HORNHOOF_SECRET: SECRET, PUBLIC_URL: 'https://corp.example.com/' });
    expect(config.secureCookies).toBe(true);
    expect(config.publicUrl).toBe('https://corp.example.com');
  });
});

describe('GET /api/health', () => {
  it('returns ok', async () => {
    const app = await buildApp({ db: null as never, config: loadConfig({ HORNHOOF_SECRET: SECRET }) });
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    await app.close();
  });

  it('returns the error shape for an unknown api route', async () => {
    const app = await buildApp({ db: null as never, config: loadConfig({ HORNHOOF_SECRET: SECRET }) });
    const res = await app.inject({ method: 'GET', url: '/api/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: { code: 'not_found', message: 'Not found.' } });
    await app.close();
  });
});
