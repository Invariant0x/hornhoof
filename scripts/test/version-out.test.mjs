import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { digestOf, imageOf, namedBy, platformOf, rateNote, revisionIn, signIn, tokenIn, tokenRealm, unknownOf, verdictOf, versionOut } from '../github-tests/version-out.mjs';
/* global Response, Buffer, URL */

const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const VERSION = '0.34.1';
const PUSH = { event: 'push', sha: SHA, version: VERSION };

test('the published app image of a version goes by its name in the registry', () => {
  assert.equal(imageOf(VERSION), 'ghcr.io/invariant0x/hornhoof:0.34.1');
});

test('a run by hand builds the images of its commit whatever is out', () => {
  for (const facts of [{}, { tag: OTHER, image: OTHER }, { tag: SHA, image: '' }]) {
    assert.deepEqual(verdictOf({ job: 'images', event: 'workflow_dispatch', sha: SHA, version: VERSION, ...facts }), { verdict: 'new', why: 'A run by hand builds the images of its commit under that commit alone.' });
  }
});

test('a tag on another commit stops every job of a push, whatever is published or released', () => {
  for (const job of ['images', 'publish', 'release']) {
    const { verdict, why } = verdictOf({ job, ...PUSH, tag: OTHER, image: null, release: true });
    assert.equal(verdict, 'stop', job);
    assert.match(why, new RegExp(`^The tag v0\\.34\\.1 is on commit ${OTHER}, not on this commit ${SHA}\\. `), job);
  }
});

test('images and publish build and move a version with no published images, with its tag on this commit or none', () => {
  assert.deepEqual(verdictOf({ job: 'images', ...PUSH, tag: SHA, image: null }), { verdict: 'new', why: 'Version 0.34.1 has no published images yet, though its tag v0.34.1 is on this commit, so this push builds them.' });
  assert.deepEqual(verdictOf({ job: 'publish', ...PUSH, tag: null, image: null }), { verdict: 'new', why: 'Version 0.34.1 has no published images yet, so this job moves the version and latest onto the images of this commit.' });
});

test('images and publish leave a version whose published images are those of this commit', () => {
  assert.deepEqual(verdictOf({ job: 'images', ...PUSH, tag: SHA, image: SHA }), { verdict: 'out', why: `Version 0.34.1 is out already: ${imageOf(VERSION)} holds the images of this commit, so this push builds no images.` });
  assert.deepEqual(verdictOf({ job: 'publish', ...PUSH, tag: null, image: SHA }), { verdict: 'out', why: `Version 0.34.1 is out already: ${imageOf(VERSION)} holds the images of this commit, so nothing moves.` });
});

test('images and publish stop at published images of another commit, or of a commit they cannot tell', () => {
  for (const job of ['images', 'publish']) {
    const other = verdictOf({ job, ...PUSH, tag: null, image: OTHER });
    assert.equal(other.verdict, 'stop');
    assert.match(other.why, new RegExp(`^ghcr\\.io/invariant0x/hornhoof:0\\.34\\.1 holds the images of commit ${OTHER}, not of this commit ${SHA}\\. `));
    const unlabeled = verdictOf({ job, ...PUSH, tag: SHA, image: '' });
    assert.equal(unlabeled.verdict, 'stop');
    assert.match(unlabeled.why, /^ghcr\.io\/invariant0x\/hornhoof:0\.34\.1 has no revision label/);
  }
});

test('the release job releases a version with no release, its tag on this commit or none, and leaves a released one', () => {
  assert.deepEqual(verdictOf({ job: 'release', ...PUSH, tag: SHA, release: false }), { verdict: 'new', why: 'The tag v0.34.1 is on this commit and has no release yet, so this job creates its release.' });
  assert.deepEqual(verdictOf({ job: 'release', ...PUSH, tag: null, release: false }), { verdict: 'new', why: 'Version 0.34.1 has no tag yet, so this job tags this commit and creates its release.' });
  assert.deepEqual(verdictOf({ job: 'release', ...PUSH, tag: SHA, release: true }), { verdict: 'out', why: 'v0.34.1 is released already, so this job releases nothing.' });
});

test('the release job goes by the tag and the release alone, not by the images', () => {
  assert.equal(verdictOf({ job: 'release', ...PUSH, tag: SHA, image: OTHER, release: false }).verdict, 'new');
});

test('a lookup that failed is unknown, a third answer beside out and new, and says why the job stops', () => {
  assert.deepEqual(unknownOf(VERSION, 'GitHub could not be reached'), {
    verdict: 'unknown',
    why: 'Could not tell whether version 0.34.1 is out: GitHub could not be reached. This job stops and builds, moves and releases nothing; run it again once that is fixed.',
  });
});

test('a tag names a commit or a tag object, by a full sha, and nothing else', () => {
  const commit = { type: 'commit', sha: SHA };
  assert.equal(namedBy('v0.34.1', commit), commit);
  assert.deepEqual(namedBy('v0.34.1', { type: 'tag', sha: OTHER }), { type: 'tag', sha: OTHER });
  for (const object of [{ type: 'tree', sha: SHA }, { type: 'commit', sha: 'main' }, { type: 'tag', sha: '../x' }, {}, null, undefined]) {
    assert.throws(() => namedBy('v0.34.1', object), { message: 'the tag v0.34.1 is not on a commit' }, JSON.stringify(object));
  }
});

const REGISTRY = new URL('https://ghcr.io');

test('the registry is asked for a token only at a realm of its own, with the service and scope it names', () => {
  const realm = tokenRealm('Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:invariant0x/hornhoof:pull"', REGISTRY);
  assert.equal(realm.href, 'https://ghcr.io/token?service=ghcr.io&scope=repository%3Ainvariant0x%2Fhornhoof%3Apull');
  assert.equal(tokenRealm('bearer realm="https://ghcr.io/token"', REGISTRY).href, 'https://ghcr.io/token');
  assert.throws(() => tokenRealm('Bearer realm="https://evil.example/token",service="ghcr.io"', REGISTRY), { message: 'the registry sends for a token to https://evil.example, which is not its own' });
  for (const challenge of ['Basic realm="https://ghcr.io/token"', 'Bearer service="ghcr.io"', '']) {
    assert.throws(() => tokenRealm(challenge, REGISTRY), { message: 'the registry asks for a kind of sign-in this job cannot give' }, challenge);
  }
});

test("the token is asked for with the workflow's token as a basic sign-in, and with no sign-in without one", () => {
  assert.deepEqual(signIn('octocat', 'ghs_1'), { authorization: `Basic ${Buffer.from('octocat:ghs_1').toString('base64')}` });
  assert.deepEqual(signIn(undefined, 'ghs_1'), { authorization: `Basic ${Buffer.from('github-actions:ghs_1').toString('base64')}` });
  assert.deepEqual(signIn('octocat', undefined), {});
  assert.deepEqual(signIn('octocat', ''), {});
});

test('the registry gives its token as token or access_token, and nothing else counts as one', () => {
  assert.equal(tokenIn({ token: 'pull' }), 'pull');
  assert.equal(tokenIn({ access_token: 'pull' }), 'pull');
  assert.equal(tokenIn({ token: '', access_token: 'pull' }), 'pull');
  for (const body of [{}, { token: '' }, { token: 7 }, null]) assert.throws(() => tokenIn(body), { message: 'the registry gave no token' }, JSON.stringify(body));
});

test("GitHub's rate limit is named when GitHub says it is used up, and only then", () => {
  assert.equal(rateNote(new Response(null, { status: 403, headers: { 'x-ratelimit-remaining': '0' } })), ', as its rate limit is used up');
  assert.equal(rateNote(new Response(null, { status: 403, headers: { 'x-ratelimit-remaining': '12' } })), '');
  assert.equal(rateNote(new Response(null, { status: 500 })), '');
});

test('a digest the registry names is a sha256 one, or the lookup ends', () => {
  const digest = `sha256:${'1'.repeat(64)}`;
  assert.equal(digestOf({ digest }, 'image'), digest);
  for (const reference of [{ digest: 'sha256:abc' }, { digest: `sha512:${'1'.repeat(128)}` }, { digest: `../${digest}` }, {}, undefined]) {
    assert.throws(() => digestOf(reference, 'image of a platform'), { message: 'the registry names no image of a platform' }, JSON.stringify(reference));
  }
});

test('an index gives the image of its first real platform, not an attestation', () => {
  const amd64 = { digest: 'a', platform: { os: 'linux', architecture: 'amd64' } };
  assert.equal(platformOf({ manifests: [{ digest: 'x', platform: { os: 'unknown', architecture: 'unknown' } }, { digest: 'y' }, amd64] }), amd64);
  assert.equal(platformOf({ manifests: [{ digest: 'x', platform: { os: 'unknown' } }] }), undefined);
});

const runtime = { architecture: 'amd64', os: 'linux', rootfs: { type: 'layers', diff_ids: [] } };
const revisionLabel = 'org.opencontainers.image.revision';

test('a valid image configuration gives its revision label or confirms it is missing', () => {
  assert.equal(revisionIn({ ...runtime, config: { Labels: { [revisionLabel]: SHA } } }), SHA);
  for (const config of [{ ...runtime, config: { Labels: {} } }, { ...runtime, config: {} }, runtime]) assert.equal(revisionIn(config), '');
  for (const config of [{}, null, { ...runtime, config: { Labels: [] } }, { ...runtime, config: { Labels: { [revisionLabel]: [SHA] } } }]) {
    assert.throws(() => revisionIn(config), /invalid image/, JSON.stringify(config));
  }
});

const API_URL = 'https://api.example.invalid';
const REPOSITORY = 'example/hornhoof';
const REGISTRY_URL = 'https://registry.example.invalid';
const API = `${API_URL}/repos/${REPOSITORY}`;
const GIT_REF = `${API}/git/ref/tags/v${VERSION}`;
const RELEASE = `${API}/releases/tags/v${VERSION}`;
const IMAGE = `${REGISTRY_URL}/v2/invariant0x/hornhoof`;
const MANIFEST = `${IMAGE}/manifests/${VERSION}`;
const STORAGE = 'https://storage.example.invalid/object';
const HTTP = status => new Response(null, { status });
const refAt = (sha, type = 'commit') => Response.json({ ref: `refs/tags/v${VERSION}`, object: { type, sha } });

/* Replies are recorded samples. The mock also checks the exact list of requests after every case. */
function recorded(t, replies) {
  const settings = {
    GITHUB_API_URL: API_URL,
    GITHUB_REPOSITORY: REPOSITORY,
    GITHUB_TOKEN: 'fixture-token',
    GITHUB_ACTOR: 'fixture-actor',
    HORNHOOF_REGISTRY_URL: REGISTRY_URL,
  };
  const original = Object.fromEntries(Object.keys(settings).map(key => [key, process.env[key]]));
  Object.assign(process.env, settings);
  const requests = [];
  t.mock.method(globalThis, 'fetch', (url, options) => {
    const [expected, response] = replies[requests.length] ?? [];
    requests.push({ url: String(url), ...options });
    if (String(url) !== expected) throw new Error('unexpected fixture request');
    if (response instanceof Error) throw response;
    return response;
  });
  t.after(() => {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    assert.deepEqual(requests.map(({ url }) => url), replies.map(([url]) => url));
    assert.ok(requests.every(({ redirect }) => redirect === 'manual'));
  });
  return requests;
}

async function stopsUnknown(job, reason) {
  const { verdict, why } = await versionOut({ job, ...PUSH });
  assert.equal(verdict, 'unknown');
  assert.match(why, reason);
  assert.match(why, /This job stops/);
}

test('a confirmed direct 404 keeps the new-version path open', async t => {
  recorded(t, [[GIT_REF, HTTP(404)], [MANIFEST, HTTP(404)]]);
  assert.equal((await versionOut({ job: 'publish', ...PUSH })).verdict, 'new');
});

test('a version manifest redirect stops at the registry response', async t => {
  recorded(t, [[GIT_REF, refAt(SHA)], [MANIFEST, Response.redirect(STORAGE, 307)]]);
  await stopsUnknown('publish', /redirected the version lookup/);
});

test('a successful version response must have a supported manifest shape', async t => {
  for (const [name, body] of [['null', null], ['bare object', {}], ['empty string', '']]) {
    await t.test(name, async sample => {
      recorded(sample, [[GIT_REF, refAt(SHA)], [MANIFEST, Response.json(body)]]);
      await stopsUnknown('publish', /invalid image manifest/);
    });
  }
});

test('an invalid success or an ordinary GitHub failure stops the job', async t => {
  for (const [name, response, reason] of [
    ['null reference', Response.json(null), /invalid tag reference/],
    ['invalid JSON', new Response('<html>'), /not JSON/],
    ['partial success', HTTP(206), /answered 206/],
    ['temporary failure', HTTP(503), /answered 503/],
    ['unreachable', new Error('fixture network error'), /could not be reached/],
    ['redirect', Response.redirect(STORAGE, 301), /answered 301/],
  ]) {
    await t.test(name, async sample => {
      const requests = recorded(sample, [[GIT_REF, response]]);
      await stopsUnknown('publish', reason);
      assert.equal(requests[0].headers.authorization, 'Bearer fixture-token');
    });
  }
});

test('a confirmed tag on another commit stops without a registry read', async t => {
  recorded(t, [[GIT_REF, refAt(OTHER)]]);
  assert.equal((await versionOut({ job: 'publish', ...PUSH })).verdict, 'stop');
});

test('a release lookup requires a matching tag and release id from GitHub', async t => {
  for (const [name, response, expected] of [
    ['present', Response.json({ tag_name: `v${VERSION}`, id: 1 }), 'out'],
    ['absent', HTTP(404), 'new'],
    ['wrong tag', Response.json({ tag_name: 'v1.0.0', id: 1 }), 'unknown'],
    ['no id', Response.json({ tag_name: `v${VERSION}` }), 'unknown'],
    ['null release', Response.json(null), 'unknown'],
  ]) {
    await t.test(name, async sample => {
      recorded(sample, [[GIT_REF, refAt(OTHER, 'tag')], [`${API}/git/tags/${OTHER}`, Response.json({ sha: OTHER, object: { type: 'commit', sha: SHA } })], [RELEASE, response]]);
      assert.equal((await versionOut({ job: 'release', ...PUSH })).verdict, expected);
    });
  }
});

const contentDigest = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const config = JSON.stringify({ ...runtime, config: { Labels: { [revisionLabel]: SHA } } });
const configId = contentDigest(config);
const manifest = { schemaVersion: 2, config: { digest: configId }, layers: [] };
const blobUrl = `${IMAGE}/blobs/${configId}`;
const askToken = () => new Response(null, {
  status: 401,
  headers: { 'www-authenticate': `Bearer realm="${REGISTRY_URL}/token"` },
});

test('a registry token request stops at a redirect', async t => {
  const requests = recorded(t, [[GIT_REF, HTTP(404)], [MANIFEST, askToken()], [`${REGISTRY_URL}/token`, Response.redirect(STORAGE, 307)]]);
  await stopsUnknown('publish', /answered 307 for a token/);
  assert.equal(requests[2].headers.authorization, signIn('fixture-actor', 'fixture-token').authorization);
});

test('a confirmed image may read a digest from storage without credentials', async t => {
  const image = JSON.stringify(manifest);
  const imageId = contentDigest(image);
  const index = { schemaVersion: 2, manifests: [{ digest: imageId, platform: { architecture: 'amd64', os: 'linux' } }] };
  const requests = recorded(t, [
    [GIT_REF, refAt(SHA)], [MANIFEST, askToken()], [`${REGISTRY_URL}/token`, Response.json({ token: 'pull' })],
    [MANIFEST, Response.json(index)], [`${IMAGE}/manifests/${imageId}`, new Response(image)],
    [blobUrl, Response.redirect(STORAGE, 307)], [STORAGE, new Response(config)],
  ]);
  assert.equal((await versionOut({ job: 'publish', ...PUSH })).verdict, 'out');
  assert.equal(requests[5].headers.authorization, 'Bearer pull');
  assert.equal(requests[6].headers.authorization, undefined);
});

test('a digest redirect needs a secure storage URL with no credentials', async t => {
  for (const location of ['http://storage.example.invalid/object', 'https://example:fixture@storage.example.invalid/object']) {
    await t.test(location, async sample => {
      recorded(sample, [[GIT_REF, refAt(SHA)], [MANIFEST, Response.json(manifest)], [blobUrl, Response.redirect(location, 307)]]);
      await stopsUnknown('publish', /invalid redirect/);
    });
  }
});

test('a delegated digest read needs a valid response that matches the digest', async t => {
  for (const [name, response, reason] of [
    ['missing', HTTP(404), /storage answered 404/],
    ['ordinary failure', HTTP(503), /storage answered 503/],
    ['second redirect', Response.redirect('https://elsewhere.example.invalid/object', 302), /storage answered 302/],
    ['wrong bytes', new Response('{}'), /does not match its digest/],
  ]) {
    await t.test(name, async sample => {
      recorded(sample, [[GIT_REF, refAt(SHA)], [MANIFEST, Response.json(manifest)], [blobUrl, Response.redirect(STORAGE, 307)], [STORAGE, response]]);
      await stopsUnknown('publish', reason);
    });
  }
});

test('no message has an em dash or a dash between words', () => {
  const all = [
    verdictOf({ job: 'images', event: 'workflow_dispatch', sha: SHA, version: VERSION }),
    verdictOf({ job: 'images', ...PUSH, tag: OTHER }),
    verdictOf({ job: 'images', ...PUSH, image: OTHER }),
    verdictOf({ job: 'images', ...PUSH, image: '' }),
    verdictOf({ job: 'publish', ...PUSH, image: SHA }),
    verdictOf({ job: 'release', ...PUSH, release: false }),
    unknownOf(VERSION, 'the registry answered 500 for manifests/0.34.1'),
  ];
  for (const { why } of all) assert.doesNotMatch(why, /[\u2013\u2014]| - /);
});
