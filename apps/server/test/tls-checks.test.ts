import type { RequestListener } from 'node:http';
import https from 'node:https';
import net, { type AddressInfo } from 'node:net';
import { createSecureContext } from 'node:tls';
import { describe, expect, it, onTestFinished } from 'vitest';
import { probe } from '../src/modules/tls/checks.js';
import { selfSigned } from '../src/modules/tls/x509.js';
import { closedPort } from './closed-port.js';

const QUICK = { tries: 2, everyMs: 10 };

/* The address of a server on a free local port, which goes when the test ends. */
async function urlOf(server: net.Server): Promise<string> {
  const sockets = new Set<net.Socket>();
  server.on('connection', socket => sockets.add(socket));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  onTestFinished(() => {
    sockets.forEach(socket => socket.destroy());
    return new Promise<void>(resolve => server.close(() => resolve()));
  });
  return `https://localhost:${(server.address() as AddressInfo).port}`;
}

type Pair = Awaited<ReturnType<typeof selfSigned>>;

const healthOnly: RequestListener = (req, res) => {
  res.statusCode = req.url === '/api/health' ? 200 : 404;
  res.end('{}');
};

const serverOf = (pair: Pair, listener: RequestListener = healthOnly) => https.createServer({ key: pair.keyPem, cert: pair.certPem }, listener);

const quickly = async (asked: Promise<boolean>): Promise<{ answer: boolean; ms: number }> => {
  const started = performance.now();
  return { answer: await asked, ms: performance.now() - started };
};

describe('probe', () => {
  it('probe is true for its own certificate and false for another or a closed port', async () => {
    const own = await selfSigned('localhost');
    const other = await selfSigned('localhost');
    const url = await urlOf(serverOf(own));
    expect(await probe(url, own.certPem, { ca: own.certPem })).toBe(true);
    expect(await probe(url, other.certPem, { ca: own.certPem, ...QUICK })).toBe(false);
    expect(await probe(`https://localhost:${await closedPort()}`, own.certPem, { ca: own.certPem, ...QUICK })).toBe(false);
  });

  it('checks the certificate, so one nobody trusts is no answer', async () => {
    const own = await selfSigned('localhost');
    expect(await probe(await urlOf(serverOf(own)), own.certPem, QUICK)).toBe(false);
  });

  it('wants a 200', async () => {
    const own = await selfSigned('localhost');
    const url = await urlOf(serverOf(own, (_req, res) => void res.writeHead(503).end()));
    expect(await probe(url, own.certPem, { ca: own.certPem, ...QUICK })).toBe(false);
  });

  it('takes text that is no certificate as a failed probe', async () => {
    const own = await selfSigned('localhost');
    expect(await probe(await urlOf(serverOf(own)), 'not a certificate', { ca: own.certPem, ...QUICK })).toBe(false);
  });

  it('gives up on a server that never finishes TLS, or never answers', async () => {
    const own = await selfSigned('localhost');
    const silent = await urlOf(net.createServer(() => {}));
    const mute = await urlOf(serverOf(own, () => {}));
    for (const url of [silent, mute]) {
      const { answer, ms } = await quickly(probe(url, own.certPem, { ca: own.certPem, tries: 3, everyMs: 10, timeoutMs: 200, deadlineMs: 500 }));
      expect(answer).toBe(false);
      expect(ms).toBeLessThan(1500);
    }
  });

  it('stops at the deadline, however many tries are left', async () => {
    const own = await selfSigned('localhost');
    const mute = await urlOf(serverOf(own, () => {}));
    const { answer, ms } = await quickly(probe(mute, own.certPem, { ca: own.certPem, tries: 100, everyMs: 10, timeoutMs: 200, deadlineMs: 300 }));
    expect(answer).toBe(false);
    expect(ms).toBeLessThan(1500);
  });

  it('asks over a new connection each time', async () => {
    const right = await selfSigned('localhost');
    const wrong = await selfSigned('localhost');
    let connections = 0;
    const server = https.createServer(
      {
        key: right.keyPem,
        cert: right.certPem,
        SNICallback: (_name, done) => {
          const pair = connections === 0 ? wrong : right;
          done(null, createSecureContext({ key: pair.keyPem, cert: pair.certPem }));
        },
      },
      healthOnly,
    );
    server.on('secureConnection', () => connections++);
    const url = await urlOf(server);
    expect(await probe(url, right.certPem, { ca: `${right.certPem}${wrong.certPem}`, tries: 3, everyMs: 10 })).toBe(true);
    expect(connections).toBe(2);
  });
});
