/* What Hornhoof answered when agents' programs connected to its tools: to initialize, by the protocol version the program
   asked for, and each agent's list of its tools. Hornhoof answers only during a turn, and an MCP client that cannot
   connect keeps no tools for the rest of its session, so a program that connects or lists its tools with no turn open
   gets the answer Hornhoof gave to the same question before. Its tool calls still wait for a turn. */
export class ToolsMemory {
  private readonly greetings = new Map<string, unknown>();
  private readonly lists = new Map<string, unknown>();

  /* Keeps Hornhoof's answer to a program's initialize or tools/list. */
  keep(key: string, asked: Buffer, answer: Buffer): void {
    const msg = single(asked);
    const result = resultOf(answer);
    if (!msg || result === undefined) return;
    if (msg.method === 'initialize') this.greetings.set(versionOf(msg), result);
    if (whole(msg)) this.lists.set(key, result);
  }

  /* The node's own answer to what a program sends as it connects: '' to a notification, which wants none, or null when the
     node has nothing to say. */
  answer(key: string, asked: Buffer): string | null {
    const msg = single(asked);
    if (msg?.method === 'notifications/initialized') return '';
    if (!msg || msg.id === undefined || msg.id === null) return null;
    const result = msg.method === 'ping' ? {} : msg.method === 'initialize' ? this.greetings.get(versionOf(msg)) : whole(msg) ? this.lists.get(key) : undefined;
    return result === undefined ? null : JSON.stringify({ jsonrpc: '2.0', id: msg.id, result });
  }
}

type Message = { id?: unknown; method?: unknown; params?: { protocolVersion?: unknown; cursor?: unknown } };

/* One JSON-RPC message, not a batch. */
function single(body: Buffer): Message | null {
  try {
    const msg: unknown = JSON.parse(body.toString('utf8'));
    return msg && typeof msg === 'object' && !Array.isArray(msg) ? (msg as Message) : null;
  } catch {
    return null;
  }
}

const resultOf = (answer: Buffer): unknown => (single(answer) as { result?: unknown } | null)?.result;

const versionOf = (msg: Message) => String(msg.params?.protocolVersion ?? '');
/* The whole list of an agent's tools: Hornhoof lists them on one page. */
const whole = (msg: Message) => msg.method === 'tools/list' && msg.params?.cursor === undefined;
