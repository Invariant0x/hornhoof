#!/usr/bin/env node
// Stand of #428, a fake program, not a real CLI: plays Claude Code's queue around the end of a turn, shows what is typed and runs hh-fetch as an agent would.
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { claudePasted, claudeQueue } from './word-receipts.mjs';
import { rawKeys, readKeys } from './keys.mjs';
rawKeys();
const args = process.argv.slice(2);
const flag = name => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const session = flag('--session-id') ?? flag('--resume') ?? 'none';
const home = process.env.CLAUDE_CONFIG_DIR ?? '/tmp';
const log = join(home, 'projects', process.cwd().replace(/[^A-Za-z0-9]/g, '-'), `${session}.jsonl`);
mkdirSync(dirname(log), { recursive: true });
const write = line => appendFileSync(log, JSON.stringify(line) + '\n');
const hook = (event, body) => fetch(`${process.env.HH_BRIDGE}/${event}`, { method: 'POST', body: JSON.stringify({ session_id: session, ...body }) }).then(r => r.text()).catch(() => '');
const { url } = JSON.parse(flag('--mcp-config')).mcpServers.hornhoof;
const tool = async () => {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'database', arguments: { sql: 'select 1' } } }) });
  return `${r.status} ${(await r.text()).slice(0, 400).replace(/\s+/g, ' ')}`;
};
process.stdout.write(`fake claude\n❯ `);
await hook('start', {});
await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'tools/list' }) }).then(r => r.text()).catch(() => '');
let busy = false;
const queued = [];
let input = '';
const HH_FETCH = fileURLToPath(new URL('../../hh-fetch.cjs', import.meta.url));
/* What the agent does with the line Hornhoof inserted for a picture: runs its command and opens the file it prints. */
const fetched = line => {
  const id = /hh-fetch message ([0-9a-f-]{36})/.exec(line)?.[1];
  if (!id) return null;
  try {
    const path = execFileSync(process.execPath, [HH_FETCH, 'message', id], { encoding: 'utf8' }).trim();
    return { path, base64: readFileSync(path).toString('base64') };
  } catch (error) {
    return { error: String(error.stderr ?? error.message).slice(0, 300) };
  }
};
const answer = async line => {
  busy = true;
  await hook('prompt', { prompt: line });
  write({ type: 'user', message: { role: 'user', content: line } });
  if (line.includes('SLOW')) await new Promise(r => setTimeout(r, 2500));
  const result = await tool();
  appendFileSync(process.env.STAND_OUT, `${JSON.stringify({ line, result, fetched: fetched(line) })}\n`);
  const text = `answered: ${line}`;
  write({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
  process.stdout.write(`\r\n${text}\r\n❯ `);
  await hook('stop', { last_assistant_message: text, transcript_path: log });
  write({ type: 'system', subtype: 'turn_duration', durationMs: 1 });
  busy = false;
  const next = queued.shift();
  if (next) {
    write(claudeQueue('dequeue', next));
    await answer(next);
  }
};
const OUT = `${process.env.STAND_OUT}.keys`;
const show = () => process.stdout.write(`\r\x1b[2K❯ ${input}`);
readKeys(key => {
  if (key === 'escape') appendFileSync(OUT, 'ESC\n');
  if (key === 'kill') { input = ''; show(); return; }
  if (key === 'erase') { input = input.slice(0, -1); show(); return; }
  if (key !== 'enter') { input += key.text ?? ''; show(); return; }
  const said = input;
  input = '';
  show();
  if (!said) return;
  /* Words over several lines go in Claude's paste wrapper, in its queue and in what it takes. */
  const line = said.includes('\n') ? claudePasted(said) : said;
  write(claudeQueue('enqueue', line));
  if (busy) { queued.push(line); return; }
  write(claudeQueue('dequeue', line));
  void answer(line);
});
setInterval(() => {}, 1000);
