import { once } from 'node:events';
import net, { type AddressInfo } from 'node:net';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { testApp } from './helpers.js';

describe('closing the app', () => {
  it('does not wait for a connection that has asked nothing yet', async () => {
    const { app } = await testApp();
    await app.listen({ host: '127.0.0.1', port: 0 });
    /* As a client's pool leaves one: connected, and nothing sent on it. */
    const quiet = net.connect((app.server.address() as AddressInfo).port, '127.0.0.1');
    onTestFinished(() => void quiet.destroy());
    await once(quiet, 'connect');
    const gone = once(quiet, 'close');
    const from = Date.now();
    await app.close();
    await gone;
    expect(Date.now() - from).toBeLessThan(5000);
  });

  it('still answers on a connection that has asked something', async () => {
    const { app } = await testApp();
    await app.listen({ host: '127.0.0.1', port: 0 });
    const taken = once(app.server, 'connection') as Promise<[net.Socket]>;
    const asking = net.connect((app.server.address() as AddressInfo).port, '127.0.0.1');
    onTestFinished(() => void asking.destroy());
    const gone = once(asking, 'close');
    const [inApp] = await taken;
    let answer = '';
    asking.on('data', chunk => void (answer += String(chunk)));
    asking.write('GET /api/health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n');
    await vi.waitFor(() => expect(inApp.bytesRead).toBeGreaterThan(0));
    await app.close();
    await gone;
    /* Answered or told that the app is closing, and not cut off. */
    expect(answer).toMatch(/^HTTP\/1\.1 (200|503) /);
  });
});
