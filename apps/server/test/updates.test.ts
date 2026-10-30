import Fastify, { type FastifyInstance } from 'fastify';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, onTestFinished } from 'vitest';
import { companies, departments } from '../src/db/schema.js';
import { as, invitePerson, setUpCompany, testApp } from './helpers.js';

type FakeBuild = { commit: string; version?: string; title?: string; migrations?: number; created?: string };
const ARCH = process.arch === 'arm64' ? 'arm64' : 'amd64';
const OCI_INDEX = 'application/vnd.oci.image.index.v1+json';

/* A registry that serves an index per tag, a manifest per platform and a config blob with the build's labels. */
async function fakeRegistry(tags: Record<string, FakeBuild>): Promise<{ base: string; set(tag: string, build: FakeBuild): void; fail(status: number | null): void; calls: string[] }> {
  const calls: string[] = [];
  let failing: number | null = null;
  const reg: FastifyInstance = Fastify();
  reg.addHook('onRequest', async (req, reply) => {
    calls.push(req.url);
    if (failing) return reply.code(failing).send({ errors: [{ code: 'TOOMANYREQUESTS' }] });
  });
  reg.get('/token', async req => {
    expect((req.query as { scope: string }).scope).toBe('repository:acme/hornhoof:pull');
    return { token: 'anon' };
  });
  reg.get('/v2/acme/hornhoof/tags/list', async req => {
    expect(req.headers.authorization).toBe('Bearer anon');
    return { name: 'acme/hornhoof', tags: Object.keys(tags) };
  });
  reg.get('/v2/acme/hornhoof/manifests/:ref', async (req, reply) => {
    const { ref } = req.params as { ref: string };
    if (ref.startsWith('sha256:m-')) {
      return reply.type('application/vnd.oci.image.manifest.v1+json').send({ config: { digest: `sha256:c-${ref.slice(9)}` } });
    }
    if (!tags[ref]) return reply.code(404).send({ errors: [{ code: 'MANIFEST_UNKNOWN' }] });
    expect(req.headers.accept).toContain(OCI_INDEX);
    return reply.type(OCI_INDEX).send({
      manifests: [
        { digest: `sha256:m-${ref}-other`, platform: { os: 'linux', architecture: ARCH === 'amd64' ? 'arm64' : 'amd64' } },
        { digest: `sha256:m-${ref}`, platform: { os: 'linux', architecture: ARCH } },
        { digest: `sha256:m-${ref}-att`, platform: { os: 'unknown', architecture: 'unknown' } },
      ],
    });
  });
  reg.get('/v2/acme/hornhoof/blobs/:digest', async req => {
    const tag = (req.params as { digest: string }).digest.slice('sha256:c-'.length);
    const b = tags[tag]!;
    const labels: Record<string, string> = { 'org.opencontainers.image.revision': b.commit };
    if (b.version) labels['org.opencontainers.image.version'] = b.version;
    if (b.title) labels['io.hornhoof.title'] = b.title;
    if (b.migrations !== undefined) labels['io.hornhoof.migrations'] = String(b.migrations);
    return { created: b.created ?? '2026-10-30T01:00:00Z', config: { Labels: labels } };
  });
  await reg.listen({ port: 0, host: '127.0.0.1' });
  onTestFinished(() => reg.close());
  return {
    base: `http://127.0.0.1:${(reg.server.address() as AddressInfo).port}`,
    set: (tag, build) => (tags[tag] = build),
    fail: status => (failing = status),
    calls,
  };
}

async function company(registry: { base: string }, commit = 'aaa') {
  const { app, db } = await testApp({ HORNHOOF_IMAGE: 'ghcr.io/acme/hornhoof', REGISTRY_URL: registry.base, HORNHOOF_VERSION: '0.4.0', HORNHOOF_COMMIT: commit });
  return { app, db, ceo: await setUpCompany(app) };
}

describe('updates', () => {
  it('finds a newer build of the main line', async () => {
    const registry = await fakeRegistry({ latest: { commit: 'bbb', version: '0.4.1', title: 'Hire from the staff card', migrations: 6 } });
    const { app, ceo } = await company(registry);
    const res = await app.inject({ method: 'POST', url: '/api/updates/check', ...as(ceo) });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.current).toMatchObject({ version: '0.4.0', commit: 'aaa' });
    expect(body.available).toBe(true);
    expect(body.latest).toMatchObject({ tag: 'latest', version: '0.4.1', commit: 'bbb', title: 'Hire from the staff card', migrations: 6, created: '2026-10-30T01:00:00Z' });
    expect(body.checkedAt).toEqual(expect.any(String));
    expect(body.error).toBeNull();
    expect((await app.inject({ method: 'GET', url: '/api/updates', ...as(ceo) })).json()).toEqual(body);
  });

  it('says nothing is new when the latest build is the running one', async () => {
    const registry = await fakeRegistry({ latest: { commit: 'aaa', version: '0.4.0' } });
    const { app, ceo } = await company(registry);
    const body = (await app.inject({ method: 'POST', url: '/api/updates/check', ...as(ceo) })).json();
    expect(body.available).toBe(false);
    expect(body.latest.commit).toBe('aaa');
  });

  it('lists published versions newest first', async () => {
    const registry = await fakeRegistry({
      latest: { commit: 'ccc', version: '0.10.0' },
      '0.3.0': { commit: 'c03', version: '0.3.0' },
      '0.4.0': { commit: 'c04', version: '0.4.0' },
      '0.10.0': { commit: 'ccc', version: '0.10.0' },
      abc123: { commit: 'abc123' },
    });
    const { app, ceo } = await company(registry);
    const body = (await app.inject({ method: 'POST', url: '/api/updates/check', ...as(ceo) })).json();
    expect(body.versions.map((v: { tag: string }) => v.tag)).toEqual(['0.10.0', '0.4.0', '0.3.0']);
    expect(body.versions[1]).toMatchObject({ version: '0.4.0', commit: 'c04' });
  });

  it('keeps the last result when the registry fails', async () => {
    const registry = await fakeRegistry({ latest: { commit: 'bbb', version: '0.4.1' } });
    const { app, ceo } = await company(registry);
    const first = (await app.inject({ method: 'POST', url: '/api/updates/check', ...as(ceo) })).json();
    registry.fail(429);
    const res = await app.inject({ method: 'POST', url: '/api/updates/check', ...as(ceo) });
    expect(res.statusCode).toBe(200);
    const second = res.json();
    expect(second.error).toEqual(expect.stringContaining('429'));
    expect(second.latest).toEqual(first.latest);
    expect(second.available).toBe(true);
    expect(second.checkedAt).toBe(first.checkedAt);
  });

  it('is only for people with the whole company', async () => {
    const registry = await fakeRegistry({ latest: { commit: 'bbb' } });
    const { app, db, ceo } = await company(registry);
    const [acme] = await db.select().from(companies);
    const [sales] = await db.insert(departments).values({ companyId: acme!.id, name: 'Sales', roleCode: 'SAL' }).returning();
    const seller = await invitePerson(app, ceo, { name: 'Oleg', email: 'oleg@acme.com', scope: { kind: 'department', id: sales!.id } });
    expect((await app.inject({ method: 'GET', url: '/api/updates', ...as(seller) })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/updates/check', ...as(seller) })).statusCode).toBe(403);
    expect(registry.calls).toEqual([]);
  });
});
