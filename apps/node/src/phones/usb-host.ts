import { PhoneGrant, PhoneOperation, PhoneSerial, type PhoneBridgeAuthorization } from '@hornhoof/protocol';
import { z } from 'zod';
import type { PhoneAdb } from './adb.js';

const UsbSerial = PhoneSerial.refine(serial => !serial.includes(':') && !serial.startsWith('emulator-'));
const Operation = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('devices') }),
  z.strictObject({ kind: z.literal('identity'), serial: UsbSerial }),
  z.strictObject({ kind: z.literal('drain'), serial: UsbSerial }),
  z.strictObject({ kind: z.literal('tree'), serial: UsbSerial }),
  z.strictObject({ kind: z.literal('screenshot'), serial: UsbSerial }),
  z.strictObject({ kind: z.literal('act'), serial: UsbSerial, action: PhoneOperation.refine(op => op.kind !== 'capture') }),
]);
export const UsbRequest = z.strictObject({ type: z.literal('request'), id: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/), grant: PhoneGrant.nullable(), operation: Operation });
export const UsbCancel = z.strictObject({ type: z.literal('cancel'), id: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/) });
export const UsbReply = z.strictObject({ type: z.literal('reply'), id: z.string().max(100), status: z.enum(['ok', 'failed', 'denied', 'cancelled']), value: z.unknown() });
export type UsbRequest = z.infer<typeof UsbRequest>;
export type UsbReply = z.infer<typeof UsbReply>;
type Pending = { stop: AbortController; done: Promise<void> };

/* A host receives only these operations. It never accepts argv, a shell command or an executable path. */
export class UsbHost {
  readonly #pending = new Map<string, Pending>();
  readonly #chains = new Map<string, Promise<void>>();
  #closed = false;
  constructor(private readonly deps: { adb: PhoneAdb; authorize(input: PhoneBridgeAuthorization, signal: AbortSignal): Promise<boolean>; send(input: UsbReply): void }) {}

  async receive(input: unknown): Promise<void> {
    const cancelled = UsbCancel.safeParse(input);
    if (cancelled.success) {
      const active = this.#pending.get(cancelled.data.id);
      active?.stop.abort();
      await active?.done;
      return;
    }
    const parsed = UsbRequest.safeParse(input);
    if (!parsed.success || this.#closed) return;
    const request = parsed.data;
    if (this.#pending.has(request.id)) return;
    if (this.#pending.size >= 128) { this.reply(request.id, 'failed'); return; }
    const stop = new AbortController();
    const serial = 'serial' in request.operation ? request.operation.serial : request.grant?.binding.serial ?? '_devices';
    const previous = this.#chains.get(serial) ?? Promise.resolve();
    // Register before the first await so a cancel also stops authorization and queued work.
    const done = previous.then(() => this.execute(request, stop)).catch(() => this.reply(request.id, stop.signal.aborted ? 'cancelled' : 'failed'));
    this.#pending.set(request.id, { stop, done });
    this.#chains.set(serial, done);
    try { await done; }
    finally { this.#pending.delete(request.id); if (this.#chains.get(serial) === done) this.#chains.delete(serial); }
  }

  close(): void {
    this.#closed = true;
    for (const pending of this.#pending.values()) pending.stop.abort();
  }

  async drained(): Promise<void> { await Promise.all([...this.#pending.values()].map(p => p.done)); }

  private reply(id: string, status: UsbReply['status'], value: unknown = null): void {
    if (!this.#closed) this.deps.send({ type: 'reply', id, status, value });
  }

  private async execute(request: UsbRequest, stop: AbortController): Promise<void> {
    const { operation: op, grant } = request;
    const serial = 'serial' in op ? op.serial : null;
    let authorization: PhoneBridgeAuthorization;
    if (grant) {
      if (grant.binding.transport !== 'usb' || grant.binding.endpoint !== null || !UsbSerial.safeParse(grant.binding.serial).success || (serial !== null && serial !== grant.binding.serial) || (op.kind !== 'drain' && Date.parse(grant.expiresAt) <= Date.now())) { this.reply(request.id, 'denied'); return; }
      authorization = op.kind === 'drain' ? { scope: 'probe', serial } : { scope: 'session', phoneId: grant.binding.phoneId, sessionId: grant.sessionId, generation: grant.generation, serial: grant.binding.serial, hardwareKey: grant.binding.hardwareKey };
    } else {
      if (op.kind !== 'devices' && op.kind !== 'identity') { this.reply(request.id, 'denied'); return; }
      authorization = { scope: 'probe', serial };
    }
    if (stop.signal.aborted) throw new Error('phone_cancelled');
    const timer = grant && op.kind !== 'drain' ? setTimeout(() => stop.abort(), Math.max(0, Date.parse(grant.expiresAt) - Date.now())) : null;
    try {
      if (!await this.deps.authorize(authorization, stop.signal)) { this.reply(request.id, 'denied'); return; }
      if (stop.signal.aborted) throw new Error('phone_cancelled');
      if (grant && op.kind !== 'drain' && await this.deps.adb.identity(grant.binding.serial, stop.signal) !== grant.binding.hardwareKey) { this.reply(request.id, 'denied'); return; }
      if (stop.signal.aborted) throw new Error('phone_cancelled');
      const value = await this.perform(op, grant, stop.signal);
      if (stop.signal.aborted) throw new Error('phone_cancelled');
      this.reply(request.id, 'ok', value);
    } finally { if (timer) clearTimeout(timer); }
  }

  private async perform(op: UsbRequest['operation'], grant: PhoneGrant | null, signal: AbortSignal): Promise<unknown> {
    switch (op.kind) {
      case 'drain': return null;
      case 'devices': return (await this.deps.adb.devices(signal)).filter(d => UsbSerial.safeParse(d.serial).success && (!grant || d.serial === grant.binding.serial));
      case 'identity': return this.deps.adb.identity(op.serial, signal);
      case 'tree': return this.deps.adb.tree(op.serial, signal);
      case 'screenshot': return (await this.deps.adb.screenshot(op.serial, signal)).toString('base64');
      case 'act': await this.deps.adb.act(op.serial, op.action, signal); return null;
    }
  }
}
