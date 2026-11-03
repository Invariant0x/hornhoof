import { describe, expect, it } from 'vitest';
import { agyError } from '../src/terminal/transcripts.js';

describe('Antigravity native failure diagnostics', () => {
  it('reads stderr after the terminal prompt without changing the retryable flag', () => {
    expect(agyError('prompt> AGY_ERROR: {"short_error":"overloaded","retryable":false}\n', 'overloaded')).toEqual({ short_error: 'overloaded', retryable: false });
  });

  it.each(['AGY_ERROR: {', 'AGY_ERROR: null', 'AGY_ERROR: {"short_error":"network","retryable":true}'])('keeps the Stop reason when the latest diagnostic is %s', latest => {
    expect(agyError(`AGY_ERROR: {"short_error":"overloaded","retryable":false}\n${latest}\n`, 'overloaded')).toBeNull();
  });

  it('leaves a failure without a diagnostic to its Stop hook', () => {
    expect(agyError('A tool failed.\n', 'overloaded')).toBeNull();
  });
  it('reads a valid failure without requiring a surviving Stop hook', () => {
    expect(agyError('AGY_ERROR: {"short_error":"overloaded","retryable":false}\n', undefined)).toEqual({ short_error: 'overloaded', retryable: false });
    expect(agyError('AGY_ERROR: {"short_error":42,"retryable":false}\n', undefined)).toBeNull();
  });

});
