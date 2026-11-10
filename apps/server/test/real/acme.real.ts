import { createPrivateKey, X509Certificate } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { AcmeAccount, AcmeError, type ChallengeHooks, newAccountKey } from '../../src/modules/tls/acme.js';
import { certId, renewalInfo } from '../../src/modules/tls/ari.js';
import { certInfo } from '../../src/modules/tls/x509.js';
import { testApp } from '../helpers.js';

function fromRunScript(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error('run with npm run test:real');
  return value;
}

const DIRECTORY = fromRunScript('PEBBLE_DIRECTORY');
const MANAGEMENT = fromRunScript('PEBBLE_MANAGEMENT');

const HOST = 'acme.test';
// The port Pebble's default config validates HTTP-01 on, shared by every test here.
const VALIDATION_PORT = 5002;
const HOUR_MS = 3600 * 1000;
const NOT_ANSWERING: ChallengeHooks = { answer: () => {}, forget: () => {} };

async function appAnswering(): Promise<FastifyInstance> {
  const { app } = await testApp();
  await app.listen({ port: VALIDATION_PORT, host: '0.0.0.0' });
  return app;
}

function answeringHooks(app: FastifyInstance): { hooks: ChallengeHooks; tokens: string[] } {
  const tokens: string[] = [];
  const hooks: ChallengeHooks = {
    answer: (token, keyAuthorization) => {
      tokens.push(token);
      app.ctx.challenges.answer(token, keyAuthorization);
    },
    forget: (token) => app.ctx.challenges.forget(token),
  };
  return { hooks, tokens };
}

// Pebble reuses an account's valid authorization half the time, so a test that must see a validation gets its own account.
async function newAccount(opts?: ConstructorParameters<typeof AcmeAccount>[3]): Promise<AcmeAccount> {
  return new AcmeAccount(DIRECTORY, await newAccountKey(), null, opts);
}

async function acmeErrorFrom(work: Promise<unknown>): Promise<AcmeError> {
  const error = await work.then(() => null, (reason: unknown) => reason);
  expect(error).toBeInstanceOf(AcmeError);
  return error as AcmeError;
}

async function setRenewalWindow(certPem: string, start: Date, end: Date): Promise<void> {
  const res = await fetch(`${MANAGEMENT}/set-renewal-info/`, {
    method: 'POST',
    body: JSON.stringify({ Certificate: certPem, ARIResponse: JSON.stringify({ suggestedWindow: { start, end } }) }),
  });
  expect(res.ok).toBe(true);
}

describe('ACME against Pebble', () => {
  it('makes an account and finds the same one again by its key', async () => {
    const key = await newAccountKey();
    const made = await new AcmeAccount(DIRECTORY, key).account();
    expect(made).toMatch(/^https:/);
    expect(await new AcmeAccount(DIRECTORY, key).account()).toBe(made);
  });

  it("orders a certificate over HTTP-01, answered by the app's own route", async () => {
    const app = await appAnswering();
    const { hooks, tokens } = answeringHooks(app);
    const { certPem, keyPem } = await (await newAccount()).issue(HOST, hooks, { selfCheck: false });
    expect(certInfo(certPem).names).toEqual([HOST]);
    expect(certId(certPem)).not.toBeNull();
    expect(new X509Certificate(certPem).checkPrivateKey(createPrivateKey(keyPem))).toBe(true);
    expect(tokens.length).toBeGreaterThan(0);
    expect(tokens.map((token) => app.ctx.challenges.get(token))).toEqual(tokens.map(() => undefined));
  });

  it('asks when to renew, and renews once with replaces', async () => {
    const app = await appAnswering();
    const { hooks } = answeringHooks(app);
    const account = await newAccount();
    const first = await account.issue(HOST, hooks, { selfCheck: false });
    const a = certInfo(first.certPem);

    const window = (await renewalInfo(DIRECTORY, first.certPem))!;
    expect(window.start.getTime()).toBeLessThan(window.end.getTime());
    expect(window.start.getTime()).toBeGreaterThanOrEqual(a.notBefore.getTime());
    expect(window.end.getTime()).toBeLessThanOrEqual(a.notAfter.getTime());

    await setRenewalWindow(first.certPem, new Date(Date.now() - HOUR_MS), new Date(Date.now() - 60_000));
    expect((await renewalInfo(DIRECTORY, first.certPem))!.end.getTime()).toBeLessThan(Date.now());

    const replaces = certId(first.certPem)!;
    const second = await account.issue(HOST, hooks, { replaces, selfCheck: false });
    expect(certId(second.certPem)).not.toBe(replaces);
    expect(certInfo(second.certPem).fingerprint256).not.toBe(a.fingerprint256);

    const error = await acmeErrorFrom(account.issue(HOST, hooks, { replaces, selfCheck: false }));
    expect(error.kind).toBe('refused');
    expect(error.type).toBe('urn:ietf:params:acme:error:alreadyReplaced');
  });

  it('says invalid when the app does not answer the challenge', async () => {
    await appAnswering();
    const error = await acmeErrorFrom((await newAccount()).issue(HOST, NOT_ANSWERING, { selfCheck: false }));
    expect(error.kind).toBe('invalid');
    expect(error.type).toMatch(/^urn:ietf:params:acme:error:/);
  });

  it('does not ask the CA to validate while its own check fails', async () => {
    const app = await appAnswering();
    const asked = vi.spyOn(app.ctx.challenges, 'get');
    const account = await newAccount({ backoff: { attempts: 2, min: 100, max: 100 } });
    const error = await acmeErrorFrom(account.issue(HOST, NOT_ANSWERING));
    expect(error.kind).toBe('not_ready');
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(asked).not.toHaveBeenCalled();
  });
});
