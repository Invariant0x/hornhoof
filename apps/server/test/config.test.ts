import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { TEST_SECRET } from './helpers.js';

describe('loadConfig', () => {
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

  it('names every wrong setting at once', () => {
    expect(() => loadConfig({ HORNHOOF_SECRET: TEST_SECRET, PORT: 'abc', REGISTRY_URL: 'registry' })).toThrow(/PORT must be[\s\S]*REGISTRY_URL must be an http:\/\/ or https:\/\/ address/);
  });
});
