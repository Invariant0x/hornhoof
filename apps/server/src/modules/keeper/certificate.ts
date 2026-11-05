import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { certFacts, issuedBy, needsRenewal } from '../network/authority.js';
import type { MachineRole } from '../network/authority.js';
import { writePrivately } from './machine-keys.js';
import type { MachineKey } from './machine-keys.js';

export const CERT_FILE = 'certificate.json';
const RETRY_MS = 10_000;
const EVERY_MS = 3_600_000;
const NOT_FOR_THIS_KEY = "The app's answer is not a certificate for this machine's key.";

export type HeldCertificate = { machine: string; role: MachineRole; certPem: string; authorityPem: string; until: string };
export type CertificateKeeperOptions = {
  dir: string;
  key: MachineKey;
  ask: (signKey: string) => Promise<HeldCertificate>;
  now?: () => Date;
  retryMs?: number;
  everyMs?: number;
  log: (line: string) => void;
};

const HeldShape: z.ZodType<HeldCertificate> = z.object({
  machine: z.string(),
  role: z.enum(['data', 'worker']),
  certPem: z.string(),
  authorityPem: z.string(),
  until: z.string(),
});

const reasonOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function fitsKey(held: HeldCertificate, key: MachineKey): boolean {
  try {
    const facts = certFacts(held.certPem);
    const namesItself = facts.machineId === held.machine && facts.role === held.role;
    return facts.signKey === key.publicPem && namesItself && issuedBy(held.authorityPem, held.certPem);
  } catch {
    return false;
  }
}

/* One check for the file and for the app's answer, so what the keeper holds always fits its key and itself, and carries
   nothing else. */
function heldFor(value: unknown, key: MachineKey): HeldCertificate | null {
  const parsed = HeldShape.safeParse(value);
  return parsed.success && fitsKey(parsed.data, key) ? parsed.data : null;
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

export function readHeldCertificate(dir: string, key: MachineKey): HeldCertificate | null {
  return heldFor(readJson(join(dir, CERT_FILE)), key);
}

export class CertificateKeeper {
  private held: HeldCertificate | null;
  private readonly listeners: Array<(held: HeldCertificate) => void> = [];
  private timer: NodeJS.Timeout | null = null;
  private asking = false;
  private told = false;
  private stopped = false;
  /* A failure that lasts is said once, since the keeper tries again every few seconds for as long as the app is away. */
  private lastFailure: string | null = null;

  constructor(private readonly opts: CertificateKeeperOptions) {
    this.held = readHeldCertificate(opts.dir, opts.key);
  }

  current(): HeldCertificate | null {
    return this.held;
  }

  start(): void {
    this.stopped = false;
    this.look();
  }

  renewNow(): void {
    this.told = true;
    this.look();
  }

  onChange(fn: (held: HeldCertificate) => void): void {
    this.listeners.push(fn);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /* One ask at a time. A word that comes during an ask stays in told and is acted on when that ask ends. */
  private look(): void {
    if (this.stopped || this.asking) return;
    if (this.due()) void this.ask();
    else this.lookAgainAfter(this.opts.everyMs ?? EVERY_MS);
  }

  private due(): boolean {
    if (this.told || !this.held) return true;
    return needsRenewal(certFacts(this.held.certPem), this.opts.now?.() ?? new Date());
  }

  private lookAgainAfter(ms: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.look(), ms);
    this.timer.unref();
  }

  private async ask(): Promise<void> {
    const told = this.told;
    this.told = false;
    this.asking = true;
    const answer = await this.answer();
    this.asking = false;
    if (this.stopped) return;
    if (!answer) {
      this.told ||= told;
      return this.lookAgainAfter(this.opts.retryMs ?? RETRY_MS);
    }
    this.take(answer);
    // Not due() again: a machine whose clock runs ahead would find every answer old and ask without a pause.
    this.lookAgainAfter(this.told ? 0 : (this.opts.everyMs ?? EVERY_MS));
  }

  private async answer(): Promise<HeldCertificate | null> {
    try {
      const held = heldFor(await this.opts.ask(this.opts.key.publicPem), this.opts.key);
      if (!held) throw new Error(NOT_FOR_THIS_KEY);
      this.lastFailure = null;
      return held;
    } catch (err) {
      this.sayFailure(reasonOf(err));
      return null;
    }
  }

  private sayFailure(reason: string): void {
    if (reason !== this.lastFailure) this.opts.log(`Could not get this machine's certificate: ${reason}`);
    this.lastFailure = reason;
  }

  private take(held: HeldCertificate): void {
    this.keepOnDisk(held);
    this.held = held;
    for (const listener of this.listeners) this.announce(listener, held);
  }

  /* A folder that refuses it costs the certificate only at the next start. Asking again instead would add a certificate
     to the company's database every few seconds for as long as the disk is full. */
  private keepOnDisk(held: HeldCertificate): void {
    try {
      writePrivately(join(this.opts.dir, CERT_FILE), JSON.stringify(held));
    } catch (err) {
      this.opts.log(`Could not keep this machine's certificate in its folder: ${reasonOf(err)}`);
    }
  }

  private announce(listener: (held: HeldCertificate) => void, held: HeldCertificate): void {
    try {
      listener(held);
    } catch (err) {
      this.opts.log(`A listener of the certificate failed: ${reasonOf(err)}`);
    }
  }
}
