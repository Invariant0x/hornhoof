import { randomUUID } from 'node:crypto';
import { PhoneDevice, PhoneHardwareKey, PhoneOperation, type PhoneGrant } from '@hornhoof/protocol';
import { z } from 'zod';
import type { PhoneDriver } from './executor.js';
import { UsbRequest, UsbReply } from './usb-host.js';

const unavailable = () => new Error('phone_usb_unavailable');
type Pending = { resolve(input: unknown): void; reject(error: Error): void; cleanup(): void };

export class UsbPeer {
  readonly #pending = new Map<string, Pending>();
  #closed = false;
  constructor(private readonly send: (message: unknown) => void, private readonly disconnect: () => void) {}

  receive(input: unknown): void {
    const parsed = UsbReply.safeParse(input);
    if (!parsed.success) { this.close(); return; }
    const reply = parsed.data;
    const pending = this.#pending.get(reply.id);
    if (!pending) return;
    this.#pending.delete(reply.id); pending.cleanup();
    if (reply.status === 'ok') pending.resolve(reply.value);
    else pending.reject(unavailable());
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.disconnect();
    for (const pending of this.#pending.values()) { pending.cleanup(); pending.reject(unavailable()); }
    this.#pending.clear();
  }

  driver(grant: PhoneGrant | null): PhoneDriver {
    const ask = <T>(operation: UsbRequest['operation'], schema: z.ZodType<T>, signal: AbortSignal) => this.request(grant, operation, signal).then(value => {
      const parsed = schema.safeParse(value);
      if (!parsed.success) { this.close(); throw unavailable(); }
      return parsed.data;
    });
    return {
      connect: async () => { throw unavailable(); }, pair: async () => { throw unavailable(); },
      devices: signal => ask({ kind: 'devices' }, z.array(PhoneDevice).max(1000), signal),
      identity: (serial, signal) => ask({ kind: 'identity', serial }, PhoneHardwareKey.nullable(), signal),
      tree: (serial, signal) => ask({ kind: 'tree', serial }, z.string().max(2 * 1024 * 1024), signal),
      screenshot: async (serial, signal) => Buffer.from(await ask({ kind: 'screenshot', serial }, z.string().max(12 * 1024 * 1024).regex(/^[A-Za-z0-9+/]*={0,2}$/), signal), 'base64'),
      act: async (serial, action, signal) => {
        const parsed = PhoneOperation.safeParse(action);
        if (!parsed.success || parsed.data.kind === 'capture') throw unavailable();
        await ask({ kind: 'act', serial, action: parsed.data }, z.null(), signal);
      },
      type: async (serial, value, signal) => { await ask({ kind: 'type', serial, value }, z.null(), signal); },
    };
  }

  async drained(grant: PhoneGrant): Promise<boolean> {
    try { return await this.request(grant, { kind: 'drain', serial: grant.binding.serial }, new AbortController().signal) === null; }
    catch { return false; }
  }

  private request(grant: PhoneGrant | null, operation: UsbRequest['operation'], signal: AbortSignal): Promise<unknown> {
    if (this.#closed || signal.aborted || this.#pending.size >= 128) return Promise.reject(unavailable());
    const parsed = UsbRequest.safeParse({ type: 'request', id: randomUUID(), grant, operation });
    if (!parsed.success) return Promise.reject(unavailable());
    const request = parsed.data;
    return new Promise((resolve, reject) => {
      // Cancel waits for the host's receipt, which comes only after its adb child has stopped.
      const cancel = () => { try { this.send({ type: 'cancel', id: request.id }); } catch { this.close(); } };
      const timer = setTimeout(() => this.close(), 20_000);
      timer.unref();
      const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', cancel); };
      this.#pending.set(request.id, { resolve, reject, cleanup });
      signal.addEventListener('abort', cancel, { once: true });
      try { this.send(request); }
      catch { this.close(); }
    });
  }
}
