import { PhoneCapture, PhoneServerMessage, type PhoneFrame, type PhoneReply, type PhoneGrant, type PhoneBinding } from '@hornhoof/protocol';
import type { PhoneAdb } from './adb.js';
import { safeCapture } from './capture.js';
import { PhoneSessions, type PhoneSessionView } from './sessions.js';

export type PhoneDriver = Pick<PhoneAdb, 'connect' | 'pair' | 'identity' | 'devices' | 'tree' | 'screenshot' | 'act'>;
export type PhoneExecutorDeps = { drivers: { network: PhoneDriver; usb: ((grant: PhoneGrant | null) => PhoneDriver) | null }; revokeUsb?(binding: PhoneBinding, sessionId: string, generation: number): Promise<boolean>; send(message: PhoneReply | PhoneFrame): void; hide(text: string): string };
const hiddenFrame = (): PhoneCapture => ({ png: null, width: 0, height: 0, elements: [], masked: true });
const FRAME_MS = 1500;

export class PhoneExecutor {
  readonly #sessions = new PhoneSessions();
  readonly #timers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #sequences = new Map<string, number>();
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
      const stopped = m.binding.transport !== 'usb' || await this.deps.revokeUsb?.(m.binding, m.sessionId, m.generation) === true;
      this.deps.send({ type: 'phone.reply', requestId: m.requestId, status: stopped ? 'ok' : 'failed' });
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

  private driver(transport: PhoneBinding['transport'], grant: PhoneGrant | null): PhoneDriver {
    if (transport === 'network') return this.deps.drivers.network;
    const driver = this.deps.drivers.usb?.(grant);
    if (!driver) throw new Error('phone_usb_unavailable');
    return driver;
  }

  private async request(m: Exclude<PhoneServerMessage, { type: 'phone.renew' | 'phone.revoke' }>): Promise<PhoneReply> {
    const reply = (status: PhoneReply['status'], extra: Partial<PhoneReply> = {}): PhoneReply => ({ type: 'phone.reply', requestId: m.requestId, status, ...extra });
    if (m.type === 'phone.probe') {
      if ((m.transport === 'network') !== (m.endpoint !== null)) return reply('failed');
      const driver = this.driver(m.transport, null);
      const stop = new AbortController();
      if (m.pairing) {
        if (m.transport !== 'network') return reply('failed');
        if (await driver.pair(m.pairing.endpoint, m.pairing.code, stop.signal) !== 'paired') return reply('needs_person');
      }
      if (m.endpoint && await driver.connect(m.endpoint, stop.signal) !== 'connected') return reply('needs_person');
      const devices = (await driver.devices(stop.signal)).filter(d => m.transport === 'usb' ? !d.serial.includes(':') : d.serial === m.endpoint);
      const verified = await Promise.all(devices.filter(d => !d.serial.startsWith('emulator-')).map(async device => {
        if (device.status !== 'device') return device;
        const hardwareKey = await driver.identity(device.serial, stop.signal);
        return hardwareKey ? { ...device, hardwareKey } : { ...device, status: 'unverified' as const };
      }));
      return reply('ok', { devices: verified });
    }
    if (m.type === 'phone.open') {
      const { grant } = m;
      if ((grant.binding.transport === 'network') !== (grant.binding.endpoint !== null) || (grant.binding.endpoint !== null && grant.binding.endpoint !== grant.binding.serial)) return reply('failed');
      this.#sessions.open(grant);
      try {
        await this.#sessions.use(grant.sessionId, grant.generation, async state => {
          const driver = this.driver(grant.binding.transport, grant);
          if (grant.binding.endpoint && await driver.connect(grant.binding.endpoint, state.signal) !== 'connected') throw new Error('phone_needs_person');
          if (!(await driver.devices(state.signal)).some(d => d.serial === grant.binding.serial && d.status === 'device')) throw new Error('phone_needs_person');
          await this.assertDevice(state, driver);
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
        const driver = this.driver(state.grant.binding.transport, state.grant);
        await this.assertDevice(state, driver);
        if (m.operation.kind !== 'capture') await driver.act(state.grant.binding.serial, m.operation, state.signal);
        return this.capture(state, driver);
      });
      const state = this.#sessions.view(m.sessionId, m.generation);
      this.emitFrame(state.grant, capture);
      return reply('ok', { capture });
    } catch { return reply('session_gone'); }
  }

  private async capture(state: PhoneSessionView, driver: PhoneDriver): Promise<PhoneCapture> {
    const serial = state.grant.binding.serial;
    await this.assertDevice(state, driver);
    const before = await driver.tree(serial, state.signal);
    const png = await driver.screenshot(serial, state.signal);
    const after = await driver.tree(serial, state.signal);
    await this.assertDevice(state, driver);
    if (!state.valid()) return hiddenFrame();
    const clean = safeCapture(after, png, before !== after, this.deps.hide);
    return PhoneCapture.safeParse(clean).success ? clean : hiddenFrame();
  }

  private async assertDevice(state: PhoneSessionView, driver: PhoneDriver): Promise<void> {
    if (await driver.identity(state.grant.binding.serial, state.signal) !== state.grant.binding.hardwareKey) throw new Error('phone_device_changed');
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
      const capture = await this.#sessions.use(grant.sessionId, grant.generation, state => this.capture(state, this.driver(state.grant.binding.transport, state.grant)));
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
