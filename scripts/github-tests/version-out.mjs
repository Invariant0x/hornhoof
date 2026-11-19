import { versionParts } from '../release/versions.mjs';

/* global fetch, AbortSignal, URL, Buffer */

/* Whether the version of a commit is out, for the images, publish and release jobs of .github/workflows/images.yml. A
   version is out once its app image is published, ghcr.io/invariant0x/hornhoof:<version>, and released once its tag has
   a GitHub release: the tag alone says neither, as it may come with main before anything was built. */

const IMAGE = 'invariant0x/hornhoof';
const REVISION = 'org.opencontainers.image.revision';
const READ_MS = 20_000;
const COMMIT = /^[0-9a-f]{40}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const MANIFESTS = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');
const env = process.env;

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
  if (job === 'release') return releaseVerdict({ version, tag, release });
  if (image === '') return stop(`${imageOf(version)} has no revision label, so it cannot tell which commit its images were built from. Nothing is built or moved until it says.`);
  if (image && image !== sha) return stop(`${imageOf(version)} holds the images of commit ${image}, not of this commit ${sha}. Version ${version} is out already for that commit, so this one builds and moves nothing. Give this commit a new version.`);
  if (image) return { verdict: 'out', why: `Version ${version} is out already: ${imageOf(version)} holds the images of this commit, so ${DOES[job].out}.` };
  const tagged = tag ? `, though its tag v${version} is on this commit` : '';
  return { verdict: 'new', why: `Version ${version} has no published images yet${tagged}, so ${DOES[job].new}.` };
}

const signal = () => AbortSignal.timeout(READ_MS);

/* One object of the repository through GitHub's API, null when GitHub has none. */
async function fromGitHub(path) {
  const res = await fetch(`${env.GITHUB_API_URL}/repos/${env.GITHUB_REPOSITORY}/${path}`, {
    headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', ...(env.GITHUB_TOKEN ? { authorization: `Bearer ${env.GITHUB_TOKEN}` } : {}) },
    signal: signal(),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub answered ${res.status} for ${path}`);
  return res.json();
}

/* The commit the tag is on, through its annotated tag objects; null without the tag. */
async function tagCommit(tag) {
  let object = (await fromGitHub(`git/ref/tags/${tag}`))?.object;
  if (!object) return null;
  for (let depth = 0; object.type === 'tag' && depth < 4; depth += 1) {
    if (!COMMIT.test(object.sha)) throw new Error(`the tag ${tag} names no tag object`);
    object = (await fromGitHub(`git/tags/${object.sha}`))?.object;
    if (!object) throw new Error(`GitHub has no tag object for ${tag}`);
  }
  if (object.type !== 'commit' || !COMMIT.test(object.sha)) throw new Error(`the tag ${tag} is not on a commit`);
  return object.sha;
}

const registryUrl = () => new URL(env.HORNHOOF_REGISTRY_URL || 'https://ghcr.io');
let bearer = null;

/* A token to pull with, from the realm the registry names. The workflow's token goes only to a realm of the registry itself. */
async function pullToken(challenge) {
  const fields = Object.fromEntries([...challenge.matchAll(/(\w+)="([^"]*)"/g)].map(([, key, value]) => [key, value]));
  if (!/^Bearer /i.test(challenge) || !fields.realm) throw new Error('the registry asks for a kind of sign-in this job cannot give');
  const realm = new URL(fields.realm);
  if (realm.origin !== registryUrl().origin) throw new Error(`the registry sends for a token to ${realm.origin}, which is not its own`);
  for (const key of ['service', 'scope']) if (fields[key]) realm.searchParams.set(key, fields[key]);
  const basic = env.GITHUB_TOKEN ? { authorization: `Basic ${Buffer.from(`${env.GITHUB_ACTOR || 'github-actions'}:${env.GITHUB_TOKEN}`).toString('base64')}` } : {};
  const res = await fetch(realm, { headers: basic, signal: signal() });
  if (!res.ok) throw new Error(`the registry answered ${res.status} for a token`);
  const body = await res.json();
  const token = body.token ?? body.access_token;
  if (typeof token !== 'string' || !token) throw new Error('the registry gave no token');
  return token;
}

async function registryAnswer(url, accept) {
  const headers = { accept, ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) };
  const res = await fetch(url, { headers, redirect: 'manual', signal: signal() });
  if (res.status !== 401 || bearer) return res;
  await res.body?.cancel();
  bearer = await pullToken(res.headers.get('www-authenticate') ?? '');
  return registryAnswer(url, accept);
}

/* A manifest or blob of the app image, null when the registry has none. A blob served from elsewhere is fetched there
   without any token. */
async function fromRegistry(path, accept) {
  const url = new URL(`/v2/${IMAGE}/${path}`, registryUrl());
  let res = await registryAnswer(url, accept);
  const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
  if (location) {
    await res.body?.cancel();
    res = await fetch(new URL(location, url), { signal: signal() });
  }
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`the registry answered ${res.status} for ${path}`);
  return res.json();
}

async function required(path, accept, what) {
  const found = await fromRegistry(path, accept);
  if (!found) throw new Error(`the registry has no ${what} of ${path}`);
  return found;
}

function digestOf(reference, what) {
  if (!DIGEST.test(reference?.digest ?? '')) throw new Error(`the registry names no ${what}`);
  return reference.digest;
}

/* The image of one platform in an index, as each platform's image carries the same labels; attestations name no platform. */
const platformOf = index => index.manifests?.find(entry => entry.platform && entry.platform.os !== 'unknown');

/* The revision label of the published app image of the version: null when it is not published, '' when it carries none. */
async function imageRevision(version) {
  const top = await fromRegistry(`manifests/${version}`, MANIFESTS);
  if (!top) return null;
  const manifest = Array.isArray(top.manifests) ? await required(`manifests/${digestOf(platformOf(top), 'image of a platform')}`, MANIFESTS, 'image') : top;
  const config = await required(`blobs/${digestOf(manifest.config, 'image configuration')}`, '*/*', 'configuration');
  return config.config?.Labels?.[REVISION] ?? '';
}

/* What each job must know: the images job of a run by hand nothing, release the tag and its release, the rest the tag and
   the published images. */
async function factsFor(job, event, version) {
  if (job === 'images' && event !== 'push') return {};
  const tag = await tagCommit(`v${version}`);
  if (job === 'release') return { tag, release: (await fromGitHub(`releases/tags/v${version}`)) !== null };
  return { tag, image: await imageRevision(version) };
}

export async function versionOut({ job, event, sha, version }) {
  if (!COMMIT.test(sha ?? '')) throw new Error(`${sha} is not a commit`);
  versionParts(version);
  return verdictOf({ job, event, sha, version, ...await factsFor(job, event, version) });
}
