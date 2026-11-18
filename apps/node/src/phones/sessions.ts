import { PHONE_LEASE_MS, PhoneGrant } from '@hornhoof/protocol';

type Held = { grant: PhoneGrant; stop: AbortController; timer: ReturnType<typeof setTimeout>; chain: Promise<unknown>; count: number };
export type PhoneSessionView = { grant: PhoneGrant; signal: AbortSignal; valid(): boolean };

const gone = () => new Error('phone_session_gone');

export class PhoneSessions {
  readonly #held = new Map<string, Held>();
  readonly #serials = new Map<string, Held>();
  readonly #fences = new Map<string, number>();

  holds(serial: string, hardwareKey: string): boolean {
    return this.#serials.has(serial) || [...this.#held.values()].some(held => held.grant.binding.hardwareKey === hardwareKey);
  }

  open(input: PhoneGrant): void {
    const grant = PhoneGrant.parse(input);
    const until = Date.parse(grant.expiresAt);
    if (until <= Date.now() || until > Date.now() + PHONE_LEASE_MS * 2) throw gone();
    const old = this.#serials.get(grant.binding.serial);
    if (this.#held.has(grant.sessionId) && this.#held.get(grant.sessionId) !== old) throw gone();
    if (old) {
      if (old.count || old.grant.sessionId !== grant.sessionId || old.grant.generation !== grant.generation) throw new Error('phone_busy');
      if (old.stop.signal.aborted) throw gone();
      if (JSON.stringify(old.grant.binding) !== JSON.stringify(grant.binding)) throw gone();
      this.renew(grant.sessionId, grant.generation, grant.expiresAt);
      return;
    }
    if (grant.generation <= (this.#fences.get(grant.binding.serial) ?? -1)) throw gone();
    const held: Held = { grant, stop: new AbortController(), timer: setTimeout(() => this.revoke(grant.sessionId, grant.generation), until - Date.now()), chain: Promise.resolve(), count: 0 };
    held.timer.unref();
    this.#held.set(grant.sessionId, held);
    this.#serials.set(grant.binding.serial, held);
    this.#fences.set(grant.binding.serial, grant.generation);
  }

  renew(id: string, generation: number, expiresAt: string): boolean {
    const held = this.#held.get(id);
    const until = Date.parse(expiresAt);
    if (!held || held.grant.generation !== generation || held.stop.signal.aborted || Date.parse(held.grant.expiresAt) <= Date.now() || !Number.isFinite(until) || until <= Date.now() || until > Date.now() + PHONE_LEASE_MS * 2) return false;
    clearTimeout(held.timer);
    held.grant = { ...held.grant, expiresAt };
    held.timer = setTimeout(() => this.revoke(id, generation), until - Date.now());
    held.timer.unref();
    return true;
  }

  view(id: string, generation: number): PhoneSessionView {
    const held = this.#held.get(id);
    if (!held || held.stop.signal.aborted || held.grant.generation !== generation || Date.parse(held.grant.expiresAt) <= Date.now()) throw gone();
    return { grant: held.grant, signal: held.stop.signal, valid: () => !held.stop.signal.aborted && Date.parse(held.grant.expiresAt) > Date.now() };
  }

  async use<T>(id: string, generation: number, work: (state: PhoneSessionView) => Promise<T>): Promise<T> {
    this.view(id, generation);
    const held = this.#held.get(id)!;
    held.count++;
    const result = held.chain.then(async () => {
      const before = this.view(id, generation);
      const answer = await work(before);
      if (!before.valid()) throw gone();
      return answer;
    });
    held.chain = result.catch(() => {});
    try { return await result; }
    finally {
      held.count--;
      if (held.stop.signal.aborted && held.count === 0) this.forget(held);
    }
  }

  revoke(id: string, generation: number): void {
    const held = this.#held.get(id);
    if (!held || generation < held.grant.generation) return;
    held.stop.abort();
    clearTimeout(held.timer);
    if (!held.count) this.forget(held);
  }

  fence(serial: string, generation: number): void {
    this.#fences.set(serial, Math.max(generation, this.#fences.get(serial) ?? -1));
    const held = this.#serials.get(serial);
    if (held && held.grant.generation <= generation) this.revoke(held.grant.sessionId, generation);
  }

  async drained(id: string): Promise<void> {
    await this.#held.get(id)?.chain;
  }

  close(): void {
    for (const held of this.#held.values()) this.revoke(held.grant.sessionId, held.grant.generation);
  }

  private forget(held: Held): void {
    this.#held.delete(held.grant.sessionId);
    this.#serials.delete(held.grant.binding.serial);
  }
}
