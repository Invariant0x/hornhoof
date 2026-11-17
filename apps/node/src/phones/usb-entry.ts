import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { z } from 'zod';
import { startUsbHost } from './usb-runtime.js';

/* This file is bundled into the exact node image. Only the normal installer starts it. */
const Settings = z.strictObject({ server: z.string().url(), subscriptionId: z.string().min(1), provider: z.string().nullable(), key: z.string().min(16) });

try {
  const config = process.env.HORNHOOF_PHONE_CONFIG ? z.strictObject({ stateFile: z.string(), socket: z.string(), server: z.string(), adb: z.string(), marker: z.string() }).parse(JSON.parse(readFileSync(process.env.HORNHOOF_PHONE_CONFIG, 'utf8'))) : null;
  const state = Settings.parse(JSON.parse(readFileSync(config?.stateFile ?? process.env.HORNHOOF_PHONE_STATE ?? '/node-state/node.json', 'utf8')));
  const installed = config ? readFileSync(config.marker, 'utf8') : null;
  const host = startUsbHost({ state: { ...state, provider: null }, socket: config?.socket ?? process.env.HORNHOOF_PHONE_SOCKET ?? '', server: config?.server ?? process.env.HORNHOOF_PHONE_SERVER ?? state.server, adb: config?.adb ?? process.env.HORNHOOF_PHONE_ADB ?? 'adb', keyDir: config ? join(dirname(config.stateFile), 'android') : '/root/.android' });
  let watch: ReturnType<typeof setInterval> | null = null;
  const stop = () => { if (watch) clearInterval(watch); host.stop(); process.exitCode = 0; };
  if (config) {
    const changed = () => {
      const next = readFileSync(config.marker, 'utf8');
      if (next === 'removed') {
        stop();
        const label = `org.hornhoof.phone.${dirname(config.stateFile).split('/').at(-1)}`;
        if (/^org\.hornhoof\.phone\.hornhoof-[A-Za-z0-9_-]+$/.test(label)) execFile('launchctl', ['bootout', `gui/${process.getuid?.()}/${label}`], () => {});
      } else if (next !== installed) stop();
    };
    watch = setInterval(() => { try { changed(); } catch { stop(); } }, 5000);
    changed();
  }
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
} catch {
  // No exception, request body, key, typed value or adb output is ever printed.
  process.stderr.write('The Hornhoof USB phone bridge could not start.\n');
  process.exitCode = 1;
}
