import { describe, expect, it } from 'vitest';
import { install } from './install-script-helpers.js';

describe('install.sh', () => {

  it('opens the sign-in link in the browser', () => {
    const r = install({ env: { STUB_OS: 'Darwin', STUB_ARCH: 'arm64', STUB_STATUS: 'after_login', STUB_LOGIN_URL: 'https://claude.ai/oauth/authorize?code=1', STUB_LOGIN_UNTIL_LOOKS: '2' } });
    expect(r.code).toBe(0);
    expect(r.calls).toContain('open https://claude.ai/oauth/authorize?code=1');
  });

  it('opens only https sign-in links', () => {
    for (const link of ['file:///etc/passwd', '-a Terminal']) {
      const r = install({ env: { STUB_OS: 'Darwin', STUB_ARCH: 'arm64', STUB_STATUS: 'after_login', STUB_LOGIN_URL: link, STUB_LOGIN_UNTIL_LOOKS: '2' } });
      expect(r.code).toBe(0);
      expect(r.calls.filter(c => c.startsWith('open '))).toEqual([]);
    }
  });
});
