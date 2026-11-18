import { PhoneCapture, PhoneServerMessage, networkEndpoint, type PhoneFrame, type PhoneOperation, type PhoneReply, type PhoneGrant, type PhoneTypingCheck, type PhoneTypingIssue } from '@hornhoof/protocol';
import type { PhoneAdb, PhoneTyped } from './adb.js';
import { phoneCapture } from './capture.js';
import { PhoneSessions, type PhoneSessionView } from './sessions.js';
import { checkPhoneText } from './text.js';

export type PhoneDriver = Pick<PhoneAdb, 'connect' | 'pair' | 'identity' | 'devices' | 'tree' | 'screenshot' | 'act' | 'type' | 'readiness'>;
export type PhoneExecutorDeps = { adb: PhoneDriver; send(message: PhoneReply | PhoneFrame): void };
const noFrame = (): PhoneCapture => ({ jpeg: null, width: 0, height: 0, elements: [] });
const FRAME_MS = 1500;
/* The server waits 20 seconds. Leave two seconds for delivery and reserve part of our budget for readback. */
const TEXT_REPLY_MS = 18_000;
const TEXT_READBACK_MS = 6_000;
const TEXT_START_ROOM_MS = 4_000;
const TEXT_IDENTITY_MS = 2_000;
type TextOperation = Extract<PhoneOperation, { kind: 'text' }>;
type ActionResult = Pick<PhoneReply, 'capture' | 'typing'>;
class PhoneDeviceChanged extends Error {}

function typingIssue(typed: PhoneTyped, length: number, check: PhoneTypingCheck | undefined): PhoneTypingIssue | undefined {
  const found = check ? { check } : {};
  if (typed.failure) return { kind: 'typing_failed', reason: typed.failure, next: typed.next, ...found };
  if (typed.next < length) return { kind: 'typing_partial', next: typed.next, ...found };
  return check;
}

/* Text that went in but could not be read back is not a failure: typing it again would double a password. */
function typingStatus(typing: PhoneTypingIssue | undefined): PhoneReply['status'] {
  if (!typing || typing.kind === 'typing_unverified') return 'ok';
  return typing.kind === 'typing_partial' ? 'partial' : 'failed';
}

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
  readonly #checks = new Map<string, Promise<PhoneReply>>();
  #readiness = new AbortController();

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
      const done = this.request(m, now).catch((): PhoneReply => ({ type: 'phone.reply', requestId: m.requestId, status: 'failed' }));
      this.#seen.set(m.requestId, (seen = { at: now, done }));
    }
    const result = await seen.done;
    this.deps.send(result);
    // Remember the outcome, not megabytes of screenshots for every action of the last ten minutes.
    if (this.#seen.get(m.requestId) === seen) {
      const { status, readiness, typing } = result;
      this.#seen.set(m.requestId, { at: seen.at, done: Promise.resolve({ type: 'phone.reply', requestId: m.requestId, status, ...(readiness ? { readiness } : {}), ...(typing ? { typing } : {}) }) });
    }
  }

  close(): void {
    this.#readiness.abort();
    this.#readiness = new AbortController();
    this.#sessions.close();
    for (const id of this.#timers.keys()) this.clearTimer(id);
  }

  private async request(m: Exclude<PhoneServerMessage, { type: 'phone.renew' | 'phone.revoke' }>, receivedAt: number): Promise<PhoneReply> {
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
    if (m.type === 'phone.list') {
      const listed = await this.deps.adb.devices(new AbortController().signal);
      return reply('ok', { devices: listed.filter(device => m.serials.includes(device.serial)) });
    }
    if (m.type === 'phone.baseline') {
      const { serial, hardwareKey } = m.binding;
      if (this.#sessions.holds(serial, hardwareKey) || this.#checks.has(hardwareKey)) return reply('busy');
      const check = this.checkBaseline(m);
      this.#checks.set(hardwareKey, check);
      try { return await check; }
      finally { this.#checks.delete(hardwareKey); }
    }
    if (m.type === 'phone.open') {
      const { grant } = m;
      const signal = this.#readiness.signal;
      const check = this.#checks.get(grant.binding.hardwareKey);
      if (check) await check.catch(() => {});
      if (signal.aborted) return reply('failed');
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
    const { operation } = m;
    const deadline = receivedAt + TEXT_REPLY_MS;
    try {
      const result = operation.kind === 'text'
        ? await this.queueText(m.sessionId, m.generation, operation, deadline)
        : await this.#sessions.use<ActionResult>(m.sessionId, m.generation, async state => {
          await this.assertDevice(state);
          const serial = state.grant.binding.serial;
          if (operation.kind !== 'capture') {
            if (!this.#scales.has(serial)) await this.capture(state);
            await this.deps.adb.act(serial, onPhone(operation, this.#scales.get(serial)!), state.signal);
          }
          return { capture: await this.capture(state) };
        });
      const state = this.#sessions.view(m.sessionId, m.generation);
      if (result.capture) this.emitFrame(state.grant, result.capture);
      return reply(typingStatus(result.typing), result);
    } catch (error) {
      if (operation.kind !== 'text' || error instanceof PhoneDeviceChanged || await this.textSessionGone(m, deadline)) return reply('session_gone');
      // The device check before typing can fail before any text was sent.
      return reply('failed', this.textNotStarted());
    }
  }

  private textNotStarted(): ActionResult {
    return { typing: { kind: 'typing_failed', reason: 'phone_adb_failed', next: 0 } };
  }

  private async queueText(id: string, generation: number, operation: TextOperation, deadline: number): Promise<ActionResult> {
    const startBy = deadline - TEXT_READBACK_MS - TEXT_START_ROOM_MS;
    let timer!: ReturnType<typeof setTimeout>;
    let expired = false;
    const wait = new Promise<ActionResult>(resolve => {
      timer = setTimeout(() => {
        expired = true;
        resolve(this.textNotStarted());
      }, Math.max(0, startBy - Date.now()));
    });
    const action = this.#sessions.use(id, generation, state => {
      if (expired || Date.now() >= startBy) return Promise.resolve(this.textNotStarted());
      clearTimeout(timer);
      return this.typeText(state, operation, deadline, startBy);
    });
    try { return await Promise.race([action, wait]); }
    finally { clearTimeout(timer); }
  }

  private async typeText(state: PhoneSessionView, operation: TextOperation, deadline: number, beforeDeadline: number): Promise<ActionResult> {
    const { grant: { binding: { serial } }, signal } = state;
    const readTree = (until: number) => this.deps.adb.tree(serial, signal, until).catch(() => '');
    await this.assertDevice(state, Math.min(Date.now() + TEXT_IDENTITY_MS, beforeDeadline));
    const before = await readTree(beforeDeadline);
    const typed = await this.deps.adb.type(serial, operation.text, signal, deadline - TEXT_READBACK_MS);
    const after = await readTree(deadline);
    if (typed.failure && await this.deviceGone(state, deadline)) throw new PhoneDeviceChanged('phone_device_gone');
    const sent = [...operation.text];
    const check = checkPhoneText(before, after, sent.slice(0, typed.next).join(''));
    const capture = await this.capture(state, after, deadline).catch((error: unknown) => {
      if (error instanceof PhoneDeviceChanged) throw error;
      return undefined;
    });
    const typing = typingIssue(typed, sent.length, check);
    return { ...(capture ? { capture } : {}), ...(typing ? { typing } : {}) };
  }

  private async textSessionGone(m: Extract<PhoneServerMessage, { type: 'phone.action' }>, deadline: number): Promise<boolean> {
    let state: PhoneSessionView;
    try { state = this.#sessions.view(m.sessionId, m.generation); }
    catch { return true; }
    return this.deviceGone(state, deadline);
  }

  private async deviceGone(state: PhoneSessionView, deadline: number): Promise<boolean> {
    const devices = await this.deps.adb.devices(state.signal, deadline).catch(() => undefined);
    return !state.valid() || Boolean(devices && !devices.some(device => device.serial === state.grant.binding.serial && device.status === 'device'));
  }

  private async checkBaseline(m: Extract<PhoneServerMessage, { type: 'phone.baseline' }>): Promise<PhoneReply> {
    const { adb } = this.deps;
    const { serial, hardwareKey } = m.binding;
    const signal = this.#readiness.signal;
    const reply = { type: 'phone.reply', requestId: m.requestId } as const;
    const missing = () => ({ ...reply, status: 'needs_person' as const });
    try {
      if (networkEndpoint(serial) && await adb.connect(serial, signal) !== 'connected') return missing();
      if (!(await adb.devices(signal)).some(device => device.serial === serial && device.status === 'device')) return missing();
      if (await adb.identity(serial, signal) !== hardwareKey) return missing();
    } catch { return missing(); }
    return { ...reply, status: 'ok', readiness: await adb.readiness(serial, signal) };
  }

  private async capture(state: PhoneSessionView, tree?: string, deadline?: number): Promise<PhoneCapture> {
    const serial = state.grant.binding.serial;
    await this.assertDevice(state, deadline);
    const { capture, scale } = phoneCapture(tree ?? await this.deps.adb.tree(serial, state.signal, deadline), await this.deps.adb.screenshot(serial, state.signal, deadline));
    this.#scales.set(serial, scale);
    return PhoneCapture.safeParse(capture).success ? capture : noFrame();
  }

  private async assertDevice(state: PhoneSessionView, deadline?: number): Promise<void> {
    if (await this.deps.adb.identity(state.grant.binding.serial, state.signal, deadline) !== state.grant.binding.hardwareKey) throw new PhoneDeviceChanged('phone_device_changed');
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
