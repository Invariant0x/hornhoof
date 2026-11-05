import { spawn } from 'node:child_process';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { hookClock } from './hook-test-clock.js';

const HOOK = fileURLToPath(new URL('../hh-hook.cjs', import.meta.url));
const CLOCK = fileURLToPath(new URL('./fakes/hook-clock.cjs', import.meta.url));

type Call = { headers: IncomingHttpHeaders; text: string };

export async function client(answer: (call: number) => 'ok' | 'disconnect' | 'timeout' | 'forbidden', cleanups: (() => void)[]) {
  const calls: Call[] = [];
  const server = createServer((req, res) => {
    let text = '';
    req.setEncoding('utf8').on('data', chunk => text += chunk).on('end', () => {
      if (req.url !== '/stop') return void res.end('');
      calls.push({ headers: req.headers, text });
      const how = answer(calls.length);
      if (how === 'disconnect') return res.destroy();
      if (how === 'timeout') return;
      res.writeHead(how === 'forbidden' ? 403 : 200).end('');
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => { server.closeAllConnections(); server.close(); });
  const dir = mkdtempSync(join(tmpdir(), 'hh-client-'));
  const args = [HOOK, 'stop', '{"last_assistant_message":"Done."}'];
  const child = spawn('node', ['-r', CLOCK, ...args], { stdio: ['pipe', 'pipe', 'pipe', 'ipc'], cwd: dir, env: { PATH: process.env.PATH, HOME: dir, HH_BRIDGE: `http://127.0.0.1:${(server.address() as AddressInfo).port}` } });
  if (!child.stdin || !child.stdout || !child.stderr) throw new Error('Hook pipe streams unavailable');
  cleanups.push(() => child.kill('SIGKILL'));
  let errors = '';
  child.stdout.resume();
  child.stderr.setEncoding('utf8').on('data', chunk => errors += chunk);
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
  child.stdin.end();
  return { calls, child, stderr: child.stderr, clock: hookClock(child), errors: () => errors, closed };
}
