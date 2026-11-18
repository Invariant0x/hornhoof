import type { ExecFileException } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { answered } from '../src/terminal/mac-peer.js';

/* How execFile ends lsof and ps on a Mac, as Node reports it: the output, with the error it rejects with. */
const ended = (fields: Pick<ExecFileException, 'code' | 'killed' | 'signal'>): ExecFileException => Object.assign(new Error('Command failed'), { killed: false, ...fields });

describe("the macOS owner check's lookup commands", () => {
  it('takes what a command printed when it ended well, or what lsof printed when it ended with 1 as it does finding nothing it was asked about', () => {
    expect(answered('/usr/sbin/lsof', null, 'p55\nn127.0.0.1:1->127.0.0.1:2\n')).toBe('p55\nn127.0.0.1:1->127.0.0.1:2\n');
    expect(answered('/bin/ps', null, '   55    10\n')).toBe('   55    10\n');
    expect(answered('/usr/sbin/lsof', ended({ code: 1 }), '')).toBe('');
  });

  it('gives no answer for a command ended at its time limit, one that did not start, one that failed otherwise and ps ending with 1', () => {
    expect(() => answered('/usr/sbin/lsof', ended({ code: null, killed: true, signal: 'SIGTERM' as const }), '')).toThrow('Command failed');
    expect(() => answered('/usr/sbin/lsof', ended({ code: 1, killed: true, signal: 'SIGTERM' as const }), '')).toThrow('Command failed');
    expect(() => answered('/usr/sbin/lsof', ended({ code: 'ENOENT' }), '')).toThrow('Command failed');
    expect(() => answered('/usr/sbin/lsof', ended({ code: 2 }), 'partial')).toThrow('Command failed');
    expect(() => answered('/bin/ps', ended({ code: 1 }), '')).toThrow('Command failed');
  });
});
