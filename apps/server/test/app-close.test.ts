import { once } from 'node:events';
import net, { type AddressInfo } from 'node:net';
import { describe, expect, it, onTestFinished } from 'vitest';
import { testApp } from './helpers.js';
import { until } from './helpers-basic.js';

describe('closing the app', () => {
  it('does not wait for a connection that has asked nothing yet', async () => {
    const { app } = await testApp();
    await app.listen({ host: '127.0.0.1', port: 0 });
    /* As a client's pool leaves one: connected, and nothing sent on it. */
    const quiet = net.connect((app.server.address() as AddressInfo).port, '127.0.0.1');
    onTestFinished(() => void quiet.destroy());
    await once(quiet, 'connect');
    const gone = once(quiet, 'close');
    /* Without this the close takes Node's minute for a first request, well past the limit of a test. */
    await app.close();
    await gone;
  });

  it('does not wait for one that comes while it closes either', async () => {
    const { app } = await testApp();
    await app.listen({ host: '127.0.0.1', port: 0 });
    const { port } = app.server.address() as AddressInfo;
    const closed = app.close();
    /* The server still takes connections while the app's own parts stop. */
    const late = net.connect(port, '127.0.0.1');
    onTestFinished(() => void late.destroy());
    /* Taken or turned away, it is gone by the time the app has closed, and the close does not wait for it. */
    late.on('error', () => undefined);
    const gone = new Promise<void>(resolve => late.once('close', () => resolve()));
    await closed;
    await gone;
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
    await until(() => inApp.bytesRead > 0);
    await app.close();
    await gone;
    /* Answered or told that the app is closing, and not cut off. */
    expect(answer).toMatch(/^HTTP\/1\.1 (200|503) /);
  });
});
