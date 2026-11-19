import assert from 'node:assert/strict';
import { test } from 'node:test';
import { versionOut } from '../github-tests/version-out.mjs';

/* global Response, URL */

/* Probes of #1485 for the version lookup of the images, publish and release jobs: which answers of GitHub and the registry
   still read as "not out". Each fake below stands for GitHub or the registry answering outside its usual way. */

const sha = 'a'.repeat(40);
const other = 'c'.repeat(40);
const github = 'https://api.example.invalid';
const registry = 'https://registry.example.invalid';
const storage = 'https://storage.example.invalid';

function fixture(t, answer) {
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
  Object.assign(process.env, { GITHUB_API_URL: github, GITHUB_REPOSITORY: 'example/project', GITHUB_TOKEN: '', HORNHOOF_REGISTRY_URL: registry });
  const seen = [];
  t.mock.method(globalThis, 'fetch', async input => {
    const { origin, pathname } = new URL(input);
    seen.push(`${origin}${pathname}`);
    const res = answer(origin, pathname);
    if (!res) throw new Error(`Unexpected fixture request ${origin}${pathname}.`);
    return res;
  });
  return seen;
}

const tagRef = commit => Response.json({ ref: 'refs/tags/v0.34.1', object: { type: 'commit', sha: commit } });

test('a version manifest answered by a redirect to a 404 reads as not published, so publish moves the version and latest', async t => {
  const seen = fixture(t, (origin, pathname) => {
    if (origin === github && pathname.endsWith('/git/ref/tags/v0.34.1')) return tagRef(sha);
    if (origin === registry && pathname.endsWith('/manifests/0.34.1')) return new Response(null, { status: 307, headers: { location: `${storage}/gone` } });
    if (origin === storage && pathname === '/gone') return new Response(null, { status: 404 });
    return null;
  });
  const outcome = await versionOut({ job: 'publish', event: 'push', sha, version: '0.34.1' });
  assert.equal(outcome.verdict, 'new');
  assert.ok(seen.includes(`${storage}/gone`));
});

test('a version manifest answered 200 with the JSON null reads as not published', async t => {
  fixture(t, (origin, pathname) => {
    if (origin === github && pathname.endsWith('/git/ref/tags/v0.34.1')) return tagRef(sha);
    if (origin === registry && pathname.endsWith('/manifests/0.34.1')) return new Response('null', { status: 200, headers: { 'content-type': 'application/json' } });
    return null;
  });
  const outcome = await versionOut({ job: 'publish', event: 'push', sha, version: '0.34.1' });
  assert.equal(outcome.verdict, 'new');
});

test('the tag on another commit stops publish, but a tag reference answered 200 with the JSON null reads as no tag', async t => {
  let ref = tagRef(other);
  fixture(t, (origin, pathname) => {
    if (origin === github && pathname.endsWith('/git/ref/tags/v0.34.1')) return ref;
    if (origin === registry && pathname.endsWith('/manifests/0.34.1')) return new Response(null, { status: 404 });
    return null;
  });
  assert.equal((await versionOut({ job: 'publish', event: 'push', sha, version: '0.34.1' })).verdict, 'stop');
  ref = new Response('null', { status: 200, headers: { 'content-type': 'application/json' } });
  assert.equal((await versionOut({ job: 'publish', event: 'push', sha, version: '0.34.1' })).verdict, 'new');
});

test('a GitHub 503 for the tag reference stops the job instead of reading as no tag', async t => {
  fixture(t, (origin, pathname) => (origin === github && pathname.endsWith('/git/ref/tags/v0.34.1') ? new Response(null, { status: 503 }) : null));
  assert.equal((await versionOut({ job: 'publish', event: 'push', sha, version: '0.34.1' })).verdict, 'unknown');
});
