import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LIMITS, main, parseArgs, USAGE } from '../src/web-page/cli.js';
import type { BrowseRequest } from '../src/web-page/browse.js';
import type { BrowseResult } from '../src/web-page/read.js';

const read: BrowseResult = {
  status: 'ok', reason: null, address: 'https://shop.example/', finalAddress: 'https://shop.example/', httpStatus: 200,
  title: 'Shop', text: 'Spring sets are in.', textLength: 19, links: [{ text: 'Sets', url: 'https://shop.example/sets' }], linkCount: 1, screenshot: null, notes: [],
};

function run(argv: string[], result: Partial<BrowseResult> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const asked: BrowseRequest[] = [];
  const done = main(argv, { out: text => out.push(text), err: text => err.push(text) }, async request => {
    asked.push(request);
    return { ...read, address: request.address, ...result };
  });
  return done.then(code => ({ code, out: out.join(''), err: err.join(''), asked }));
}

describe('the hh-browse command', () => {
  it('takes one address and its options within their limits', () => {
    expect(parseArgs(['https://shop.example/'])).toEqual({
      kind: 'browse', json: false,
      request: { address: 'https://shop.example/', screenshot: null, fullPage: false, waitFor: null, limits: { timeoutMs: 30_000, maxText: 20_000, maxLinks: 100, maxBytes: 20 * 1024 * 1024 } },
    });
    expect(parseArgs(['--screenshot', 'shot.png', '--full-page', '--wait-for', '#prices', '--json', '--timeout', '60', '--max-text', '5000', '--max-links', '0', '--max-mb', '50', 'https://shop.example/'])).toMatchObject({
      kind: 'browse', json: true,
      request: { address: 'https://shop.example/', screenshot: expect.stringMatching(/shot\.png$/), fullPage: true, waitFor: '#prices', limits: { timeoutMs: 60_000, maxText: 5000, maxLinks: 0, maxBytes: 50 * 1024 * 1024 } },
    });
    expect(LIMITS.timeout).toEqual({ fallback: 30, min: 5, max: 120 });
  });

  it('refuses a missing address, a second address, an unknown option and a value outside its limit', () => {
    expect(parseArgs([])).toMatchObject({ kind: 'error', message: expect.stringMatching(/one address/) });
    expect(parseArgs(['https://a.example/', 'https://b.example/'])).toMatchObject({ kind: 'error', message: expect.stringMatching(/one address/) });
    expect(parseArgs(['--proxy', 'x', 'https://a.example/'])).toMatchObject({ kind: 'error', message: expect.stringMatching(/--proxy/) });
    expect(parseArgs(['--timeout', '600', 'https://a.example/'])).toMatchObject({ kind: 'error', message: expect.stringMatching(/--timeout[^\n]*5[^\n]*120/) });
    expect(parseArgs(['--max-mb', 'lots', 'https://a.example/'])).toMatchObject({ kind: 'error', message: expect.stringMatching(/--max-mb/) });
    expect(parseArgs(['--screenshot', 'shot.jpg', 'https://a.example/'])).toMatchObject({ kind: 'error', message: expect.stringMatching(/\.png/) });
    expect(parseArgs(['--help'])).toEqual({ kind: 'help' });
  });

  it('prints its help with every limit, and an error with how to call it', async () => {
    const help = await run(['--help']);
    expect(help.code).toBe(0);
    expect(help.out).toBe(USAGE);
    for (const word of ['--screenshot', '--full-page', '--wait-for', '--json', '--timeout', '--max-text', '--max-links', '--max-mb', 'login_required', 'robot_check', 'hh-attach']) expect(USAGE, word).toContain(word);
    const wrong = await run(['--timeout', '0', 'https://a.example/']);
    expect(wrong.code).toBe(2);
    expect(wrong.err).toMatch(/--timeout[\s\S]*Usage: hh-browse/);
    expect(wrong.asked).toEqual([]);
  });

  it('prints the page as text or JSON and exits with the code of its status', async () => {
    const text = await run(['https://shop.example/']);
    expect(text.code).toBe(0);
    expect(text.out).toMatch(/^Status: ok\n[\s\S]*Spring sets are in\.[\s\S]*- Sets: https:\/\/shop\.example\/sets\n$/);
    const json = await run(['--json', 'https://shop.example/']);
    expect(JSON.parse(json.out)).toEqual({ ...read });
    expect((await run(['https://shop.example/'], { status: 'robot_check', reason: 'The page checks that a person is there.' })).code).toBe(0);
    expect((await run(['http://10.0.0.1/'], { status: 'refused', reason: 'a private network address' })).code).toBe(2);
    expect((await run(['https://shop.example/'], { status: 'failed', reason: 'The browser could not start.' })).code).toBe(1);
  });

  it('starts from its launcher, which runs the built command', async () => {
    const launcher = fileURLToPath(new URL('../hh-browse.cjs', import.meta.url));
    const answer = await new Promise<{ code: number | null; out: string }>(resolve => {
      execFile(process.execPath, [launcher, '--help'], (error, out) => resolve({ code: error ? (error.code as number) : 0, out }));
    });
    expect(answer).toEqual({ code: 0, out: USAGE });
  });
});
