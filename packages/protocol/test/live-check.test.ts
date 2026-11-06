import { describe, expect, it } from 'vitest';
import { judgeLiveCheck, LIVE_CHECK_PROGRAMS, liveCheckTag, type LiveCheckBuild, type LiveCheckProof } from '../src/live-check.js';

const COMMIT = 'a'.repeat(40);
const digest = (c: string) => `sha256:${c.repeat(64)}`;
const BUILD: LiveCheckBuild = { commit: COMMIT, version: '0.7.1', digest: digest('1'), node: digest('2'), updater: digest('3'), created: '2026-11-05T20:00:00.000Z' };
const id = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;

const passed = (program: string, n: number) => ({
  program, outcome: 'passed', version: `${program} 1.2.3`, machine: 'check-machine', node: id(n), session: `session-${n}`, job: id(n), instance: id(n), generations: 1,
  asked: '2026-11-05T21:00:00.000Z', recorded: '2026-11-05T21:00:05.000Z', answered: '2026-11-05T21:00:30.000Z', finished: '2026-11-05T21:00:31.000Z',
});

const proof = (over: Partial<Record<keyof LiveCheckProof, unknown>> = {}) => ({
  schema: 1, commit: COMMIT, version: '0.7.1', images: { app: BUILD.digest, node: BUILD.node, updater: BUILD.updater }, checkedAt: '2026-11-05T21:01:00.000Z', evidence: digest('4'),
  programs: LIVE_CHECK_PROGRAMS.map(passed), ...over,
});

describe('a release may reach machines only with the live check of its exact build', () => {
  it('passes all four programs on these exact images', () => {
    expect(judgeLiveCheck(proof(), BUILD)).toEqual({ ok: true });
  });

  it('names the four programs', () => {
    expect([...LIVE_CHECK_PROGRAMS].sort()).toEqual(['antigravity', 'claude', 'codex', 'kimi']);
  });

  it('names one tag for one commit', () => {
    expect(liveCheckTag(COMMIT)).toBe(`live-check-${COMMIT}`);
  });

  it.each([[null], [undefined]])('calls %s missing', raw => {
    expect(judgeLiveCheck(raw, BUILD)).toEqual({ ok: false, reason: 'missing' });
  });

  it.each<[string, unknown]>([
    ['text', 'all good'],
    ['an empty object', {}],
    ['another schema', proof({ schema: 2 })],
    ['a short commit', proof({ commit: 'abc' })],
    ['an unknown field', { ...proof(), trusted: true }],
    ['a date that is no date', proof({ checkedAt: 'yesterday' })],
    ['a passed program without its facts', proof({ programs: [{ program: 'claude', outcome: 'passed' }] })],
    ['a passed program with an unknown field', proof({ programs: LIVE_CHECK_PROGRAMS.map((p, n) => ({ ...passed(p, n), trusted: true })) })],
    ['a program not of the four', proof({ programs: [...LIVE_CHECK_PROGRAMS.map(passed), passed('gemini', 5)] })],
  ])('calls %s invalid', (_name, raw) => {
    expect(judgeLiveCheck(raw, BUILD)).toEqual({ ok: false, reason: 'invalid' });
  });

  it.each<[string, Partial<LiveCheckBuild>]>([
    ['another commit', { commit: 'b'.repeat(40) }],
    ['another version', { version: '0.7.2' }],
    ['another app image', { digest: digest('9') }],
    ['another node image', { node: digest('9') }],
    ['another updater image', { updater: digest('9') }],
    ['a build without its node image', { node: '' }],
    ['a build without its updater image', { updater: '' }],
  ])('calls a proof of %s foreign', (_name, build) => {
    expect(judgeLiveCheck(proof(), { ...BUILD, ...build })).toEqual({ ok: false, reason: 'foreign' });
  });

  it.each(LIVE_CHECK_PROGRAMS)('calls a run without %s partial', program => {
    const programs = LIVE_CHECK_PROGRAMS.filter(p => p !== program).map(passed);
    expect(judgeLiveCheck(proof({ programs }), BUILD)).toEqual({ ok: false, reason: 'partial' });
  });

  it.each(['failed', 'not_run'])('calls a run with one program %s partial', outcome => {
    const programs = [{ program: 'antigravity', outcome, why: 'It did not take the words.' }, ...LIVE_CHECK_PROGRAMS.filter(p => p !== 'antigravity').map(passed)];
    expect(judgeLiveCheck(proof({ programs }), BUILD)).toEqual({ ok: false, reason: 'partial' });
  });

  it('calls one program counted twice partial, with another left out', () => {
    expect(judgeLiveCheck(proof({ programs: [passed('claude', 1), passed('claude', 2), passed('codex', 3), passed('kimi', 4)] }), BUILD)).toEqual({ ok: false, reason: 'partial' });
  });

  it('calls a program run twice invalid, even when both runs passed', () => {
    expect(judgeLiveCheck(proof({ programs: [...LIVE_CHECK_PROGRAMS.map(passed), passed('claude', 5)] }), BUILD)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('calls a passed program whose facts run backwards invalid', () => {
    const programs = LIVE_CHECK_PROGRAMS.map((p, n) => p === 'kimi' ? { ...passed(p, n), finished: '2026-11-05T20:59:00.000Z' } : passed(p, n));
    expect(judgeLiveCheck(proof({ programs }), BUILD)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('calls a run with two programs started for one agent invalid', () => {
    const programs = LIVE_CHECK_PROGRAMS.map((p, n) => p === 'codex' ? { ...passed(p, n), generations: 2 } : passed(p, n));
    expect(judgeLiveCheck(proof({ programs }), BUILD)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('calls a check made before these images existed stale', () => {
    expect(judgeLiveCheck(proof(), { ...BUILD, created: '2026-11-05T21:00:01.000Z' })).toEqual({ ok: false, reason: 'stale' });
  });

  it('calls a build that does not say when it was made stale', () => {
    expect(judgeLiveCheck(proof(), { ...BUILD, created: '' })).toEqual({ ok: false, reason: 'stale' });
  });

  it('calls a check from the future invalid', () => {
    const now = new Date('2026-11-05T20:30:00.000Z');
    expect(judgeLiveCheck(proof(), BUILD, now)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('takes a check from just before the clock of this machine', () => {
    expect(judgeLiveCheck(proof(), BUILD, new Date('2026-11-05T21:00:00.000Z'))).toEqual({ ok: true });
  });
});
