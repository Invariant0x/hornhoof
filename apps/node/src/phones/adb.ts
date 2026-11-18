import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PhoneOperation, PhoneSerial, networkEndpoint, type PhoneDevice, type PhoneReadinessIssue } from '@hornhoof/protocol';
import { readReadiness, readinessScript } from './readiness.js';
export { PhoneOperation, PhoneSerial, networkEndpoint, type PhoneDevice } from '@hornhoof/protocol';

export type AdbCall = { args: string[]; input?: string; signal: AbortSignal };
export type AdbRun = (call: AdbCall) => Promise<Buffer>;

/* The phone's own PNG of a whole screen of a photo, up to 10.4 MB at 1080x2400, comes whole before the node shrinks it. */
export const ADB_MAX_BYTES = 16 * 1024 * 1024;

/* Remote shell arguments are quoted even though adb itself starts with shell:false. */
export const shellWord = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

/* adb treats %s as a space. A literal percent is sent separately, so a text with %s in it, a password too, goes in as written.
   input text types plain Latin letters, digits and signs only; any other text gives null. */
function textScript(value: string): string | null {
  if (!/^[\x20-\x7e]+$/.test(value)) return null;
  return (value.match(/%|[^%]+/g) ?? []).map(part => `input text ${shellWord(part.replaceAll(' ', '%s'))}\n`).join('');
}

/* No stdout, stderr, script or adb error object is logged or returned on failure. */
export const adbRunner = (executable: string, environment?: NodeJS.ProcessEnv): AdbRun => call => new Promise((resolve, reject) => {
  if (call.signal.aborted) return reject(new Error('phone_cancelled'));
  const child = spawn(executable, call.args, { stdio: ['pipe', 'pipe', 'pipe'], shell: false, signal: call.signal, killSignal: 'SIGKILL', ...(environment ? { env: environment } : {}) });
  const chunks: Buffer[] = [];
  let bytes = 0;
  let failed = false;
  const fail = () => { failed = true; child.kill('SIGKILL'); };
  const timer = setTimeout(fail, 15_000);
  child.stdout.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > ADB_MAX_BYTES) fail();
    else chunks.push(chunk);
  });
  child.stderr.on('data', () => {});
  child.stdin.on('error', () => {});
  // Abort also emits error before close. The receipt must wait until the process has actually closed.
  child.on('error', () => { failed = true; });
  child.on('close', code => {
    clearTimeout(timer);
    if (failed || code !== 0 || call.signal.aborted) reject(new Error('phone_adb_failed'));
    else resolve(Buffer.concat(chunks));
  });
  child.stdin.end(call.input ?? '');
});

export function privateAdbEnvironment(keyDir: string): NodeJS.ProcessEnv {
  const socketDir = join('/tmp', `hornhoof-adb-${createHash('sha256').update(`${process.getuid?.()}:${keyDir}`).digest('hex').slice(0, 24)}`);
  return { ...process.env, ANDROID_USER_HOME: keyDir, ADB_SERVER_SOCKET: `localfilesystem:${socketDir}/server`, ADB_TRACE: '', ADB_VENDOR_KEYS: '' };
}

/* The adb server itself must not expose an unrestricted TCP port to the node's agent users. On the machine a phone is
   plugged into by cable, its administrator may put a socket to that machine's own adb server into keyDir as host.sock;
   while it is there, the node uses that server, the only one that sees the phone. */
export function privateAdb(executable: string, keyDir: string): AdbRun {
  const env = privateAdbEnvironment(keyDir);
  for (const directory of [keyDir, dirname(env.ADB_SERVER_SOCKET!.slice('localfilesystem:'.length))]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.uid !== process.getuid?.()) throw new Error('phone_adb_directory_invalid');
    chmodSync(directory, 0o700);
  }
  const host = join(keyDir, 'host.sock');
  const own = adbRunner(executable, env), shared = adbRunner(executable, { ...env, ADB_SERVER_SOCKET: `localfilesystem:${host}` });
  return call => (existsSync(host) ? shared : own)(call);
}

/* The keyboard app that types any text adb gives it, for what Android's input text cannot type: Russian, emoji, new lines. */
const KEYBOARD_APP = 'com.android.adbkeyboard';
const KEYBOARD_IME = `${KEYBOARD_APP}/.AdbIME`;

export class PhoneAdb {
  /* keyboard: the local path of the keyboard app, put on a phone the first time it types such a text. */
  constructor(private readonly run: AdbRun, private readonly keyboard?: () => Promise<string>) {}

  async pair(endpoint: string, code: string, signal: AbortSignal): Promise<'paired' | 'needs_person'> {
    if (!networkEndpoint(endpoint) || !/^[0-9]{6}$/.test(code)) throw new Error('phone_pairing_invalid');
    const output = await this.execute({ args: ['pair', endpoint], input: `${code}\n`, signal });
    return output.toString().includes(`Successfully paired to ${endpoint}`) ? 'paired' : 'needs_person';
  }

  async identity(serial: string, signal: AbortSignal): Promise<string | null> {
    if (serial.startsWith('emulator-')) return null;
    const qemu = await this.call(serial, ['shell', 'getprop', 'ro.kernel.qemu'], signal);
    if (qemu.toString().trim() === '1') return null;
    const [number, maker] = await Promise.all([
      this.call(serial, ['shell', 'getprop', 'ro.serialno'], signal),
      this.call(serial, ['shell', 'getprop', 'ro.product.manufacturer'], signal),
    ]);
    const hardware = number.toString().trim();
    const manufacturer = maker.toString().trim().toLowerCase();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{3,199}$/.test(hardware) || /^(unknown|null|none)$/i.test(hardware) || !/^[\p{L}\p{N} ._-]{1,100}$/u.test(manufacturer)) return null;
    return createHash('sha256').update(`android:${manufacturer}:${hardware}`).digest('hex');
  }

  async connect(endpoint: string, signal: AbortSignal): Promise<'connected' | 'needs_person'> {
    if (!networkEndpoint(endpoint)) throw new Error('phone_endpoint_invalid');
    const output = await this.execute({ args: ['connect', endpoint], signal });
    return output.toString().trim().replace(/^already /, '') === `connected to ${endpoint}` ? 'connected' : 'needs_person';
  }

  async devices(signal: AbortSignal): Promise<PhoneDevice[]> {
    const output = await this.execute({ args: ['devices', '-l'], signal });
    return output.toString().split(/\r?\n/).flatMap(line => {
      const match = /^(\S+)\s+(device|offline|unauthorized)(?:\s+(.*))?$/.exec(line);
      if (!match || !PhoneSerial.safeParse(match[1]).success) return [];
      const model = /(?:^|\s)model:([A-Za-z0-9_-]{1,100})(?:\s|$)/.exec(match[3] ?? '')?.[1] ?? null;
      return [{ serial: match[1]!, status: match[2] as PhoneDevice['status'], model }];
    }).sort((a, b) => a.serial.localeCompare(b.serial, 'en'));
  }

  async tree(serial: string, signal: AbortSignal): Promise<string> {
    const output = await this.call(serial, ['exec-out', 'uiautomator', 'dump', '/dev/tty'], signal);
    if (output.length > 2 * 1024 * 1024) throw new Error('phone_tree_too_large');
    return output.toString();
  }

  async readiness(serial: string, signal: AbortSignal): Promise<PhoneReadinessIssue[]> {
    return readReadiness(await this.call(serial, ['shell', 'sh'], signal, readinessScript));
  }

  screenshot(serial: string, signal: AbortSignal): Promise<Buffer> {
    return this.call(serial, ['exec-out', 'screencap', '-p'], signal);
  }

  async act(serial: string, input: unknown, signal: AbortSignal): Promise<void> {
    const op = PhoneOperation.parse(input);
    if (op.kind === 'capture') throw new Error('phone_capture_is_not_an_action');
    const script = await this.script(serial, op, signal);
    await this.call(serial, ['shell'], signal, script);
  }

  private async call(serial: string, args: string[], signal: AbortSignal, input?: string): Promise<Buffer> {
    PhoneSerial.parse(serial);
    if (signal.aborted) throw new Error('phone_cancelled');
    return this.execute({ args: ['-s', serial, ...args], signal, ...(input === undefined ? {} : { input }) });
  }

  private async execute(call: AdbCall): Promise<Buffer> {
    try {
      const output = await this.run(call);
      if (output.length > ADB_MAX_BYTES) throw new Error('phone_output_too_large');
      return output;
    } catch { throw new Error('phone_adb_failed'); }
  }

  private async script(serial: string, op: Exclude<PhoneOperation, { kind: 'capture' }>, signal: AbortSignal): Promise<string> {
    switch (op.kind) {
      case 'tap': return `input tap ${op.x} ${op.y}\n`;
      case 'swipe': return `input swipe ${op.x} ${op.y} ${op.toX} ${op.toY} ${op.ms}\n`;
      case 'text': return textScript(op.text) ?? this.keyboardScript(serial, op.text, signal);
      case 'key': return `input keyevent KEYCODE_${op.key.toUpperCase()}\n`;
      case 'url': return `am start -a android.intent.action.VIEW -d ${shellWord(op.url)} -p com.android.chrome\n`;
      case 'app': {
        const out = await this.call(serial, ['shell', 'cmd', 'package', 'resolve-activity', '--brief', '-c', 'android.intent.category.LAUNCHER', op.package], signal);
        const component = out.toString().trim().split(/\r?\n/).at(-1) ?? '';
        if (!/^[A-Za-z][A-Za-z0-9_.]*\/[A-Za-z0-9_.]+$/.test(component) || component.split('/')[0] !== op.package) throw new Error('phone_app_unavailable');
        return `am start -n ${shellWord(component)}\n`;
      }
    }
  }

  /* Switches to the keyboard app for one text, as a person picks another keyboard, and back to the phone's own one. */
  private async keyboardScript(serial: string, text: string, signal: AbortSignal): Promise<string> {
    if (!(await this.call(serial, ['shell', 'pm', 'path', KEYBOARD_APP], signal)).toString().startsWith('package:')) {
      const apk = await this.keyboard?.();
      if (!apk || !(await this.call(serial, ['install', '-r', apk], signal)).toString().includes('Success')) throw new Error('phone_keyboard_unavailable');
    }
    return [
      'p=$(settings get secure default_input_method)',
      `ime enable ${KEYBOARD_IME} >/dev/null`,
      `ime set ${KEYBOARD_IME} >/dev/null`,
      'sleep 1',
      `am broadcast -a ADB_INPUT_B64 --es msg '${Buffer.from(text).toString('base64')}' >/dev/null`,
      'ime set "$p" >/dev/null 2>&1 || ime reset >/dev/null',
      '',
    ].join('\n');
  }
}
