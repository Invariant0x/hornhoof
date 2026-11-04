import { afterEach, describe, expect, it, vi } from 'vitest';
import { childEnv } from '../src/providers/process.js';

/* Independent examples of machine settings that must not select an agent's account, model or context. */
const MACHINE_SETTINGS = [
  'NODE_KEY', 'NODE_ENV', 'HORNHOOF_DATA',
  'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_AUTO_COMPACT_WINDOW', 'CLAUDE_CODE_EFFORT_LEVEL', 'CLAUDE_CODE_SUBAGENT_MODEL',
  'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_OAUTH_REFRESH_TOKEN', 'CLAUDE_CODE_OAUTH_SCOPES', 'CLAUDE_CODE_USE_ANTHROPIC_AWS', 'CLAUDE_CODE_USE_MANTLE',
  'ANTHROPIC_PROFILE', 'ANTHROPIC_DEFAULT_MODEL', 'ANTHROPIC_FEDERATION_RULE_ID', 'ANTHROPIC_ORGANIZATION_ID',
  'ANTHROPIC_DEFAULT_FABLE_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL_FORCE', 'CLAUDE_CODE_SIMPLE',
  'DISABLE_AUTO_COMPACT', 'DISABLE_COMPACT', 'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE', 'CLAUDE_CODE_DISABLE_1M_CONTEXT',
  'CLAUDE_CODE_MAX_CONTEXT_TOKENS', 'CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT', 'CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS',
  'MAX_THINKING_TOKENS', 'CLAUDE_CODE_DISABLE_THINKING', 'CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING',
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_CUSTOM_HEADERS', 'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL',
  'API_TIMEOUT_MS', 'CODEX_HOME', 'CODEX_SQLITE_HOME', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN', 'OPENAI_API_KEY', 'OPENAI_BASE_URL',
  'KIMI_CODE_HOME', 'KIMI_CODE_BASE_URL', 'KIMI_CODE_OAUTH_HOST', 'KIMI_OAUTH_HOST', 'KIMI_CODE_CUSTOM_HEADERS',
  'KIMI_MODEL_NAME', 'KIMI_MODEL_API_KEY', 'KIMI_MODEL_PROVIDER_TYPE', 'KIMI_MODEL_BASE_URL', 'KIMI_MODEL_MAX_CONTEXT_SIZE',
  'KIMI_MODEL_CAPABILITIES', 'KIMI_MODEL_DISPLAY_NAME', 'KIMI_MODEL_MAX_OUTPUT_SIZE', 'KIMI_MODEL_REASONING_KEY',
  'KIMI_MODEL_THINKING_EFFORT', 'KIMI_MODEL_ADAPTIVE_THINKING',
  'AGY_ADC_AUTH', 'GEMINI_API_KEY', 'GOOGLE_GEMINI_BASE_URL',
];

afterEach(() => vi.unstubAllEnvs());

describe('the environment inherited by agent programs', () => {
  it.each(MACHINE_SETTINGS)('does not inherit %s from the machine', key => {
    vi.stubEnv(key, 'machine-setting');
    expect(childEnv('/tools', {})[key]).toBeUndefined();
  });

  it('keeps operating-system paths, proxies, certificates and unrelated program settings', () => {
    const kept = {
      HOME: '/machine/home', PATH: '/machine/bin', TMPDIR: '/machine/tmp', LANG: 'en_US.UTF-8',
      HTTPS_PROXY: 'http://proxy.test:8080', HTTP_PROXY: 'http://proxy.test:8080', NO_PROXY: 'localhost',
      SSL_CERT_FILE: '/machine/ca.pem', NODE_EXTRA_CA_CERTS: '/machine/ca.pem', CODEX_CA_CERTIFICATE: '/machine/ca.pem',
      KIMI_DISABLE_TELEMETRY: '1', UNRELATED_CONFIG: '/machine/unrelated',
    };
    for (const [key, value] of Object.entries(kept)) vi.stubEnv(key, value);
    expect(childEnv('/tools', {})).toMatchObject({ ...kept, PATH: '/tools/bin:/machine/bin' });
  });

  it('keeps the fallback executable path when the machine has none', () => {
    vi.stubEnv('PATH', undefined);
    expect(childEnv('/tools', {}).PATH).toBe('/tools/bin:/usr/local/bin:/usr/bin:/bin');
  });

  it('applies the account and settings chosen by Hornhoof after removing machine values', () => {
    const chosen = {
      CLAUDE_CONFIG_DIR: '/plan/claude', CLAUDE_CODE_OAUTH_TOKEN: 'plan-test-token',
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: '500000', ANTHROPIC_API_KEY: 'company-test-key', ANTHROPIC_AUTH_TOKEN: 'glm-test-key',
      ANTHROPIC_BASE_URL: 'https://company.test', API_TIMEOUT_MS: '3000000',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'GLM-5', ANTHROPIC_DEFAULT_SONNET_MODEL: 'GLM-5', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'GLM-4.7-Flash',
      CODEX_HOME: '/plan/codex', CODEX_API_KEY: 'job-test-key',
      KIMI_CODE_HOME: '/plan/kimi', KIMI_MODEL_THINKING_EFFORT: 'max', HOME: '/plan/home',
    };
    for (const key of Object.keys(chosen)) vi.stubEnv(key, 'machine-setting');
    expect(childEnv('/tools', chosen)).toMatchObject(chosen);
  });

  it("points Playwright at the node's persistent browsers folder and disables cache garbage collection", () => {
    vi.stubEnv('PLAYWRIGHT_BROWSERS_PATH', '/opt/ms-playwright');
    expect(childEnv('/data/tools', {})).toMatchObject({
      PLAYWRIGHT_BROWSERS_PATH: '/data/browsers',
      PLAYWRIGHT_SKIP_BROWSER_GC: '1',
    });
  });
});
