import { createHmac } from 'node:crypto';
import type { AssistantEventKind, AssistantProgram } from '../../db/schema.js';

/* How Hornhoof reaches each program an assistant runs: a wake in the program's own form, and the settings that connect the
   program to Hornhoof, which the person puts into it once. OpenClaw and Hermes Agent take Hornhoof's tools over MCP and
   are woken at their own webhooks; compatible programs take the wake docs/assistant-api.md describes. */

const hex = (secret: string, text: string) => createHmac('sha256', secret).update(text).digest('hex');

/* What a wake is signed with for compatible programs: HMAC-SHA256 of the exact body under the signing secret. */
export const signature = (secret: string, body: string): string => `sha256=${hex(secret, body)}`;

/* A wake of OpenClaw or Hermes starts a turn of the program's model, which costs and may write to the owner. So an event
   wakes them on its own only when it is worth a turn: an answer that is over, or a request that came to wait for the owner.
   A word of an answer still going on, or a request that waits no more, waits for the next wake. */
export const wakesModel = (program: AssistantProgram): boolean => program === 'openclaw' || program === 'hermes';
export const WORTH_A_TURN: ReadonlySet<AssistantEventKind> = new Set(['reply_end', 'request']);

/* What the model reads when it is woken, with the number to read after, or the template's place for it. */
const wakeWords = (after: string) =>
  `New events wait for you in Hornhoof after number ${after}. Read them with the Hornhoof tool read_events, with after ${after}, and tell your owner what they need to know.`;

/* A wake as the assistant's program takes it. OpenClaw: its wake hook, with the signing secret as the hook's token.
   Hermes: its webhook, signed as its generic V2 signature, with an id the same on every try, so it runs a wake once. */
export function wakeRequest(program: AssistantProgram, wake: { assistantId: string; after: number; secret: string; now: number }): { headers: Record<string, string>; body: string } {
  const json = { 'content-type': 'application/json' };
  if (program === 'openclaw') return { headers: { ...json, authorization: `Bearer ${wake.secret}` }, body: JSON.stringify({ text: wakeWords(String(wake.after)), mode: 'now' }) };
  const body = JSON.stringify({ type: 'wake', after: wake.after });
  if (program !== 'hermes') return { headers: { ...json, 'x-hornhoof-signature': signature(wake.secret, body) }, body };
  const stamp = String(Math.floor(wake.now / 1000));
  return { headers: { ...json, 'x-webhook-timestamp': stamp, 'x-webhook-signature-v2': hex(wake.secret, `${stamp}.${body}`), 'x-request-id': `hornhoof-${wake.assistantId}-${wake.after}` }, body };
}

/* The settings that connect the program, as the person puts them into its own file: Hornhoof's MCP server with the key,
   and, when Hornhoof wakes it, the webhook that takes the wake with the signing secret. Words in JSON quotes, which both
   JSON5 and YAML read as they are. Null for a program that takes the address and the key in its own way. */
export function settingsFor(program: AssistantProgram, to: { address: string; key: string; secret: string; woken: boolean }): { file: string; text: string } | null {
  const q = JSON.stringify;
  const mcp = `${to.address.replace(/\/+$/, '')}/api/assistant/mcp`;
  const bearer = `Bearer ${to.key}`;
  if (program === 'openclaw') {
    const hooks = to.woken ? ['  hooks: {', '    enabled: true,', `    token: ${q(to.secret)},`, '  },'] : [];
    const text = ['{', '  mcp: {', '    servers: {', '      hornhoof: {', `        url: ${q(mcp)},`, '        transport: "streamable-http",', `        headers: { Authorization: ${q(bearer)} },`, '      },', '    },', '  },', ...hooks, '}'];
    return { file: '~/.openclaw/openclaw.json', text: text.join('\n') };
  }
  if (program === 'hermes') {
    const webhook = to.woken
      ? ['platforms:', '  webhook:', '    enabled: true', '    extra:', '      routes:', '        hornhoof:', `          secret: ${q(to.secret)}`, `          prompt: ${q(wakeWords('{after}'))}`, '          deliver: telegram', '          mirror_to_session: true']
      : [];
    const text = ['mcp_servers:', '  hornhoof:', `    url: ${q(mcp)}`, '    headers:', `      Authorization: ${q(bearer)}`, ...webhook];
    return { file: '~/.hermes/config.yaml', text: text.join('\n') };
  }
  return null;
}
