import type { ExecFileException } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { answered } from '../src/terminal/mac-peer.js';

/* How execFile ends lsof and ps on a Mac, as Node reports it: the output, with the error it rejects with. */
const ended = (fields: Pick<ExecFileException, 'code' | 'killed' | 'signal'>): ExecFileException => Object.assign(new Error('Command failed'), { killed: false, ...fields });

describe("the macOS owner check's lookup commands", () => {
  it('takes what a command printed when it ended well, or with 1 as lsof does when it finds nothing it was asked about', () => {
    expect(answered(null, 'p55\nn127.0.0.1:1->127.0.0.1:2\n', '/usr/sbin/lsof', '')).toBe('p55\nn127.0.0.1:1->127.0.0.1:2\n');
    expect(answered(ended({ code: 1 }), '', '/usr/sbin/lsof', '')).toBe('');
  });

  it('gives no answer for exit 1 from ps or a diagnostic or incomplete listing from lsof', () => {
    const error = ended({ code: 1 });
    expect(() => answered(error, '', '/bin/ps', '')).toThrow('Command failed');
    expect(() => answered(error, '', '/usr/sbin/lsof', 'lsof: cannot inspect processes')).toThrow('Command failed');
    expect(() => answered(error, 'partial', '/usr/sbin/lsof', '')).toThrow('Command failed');
  });

  it('gives no answer for a command ended at its time limit, one that did not start and one that failed otherwise', () => {
    expect(() => answered(ended({ code: null, killed: true, signal: 'SIGTERM' as const }), '', '/usr/sbin/lsof', '')).toThrow('Command failed');
    expect(() => answered(ended({ code: 1, killed: true, signal: 'SIGTERM' as const }), '', '/usr/sbin/lsof', '')).toThrow('Command failed');
    expect(() => answered(ended({ code: 'ENOENT' }), '', '/usr/sbin/lsof', '')).toThrow('Command failed');
    expect(() => answered(ended({ code: 2 }), 'partial', '/usr/sbin/lsof', '')).toThrow('Command failed');
  });
});
