import { describe, expect, it } from 'vitest';
import { TUNNEL, testApp, viaLink } from './helpers.js';

const TOKEN = 'abc_-1';
const KEY_AUTHORIZATION = `${TOKEN}.thumbprint`;
const path = (token: string) => `/.well-known/acme-challenge/${token}`;

describe('ACME challenge answers', () => {
  it('answers a token it holds as text, and nothing else', async () => {
    const { app } = await testApp({ TUNNEL_HOST: TUNNEL });
    const get = (token: string) => app.inject({ method: 'GET', url: path(token) });
    expect((await get(TOKEN)).statusCode).toBe(404);

    app.ctx.challenges.answer(TOKEN, KEY_AUTHORIZATION);

    const answer = await get(TOKEN);
    expect(answer.statusCode).toBe(200);
    expect(answer.headers['content-type']).toMatch(/^text\/plain/);
    expect(answer.body).toBe(KEY_AUTHORIZATION);
    const overLink = await app.inject({ method: 'GET', url: path(TOKEN), ...viaLink() });
    expect(overLink.statusCode).toBe(200);
    expect(overLink.body).toBe(KEY_AUTHORIZATION);
    expect((await get('other')).statusCode).toBe(404);

    app.ctx.challenges.forget(TOKEN);
    expect((await get(TOKEN)).statusCode).toBe(404);
  });

  it('does not answer a token outside the shape of one, even when it holds it', async () => {
    const { app } = await testApp();
    app.ctx.challenges.answer('a.b', KEY_AUTHORIZATION);
    expect((await app.inject({ method: 'GET', url: path('a.b') })).statusCode).toBe(404);
  });
});
