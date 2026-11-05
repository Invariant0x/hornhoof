import { Agent, request } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { Bridge } from '../src/terminal/bridge.js';
import { macOwner, type Command } from '../src/terminal/mac-peer.js';
import { trackCheckProcess } from '../src/check-processes.js';
import { terminalOwner } from '../src/main.js';

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach(clean => clean()));

function post(url: string, agent: Agent, pid = 55): Promise<number> {
  return new Promise((resolve, reject) => {
    const call = request(url + '/stop', { method: 'POST', agent, headers: { 'x-hh-pid': String(pid) } }, res => {
      res.resume().on('end', () => resolve(res.statusCode!));
    });
    call.on('error', reject).end('{}');
  });
}

async function opened(mode = 'own') {
  let url = '';
  let current = mode;
  const commands: { file: string; args: string[]; timeout: number }[] = [];
  const heard: string[] = [];
  const run: Command = async (file, args, options) => {
    commands.push({ file, args, timeout: options.timeout });
    if (file === '/bin/ps') {
      if (current === 'ps-error' || args.at(-1) === '0') throw new Error('ps failed');
      return args.at(-1) === '55' ? '10\n' : '0\n';
    }
    if (current === 'error' || current === 'timeout') throw new Error(current);
    if (current === 'empty') return '';
    const client = args.find(arg => arg.startsWith('-iTCP:'))!.slice(6);
    const server = new URL(url).port;
    const wrong = `p999\nn127.0.0.1:${server}->127.0.0.1:${client}\n`;
    if (current === 'reversed') return wrong;
    if (current === 'malformed') return `pzero\nn127.0.0.1:${client}->127.0.0.1:${server}\n`;
    if (current === 'leading-zero') return `p01\nn127.0.0.1:${client}->127.0.0.1:${server}\n`;
    if (current === 'no-pid') return `n127.0.0.1:${client}->127.0.0.1:${server}\n`;
    if (current === 'huge-pid') return `p99999999999999999999999999\nn127.0.0.1:${client}->127.0.0.1:${server}\n`;
    const pid = current === 'foreign' ? 77 : current === 'root-one' ? 1 : 55;
    const own = `p${pid}\nn127.0.0.1:${client}->127.0.0.1:${server}\n`;
    return wrong + own + (current === 'ambiguous' ? `p66\nn127.0.0.1:${client}->127.0.0.1:${server}\n` : '');
  };
  const owner = terminalOwner('darwin', run)!(async () => [10, 1]);
  const bridge = new Bridge('http://127.0.0.1:9', key => void heard.push(key), owner.owns, { capture: owner.capture });
  await bridge.start();
  url = bridge.agent('agent-1').hookUrl;
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  cleanups.push(() => { agent.destroy();bridge.stop(); });
  return { url, agent, heard, commands, mode: (value: string) => { current = value; } };
}

describe('macOS hook ownership without proc', () => {
  it('accepts the client process under the pane and ignores the bridge side of the TCP pair', async () => {
    const c = await opened();
    expect(await post(c.url, c.agent)).toBe(200);
    expect(c.heard).toEqual(['agent-1']);
    const lookup = c.commands.find(command => command.file === '/usr/sbin/lsof')!;
    expect(lookup).toEqual({ file: '/usr/sbin/lsof', args: ['-nP', '-a', expect.stringMatching(/^-iTCP:\d+$/), '-sTCP:ESTABLISHED', '-Fpn'], timeout: 2000 });
  });

  it('rejects a foreign socket owner and a caller borrowing the pid of the pane', async () => {
    const c = await opened('foreign');
    expect(await post(c.url, c.agent, 77)).toBe(403);
    expect(await post(c.url, c.agent, 55)).toBe(403);
    expect(c.heard).toEqual([]);
  });

  it('recognizes only the live check roots of the authenticated agent', async () => {
    const owner = macOwner(async () => '0')(async () => []);
    const forget = trackCheckProcess('agent-1', 77); cleanups.push(forget);
    const peer = { port: 1, bridgePort: 2, pid: 77, acceptedPid: 77 };
    expect(await owner.owns!('agent-1', peer)).toBe(true);
    expect(await owner.owns!('agent-2', peer)).toBe(false);
    forget();
    expect(await owner.owns!('agent-1', peer)).toBe(false);
  });

  it('accepts a verified process at pid 1', async () => {
    const c = await opened('root-one');
    expect(await post(c.url, c.agent, 1)).toBe(200);
  });

  it.each(['error', 'timeout', 'empty', 'reversed', 'ambiguous', 'malformed', 'leading-zero', 'no-pid', 'huge-pid', 'ps-error'])('closes access when process lookup returns %s', async mode => {
    const c = await opened(mode);
    expect(await post(c.url, c.agent, mode === 'ps-error' ? 55 : 1)).toBe(403);
    expect(c.heard).toEqual([]);
  });

  it('reuses capture only for the same Socket and checks every new connection', async () => {
    const c = await opened();
    expect(await post(c.url, c.agent)).toBe(200);
    expect(await post(c.url, c.agent)).toBe(200);
    expect(await post(c.url, c.agent, 77)).toBe(403);
    expect(c.commands.filter(command => command.file === '/usr/sbin/lsof')).toHaveLength(1);
    c.mode('foreign');
    c.agent.destroy();
    expect(await post(c.url, c.agent, 77)).toBe(403);
    expect(c.commands.filter(command => command.file === '/usr/sbin/lsof')).toHaveLength(2);
  });

  it('captures ancestry before waiting for a slow pane lookup', async () => {
    let atPane!: () => void;
    const entered = new Promise<void>(resolve => { atPane = resolve; });
    let release!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    let alive = true;
    const check = macOwner(async () => { if (!alive) throw new Error('caller exited');return '10'; })(async () => { atPane();await wait;return [10]; });
    const result = check.owns!('agent-1', { port: 1, bridgePort: 2, pid: 55, acceptedPid: 55 });
    await entered;
    alive = false;
    release();
    expect(await result).toBe(true);
  });
});
