# Agent environment audit

Reviewed on 2026-11-03. `src/agent-env.ts` in the node defines the shared inheritance policy. `childEnv` applies it before adding Hornhoof's account settings. Tmux also resets these named settings before loading the private per-agent environment file, including when its server survived a node restart. Existing agent processes are unaffected until restarted.

## Removed from the machine environment

| Program | Variables | Reason |
| --- | --- | --- |
| Node | `NODE_KEY` | Keep the node authentication key private. |
| Node | `NODE_ENV` | Let repository installs include development dependencies. |
| Node | `HORNHOOF_*` | Keep node settings and secrets private. |
| Claude | `CLAUDE_CONFIG_DIR` | Use Hornhoof's plan home. |
| Claude | `CLAUDE_CODE_OAUTH_TOKEN` | Use Hornhoof's subscription token. |
| Claude | `CLAUDE_CODE_OAUTH_REFRESH_TOKEN` | Do not sign in through a machine refresh token. |
| Claude | `CLAUDE_CODE_OAUTH_SCOPES` | Do not inherit machine refresh-login scopes. |
| Claude | `ANTHROPIC_PROFILE` | Do not select a machine Anthropic profile. |
| Claude | `ANTHROPIC_FEDERATION_RULE_ID` | Do not select federation instead of the Hornhoof login. |
| Claude | `ANTHROPIC_ORGANIZATION_ID` | Do not select a machine federation organization. |
| Claude | `CLAUDE_CODE_AUTO_COMPACT_WINDOW` | Use the agent's compact window or the program default. |
| Claude | `CLAUDE_CODE_EFFORT_LEVEL` | Do not override the agent's effort flag. |
| Claude | `CLAUDE_CODE_SUBAGENT_MODEL` | Do not replace the agent configuration with a machine model. |
| Claude | `ANTHROPIC_MODEL` | Do not replace the default model with a machine model. |
| Claude | `ANTHROPIC_DEFAULT_MODEL` | Do not change the model new agent sessions start on. |
| Claude | `ANTHROPIC_DEFAULT_OPUS_MODEL` | Keep the selected model alias independent of machine remapping. |
| Claude | `ANTHROPIC_DEFAULT_SONNET_MODEL` | Keep the selected model alias independent of machine remapping. |
| Claude | `ANTHROPIC_DEFAULT_HAIKU_MODEL` | Keep the selected model alias independent of machine remapping. |
| Claude | `ANTHROPIC_SMALL_FAST_MODEL` | Do not redirect legacy background-model selection. |
| Claude | `ANTHROPIC_DEFAULT_FABLE_MODEL` | Keep the selected model alias independent of machine remapping. |
| Claude | `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` | Do not force machine model selection on subagents. |
| Claude | `MAX_THINKING_TOKENS` | Keep model aliases and reasoning independent of the machine. |
| Claude | `CLAUDE_CODE_DISABLE_THINKING` | Keep model aliases and reasoning independent of the machine. |
| Claude | `CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING` | Keep model aliases and reasoning independent of the machine. |
| Claude | `DISABLE_AUTO_COMPACT` | Keep the compaction policy and context limit independent of the machine. |
| Claude | `DISABLE_COMPACT` | Keep the compaction policy and context limit independent of the machine. |
| Claude | `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` | Keep the compaction policy and context limit independent of the machine. |
| Claude | `CLAUDE_CODE_DISABLE_1M_CONTEXT` | Keep the compaction policy and context limit independent of the machine. |
| Claude | `CLAUDE_CODE_MAX_CONTEXT_TOKENS` | Keep the compaction policy and context limit independent of the machine. |
| Claude | `CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT` | Keep the compaction policy and context limit independent of the machine. |
| Claude | `CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS` | Keep the compaction policy and context limit independent of the machine. |
| Claude | `CLAUDE_CODE_SIMPLE` | Keep plan authentication, hooks and skills available. |
| Claude | `ANTHROPIC_API_KEY` | Do not substitute a machine API key for the plan or job key. |
| Claude | `ANTHROPIC_AUTH_TOKEN` | Use Hornhoof's GLM token or plan login. |
| Claude | `ANTHROPIC_BASE_URL` | Use Hornhoof's GLM endpoint or the program default. |
| Claude | `ANTHROPIC_CUSTOM_HEADERS` | Do not replace authentication or routing through machine headers. |
| Claude | `CLAUDE_CODE_USE_BEDROCK` | Do not switch the configured subscription to another provider. |
| Claude | `CLAUDE_CODE_USE_VERTEX` | Do not switch the configured subscription to another provider. |
| Claude | `CLAUDE_CODE_USE_FOUNDRY` | Do not switch the configured subscription to another provider. |
| Claude | `CLAUDE_CODE_USE_ANTHROPIC_AWS` | Do not switch the configured subscription to another provider. |
| Claude | `CLAUDE_CODE_USE_MANTLE` | Do not switch the configured subscription to another provider. |
| Claude | `API_TIMEOUT_MS` | Use Hornhoof's GLM timeout or the program default. |
| Codex | `CODEX_HOME` | Use Hornhoof's Codex plan home. |
| Codex | `CODEX_SQLITE_HOME` | Keep Codex state in the plan's home. |
| Codex | `CODEX_API_KEY` | Use the job's API key or plan sign-in. |
| Codex | `CODEX_ACCESS_TOKEN` | Use the plan's sign-in rather than a machine access token. |
| Codex | `OPENAI_API_KEY` | Do not substitute machine OpenAI credentials. |
| Codex | `OPENAI_BASE_URL` | Do not redirect the OpenAI endpoint from the machine. |
| Kimi | `KIMI_CODE_HOME` | Use Hornhoof's Kimi plan home. |
| Kimi | `KIMI_CODE_BASE_URL` | Use the plan's service endpoint for the agent program. |
| Kimi | `KIMI_CODE_OAUTH_HOST` | Do not redirect plan login to a machine OAuth host. |
| Kimi | `KIMI_OAUTH_HOST` | Do not redirect plan login through the fallback OAuth host. |
| Kimi | `KIMI_CODE_CUSTOM_HEADERS` | Do not override request authentication or routing. |
| Kimi | `KIMI_MODEL_NAME` | Prevent a temporary machine model from overriding the agent. |
| Kimi | `KIMI_MODEL_API_KEY` | Prevent a temporary machine model from overriding the agent. |
| Kimi | `KIMI_MODEL_PROVIDER_TYPE` | Prevent a temporary machine model from overriding the agent. |
| Kimi | `KIMI_MODEL_BASE_URL` | Prevent a temporary machine model from overriding the agent. |
| Kimi | `KIMI_MODEL_MAX_CONTEXT_SIZE` | Prevent a temporary machine model from overriding the agent. |
| Kimi | `KIMI_MODEL_CAPABILITIES` | Prevent a temporary machine model from overriding the agent. |
| Kimi | `KIMI_MODEL_DISPLAY_NAME` | Prevent a temporary machine model from overriding the agent. |
| Kimi | `KIMI_MODEL_MAX_OUTPUT_SIZE` | Prevent a temporary machine model from overriding the agent. |
| Kimi | `KIMI_MODEL_REASONING_KEY` | Prevent a temporary machine model from overriding the agent. |
| Kimi | `KIMI_MODEL_THINKING_EFFORT` | Use the agent's effort or the program default. |
| Kimi | `KIMI_MODEL_ADAPTIVE_THINKING` | Prevent a temporary machine model from overriding the agent. |
| Antigravity | `AGY_ADC_AUTH` | Use the Hornhoof plan rather than machine ADC sign-in. |
| Antigravity | `GEMINI_API_KEY` | Do not substitute a machine Gemini credential. |
| Antigravity | `GOOGLE_GEMINI_BASE_URL` | Do not redirect agent requests to a machine endpoint. |

Explicit per-agent values are applied after filtering, so Hornhoof's compact window, API keys, GLM settings and Kimi effort still reach the program. No credential values were inspected during this audit.

## Retained

Operating-system settings remain available: `PATH` (with tools first), `HOME` (unless the provider supplies its own), temporary directories, locale, proxies, certificate paths, and unrelated developer tools' settings. `CODEX_CA_CERTIFICATE` is a transport trust setting, not an account selector. Telemetry preferences such as `KIMI_DISABLE_TELEMETRY` remain available. Auto-update policy is not part of this list.

`CLAUDE_CODE_MAX_OUTPUT_TOKENS` remains available because Hornhoof does not manage an output-token cap. It can indirectly affect the room left before compaction; this is an audit concern. Display/capability metadata and inactive cloud-specific settings were also left alone.

Unknown `*_CONFIG` names are not removed as a family. The checked node provider and terminal code uses the explicit homes listed above; no additional generic `*_CONFIG` reader was identified. Arbitrary configuration-selected credential names (`env_key`, `api_key_env`, for example the documented `AZURE_OPENAI_API_KEY`) remain available. `KIMI_API_KEY` and `KIMI_BASE_URL` are config-file key names rather than automatic shell overrides in current Kimi. Workload identity variables (`OPENAI_IDENTITY_TOKEN_FILE`, `OPENAI_FEDERATION_RULE_ID`) and general SDK settings such as `GOOGLE_APPLICATION_CREDENTIALS` were left alone because Hornhoof does not configure these integrations.

The node's own `kimiPlanLimits` still reads the machine's `KIMI_CODE_BASE_URL`, as approved by the head of development. The Kimi token is sent to that address. This is separate from the environment inherited by an agent.

## Compatibility and release concern

Hornhoof does not set any of the 21 additional Claude variables found during review. Their only production references are the new policy; the agent values it does set (plan home, OAuth token, API/GLM credentials, model aliases and compact window) are explicitly tested after hostile machine values.

Machines relying on environment-only Bedrock, Mantle, Vertex, Foundry, Anthropic AWS, federation or Anthropic profiles will lose those overrides. Environment-only API keys/endpoints and model/context overrides for other programs are also removed. If a working agent depends on them instead of a configured Hornhoof subscription, its sign-in or launch may fail after release. Actual deployed machine environments were not inspected, so the presence of such agents is unknown. This compatibility decision must reach the CEO before release.

## Sources

- [Claude environment reference](https://code.claude.com/docs/en/env-vars): credentials, context, models and routing overrides.
- [Claude model configuration](https://code.claude.com/docs/en/model-config): context limits and compaction.
- [Claude subagent configuration](https://code.claude.com/docs/en/sub-agents): forced subagent model selection.
- [Codex environment reference](https://learn.chatgpt.com/docs/config-file/environment-variables): state paths, credentials, certificate and workload identity settings.
- [Kimi environment reference](https://www.kimi.com/code/docs/en/kimi-code-cli/configuration/env-vars): model overrides, config key names and OAuth endpoints.
- [Antigravity authentication reference](https://antigravity.google/docs/install?tab=cli): account, API key, ADC and endpoint choices.

The regression tests use fake settings and a real tmux server. They check omitted and explicit compact windows, inherited settings, stale server settings, and retained operating-system settings.
