import { describe, expect, it } from 'vitest';
import { answered } from '../src/terminal/mac-peer.js';

/* How execFile ends lsof and ps on a Mac, as Node reports it: the output, with the error it rejects with. */
const ended = (fields: { code: number | string | null; killed?: boolean; signal?: string | null }) => Object.assign(new Error('Command failed'), { killed: false, signal: null, ...fields });

describe("the macOS owner check's lookup commands", () => {
  it('takes what a command printed when it ended well, or with 1 as lsof does when it finds nothing it was asked about', () => {
    expect(answered(null, 'p55\nn127.0.0.1:1->127.0.0.1:2\n')).toBe('p55\nn127.0.0.1:1->127.0.0.1:2\n');
    expect(answered(ended({ code: 1 }), '')).toBe('');
  });

  it('gives no answer for a command ended at its time limit, one that did not start and one that failed otherwise', () => {
    expect(() => answered(ended({ code: null, killed: true, signal: 'SIGTERM' }), '')).toThrow('Command failed');
    expect(() => answered(ended({ code: 1, killed: true, signal: 'SIGTERM' }), '')).toThrow('Command failed');
    expect(() => answered(ended({ code: 'ENOENT' }), '')).toThrow('Command failed');
    expect(() => answered(ended({ code: 2 }), 'partial')).toThrow('Command failed');
  });
});
