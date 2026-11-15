import { createHash } from 'node:crypto';

/* Reads Hornhoof's published builds from the container registry, anonymously, the way docker pull does. */

/* digest is the one docker pull resolves the tag to: the SHA-256 of the manifest the registry sent for it. */
export type Build = { tag: string; digest: string; version: string; commit: string; created: string; title: string; migrations: number };

/* The node and updater images built from the same commit, by digest; empty for one a build does not have, as builds
   from before the updater. */
export type Siblings = { node: string; updater: string };

/* find: the build of that tag, null when the registry has none. */
export type Registry = { latest(): Promise<Build | null>; versions(): Promise<Build[]>; siblings(tag: string): Promise<Siblings>; find(tag: string): Promise<Build | null> };

const INDEX_TYPES = ['application/vnd.oci.image.index.v1+json', 'application/vnd.docker.distribution.manifest.list.v2+json'];
const MANIFEST_TYPES = ['application/vnd.oci.image.manifest.v1+json', 'application/vnd.docker.distribution.manifest.v2+json'];
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;
/* A commit as CI names it: every image of a build is pushed under this tag. */
export const FULL_SHA = /^[0-9a-f]{40}$/;
/* The Versions dialog lists this many; older ones stay reachable by their tag. */
const MAX_VERSIONS = 20;
const MAX_TAG_PAGES = 20;

type Manifest = { manifests?: { digest: string; platform?: { os?: string; architecture?: string } }[]; config?: { digest: string } };
type ConfigBlob = { created?: string; config?: { Labels?: Record<string, string> | null } };

/* Newest first: 0.10.0 before 0.4.0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.match(SEMVER)!.slice(1).map(Number);
  const pb = b.match(SEMVER)!.slice(1).map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pb[i]! - pa[i]!;
  return 0;
}

export function registry(opts: { image: string; arch: 'amd64' | 'arm64'; fetch?: typeof fetch; base?: string }): Registry {
  const slash = opts.image.indexOf('/');
  const path = opts.image.slice(slash + 1);
  const base = (opts.base ?? `https://${opts.image.slice(0, slash)}`).replace(/\/+$/, '');
  const get = opts.fetch ?? fetch;

  /* mayLack: a 404 comes back as it is instead of as an error. */
  async function call(url: string, token: string | null, accept?: string[], mayLack = false): Promise<Response> {
    const headers: Record<string, string> = {};
    if (token) headers.authorization = `Bearer ${token}`;
    if (accept) headers.accept = accept.join(', ');
    const res = await get(url.startsWith('http') ? url : `${base}${url}`, { headers, signal: AbortSignal.timeout(15000) });
    if (!res.ok && !(mayLack && res.status === 404)) throw new Error(`The registry answered ${res.status} for ${url.split('?')[0]}.`);
    return res;
  }

  async function token(repo = path): Promise<string> {
    const res = await call(`/token?scope=repository:${repo}:pull`, null);
    return ((await res.json()) as { token: string }).token;
  }

  const digestOf = (raw: Buffer) => `sha256:${createHash('sha256').update(raw).digest('hex')}`;

  async function tags(auth: string): Promise<string[]> {
    const all: string[] = [];
    let next: string | null = `/v2/${path}/tags/list`;
    for (let page = 0; next && page < MAX_TAG_PAGES; page++) {
      const res = await call(next, auth);
      all.push(...(((await res.json()) as { tags?: string[] | null }).tags ?? []));
      next = res.headers.get('link')?.match(/<([^>]+)>;\s*rel="next"/)?.[1] ?? null;
    }
    return all;
  }

  async function build(auth: string, tag: string): Promise<Build>;
  async function build(auth: string, tag: string, mayLack: true): Promise<Build | null>;
  async function build(auth: string, tag: string, mayLack = false): Promise<Build | null> {
    const index = await call(`/v2/${path}/manifests/${tag}`, auth, [...INDEX_TYPES, ...MANIFEST_TYPES], mayLack);
    if (index.status === 404) return null;
    const raw = Buffer.from(await index.arrayBuffer());
    const digest = digestOf(raw);
    let manifest = JSON.parse(raw.toString('utf8')) as Manifest;
    if (manifest.manifests) {
      const mine = manifest.manifests.find(m => m.platform?.os === 'linux' && m.platform.architecture === opts.arch);
      if (!mine) throw new Error(`The build ${tag} has no ${opts.arch} image.`);
      manifest = (await (await call(`/v2/${path}/manifests/${mine.digest}`, auth, MANIFEST_TYPES)).json()) as Manifest;
    }
    if (!manifest.config) throw new Error(`The build ${tag} has no image config.`);
    const blob = (await (await call(`/v2/${path}/blobs/${manifest.config.digest}`, auth)).json()) as ConfigBlob;
    const labels = blob.config?.Labels ?? {};
    return {
      tag,
      digest,
      version: labels['org.opencontainers.image.version'] ?? (SEMVER.test(tag) ? tag : ''),
      commit: labels['org.opencontainers.image.revision'] ?? '',
      created: blob.created ?? '',
      title: labels['io.hornhoof.title'] ?? '',
      migrations: Number(labels['io.hornhoof.migrations'] ?? 0) || 0,
    };
  }

  return {
    async latest() {
      const auth = await token();
      return (await tags(auth)).includes('latest') ? build(auth, 'latest') : null;
    },
    async versions() {
      const auth = await token();
      const published = (await tags(auth)).filter(t => SEMVER.test(t)).sort(compareVersions).slice(0, MAX_VERSIONS);
      return Promise.all(published.map(t => build(auth, t)));
    },
    async find(tag) {
      return build(await token(), tag, true);
    },
    async siblings(tag) {
      const [node, updater] = await Promise.all(
        ['node', 'updater'].map(async part => {
          const repo = `${path}-${part}`;
          const res = await call(`/v2/${repo}/manifests/${tag}`, await token(repo), [...INDEX_TYPES, ...MANIFEST_TYPES], true);
          return res.status === 404 ? '' : digestOf(Buffer.from(await res.arrayBuffer()));
        }),
      );
      return { node: node!, updater: updater! };
    },
  };
}

export const archOf = (arch: string = process.arch): 'amd64' | 'arm64' => (arch === 'arm64' ? 'arm64' : 'amd64');
