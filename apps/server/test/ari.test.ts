import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as peculiar from '@peculiar/x509';
import { describe, expect, it, onTestFinished } from 'vitest';
import { certId, certIdFrom, renewalInfo } from '../src/modules/tls/ari.js';
import { selfSigned } from '../src/modules/tls/x509.js';
import { closedPort } from './closed-port.js';

const HOST = 'acme.hornhoof.org';
const WINDOW = { start: '2026-12-01T00:00:00Z', end: '2026-12-02T00:00:00Z' };
const MALFORMED = 'urn:ietf:params:acme:error:malformed';

type Answer = (res: ServerResponse) => void;

function jsonAnswer(status: number, body: unknown, headers: Record<string, string> = {}): Answer {
  return (res) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  };
}

const windowAnswer = (headers: Record<string, string> = {}) => jsonAnswer(200, { suggestedWindow: WINDOW }, headers);

// A directory on a local port that says where renewal information lives, and records every path asked for.
async function ariServer(answer: Answer, renewalInfoPath: string | null = '/renewal-info/') {
  const paths: string[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    paths.push(req.url ?? '');
    if (req.url !== '/dir') return answer(res);
    const { port } = server.address() as AddressInfo;
    const renewal = renewalInfoPath ? { renewalInfo: `http://127.0.0.1:${port}${renewalInfoPath}` } : {};
    return jsonAnswer(200, renewal)(res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  onTestFinished(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { directory: `http://127.0.0.1:${(server.address() as AddressInfo).port}/dir`, paths };
}

describe('the certificate id', () => {
  it('builds the certificate id as RFC 9773 shows it', () => {
    expect(certIdFrom('69885b6b87464041e1b37b847ba0ae2cde01c8d4', '0087654321')).toBe('aYhba4dGQEHhs3uEe6CuLN4ByNQ.AIdlQyE');
  });

  it("keeps the serial's leading zero", async () => {
    const { certPem } = await selfSigned(HOST, { serial: '0089abcdef' });
    const id = certId(certPem)!;
    expect(id.endsWith('.AImrze8')).toBe(true);
    expect(id).not.toContain('=');
    const authority = new peculiar.X509Certificate(certPem).getExtension(peculiar.AuthorityKeyIdentifierExtension)!;
    const firstPart = Buffer.from(id.split('.')[0]!, 'base64url');
    expect(firstPart).toHaveLength(20);
    expect(firstPart.toString('hex')).toBe(authority.keyId);
  });

  it('adds no zero to a serial that needs none', async () => {
    const { certPem } = await selfSigned(HOST, { serial: '7fabcdef' });
    expect(certId(certPem)!.split('.')[1]).toBe(Buffer.from('7fabcdef', 'hex').toString('base64url'));
  });

  it('reads the first certificate of a chain', async () => {
    const first = await selfSigned(HOST, { serial: '11' });
    const second = await selfSigned(HOST, { serial: '22' });
    expect(certId(first.certPem + second.certPem)).toBe(certId(first.certPem));
  });

  it('has none for a certificate with no authority key identifier', async () => {
    const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const bare = await peculiar.X509CertificateGenerator.createSelfSigned({
      name: 'CN=test',
      keys,
      signingAlgorithm: { name: 'ECDSA', hash: 'SHA-256' },
    });
    expect(certId(bare.toString('pem'))).toBeNull();
  });
});

describe('renewal information', () => {
  it('asks the renewal information of the certificate', async () => {
    const { certPem } = await selfSigned(HOST);
    const withRetry = await ariServer(windowAnswer({ 'retry-after': '3600' }));
    expect(await renewalInfo(withRetry.directory, certPem)).toEqual({
      start: new Date(WINDOW.start),
      end: new Date(WINDOW.end),
      retryAfterS: 3600,
    });
    expect(withRetry.paths).toEqual(['/dir', `/renewal-info/${certId(certPem)}`]);

    const withoutRetry = await ariServer(windowAnswer());
    expect((await renewalInfo(withoutRetry.directory, certPem))?.retryAfterS).toBe(21600);

    const noTrailingSlash = await ariServer(windowAnswer(), '/renewal-info');
    await renewalInfo(noTrailingSlash.directory, certPem);
    expect(noTrailingSlash.paths[1]).toBe(`/renewal-info/${certId(certPem)}`);
  });

  it('says refused, with the type, when the CA turns the question down', async () => {
    const { certPem } = await selfSigned(HOST);
    const { directory } = await ariServer((res) => {
      res.writeHead(404, { 'content-type': 'application/problem+json' });
      res.end(JSON.stringify({ type: MALFORMED, detail: 'no such certificate' }));
    });
    await expect(renewalInfo(directory, certPem)).rejects.toMatchObject({ kind: 'refused', type: MALFORMED });
  });

  it('says refused for a window that ends before it starts', async () => {
    const { certPem } = await selfSigned(HOST);
    const backwards = { start: WINDOW.end, end: WINDOW.start };
    const { directory } = await ariServer(jsonAnswer(200, { suggestedWindow: backwards }));
    await expect(renewalInfo(directory, certPem)).rejects.toMatchObject({ kind: 'refused', type: null });
  });

  it('says refused for a window that is not made of dates', async () => {
    const { certPem } = await selfSigned(HOST);
    const { directory } = await ariServer(jsonAnswer(200, { suggestedWindow: { start: 'soon', end: 'later' } }));
    await expect(renewalInfo(directory, certPem)).rejects.toMatchObject({ kind: 'refused' });
  });

  it('says refused for an answer that is not JSON at all', async () => {
    const { certPem } = await selfSigned(HOST);
    const { directory } = await ariServer((res) => res.end('<html>a proxy speaks</html>'));
    await expect(renewalInfo(directory, certPem)).rejects.toMatchObject({ kind: 'refused' });
  });

  it('does not follow a redirect', async () => {
    const { certPem } = await selfSigned(HOST);
    const { directory, paths } = await ariServer((res) => {
      res.writeHead(302, { location: '/elsewhere' });
      res.end();
    });
    await expect(renewalInfo(directory, certPem)).rejects.toMatchObject({ kind: 'unreachable' });
    expect(paths).not.toContain('/elsewhere');
  });

  it('has none to give without ARI', async () => {
    const { certPem } = await selfSigned(HOST);
    const { directory, paths } = await ariServer(windowAnswer(), null);
    expect(await renewalInfo(directory, certPem)).toBeNull();
    expect(paths).toEqual(['/dir']);
  });

  it('says unreachable when nothing answers', async () => {
    const { certPem } = await selfSigned(HOST);
    const directory = `http://127.0.0.1:${await closedPort()}/dir`;
    await expect(renewalInfo(directory, certPem)).rejects.toMatchObject({ kind: 'unreachable' });
  });
});
