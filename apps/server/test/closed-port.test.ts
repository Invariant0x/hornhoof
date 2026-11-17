import { createConnection, createServer } from 'node:net';
import { expect, it, onTestFinished } from 'vitest';
import { closedPort } from './closed-port.js';

it('keeps the unavailable address bound and refuses every connection', async () => {
  const port = await closedPort();
  const other = createServer();
  onTestFinished(() => new Promise<void>(resolve => other.close(() => resolve())));
  await expect(new Promise<void>((resolve, reject) => {
    other.once('error', reject);
    other.listen(port, '127.0.0.1', resolve);
  })).rejects.toMatchObject({ code: 'EADDRINUSE' });
  for (let attempt = 0; attempt < 2; attempt++) {
    const socket = createConnection({ host: '127.0.0.1', port });
    onTestFinished(() => { socket.destroy(); });
    const failure = await new Promise<Error>(resolve => socket.once('error', resolve));
    expect(failure).toMatchObject({ code: 'ECONNRESET' });
  }
});
