import { describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';
import { SETUP, setUpCompany, testApp } from './helpers.js';

const NEW_PASSWORD = 'a brand new password';

async function cli(args: string[], deps: Omit<Parameters<typeof runCli>[1], 'print'>) {
  const lines: string[] = [];
  const code = await runCli(args, { ...deps, print: line => lines.push(line) });
  return { code, out: lines.join('\n') };
}

describe('cli', () => {
  it('owner-link prints a one-time link that lets the owner set a new password', async () => {
    const { app, db, config } = await testApp({ PUBLIC_URL: 'https://hq.acme.com' });
    await setUpCompany(app);
    const res = await cli(['owner-link'], { db, config });
    expect(res.code).toBe(0);
    const token = res.out.match(/https:\/\/hq\.acme\.com\/invite\/([A-Za-z0-9_-]{43})/)?.[1];
    expect(token).toBeDefined();
    expect(res.out).toContain('7 days');

    const opened = await app.inject({ url: `/api/invites/${token}` });
    expect(opened.json()).toMatchObject({ name: 'Ivan', email: 'ivan@acme.com' });
    const accepted = await app.inject({ method: 'POST', url: `/api/invites/${token}/accept`, payload: { password: NEW_PASSWORD } });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().person).toMatchObject({ isOwner: true, status: 'active' });

    const login = (password: string) => app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'ivan@acme.com', password } });
    expect((await login(NEW_PASSWORD)).statusCode).toBe(200);
    expect((await login(SETUP.password)).statusCode).toBe(401);
  });

  it('owner-link explains that a fresh Hornhoof has no owner yet', async () => {
    const { db, config } = await testApp();
    const res = await cli(['owner-link'], { db, config });
    expect(res.code).toBe(1);
    expect(res.out).toContain('not set up yet');
  });

  it('lists the commands for an unknown one', async () => {
    const { db, config } = await testApp();
    const res = await cli(['dance'], { db, config });
    expect(res.code).toBe(1);
    expect(res.out).toContain('owner-link');
  });
});
