import { describe, expect, it } from 'vitest';
import { autoSendKind } from '../src/modules/outbound/setup-log.js';

/* What the department's log calls a new policy: turning sending without a yes on or off, or only other numbers. */
describe('a new policy in the department\'s log', () => {
  it('turns sending without a yes on or off, or changes only its limits', () => {
    expect(autoSendKind(false, true)).toBe('auto_send_on');
    expect(autoSendKind(true, false)).toBe('auto_send_off');
    expect(autoSendKind(true, true)).toBe('policy_set');
    expect(autoSendKind(false, false)).toBe('policy_set');
  });
});
