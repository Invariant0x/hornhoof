import { createHash } from 'node:crypto';
import { versionParts } from '../release/versions.mjs';

/* global fetch, AbortSignal, URL, Buffer */

/* Whether the version of a commit is out, for the images, publish and release jobs of .github/workflows/images.yml. A
   version is out once its app image is published, ghcr.io/invariant0x/hornhoof:<version>, and released once its tag has
   a GitHub release: the tag alone says neither, as it may come with main before anything was built.

   Each lookup has three answers: there, not there (a 404 and nothing else), and unknown, when GitHub or the registry
   answers anything else, cannot be reached or gives no JSON. An unknown answer says nothing about the version, so it
   stops the job as a conflict does: it never reads as not out, which would build and move :latest or make a release. */

const IMAGE = 'invariant0x/hornhoof';
const REVISION = 'org.opencontainers.image.revision';
const READ_MS = 20_000;
const COMMIT = /^[0-9a-f]{40}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const INDEX_TYPES = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
];
const IMAGE_TYPES = [
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
];
const MANIFESTS = [...INDEX_TYPES, ...IMAGE_TYPES].join(', ');
const REDIRECTS = [301, 302, 303, 307, 308];
const MISSING = Symbol('missing');
const env = process.env;

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isCommit = value => typeof value === 'string' && value.length === 40 && COMMIT.test(value);
const isDigest = value => typeof value === 'string' && value.length === 71 && DIGEST.test(value);
const isName = value => typeof value === 'string' && value.length > 0;

export const imageOf = version => `ghcr.io/${IMAGE}:${version}`;

const DOES = {
  images: { out: 'this push builds no images', new: 'this push builds them' },
  publish: { out: 'nothing moves', new: 'this job moves the version and latest onto the images of this commit' },
};

const stop = why => ({ verdict: 'stop', why });

function releaseVerdict({ version, tag, release }) {
  if (release) return { verdict: 'out', why: `v${version} is released already, so this job releases nothing.` };
  const how = tag ? `The tag v${version} is on this commit and has no release yet, so this job creates its release.` : `Version ${version} has no tag yet, so this job tags this commit and creates its release.`;
  return { verdict: 'new', why: how };
}

/* What a job does with the version of its commit: new builds, moves or releases it, out leaves it as it is, and stop fails
   the job with why. tag is the commit the tag v<version> is on, null without one. image is the revision label of the
   published app image of the version: null when none is published, '' when it carries no label. release says whether the
   tag has a GitHub release. A run by hand builds whatever is out, under its commit alone. */
export function verdictOf({ job, event, sha, version, tag, image, release }) {
  if (job === 'images' && event !== 'push') return { verdict: 'new', why: 'A run by hand builds the images of its commit under that commit alone.' };
  if (tag && tag !== sha) return stop(`The tag v${version} is on commit ${tag}, not on this commit ${sha}. Version ${version} belongs to that commit, so this one builds, moves and releases nothing. Give this commit a new version, or move the tag if it is wrong.`);
  return job === 'release' ? releaseVerdict({ version, tag, release }) : imageVerdict({ job, sha, version, tag, image });
}

function imageVerdict({ job, sha, version, tag, image }) {
  if (image === '') return stop(`${imageOf(version)} has no revision label, so it cannot tell which commit its images were built from. Nothing is built or moved until it says.`);
  if (image && image !== sha) return stop(`${imageOf(version)} holds the images of commit ${image}, not of this commit ${sha}. Version ${version} is out already for that commit, so this one builds and moves nothing. Give this commit a new version.`);
  if (image) return { verdict: 'out', why: `Version ${version} is out already: ${imageOf(version)} holds the images of this commit, so ${DOES[job].out}.` };
  const tagged = tag ? `, though its tag v${version} is on this commit` : '';
  return { verdict: 'new', why: `Version ${version} has no published images yet${tagged}, so ${DOES[job].new}.` };
}

/* A request never follows redirects automatically, including when it carries GitHub or registry credentials. */
async function reach(who, url, options = {}) {
  let res;
  try {
    res = await fetch(url, { ...options, redirect: 'manual', signal: AbortSignal.timeout(READ_MS) });
  } catch (error) {
    throw new Error(error?.name === 'TimeoutError' ? `${who} did not answer within ${READ_MS / 1000} seconds` : `${who} could not be reached`);
  }
  if (res.redirected) throw new Error(`${who} answered through an unexpected redirect`);
  return res;
}

async function bodyOf(res, who, path, digest) {
  let bytes;
  try {
    bytes = Buffer.from(await res.arrayBuffer());
  } catch {
    throw new Error(`${who} could not finish its answer for ${path}`);
  }
  if (digest && `sha256:${createHash('sha256').update(bytes).digest('hex')}` !== digest) {
    throw new Error(`${who} answered ${path} with content that does not match its digest`);
  }
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error(`${who} answered ${path} with something that is not JSON`);
  }
}

/* GitHub says so in its headers when a 403 or 429 comes from its rate limit. */
export const rateNote = res => (res.headers.get('x-ratelimit-remaining') === '0' ? ', as its rate limit is used up' : '');

/* One object of the repository through GitHub's API, or MISSING after a direct 404. */
async function fromGitHub(path) {
  const res = await reach('GitHub', `${env.GITHUB_API_URL}/repos/${env.GITHUB_REPOSITORY}/${path}`, {
    headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', ...(env.GITHUB_TOKEN ? { authorization: `Bearer ${env.GITHUB_TOKEN}` } : {}) },
  });
  if (res.status === 404) return MISSING;
  if (res.status !== 200) throw new Error(`GitHub answered ${res.status} for ${path}${rateNote(res)}`);
  return bodyOf(res, 'GitHub', path);
}

/* What a git object of GitHub's API names, when it is a commit or a tag object; anything else ends the lookup. */
export function namedBy(tag, object) {
  if (!['commit', 'tag'].includes(object?.type) || !isCommit(object.sha)) throw new Error(`the tag ${tag} is not on a commit`);
  return object;
}

async function tagObject(tag, sha) {
  const found = await fromGitHub(`git/tags/${sha}`);
  if (found === MISSING) throw new Error(`GitHub has no tag object for ${tag}`);
  if (!isObject(found) || found.sha !== sha) throw new Error(`GitHub gave an invalid tag object for ${tag}`);
  return namedBy(tag, found.object);
}

/* The commit the tag is on, through at most four annotated tag objects; null without the tag. */
async function tagCommit(tag) {
  const ref = await fromGitHub(`git/ref/tags/${tag}`);
  if (ref === MISSING) return null;
  if (!isObject(ref) || ref.ref !== `refs/tags/${tag}`) throw new Error(`GitHub gave an invalid tag reference for ${tag}`);
  let object = namedBy(tag, ref.object);
  for (let depth = 0; object.type === 'tag' && depth < 4; depth += 1) object = await tagObject(tag, object.sha);
  return namedBy(tag, object.type === 'commit' ? object : null).sha;
}

async function releaseExists(tag) {
  const release = await fromGitHub(`releases/tags/${tag}`);
  if (release === MISSING) return false;
  if (!isObject(release) || release.tag_name !== tag || !Number.isSafeInteger(release.id) || release.id <= 0) {
    throw new Error(`GitHub gave an invalid release for ${tag}`);
  }
  return true;
}

/* Where the registry sends for a token to pull with, from its WWW-Authenticate answer: only a realm of the registry itself,
   as the workflow's token goes there. */
export function tokenRealm(challenge, registry) {
  const fields = Object.fromEntries([...challenge.matchAll(/(\w+)="([^"]*)"/g)].map(([, key, value]) => [key, value]));
  if (!/^Bearer /i.test(challenge) || !fields.realm) throw new Error('the registry asks for a kind of sign-in this job cannot give');
  const realm = new URL(fields.realm);
  if (realm.origin !== registry.origin) throw new Error(`the registry sends for a token to ${realm.origin}, which is not its own`);
  for (const key of ['service', 'scope']) if (fields[key]) realm.searchParams.set(key, fields[key]);
  return realm;
}

/* The sign-in the token is asked for with: the workflow's token, none without one. */
export const signIn = (actor, token) => (token ? { authorization: `Basic ${Buffer.from(`${actor || 'github-actions'}:${token}`).toString('base64')}` } : {});

export function tokenIn(body) {
  const token = body?.token || body?.access_token;
  if (typeof token !== 'string' || !token || /\s/.test(token)) throw new Error('the registry gave no token');
  return token;
}

async function pullToken(challenge, registryUrl) {
  const res = await reach('the registry', tokenRealm(challenge, registryUrl), { headers: signIn(env.GITHUB_ACTOR, env.GITHUB_TOKEN) });
  if (res.status !== 200) throw new Error(`the registry answered ${res.status} for a token`);
  return tokenIn(await bodyOf(res, 'the registry', 'a token'));
}

async function registryAnswer(registry, url, accept) {
  const headers = { accept, ...(registry.bearer ? { authorization: `Bearer ${registry.bearer}` } : {}) };
  const res = await reach('the registry', url, { headers });
  if (res.status !== 401 || registry.bearer) return res;
  await res.body?.cancel();
  registry.bearer = await pullToken(res.headers.get('www-authenticate') ?? '', registry.url);
  return registryAnswer(registry, url, accept);
}

function storageUrl(res, from, path) {
  const location = res.headers.get('location');
  const url = location ? URL.parse(location, from) : null;
  if (url?.protocol !== 'https:' || url.username || url.password) throw new Error(`the registry gave an invalid redirect for ${path}`);
  return url;
}

/* Only a direct 404 proves absence. A digest lets the registry delegate one read, without forwarding any credentials. */
async function fromRegistry(registry, kind, reference, accept) {
  const path = `${kind}/${reference}`;
  const url = new URL(`/v2/${IMAGE}/${path}`, registry.url);
  let res = await registryAnswer(registry, url, accept);
  if (res.status === 404) return MISSING;
  const digest = isDigest(reference) ? reference : undefined;
  if (REDIRECTS.includes(res.status)) {
    await res.body?.cancel();
    if (!digest) throw new Error(`the registry redirected the version lookup for ${path}`);
    res = await reach('registry storage', storageUrl(res, url, path), { headers: { accept } });
    if (res.status !== 200) throw new Error(`registry storage answered ${res.status} for ${path}`);
  }
  if (res.status !== 200) throw new Error(`the registry answered ${res.status} for ${path}`);
  return bodyOf(res, 'the registry', path, digest);
}

async function required(registry, kind, digest, accept, what) {
  const found = await fromRegistry(registry, kind, digest, accept);
  if (found === MISSING) throw new Error(`the registry has no ${what} at ${digest}`);
  return found;
}

export function digestOf(reference, what) {
  if (!isDigest(reference?.digest)) throw new Error(`the registry names no ${what}`);
  return reference.digest;
}

const namesPlatform = platform => isObject(platform) && isName(platform.os) && isName(platform.architecture);
/* The image of one platform in an index, as each platform's image carries the same labels; attestations name no platform. */
export const platformOf = index => index.manifests.find(({ platform }) =>
  namesPlatform(platform) && platform.os !== 'unknown' && platform.architecture !== 'unknown');

/* The revision label of a valid image configuration, '' when it carries none. */
export function revisionIn(config) {
  if (!isObject(config) || !isName(config.architecture) || !isName(config.os) ||
      config.rootfs?.type !== 'layers' || !Array.isArray(config.rootfs.diff_ids) || !config.rootfs.diff_ids.every(isDigest) ||
      (config.config !== undefined && !isObject(config.config))) {
    throw new Error('the registry gave an invalid image configuration');
  }
  const labels = config.config?.Labels;
  if (labels !== undefined && !isObject(labels)) throw new Error('the registry gave invalid image labels');
  const revision = labels?.[REVISION];
  if (revision === undefined) return '';
  if (!isCommit(revision)) throw new Error('the registry gave an invalid image revision');
  return revision;
}

function hasDescriptors(list) {
  return Array.isArray(list) && list.every(entry => isDigest(entry?.digest));
}

function configDigest(manifest) {
  if (!isObject(manifest) || manifest.schemaVersion !== 2 || manifest.manifests !== undefined || !hasDescriptors(manifest.layers) ||
      (manifest.mediaType !== undefined && !IMAGE_TYPES.includes(manifest.mediaType))) {
    throw new Error('the registry gave an invalid image manifest');
  }
  return digestOf(manifest.config, 'image configuration');
}

/* An index names a platform manifest by its digest. */
function platformDigest(index) {
  if (index.schemaVersion !== 2 || index.config !== undefined || index.layers !== undefined || !hasDescriptors(index.manifests) ||
      !index.manifests.every(({ platform }) => platform === undefined || namesPlatform(platform)) ||
      (index.mediaType !== undefined && !INDEX_TYPES.includes(index.mediaType))) {
    throw new Error('the registry gave an invalid image index');
  }
  return digestOf(platformOf(index), 'image of a platform');
}

/* The revision label of the published app image of the version: null when it is not published, '' when it carries none. */
async function imageRevision(version) {
  const registry = { url: new URL(env.HORNHOOF_REGISTRY_URL || 'https://ghcr.io'), bearer: null };
  const top = await fromRegistry(registry, 'manifests', version, MANIFESTS);
  if (top === MISSING) return null;
  const manifest = top?.manifests === undefined ? top : await required(registry, 'manifests', platformDigest(top), MANIFESTS, 'image');
  return revisionIn(await required(registry, 'blobs', configDigest(manifest), '*/*', 'configuration'));
}

/* What each job must know: the images job of a run by hand nothing, release the tag and its release, the rest the tag and
   the published images. */
async function factsFor({ job, event, sha, version }) {
  if (job === 'images' && event !== 'push') return {};
  const name = `v${version}`;
  const tag = await tagCommit(name);
  if (tag && tag !== sha) return { tag };
  if (job === 'release') return { tag, release: await releaseExists(name) };
  return { tag, image: await imageRevision(version) };
}

/* The answer when a lookup failed: the job stops, as nothing can be said of the version. */
export const unknownOf = (version, reason) => ({ verdict: 'unknown', why: `Could not tell whether version ${version} is out: ${reason}. This job stops and builds, moves and releases nothing; run it again once that is fixed.` });

export async function versionOut({ job, event, sha, version }) {
  if (!isCommit(sha)) throw new Error(`${sha} is not a commit`);
  versionParts(version);
  let facts;
  try {
    facts = await factsFor({ job, event, sha, version });
  } catch (error) {
    return unknownOf(version, error.message);
  }
  return verdictOf({ job, event, sha, version, ...facts });
}
