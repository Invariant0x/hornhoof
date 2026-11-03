/* Program updates belong to the node, outside the agent's running session. */
export const CLAUDE_NO_AUTO_UPDATE = { DISABLE_AUTOUPDATER: '1' } as const;
export const KIMI_NO_AUTO_UPDATE = { KIMI_CODE_NO_AUTO_UPDATE: '1', KIMI_CLI_NO_AUTO_UPDATE: '1' } as const;
export const CODEX_NO_AUTO_UPDATE = ['-c', 'check_for_update_on_startup=false'] as const;
