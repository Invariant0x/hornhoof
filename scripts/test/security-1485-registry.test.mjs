import assert from 'node:assert/strict';
import { test } from 'node:test';
import { versionOut } from '../github-tests/version-out.mjs';

/* global Response, URL */

test('a config storage outage stops publication and the storage request carries no registry credentials', async t => {
  const sha = 'a'.repeat(40);
  const configDigest = 'sha256:' + 'b'.repeat(64);
  const github = 'https://api.example.invalid';
  const registry = 'https://registry.example.invalid';
  const storage = 'https://storage.example.invalid';
  const oldEnv = {
    GITHUB_API_URL: process.env.GITHUB_API_URL,
    GITHUB_REPOSITORY: process.env.GITHUB_REPOSITORY,
    GITHUB_TOKEN: process.env.GITHUB_TOKEN,
    HORNHOOF_REGISTRY_URL: process.env.HORNHOOF_REGISTRY_URL,
  };
  t.after(() => {
    for (const [key, value] of Object.entries(oldEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  Object.assign(process.env, {
    GITHUB_API_URL: github,
    GITHUB_REPOSITORY: 'example/project',
    GITHUB_TOKEN: 'fixture-token',
    HORNHOOF_REGISTRY_URL: registry,
  });

  const seen = [];
  t.mock.method(globalThis, 'fetch', async (input, options) => {
    const { origin, pathname } = new URL(input);
    const authorization = options.headers?.authorization;
    seen.push({ origin, pathname, authorization });
    if (origin === github) return new Response(null, { status: 404 });
    if (origin === registry && pathname === '/token') return Response.json({ token: 'fixture-pull' });
    if (origin === registry && pathname.endsWith('/manifests/0.34.1')) {
      if (!authorization) {
        return new Response(null, { status: 401, headers: { 'www-authenticate': 'Bearer realm="' + registry + '/token"' } });
      }
      return Response.json({ config: { digest: configDigest } });
    }
    if (origin === registry && pathname.endsWith('/blobs/' + configDigest)) {
      return new Response(null, { status: 307, headers: { location: storage + '/config' } });
    }
    if (origin === storage && pathname === '/config') return new Response(null, { status: 503 });
    throw new Error('Unexpected fixture request.');
  });

  const outcome = await versionOut({ job: 'publish', event: 'push', sha, version: '0.34.1' });

  assert.equal(outcome.verdict, 'unknown');
  assert.match(outcome.why, /answered 503/);
  assert.ok(seen.find(request => request.origin === registry && request.pathname === '/token')?.authorization?.startsWith('Basic '));
  assert.deepEqual(seen.filter(request => request.origin === storage), [{ origin: storage, pathname: '/config', authorization: undefined }]);
});
