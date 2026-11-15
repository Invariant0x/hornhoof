import { describe, expect, it } from 'vitest';
import { nextSection } from '../src/modules/tools/next-section.js';

const GITHUB_TOKEN = 'ghp_' + 'syntheticNextToken00'.repeat(3);
const HOME = '/home/fixture805/private-project/.env';

describe('the Next section of a report', () => {
  it('is what follows Next: in a report written on one line', () => {
    const report = 'Status: BLOCKED. What changed: nothing. Concerns: the browser suite needs the build. Next: the head gives the Tests stage a machine with the browsers.';
    expect(nextSection(report)).toBe('the head gives the Tests stage a machine with the browsers.');
  });

  it('is the bold Next item of a list, over its lines, up to the next item', () => {
    const report = [
      '- **Status:** BLOCKED',
      '- **What changed:** nothing yet.',
      '- **Next:** the head decides which plan the worker moves to.',
      '  Then the worker runs the checks again.',
      '- **Concerns:** none.',
    ].join('\n');
    expect(nextSection(report)).toBe('the head decides which plan the worker moves to.\n  Then the worker runs the checks again.');
  });

  it('takes **Next**: with the colon outside the bold words', () => {
    expect(nextSection('**Status**: BLOCKED\n**Next**: ask Sales for the price list.')).toBe('ask Sales for the price list.');
  });

  it('is the text under a Next heading, up to the next heading', () => {
    const report = '## Status\nBLOCKED\n\n## Next\nThe CEO connects the payment provider.\n\n## Concerns\nNone.';
    expect(nextSection(report)).toBe('The CEO connects the payment provider.');
  });

  it('is the last Next of a report that has more than one', () => {
    expect(nextSection('Next: an old step.\nStatus: BLOCKED again.\nNext: the new step.')).toBe('the new step.');
  });

  it('is cut to its first 500 characters', () => {
    const next = nextSection(`Next: ${'a'.repeat(800)}`);
    expect(next).toBe('a'.repeat(500));
  });

  it('is the cleaned end of a report that names no Next, nor next in passing', () => {
    const short = 'Status: BLOCKED. I do not know what comes next: the staging database does not answer.';
    expect(nextSection(short)).toBe(short);
    const long = `Status: BLOCKED. ${'x'.repeat(900)} The database does not answer.`;
    expect(nextSection(long)).toBe(long.slice(-500));
  });

  it('is the cleaned end of a report whose Next says nothing', () => {
    expect(nextSection('Status: BLOCKED. The key is missing.\nNext:   ')).toBe('Status: BLOCKED. The key is missing.\nNext:');
  });

  it('hides credentials and private paths in a Next section', () => {
    expect(nextSection(`Status: BLOCKED.\nNext: push with token=${GITHUB_TOKEN} from ${HOME}.`)).toBe('push with token=[hidden] from [hidden]');
  });

  it('cleans a report before it cuts its end, so that no part of a credential is left at the edge', () => {
    /* The last 500 characters of the report as written begin 12 characters before the end of the token. */
    const tail = 'y'.repeat(500 - 12 - 1);
    const report = `Status: BLOCKED. ${'x'.repeat(700)} ${GITHUB_TOKEN} ${tail}`;
    expect(report.slice(-500).startsWith(GITHUB_TOKEN.slice(-12))).toBe(true);
    const next = nextSection(report);
    expect(next).not.toContain(GITHUB_TOKEN.slice(-12));
    expect(next.length).toBe(500);
    expect(next.endsWith(`[hidden] ${tail}`)).toBe(true);
  });
});
