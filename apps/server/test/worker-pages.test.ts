import { generateKeyPairSync } from 'node:crypto';
import type http from 'node:http';
import { describe, expect, it } from 'vitest';
import { disconnectedAnswer, noLeaderAnswer } from '../src/modules/keeper/worker-pages.js';
import { workerConfig } from '../src/modules/keeper/worker-config.js';

const asked = (url: string, language?: string) => ({ url, headers: language ? { 'accept-language': language } : {} }) as http.IncomingMessage;
const SERVER = { machine: 'a', networkId: 'b', hostname: 'debian', addresses: ['192.168.1.7'], peerPort: 8180, webPort: 8080, number: 1, copyName: null };
const MACHINE_ID = 'ab12cd34'.repeat(8);

describe('the pages a worker serves by itself', () => {
  it('says where the company can be opened while it reaches no server', () => {
    const view = { data: [SERVER, { ...SERVER, hostname: null, webPort: 9090 }, { ...SERVER, webPort: null }], linkUrl: 'https://acme.hornhoof.test' };
    const page = noLeaderAnswer(asked('/tasks'), view);
    expect(page.status).toBe(503);
    expect(page.headers).toMatchObject({ 'Content-Type': 'text/html; charset=utf-8', 'Retry-After': '15' });
    expect(page.body).toContain('<meta http-equiv="refresh" content="15">');
    expect(page.body).not.toContain('<script');
    expect(page.body).toContain('This machine cannot reach the company server. Open the company on a machine that keeps its data:');
    expect(page.body).not.toMatch(/[А-Яа-я]/);
    expect(page.body.match(/<li>.*<\/li>/g)).toEqual(['<li>debian: localhost:8080</li>', '<li>the company server: localhost:9090</li>']);
    expect(page.body).toContain('or at <a href="https://acme.hornhoof.test">https://acme.hornhoof.test</a>.');
    expect(page.body).not.toMatch(/[—ё]/);
    /* A visitor who asks for another language the product ships reads it under the English. */
    const russian = noLeaderAnswer(asked('/tasks', 'ru-RU,ru;q=0.9'), view).body;
    expect(russian).toContain('This machine cannot reach the company server.');
    expect(russian).toContain('<div lang="ru" dir="ltr">');
    expect(russian).toContain('Эта машина не может связаться с сервером компании. Откройте компанию на машине, где хранятся ее данные:');
    expect(russian.match(/<li>.*<\/li>/g)).toEqual([
      '<li>debian: localhost:8080</li>', '<li>the company server: localhost:9090</li>',
      '<li>debian: localhost:8080</li>', '<li>сервер компании: localhost:9090</li>',
    ]);
    expect(russian).toContain('или по адресу <a href="https://acme.hornhoof.test">https://acme.hornhoof.test</a>.');
    expect(russian).not.toMatch(/ё/);
  });

  it('names no link when the company has none, and escapes what a server said', () => {
    const page = noLeaderAnswer(asked('/'), { data: [{ ...SERVER, hostname: '<b>"x"&' }], linkUrl: null });
    expect(page.body).toContain('<li>&lt;b&gt;&quot;x&quot;&amp;: localhost:8080</li>');
    expect(page.body).not.toContain('or at');
    expect(noLeaderAnswer(asked('/', 'ru'), { data: [], linkUrl: null }).body).not.toContain('или по адресу');
    expect(noLeaderAnswer(asked('/'), { data: [], linkUrl: 'https://x.test/"><script>' }).body).not.toContain('"><script>');
  });

  it('answers a program in JSON', () => {
    for (const url of ['/api/tasks', '/mcp']) {
      const none = noLeaderAnswer(asked(url), { data: [SERVER], linkUrl: null });
      expect(none.status).toBe(503);
      expect(JSON.parse(none.body)).toEqual({ error: { code: 'unavailable', message: 'This machine cannot reach the company server now.', reason: 'no_leader' } });
      const cut = disconnectedAnswer(asked(url));
      expect(cut.status).toBe(410);
      expect(JSON.parse(cut.body).error).toMatchObject({ code: 'gone', reason: 'disconnected' });
    }
  });

  it('says that the machine was disconnected, and how to connect it again', () => {
    const page = disconnectedAnswer(asked('/'));
    expect(page.status).toBe(410);
    expect(page.headers['Content-Type']).toBe('text/html; charset=utf-8');
    expect(page.body).toContain('This machine was disconnected from the company. To connect it again, get a new command in Hornhoof under Machines and run it here.');
    expect(page.body).not.toMatch(/[А-Яа-я]/);
    expect(disconnectedAnswer(asked('/', 'ru')).body).toContain('Эту машину отключили от компании. Чтобы подключить ее снова, возьмите новую команду в Hornhoof в разделе «Машины» и выполните ее здесь.');
  });
});

describe("a worker keeper's settings", () => {
  const ENV = { HORNHOOF_MACHINE_ID: MACHINE_ID, HORNHOOF_JOIN_SERVER: 'http://192.168.1.7:8080/' };

  it("reads the worker's own lines, and no secret of the company", () => {
    const config = workerConfig({ ...ENV, HORNHOOF_SECRET: 's'.repeat(44), NODE_KEY: 'n'.repeat(40), DATABASE_URL: 'postgres://x', POSTGRES_PASSWORD: 'p' });
    expect(config).toEqual({ machineId: MACHINE_ID, joinServer: 'http://192.168.1.7:8080', ticket: null, controlDir: '/control', dir: '/keeper', commit: 'local', ports: { web: null, peer: null }, addresses: [], ownerKey: null, hostOs: null, survivorMs: 600_000 });
    expect(JSON.stringify(config)).not.toMatch(/ssss|nnnn|postgres/);
  });

  it('takes the system of its computer as the installer names it, and no other word for one', () => {
    expect(workerConfig({ ...ENV, HORNHOOF_HOST_OS: 'darwin' }).hostOs).toBe('darwin');
    expect(workerConfig({ ...ENV, HORNHOOF_HOST_OS: 'linux' }).hostOs).toBe('linux');
    expect(workerConfig({ ...ENV, HORNHOOF_HOST_OS: 'windows' }).hostOs).toBeNull();
    /* How long without a leader before it looks for a restored server: ten minutes, or what a stand shortens it to. */
    expect(workerConfig(ENV).survivorMs).toBe(600_000);
    expect(workerConfig({ ...ENV, HORNHOOF_SURVIVOR_S: '' }).survivorMs).toBe(600_000);
    expect(workerConfig({ ...ENV, HORNHOOF_SURVIVOR_S: '20' }).survivorMs).toBe(20_000);
    for (const odd of ['9', '3601', '12.5', 'soon', '-20']) expect(workerConfig({ ...ENV, HORNHOOF_SURVIVOR_S: odd }).survivorMs).toBe(600_000);
  });

  it('takes the ticket, the ports, the addresses and the name the installer wrote', () => {
    const config = workerConfig({ ...ENV, HORNHOOF_JOIN_SERVER: 'https://acme.hornhoof.test', HORNHOOF_JOIN_TICKET: 't'.repeat(43), HORNHOOF_PORT: '8081', HORNHOOF_PEER_PORT: '8181', HORNHOOF_ADDRESSES: '192.168.1.20, 10.0.0.4,', HORNHOOF_COMMIT: 'c0ffee', HORNHOOF_CONTROL_DIR: '/tmp/c' });
    expect(config).toMatchObject({ joinServer: 'https://acme.hornhoof.test', ticket: 't'.repeat(43), ports: { web: 8081, peer: 8181 }, addresses: ['192.168.1.20', '10.0.0.4'], commit: 'c0ffee', controlDir: '/tmp/c' });
  });

  it("takes the owner's key only when it is one, and says so when it is not", () => {
    const key = generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
    expect(workerConfig({ ...ENV, HORNHOOF_OWNER_KEY: key }).ownerKey).toBe(key);
    expect(workerConfig({ ...ENV }).ownerKey).toBeNull();
    const lines: string[] = [];
    expect(workerConfig({ ...ENV, HORNHOOF_OWNER_KEY: `${key}$` }, line => lines.push(line)).ownerKey).toBeNull();
    expect(workerConfig({ ...ENV, HORNHOOF_OWNER_KEY: 'A'.repeat(122) }, line => lines.push(line)).ownerKey).toBeNull();
    expect(lines).toEqual(Array(2).fill('HORNHOOF_OWNER_KEY is not a key, so this machine pins no owner. Run the join command from Hornhoof on this machine again.'));
  });

  it('refuses to start without its id or the server it joined at, and says to run the command again', () => {
    expect(() => workerConfig({ HORNHOOF_JOIN_SERVER: ENV.HORNHOOF_JOIN_SERVER })).toThrow('HORNHOOF_MACHINE_ID is not set. Run the join command from Hornhoof on this machine again.');
    expect(() => workerConfig({ ...ENV, HORNHOOF_MACHINE_ID: 'short' })).toThrow('HORNHOOF_MACHINE_ID is not set.');
    for (const HORNHOOF_JOIN_SERVER of [undefined, '', 'acme', 'ftp://acme.test']) {
      expect(() => workerConfig({ ...ENV, HORNHOOF_JOIN_SERVER })).toThrow("HORNHOOF_JOIN_SERVER is not the address of the company's server. Run the join command from Hornhoof on this machine again.");
    }
  });
});
