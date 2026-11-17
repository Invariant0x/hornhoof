import { describe, expect, it } from 'vitest';
import { parseNodeMessage, parseServerMessage, ProgramInfo } from '../src/index.js';

describe('managed program snapshots', () => {
  it('accepts an installed version and removes unrelated fields', () => {
    expect(ProgramInfo.parse({ id: 'claude', version: '2.0.0', updating: false, failed: false, output: 'private npm output' }))
      .toEqual({ id: 'claude', version: '2.0.0', updating: false, failed: false });
  });

  it('accepts an unknown version while installation is in progress', () => {
    expect(ProgramInfo.parse({ id: 'kimi', version: null, updating: true, failed: false }))
      .toEqual({ id: 'kimi', version: null, updating: true, failed: false });
  });

  it('says a program that is installed again, or one that still does not start and why', () => {
    expect(ProgramInfo.parse({ id: 'claude', version: '2.0.0', updating: false, failed: false, repair: 'reinstalling' }))
      .toEqual({ id: 'claude', version: '2.0.0', updating: false, failed: false, repair: 'reinstalling' });
    const reason = 'Error: claude native binary not installed.';
    expect(ProgramInfo.parse({ id: 'claude', version: null, updating: false, failed: true, repair: 'broken', reason }))
      .toEqual({ id: 'claude', version: null, updating: false, failed: true, repair: 'broken', reason });
  });

  it.each([
    { id: 'other' }, { version: '' }, { version: 'x'.repeat(65) }, { version: 2 }, { updating: 'yes' }, { failed: null },
    { repair: 'fixed' }, { repair: 'broken', reason: 'x'.repeat(401) },
  ])('rejects invalid program state %j', wrong => {
    expect(ProgramInfo.safeParse({ id: 'codex', version: '1.0.0', updating: false, failed: false, ...wrong }).success).toBe(false);
  });
});


describe('managed program messages', () => {
  const program = { id: 'claude', version: '2.0.0', updating: false, failed: false };
  const messages = [
    { type: 'hello', version: '0.5.0', loggedIn: true, running: [] },
    { type: 'status', loggedIn: true, limits: null },
  ];

  it.each(messages)('keeps older $type messages compatible', message => {
    expect(parseNodeMessage(JSON.stringify(message))).toEqual(message);
  });

  it.each(messages)('carries managed versions in $type', message => {
    const states = [program, { id: 'codex', version: null, updating: true, failed: false }, { id: 'kimi', version: '1.0.0', updating: false, failed: true }];
    expect(parseNodeMessage(JSON.stringify({ ...message, programs: states }))).toEqual({ ...message, programs: states });
    expect(parseNodeMessage(JSON.stringify({ ...message, programs: [] }))).toEqual({ ...message, programs: [] });
  });

  it.each(messages.flatMap(message => [null, 'unknown', [{ ...program, id: 'other' }], [{ ...program, updating: 1 }], [program, program, program, program]]
    .map(programs => ({ message, programs }))))('rejects malformed program lists in $message.type: $programs', ({ message, programs }) => {
    expect(parseNodeMessage(JSON.stringify({ ...message, programs }))).toBeNull();
  });

  it('accepts the node command to update its programs', () => {
    expect(parseServerMessage(JSON.stringify({ type: 'programs.update' }))).toEqual({ type: 'programs.update' });
  });
});
