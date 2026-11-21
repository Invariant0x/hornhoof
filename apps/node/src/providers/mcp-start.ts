/* How long a program waits for Hornhoof's tools to connect as it starts. Claude Code, Codex and Kimi Code give up on an MCP
   server after 30 seconds by default, and the session then has no Hornhoof tools at all, while a busy machine or server can
   answer later than that. Antigravity waits five minutes already. One value for every machine, which its power does not
   change. */
export const MCP_START_MS = 120_000;

/* Claude Code reads its limit in milliseconds from MCP_TIMEOUT. One the node itself was started with is its owner's, and the
   program gets that from the node's environment instead. */
export function claudeMcpStart(inherited: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return inherited.MCP_TIMEOUT ? {} : { MCP_TIMEOUT: String(MCP_START_MS) };
}

/* Codex reads it in seconds from the server's startup_timeout_sec. */
export const CODEX_MCP_START = ['-c', `mcp_servers.hornhoof.startup_timeout_sec=${MCP_START_MS / 1000}`];

/* Kimi Code reads it in milliseconds from the server's startupTimeoutMs in mcp.json. */
export const KIMI_MCP_START = { startupTimeoutMs: MCP_START_MS } as const;
