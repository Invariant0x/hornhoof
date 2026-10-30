/* Small readers shared by the providers' event mappers. Program output is untrusted JSON, so every field is checked. */

export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/* MCP tools arrive as mcp__<server>__<tool>; people see <server>.<tool>. Built-in tools keep their names. */
export function toolName(name: string): string {
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  return mcp ? `${mcp[1]}.${mcp[2]}` : name;
}

/* A tool's input in one line: a shell command as it is, anything else as JSON. A JSON string is read first. */
export function inputText(input: unknown): string {
  let value = input;
  if (typeof input === 'string') {
    try {
      value = JSON.parse(input);
    } catch {
      return input;
    }
  }
  if (isRecord(value) && typeof value.command === 'string') return value.command;
  return JSON.stringify(value) ?? '';
}

/* The text of a message or tool result: a string, or the text parts of a content list. */
export function contentText(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .map(c => (isRecord(c) && typeof c.text === 'string' ? c.text : ''))
    .join('')
    .trim();
}
