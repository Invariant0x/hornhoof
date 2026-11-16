import { spawn } from 'node:child_process';
import { PhoneOperation, PhoneSerial, networkEndpoint, type PhoneDevice } from '@hornhoof/protocol';
export { PhoneOperation, PhoneSerial, networkEndpoint, type PhoneDevice } from '@hornhoof/protocol';

export type AdbCall = { args: string[]; input?: string; signal: AbortSignal };
export type AdbRun = (call: AdbCall) => Promise<Buffer>;

export const ADB_MAX_BYTES = 8 * 1024 * 1024;

/* Remote shell arguments are quoted even though adb itself starts with shell:false. */
export const shellWord = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

/* adb treats %s as a space. A literal percent is sent separately, so passwords containing %s are not changed. */
export function textScript(value: string): string {
  if (!value || value.length > 4096 || !/^[\x20-\x7e]+$/.test(value)) throw new Error('phone_text_unsupported');
  return (value.match(/%|[^%]+/g) ?? []).map(part => `input text ${shellWord(part.replaceAll(' ', '%s'))}\n`).join('');
}

/* No stdout, stderr, script or adb error object is logged or returned on failure. */
export const systemAdb: AdbRun = call => new Promise((resolve, reject) => {
  if (call.signal.aborted) return reject(new Error('phone_cancelled'));
  const child = spawn('adb', call.args, { stdio: ['pipe', 'pipe', 'pipe'], shell: false, signal: call.signal });
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
  child.on('error', () => { failed = true; clearTimeout(timer); reject(new Error('phone_adb_failed')); });
  child.on('close', code => {
    clearTimeout(timer);
    if (failed || code !== 0 || call.signal.aborted) reject(new Error('phone_adb_failed'));
    else resolve(Buffer.concat(chunks));
  });
  child.stdin.end(call.input ?? '');
});

export class PhoneAdb {
  constructor(private readonly run: AdbRun) {}

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

  screenshot(serial: string, signal: AbortSignal): Promise<Buffer> {
    return this.call(serial, ['exec-out', 'screencap', '-p'], signal);
  }

  async act(serial: string, input: unknown, signal: AbortSignal): Promise<void> {
    const op = PhoneOperation.parse(input);
    if (op.kind === 'capture') throw new Error('phone_capture_needs_mask');
    const script = await this.script(serial, op, signal);
    await this.call(serial, ['shell'], signal, script);
  }

  /* Shared SecretFills owns secret resolution. The phone adapter reveals only to this stdin sink. */
  async type(serial: string, value: string, signal: AbortSignal): Promise<void> {
    await this.call(serial, ['shell'], signal, textScript(value));
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
      case 'text': return textScript(op.text);
      case 'url': return `am start -a android.intent.action.VIEW -d ${shellWord(op.url)} -p com.android.chrome\n`;
      case 'app': {
        const out = await this.call(serial, ['shell', 'cmd', 'package', 'resolve-activity', '--brief', '-c', 'android.intent.category.LAUNCHER', op.package], signal);
        const component = out.toString().trim().split(/\r?\n/).at(-1) ?? '';
        if (!/^[A-Za-z][A-Za-z0-9_.]*\/[A-Za-z0-9_.]+$/.test(component) || component.split('/')[0] !== op.package) throw new Error('phone_app_unavailable');
        return `am start -n ${shellWord(component)}\n`;
      }
    }
  }
}
