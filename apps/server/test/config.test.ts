import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { LETS_ENCRYPT } from '../src/modules/tls/acme.js';
import { TEST_SECRET } from './helpers-basic.js';

describe('loadConfig', () => {
  it('allows an optional upper limit for simultaneous parts on one host', () => {
    expect(loadConfig({ HORNHOOF_SECRET: TEST_SECRET }).runsPerHost).toBeUndefined();
    expect(loadConfig({ HORNHOOF_SECRET: TEST_SECRET, MAX_RUNS_PER_HOST: '' }).runsPerHost).toBeUndefined();
    expect(loadConfig({ HORNHOOF_SECRET: TEST_SECRET, MAX_RUNS_PER_HOST: '2' }).runsPerHost).toBe(2);
    for (const MAX_RUNS_PER_HOST of ['0', '-1', '1.5', 'two', '1001']) {
      expect(() => loadConfig({ HORNHOOF_SECRET: TEST_SECRET, MAX_RUNS_PER_HOST })).toThrow('MAX_RUNS_PER_HOST must be a whole number between 1 and 1000.');
    }
  });

  it('refuses a PORT that is not a port number', () => {
    for (const PORT of ['abc', '0', '65536', '80.5']) {
      expect(() => loadConfig({ HORNHOOF_SECRET: TEST_SECRET, PORT })).toThrow('PORT must be a number between 1 and 65535.');
    }
    expect(loadConfig({ HORNHOOF_SECRET: TEST_SECRET, PORT: '3000' }).port).toBe(3000);
    expect(loadConfig({ HORNHOOF_SECRET: TEST_SECRET }).port).toBe(8080);
  });

  it('refuses a PUBLIC_URL that is not a web address', () => {
    for (const PUBLIC_URL of ['hornhoof.example.com', 'ftp://example.com', 'https://', 'my company']) {
      expect(() => loadConfig({ HORNHOOF_SECRET: TEST_SECRET, PUBLIC_URL })).toThrow('PUBLIC_URL must be the address people open Hornhoof at');
    }
    expect(loadConfig({ HORNHOOF_SECRET: TEST_SECRET, PUBLIC_URL: 'https://hq.acme.com/' }).publicUrl).toBe('https://hq.acme.com');
    expect(loadConfig({ HORNHOOF_SECRET: TEST_SECRET, PUBLIC_URL: '' }).publicUrl).toBe('http://localhost:8080');
  });

  it('refuses intervals that are not whole milliseconds a timer can wait', () => {
    const bad: [string, string][] = [['NODE_PING_MS', 'abc'], ['NODE_PING_MS', '-2'], ['NODE_PING_MS', '0'], ['STREAM_PING_MS', 'NaN'], ['STREAM_PING_MS', '2.5'], ['UPDATE_CHECK_MS', '-1'], ['UPDATE_CHECK_MS', '3000000000']];
    for (const [name, value] of bad) {
      expect(() => loadConfig({ HORNHOOF_SECRET: TEST_SECRET, [name]: value })).toThrow(`${name} must be a whole number of milliseconds`);
    }
    const set = loadConfig({ HORNHOOF_SECRET: TEST_SECRET, NODE_PING_MS: '500', STREAM_PING_MS: '100', UPDATE_CHECK_MS: '0' });
    expect([set.nodePingMs, set.streamPingMs, set.updateCheckMs]).toEqual([500, 100, 0]);
    const defaults = loadConfig({ HORNHOOF_SECRET: TEST_SECRET, NODE_PING_MS: '' });
    expect([defaults.nodePingMs, defaults.streamPingMs, defaults.updateCheckMs]).toEqual([20000, 25000, 1800000]);
  });

  it("gets the link's certificate from Let's Encrypt unless ACME_DIRECTORY names another CA or says off", () => {
    expect(loadConfig({ HORNHOOF_SECRET: TEST_SECRET }).acmeDirectory).toBe(LETS_ENCRYPT);
    expect(loadConfig({ HORNHOOF_SECRET: TEST_SECRET, ACME_DIRECTORY: '' }).acmeDirectory).toBe(LETS_ENCRYPT);
    expect(loadConfig({ HORNHOOF_SECRET: TEST_SECRET, ACME_DIRECTORY: 'off' }).acmeDirectory).toBeNull();
    expect(loadConfig({ HORNHOOF_SECRET: TEST_SECRET, ACME_DIRECTORY: 'https://ca.test/dir' }).acmeDirectory).toBe('https://ca.test/dir');
    for (const ACME_DIRECTORY of ['http://x', 'ca.test/dir', 'https://', 'OFF']) {
      expect(() => loadConfig({ HORNHOOF_SECRET: TEST_SECRET, ACME_DIRECTORY })).toThrow('ACME_DIRECTORY must be off or an https:// ACME directory address.');
    }
  });

  it('asks hornhoof.org for public links unless RELAY_URL names another relay', () => {
    expect(loadConfig({ HORNHOOF_SECRET: TEST_SECRET }).relayUrl).toBe('https://hornhoof.org');
    expect(loadConfig({ HORNHOOF_SECRET: TEST_SECRET, RELAY_URL: '' }).relayUrl).toBe('https://hornhoof.org');
    expect(loadConfig({ HORNHOOF_SECRET: TEST_SECRET, RELAY_URL: 'http://127.0.0.1:9000/' }).relayUrl).toBe('http://127.0.0.1:9000');
    for (const RELAY_URL of ['hornhoof.org', 'ftp://hornhoof.org', 'https://']) {
      expect(() => loadConfig({ HORNHOOF_SECRET: TEST_SECRET, RELAY_URL })).toThrow('RELAY_URL must be an http:// or https:// address, like https://hornhoof.org.');
    }
  });

  it("is Hornhoof's own feedback inbox only when FEEDBACK_INBOX says true", () => {
    expect(loadConfig({ HORNHOOF_SECRET: TEST_SECRET }).feedbackInbox).toBe(false);
    expect(loadConfig({ HORNHOOF_SECRET: TEST_SECRET, FEEDBACK_INBOX: '' }).feedbackInbox).toBe(false);
    expect(loadConfig({ HORNHOOF_SECRET: TEST_SECRET, FEEDBACK_INBOX: 'false' }).feedbackInbox).toBe(false);
    expect(loadConfig({ HORNHOOF_SECRET: TEST_SECRET, FEEDBACK_INBOX: 'true' }).feedbackInbox).toBe(true);
    for (const FEEDBACK_INBOX of ['yes', '1', 'TRUE']) {
      expect(() => loadConfig({ HORNHOOF_SECRET: TEST_SECRET, FEEDBACK_INBOX })).toThrow('FEEDBACK_INBOX must be true or false.');
    }
  });

  it('runs behind a keeper only when HORNHOOF_KEEPER says on', () => {
    expect(loadConfig({ HORNHOOF_SECRET: TEST_SECRET }).keeper).toBe(false);
    expect(loadConfig({ HORNHOOF_SECRET: TEST_SECRET, HORNHOOF_KEEPER: '' }).keeper).toBe(false);
    expect(loadConfig({ HORNHOOF_SECRET: TEST_SECRET, HORNHOOF_KEEPER: 'on' }).keeper).toBe(true);
    expect(() => loadConfig({ HORNHOOF_SECRET: TEST_SECRET, HORNHOOF_KEEPER: 'yes' })).toThrow('HORNHOOF_KEEPER must be on, or not set.');
  });

  it('talks to Telegram\'s own Bot API unless TELEGRAM_API_URL names a stand-in', () => {
    expect(loadConfig({ HORNHOOF_SECRET: TEST_SECRET }).telegramApiUrl).toBe('https://api.telegram.org');
    expect(loadConfig({ HORNHOOF_SECRET: TEST_SECRET, TELEGRAM_API_URL: 'http://127.0.0.1:9100/' }).telegramApiUrl).toBe('http://127.0.0.1:9100');
    expect(() => loadConfig({ HORNHOOF_SECRET: TEST_SECRET, TELEGRAM_API_URL: 'api.telegram.org' })).toThrow('TELEGRAM_API_URL must be an http:// or https:// address, like https://api.telegram.org.');
  });

  it('knows the tunnel container by a plain host name', () => {
    expect(loadConfig({ HORNHOOF_SECRET: TEST_SECRET }).tunnelHost).toBeUndefined();
    expect(loadConfig({ HORNHOOF_SECRET: TEST_SECRET, TUNNEL_HOST: 'tunnel' }).tunnelHost).toBe('tunnel');
    expect(loadConfig({ HORNHOOF_SECRET: TEST_SECRET, TUNNEL_HOST: '172.18.0.5' }).tunnelHost).toBe('172.18.0.5');
    for (const TUNNEL_HOST of ['http://tunnel', 'tun nel', 'tunnel:8080']) {
      expect(() => loadConfig({ HORNHOOF_SECRET: TEST_SECRET, TUNNEL_HOST })).toThrow('TUNNEL_HOST must be the host name of the keeper container, like keeper.');
    }
  });

  it('knows the computer it runs on by the hash install.sh gives, and none without one', () => {
    const id = 'ab'.repeat(32);
    expect(loadConfig({ HORNHOOF_SECRET: TEST_SECRET }).hostId).toBeNull();
    expect(loadConfig({ HORNHOOF_SECRET: TEST_SECRET, HORNHOOF_HOST_ID: '' }).hostId).toBeNull();
    expect(loadConfig({ HORNHOOF_SECRET: TEST_SECRET, HORNHOOF_HOST_ID: id }).hostId).toBe(id);
    for (const HORNHOOF_HOST_ID of ['mac-0001-abcd', 'AB'.repeat(32), 'ab'.repeat(31)]) {
      expect(() => loadConfig({ HORNHOOF_SECRET: TEST_SECRET, HORNHOOF_HOST_ID })).toThrow('HORNHOOF_HOST_ID must be the 64 characters install.sh writes. Remove the line from .env, or run the install command again.');
    }
  });

  it('knows this install by the id install.sh gives, and none without one', () => {
    expect(loadConfig({ HORNHOOF_SECRET: TEST_SECRET }).machineId).toBeNull();
    expect(loadConfig({ HORNHOOF_SECRET: TEST_SECRET, HORNHOOF_MACHINE_ID: '' }).machineId).toBeNull();
    for (const id of ['ab'.repeat(16), 'ab'.repeat(32)]) {
      expect(loadConfig({ HORNHOOF_SECRET: TEST_SECRET, HORNHOOF_MACHINE_ID: id }).machineId).toBe(id);
    }
    for (const HORNHOOF_MACHINE_ID of ['XYZ', 'AB'.repeat(16), 'ab'.repeat(24), 'ab'.repeat(16) + '\n']) {
      expect(() => loadConfig({ HORNHOOF_SECRET: TEST_SECRET, HORNHOOF_MACHINE_ID })).toThrow('HORNHOOF_MACHINE_ID must be the hex install.sh writes. Remove the line from .env, or run the install command again.');
    }
  });

  it("loads the keeper's environment and nothing more", () => {
    const config = loadConfig({
      DATABASE_URL: 'postgres://hornhoof:hornhoof@db:5432/hornhoof',
      HORNHOOF_SECRET: randomBytes(32).toString('base64'),
      ACME_DIRECTORY: '',
      HORNHOOF_MACHINE_ID: '',
      RELAY_URL: '',
    });
    expect(config.controlDir).toBe('/control');
    expect(config.acmeDirectory).toBe(LETS_ENCRYPT);
    expect(config.machineId).toBeNull();
    expect(config.relayUrl).toBe('https://hornhoof.org');
    expect(config.databaseUrl).toBe('postgres://hornhoof:hornhoof@db:5432/hornhoof');
  });

  it('gives task files 2 GB unless TASK_FILES_MB names other whole megabytes', () => {
    expect(loadConfig({ HORNHOOF_SECRET: TEST_SECRET, TASK_FILES_MB: '' }).taskFilesBytes).toBe(2048 * 1024 * 1024);
    expect(loadConfig({ HORNHOOF_SECRET: TEST_SECRET, TASK_FILES_MB: '512' }).taskFilesBytes).toBe(512 * 1024 * 1024);
    for (const TASK_FILES_MB of ['2GB', '0', '-1', '1.5']) {
      expect(() => loadConfig({ HORNHOOF_SECRET: TEST_SECRET, TASK_FILES_MB })).toThrow('TASK_FILES_MB must be a whole number of megabytes, like 2048.');
    }
  });

  /* Compose passes both names empty when .env lacks them, so that one file serves a server and a worker. */
  it('says what to do about a secret or a node key that came empty', () => {
    expect(() => loadConfig({ HORNHOOF_SECRET: '' })).toThrow("HORNHOOF_SECRET is empty. Put the company's secret into .env, or run the install command again.");
    expect(() => loadConfig({})).toThrow('HORNHOOF_SECRET is not set. Generate one with: openssl rand -base64 32');
    expect(() => loadConfig({ HORNHOOF_SECRET: TEST_SECRET, NODE_KEY: '' })).toThrow("NODE_KEY is empty. Put the company's node key into .env, or run the install command again.");
    expect(loadConfig({ HORNHOOF_SECRET: TEST_SECRET }).nodeKey).toBeUndefined();
  });

  it('names every wrong setting at once', () => {
    expect(() => loadConfig({ HORNHOOF_SECRET: TEST_SECRET, PORT: 'abc', REGISTRY_URL: 'registry' })).toThrow(/PORT must be[\s\S]*REGISTRY_URL must be an http:\/\/ or https:\/\/ address/);
  });
});
