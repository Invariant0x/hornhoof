#!/usr/bin/env node
/* A minimal terminal whose only way to end a turn is the real hh-hook executable, without a transcript fallback. */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { rawKeys, readKeys } from './keys.mjs';
const HOOK = fileURLToPath(new URL('../../hh-hook.cjs', import.meta.url));
const args = process.argv.slice(2);
const session = args[args.indexOf('--session-id') + 1] || 'hook-session';
function hook(event, body) {
  return new Promise(resolve => {
    const child = spawn('node', [HOOK, event, JSON.stringify({ session_id: session, ...body })], { stdio: ['ignore', 'pipe', 'inherit'] });
    child.stdout.resume();child.on('close', resolve);
  });
}
rawKeys();process.stdout.write('fake hook terminal\n❯ ');
await hook('start', {});
let input = '';
readKeys(key => {
  if (key === 'escape') return;
  if (key !== 'enter') { if (typeof key === 'object') { input += key.text;process.stdout.write(key.text); }return; }
  const text = input;input = '';
  void (async () => {
    await hook('prompt', { prompt: text });
    process.stdout.write('Finished the work.\n');
    await hook('stop', { last_assistant_message: 'Delivered by hh-hook.' });
    process.stdout.write('❯ ');
  })();
});
