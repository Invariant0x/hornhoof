import { PhoneCapture, PhoneServerMessage, sameSite, type PhoneFrame, type PhoneReply, type PhoneGrant, type PhoneBinding } from '@hornhoof/protocol';
import type { FillAdapter, FillReceipt, FillValues, TargetOf } from '../secret-fill/index.js';
import type { FillField } from '@hornhoof/protocol';
import type { PhoneAdb } from './adb.js';
import { safeCapture, parsePhoneTree } from './capture.js';
import { PhoneSessions, type PhoneSessionView } from './sessions.js';

export type PhoneDriver = Pick<PhoneAdb, 'connect' | 'devices' | 'tree' | 'screenshot' | 'act' | 'type'>;
export type PhoneExecutorDeps = { drivers: { network: PhoneDriver; usb: ((grant: PhoneGrant | null) => PhoneDriver) | null }; send(message: PhoneReply | PhoneFrame): void; hide(text: string): string };
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
      this.deps.send({ type: 'phone.reply', requestId: m.requestId, status: 'ok' });
      return;
    }
    const now = Date.now();
    for (const [id, seen] of this.#seen) if (now - seen.at > 600_000) this.#seen.delete(id);
    let seen = this.#seen.get(m.requestId);
    if (!seen) {
      const done = this.request(m).catch((): PhoneReply => ({ type: 'phone.reply', requestId: m.requestId, status: 'failed' }));
      this.#seen.set(m.requestId, (seen = { at: now, done }));
    }
    this.deps.send(await seen.done);
  }

  close(): void {
    this.#sessions.close();
    for (const id of this.#timers.keys()) this.clearTimer(id);
  }

  fillAdapter(): FillAdapter<'phone'> {
    return {
      kind: 'phone',
      shield: async target => {
        const release = this.#sessions.shield(target.phoneSessionId, target.generation);
        return async () => { release(); };
      },
      fill: (target, values, fields, signal) => this.fill(target, values, fields, signal),
    };
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
      if (m.endpoint && await driver.connect(m.endpoint, stop.signal) !== 'connected') return reply('needs_person');
      const devices = (await driver.devices(stop.signal)).filter(d => m.transport === 'usb' ? !d.serial.includes(':') : d.serial === m.endpoint);
      return reply('ok', { devices });
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
    const before = await driver.tree(serial, state.signal);
    const png = await driver.screenshot(serial, state.signal);
    const after = await driver.tree(serial, state.signal);
    if (!state.valid()) return hiddenFrame();
    const clean = safeCapture(after, png, state.shielded || before !== after, this.deps.hide);
    return PhoneCapture.safeParse(clean).success ? clean : hiddenFrame();
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

  private async fill(target: TargetOf<'phone'>, values: FillValues, fields: FillField[], signal: AbortSignal): Promise<FillReceipt> {
    if (fields.length !== 1) return { status: 'needs_person', filled: [] };
    try {
      return await this.#sessions.use(target.phoneSessionId, target.generation, async state => {
        const driver = this.driver(state.grant.binding.transport, state.grant);
        const stop = AbortSignal.any([state.signal, signal]);
        const tree = parsePhoneTree(await driver.tree(state.grant.binding.serial, stop));
        const chrome = tree.some(e => e.package === 'com.android.chrome');
        if (chrome) {
          const bar = tree.find(e => /:id\/(?:url_bar|location_bar)$/.test(e.resource));
          const page = bar?.text ? (/^https?:\/\//.test(bar.text) ? bar.text : `https://${bar.text}`) : null;
          if (!target.site || !page || !sameSite(target.site, page)) return { status: 'needs_person', filled: [] };
        } else if (target.site) return { status: 'needs_person', filled: [] };
        const element = target.element ? tree.find(e => e.ref === target.element) : tree.find(e => e.focused && e.editable);
        if (!element || !element.editable) return { status: 'field_not_found', filled: [] };
        const field = fields[0]!;
        if ((field === 'password') !== element.password) return { status: 'wrong_field', filled: [] };
        const value = field === 'code' ? values.code() : values[field];
        if (!value) return { status: 'field_not_found', filled: [] };
        if (!value.reveal(v => /^[\x20-\x7e]{1,4096}$/.test(v))) return { status: 'needs_person', filled: [] };
        // A named reference still has to be focused. Never type into whatever another screen focused in the meantime.
        if (!element.focused) return { status: 'wrong_field', filled: [] };
        await value.reveal(v => driver.type(state.grant.binding.serial, v, stop));
        return { status: 'filled', filled: [field] };
      });
    } catch { return { status: 'target_gone', filled: [] }; }
  }
}
