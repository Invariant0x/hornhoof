import { describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { as, listen, setUpCompany, testApp } from './helpers.js';

/* The CEO renames their own title, a change a page could ask for with their cookie. */
async function company(env: NodeJS.ProcessEnv = {}) {
  const { app } = await testApp(env);
  const ceo = await setUpCompany(app);
  const me = (await app.inject({ url: '/api/me', ...as(ceo) })).json().person;
  const rename = (headers: Record<string, string>) =>
    app.inject({ method: 'PATCH', url: `/api/people/${me.id}`, payload: { title: 'Founder' }, headers: { host: 'localhost:8080', ...headers }, ...as(ceo) });
  return { app, ceo, rename };
}

describe('a change from a page of another site', () => {
  it("is refused, even with the person's cookie", async () => {
    const { rename } = await company();
    for (const origin of ['http://localhost:3000', 'https://evil.test', 'null']) {
      const res = await rename({ origin });
      expect(res.statusCode, origin).toBe(403);
      expect(res.json().error.reason).toBe('cross_site');
    }
  });

  it("goes through from Hornhoof's own pages, behind a proxy too, and from programs that name no page", async () => {
    const { rename } = await company({ PUBLIC_URL: 'https://hornhoof.acme.test' });
    expect((await rename({ origin: 'http://localhost:8080' })).statusCode).toBe(200);
    expect((await rename({ origin: 'https://hornhoof.acme.test', host: 'app:8080' })).statusCode).toBe(200);
    expect((await rename({ origin: 'https://office.acme.test', host: 'app:8080', 'x-forwarded-host': 'office.acme.test' })).statusCode).toBe(200);
    expect((await rename({})).statusCode).toBe(200);
  });

  it('is not asked about reading', async () => {
    const { app, ceo } = await company();
    expect((await app.inject({ url: '/api/people', headers: { host: 'localhost:8080', origin: 'https://evil.test' }, ...as(ceo) })).statusCode).toBe(200);
  });

  it('cannot open a terminal', async () => {
    const { app, ceo } = await company();
    const url = await listen(app);
    const open = (origin: string) =>
      new Promise<number>(done => {
        const ws = new WebSocket(url.replace('/api/nodes/socket', '/api/agents/orchestrator/terminal'), { origin, headers: { cookie: `hh_session=${ceo}` } });
        ws.on('unexpected-response', (req, res) => {
          req.destroy();
          done(res.statusCode ?? 0);
        });
        ws.on('error', () => {});
        ws.on('open', () => {
          ws.close();
          done(101);
        });
      });
    expect(await open('https://evil.test')).toBe(403);
    expect(await open(new URL(url).origin)).not.toBe(403);
  });
});
