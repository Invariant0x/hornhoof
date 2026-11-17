import type { RequestListener } from 'node:http';
import https from 'node:https';
import net, { type AddressInfo } from 'node:net';
import { createSecureContext } from 'node:tls';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { eventually } from '../../../test-support/eventually.mjs';
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

/* Runs a probe on a clock that moves only here: on to the probe's next timer, once every try it has started has reached the
   server, which answers nothing more. The probe then waits for nothing but time. Gives the answer, the virtual
   milliseconds it took, and the tries it made. */
async function onVirtualTime(probing: () => Promise<boolean>, reached: () => number): Promise<{ answer: boolean; ms: number; tries: number }> {
  const asks = vi.spyOn(https, 'get');
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const restore = () => {
    vi.useRealTimers();
    asks.mockRestore();
  };
  onTestFinished(restore);
  try {
    const started = Date.now();
    let answer: boolean | undefined;
    void probing().then(given => void (answer = given));
    const waitsForTime = () => vi.getTimerCount() > 0 && reached() >= asks.mock.calls.length;
    for (;;) {
      await eventually(() => answer !== undefined || waitsForTime());
      if (answer !== undefined) return { answer, ms: Date.now() - started, tries: asks.mock.calls.length };
      await vi.advanceTimersToNextTimerAsync();
    }
  } finally {
    restore();
  }
}

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
    let connected = 0;
    let asked = 0;
    const silent = await urlOf(net.createServer(() => void connected++));
    const mute = await urlOf(serverOf(own, () => void asked++));
    const servers = [
      { url: silent, reached: () => connected },
      { url: mute, reached: () => asked },
    ];
    for (const { url, reached } of servers) {
      const { answer, ms } = await onVirtualTime(() => probe(url, own.certPem, { ca: own.certPem, tries: 3, everyMs: 10, timeoutMs: 200, deadlineMs: 500 }), reached);
      expect(answer).toBe(false);
      expect(ms).toBeLessThanOrEqual(500);
    }
  });

  it('stops at the deadline, however many tries are left', async () => {
    const own = await selfSigned('localhost');
    let asked = 0;
    const mute = await urlOf(serverOf(own, () => void asked++));
    const { answer, ms, tries } = await onVirtualTime(() => probe(mute, own.certPem, { ca: own.certPem, tries: 100, everyMs: 10, timeoutMs: 200, deadlineMs: 300 }), () => asked);
    expect(answer).toBe(false);
    expect(ms).toBeLessThanOrEqual(300);
    expect(tries).toBeLessThan(100);
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
