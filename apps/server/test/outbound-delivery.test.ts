import { describe, expect, it } from 'vitest';
import { acceptedWith, definitelyNot, isOneAddress, isSendable, isTlsFailure, unknownOutcome } from '../src/modules/outbound/delivery.js';

const payload = (over: object = {}) => ({ recipient: 'ann@example.com', subject: 'Hello', text: 'One line\r\nand another\twith a tab', ...over }) as never;

describe('what may be sent', () => {
  it('takes one plain address and leaves out what a person could not read as one', () => {
    expect(isOneAddress("ann.o'neil+x@mail.example.com")).toBe(true);
    for (const value of ['ann@example', 'ann', 'a@b.com, c@d.com', 'ann@example.com\nBcc: x@y.com', '']) expect(isOneAddress(value), value).toBe(false);
  });

  it('holds an address to the longest a mail server takes', () => {
    const local = 'a'.repeat(242);
    expect(isOneAddress(`${local}@example.com`)).toBe(true);
    expect(isOneAddress(`${local}a@example.com`)).toBe(false);
  });

  it('sends a well-formed message under a plain attempt id', () => {
    expect(isSendable('attempt-1', payload())).toBe(true);
  });

  it.each([
    ['an attempt id with other characters', 'attempt 1', {}],
    ['an attempt id too long', 'a'.repeat(129), {}],
    ['no attempt id', '', {}],
    ['a bad address', 'attempt-1', { recipient: 'ann' }],
    ['a subject of two lines', 'attempt-1', { subject: 'Hello\nBcc: x@y.com' }],
    ['a subject with a line separator', 'attempt-1', { subject: 'Hello there' }],
    ['a subject that is not well formed', 'attempt-1', { subject: 'Hello\ud800' }],
    ['no text', 'attempt-1', { text: '' }],
    ['text with a control character', 'attempt-1', { text: 'Hello\u0007' }],
    ['text with a lone carriage return', 'attempt-1', { text: 'Hello\rthere' }],
    ['text that is not well formed', 'attempt-1', { text: 'Hello\ud800' }],
  ])('refuses %s before any connection', (_why, attempt, over) => {
    expect(isSendable(attempt, payload(over))).toBe(false);
  });

  it('takes the longest attempt id', () => {
    expect(isSendable('a'.repeat(128), payload())).toBe(true);
  });
});

describe('what came back', () => {
  it('keeps a receipt from outside as one short line', () => {
    const outcome = acceptedWith(`  queued\r\nas one\u0007 ${'x'.repeat(600)}`);
    if (outcome.kind !== 'accepted') throw new Error('It was accepted.');
    expect(outcome.providerReceipt.startsWith('queued as one x')).toBe(true);
    expect(outcome.providerReceipt).toHaveLength(512);
  });

  it('says when it was accepted', () => {
    const before = Date.now(), outcome = acceptedWith('id');
    if (outcome.kind !== 'accepted') throw new Error('It was accepted.');
    expect(Date.parse(outcome.acceptedAt)).toBeGreaterThanOrEqual(before);
  });

  it('tells a refusal from an outcome nobody knows', () => {
    expect(definitelyNot('refused' as never)).toEqual({ kind: 'definitely_not_accepted', safeCode: 'refused' });
    expect(unknownOutcome('refused' as never)).toEqual({ kind: 'unknown', safeCode: 'refused' });
  });

  it('knows a certificate failure by its code', () => {
    for (const code of ['CERT_HAS_EXPIRED', 'ERR_SSL_WRONG_VERSION', 'ERR_TLS_CERT_ALTNAME_INVALID', 'UNABLE_TO_GET_ISSUER_CERT', 'SIGNATURE_FAILURE']) expect(isTlsFailure(code), code).toBe(true);
    for (const code of ['ECONNREFUSED', undefined]) expect(isTlsFailure(code)).toBe(false);
  });
});
