import { PhoneCapture, PhoneServerMessage, networkEndpoint, type PhoneFrame, type PhoneOperation, type PhoneReply, type PhoneGrant } from '@hornhoof/protocol';
import type { PhoneAdb } from './adb.js';
import { phoneCapture } from './capture.js';
import { PhoneSessions, type PhoneSessionView } from './sessions.js';

export type PhoneDriver = Pick<PhoneAdb, 'connect' | 'pair' | 'identity' | 'devices' | 'tree' | 'screenshot' | 'act'>;
export type PhoneExecutorDeps = { adb: PhoneDriver; send(message: PhoneReply | PhoneFrame): void };
const noFrame = (): PhoneCapture => ({ jpeg: null, width: 0, height: 0, elements: [] });
const FRAME_MS = 1500;

/* The agent taps and swipes in the pixels of the picture it sees, adb in the phone's. */
function onPhone(op: PhoneOperation, scale: number): PhoneOperation {
  const at = (n: number) => Math.round(n * scale);
  if (op.kind === 'tap') return { ...op, x: at(op.x), y: at(op.y) };
  if (op.kind === 'swipe') return { ...op, x: at(op.x), y: at(op.y), toX: at(op.toX), toY: at(op.toY) };
  return op;
}

export class PhoneExecutor {
  readonly #sessions = new PhoneSessions();
  readonly #timers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #sequences = new Map<string, number>();
  /* How many of each phone's pixels make one pixel of the picture its agent sees. */
  readonly #scales = new Map<string, number>();
  readonly #seen = new Map<string, { at: number; done: Promise<PhoneReply> }>();

  constructor(private readonly deps: PhoneExecutorDeps) {}

  async handle(input: PhoneServerMessage): Promise<void> {
    const m = PhoneServerMessage.parse(input);
    if (m.type === 'phone.renew') { this.#sessions.renew(m.sessionId, m.generation, m.expiresAt); return; }
    // Revocation never waits for the action queue or for a previous request to finish.
    if (m.type === 'phone.revoke') {
      this.#sessions.fence(m.binding.serial, m.generation);
      this.#sessions.revoke(m.sessionId, m.generation);
      this.clearTimer(m.sessionId);
      await this.#sessions.drained(m.sessionId);
      this.deps.send({ type: 'phone.reply', requestId: m.requestId, status: 'ok' });
      return;
    }
    const now = Date.now();
    for (const [id, seen] of this.#seen) if (now - seen.at > 600_000) this.#seen.delete(id);
    let seen = this.#seen.get(m.requestId);
    if (!seen) {
      if (this.#seen.size >= 50_000) { this.deps.send({ type: 'phone.reply', requestId: m.requestId, status: 'busy' }); return; }
      const done = this.request(m).catch((): PhoneReply => ({ type: 'phone.reply', requestId: m.requestId, status: 'failed' }));
      this.#seen.set(m.requestId, (seen = { at: now, done }));
    }
    const result = await seen.done;
    this.deps.send(result);
    // Remember the outcome, not megabytes of screenshots for every action of the last ten minutes.
    if (this.#seen.get(m.requestId) === seen) this.#seen.set(m.requestId, { at: seen.at, done: Promise.resolve({ type: 'phone.reply', requestId: m.requestId, status: result.status }) });
  }

  close(): void {
    this.#sessions.close();
    for (const id of this.#timers.keys()) this.clearTimer(id);
  }

  private async request(m: Exclude<PhoneServerMessage, { type: 'phone.renew' | 'phone.revoke' }>): Promise<PhoneReply> {
    const reply = (status: PhoneReply['status'], extra: Partial<PhoneReply> = {}): PhoneReply => ({ type: 'phone.reply', requestId: m.requestId, status, ...extra });
    if (m.type === 'phone.probe') {
      const { adb } = this.deps;
      const stop = new AbortController();
      if (m.pairing && await adb.pair(m.pairing.endpoint, m.pairing.code, stop.signal) !== 'paired') return reply('needs_person');
      if (networkEndpoint(m.endpoint) && await adb.connect(m.endpoint, stop.signal) !== 'connected') return reply('needs_person');
      const devices = (await adb.devices(stop.signal)).filter(d => d.serial === m.endpoint);
      const verified = await Promise.all(devices.map(async device => {
        if (device.status !== 'device') return device;
        const hardwareKey = await adb.identity(device.serial, stop.signal);
        return hardwareKey ? { ...device, hardwareKey } : { ...device, status: 'unverified' as const };
      }));
      return reply('ok', { devices: verified });
    }
    if (m.type === 'phone.open') {
      const { grant } = m;
      this.#sessions.open(grant);
      try {
        await this.#sessions.use(grant.sessionId, grant.generation, async state => {
          const { adb } = this.deps;
          if (networkEndpoint(grant.binding.serial) && await adb.connect(grant.binding.serial, state.signal) !== 'connected') throw new Error('phone_needs_person');
          if (!(await adb.devices(state.signal)).some(d => d.serial === grant.binding.serial && d.status === 'device')) throw new Error('phone_needs_person');
          await this.assertDevice(state);
        });
        this.schedule(grant);
        return reply('ok');
      } catch {
        this.#sessions.revoke(grant.sessionId, grant.generation);
        return reply('needs_person');
      }
    }
    try {
      const capture = await this.#sessions.use(m.sessionId, m.generation, async state => {
        await this.assertDevice(state);
        const serial = state.grant.binding.serial;
        if (m.operation.kind !== 'capture') {
          if (!this.#scales.has(serial)) await this.capture(state);
          await this.deps.adb.act(serial, onPhone(m.operation, this.#scales.get(serial)!), state.signal);
        }
        return this.capture(state);
      });
      const state = this.#sessions.view(m.sessionId, m.generation);
      this.emitFrame(state.grant, capture);
      return reply('ok', { capture });
    } catch { return reply('session_gone'); }
  }

  private async capture(state: PhoneSessionView): Promise<PhoneCapture> {
    const serial = state.grant.binding.serial;
    await this.assertDevice(state);
    const { capture, scale } = phoneCapture(await this.deps.adb.tree(serial, state.signal), await this.deps.adb.screenshot(serial, state.signal));
    this.#scales.set(serial, scale);
    return PhoneCapture.safeParse(capture).success ? capture : noFrame();
  }

  private async assertDevice(state: PhoneSessionView): Promise<void> {
    if (await this.deps.adb.identity(state.grant.binding.serial, state.signal) !== state.grant.binding.hardwareKey) throw new Error('phone_device_changed');
  }

  private clearTimer(id: string): void {
    const timer = this.#timers.get(id);
    if (timer) clearTimeout(timer);
    this.#timers.delete(id);
    this.#sequences.delete(id);
  }

  private schedule(grant: PhoneGrant): void {
    const id = grant.sessionId;
    const timer = setTimeout(() => { void this.frame(grant); }, FRAME_MS);
    timer.unref();
    this.#timers.set(id, timer);
  }

  private async frame(grant: PhoneGrant): Promise<void> {
    try {
      const capture = await this.#sessions.use(grant.sessionId, grant.generation, state => this.capture(state));
      this.#sessions.view(grant.sessionId, grant.generation);
      this.emitFrame(grant, capture);
      this.schedule(grant);
    } catch { this.clearTimer(grant.sessionId); }
  }

  private emitFrame(grant: PhoneGrant, capture: PhoneCapture): void {
    const sequence = (this.#sequences.get(grant.sessionId) ?? 0) + 1;
    this.#sequences.set(grant.sessionId, sequence);
    this.deps.send({ type: 'phone.frame', sessionId: grant.sessionId, generation: grant.generation, sequence, at: new Date().toISOString(), capture });
  }
}
