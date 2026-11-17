import { setTimeout as delay } from 'node:timers/promises';
import { MachineDrain } from '@hornhoof/protocol';
import { z } from 'zod';
import type { Io } from './main.js';
import { readState } from './state.js';

const Answer = z.object({ ready: z.boolean(), drain: MachineDrain, pollAfterMs: z.number().int().positive() })
  .refine(a => a.ready === (a.drain.state === 'restarting'));
const Settings = z.object({ server: z.url({ protocol: /^https?$/ }), key: z.string().min(16).max(200) });
class OldServer extends Error {}

async function settingsFromInput(io: Io): Promise<z.infer<typeof Settings>> {
  let text = '';
  await new Promise<void>((resolve, reject) => {
    io.stdin.on('data', data => {
      text += String(data);
      if (text.length > 2000) reject(new Error('Update input is too long.'));
    });
    io.stdin.on('end', resolve);
    io.stdin.on('error', reject);
  });
  const [server, key] = text.trimEnd().split('\n');
  return Settings.parse({ server, key });
}

async function wait(server: string, key: string, scope: 'node' | 'server', io: Io): Promise<void> {
  let before: string | null = null;
  for (;;) {
    const response = await fetch(`${server.replace(/\/+$/, '')}/api/nodes/update`, {
      method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ scope }), signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 404) throw new OldServer();
    if (!response.ok) throw new Error('Update permission was not granted.');
    const answer = Answer.parse(await response.json());
    if (answer.ready) return;
    const view = answer.drain;
    if (view.state !== before) {
      io.stdout.write(`Node update ${view.state}.\n`);
      before = view.state;
    }
    /* Renew the installer's lease even during a long postponement. */
    await delay(Math.min(answer.pollAfterMs, 30_000));
  }
}

/* A helper from the new image also prepares an old node, which cannot know this command yet. */
export async function updateWaitCommand(dir: string, args: string[], io: Io): Promise<number> {
  try {
    if (args.some(arg => arg !== '--server' && arg !== '--stdin')) throw new Error('Unknown update wait option.');
    const scope = args.includes('--server') ? 'server' : 'node';
    const settings = args.includes('--stdin') ? await settingsFromInput(io) : Settings.parse(scope === 'server'
      ? { server: process.env.HORNHOOF_SERVER, key: process.env.NODE_KEY }
      : readState(dir));
    await wait(settings.server, settings.key, scope, io);
    return 0;
  } catch (err) {
    if (err instanceof OldServer) {
      io.stderr.write('This server does not support waiting for node updates. Update the server app first; the running node was left alone.\n');
      return 3;
    }
    io.stderr.write('Could not prepare this update. The running node was left alone.\n');
    return 1;
  }
}
