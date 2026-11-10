import type { Target } from '../../net/proxy.js';
import { askApp } from './app-call.js';
import { CertificateKeeper, type HeldCertificate } from './certificate.js';
import { machineKey, type MachineKey } from './machine-keys.js';
import { Measures } from './measures.js';

const KEY_RETRY_MS = 60_000;
const REPORT_EVERY_MS = 20_000;
const SAY_AGAIN_MS = 3_600_000;

export type Published = { web: number | null; peer: number | null };
export type IdentityOptions = {
  /* The keeper's own folder, in a volume of its own: the machine's key never leaves it. */
  dir: string;
  app: Target;
  commit: string;
  /* The machine's ports as compose publishes them. */
  published: Published;
  leading: () => boolean;
  log: (line: string) => void;
  reportEveryMs?: number;
  keyRetryMs?: number;
  sampleMs?: number;
};

/* A port as compose gives it in the environment; null for anything that is no port. */
const portOf = (value: string | undefined): number | null => (/^[1-9]\d{0,4}$/.test(value ?? '') && Number(value) <= 65535 ? Number(value) : null);

/* The ports this machine publishes, from the names compose gives the keeper. */
export const publishedFrom = (env: NodeJS.ProcessEnv): Published => ({ web: portOf(env.HORNHOOF_PORT), peer: portOf(env.HORNHOOF_PEER_PORT) });

const reasonOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/* What the machine is to the company's network, kept by its keeper: its key, the certificate the leading app gives for
   that key, and what the keeper measures of the machine and reports while the app leads. None of it holds back what the
   company runs today: a key the folder cannot keep, a certificate the app cannot give yet and a report that fails are
   each tried again. */
export class MachineIdentity {
  private key: MachineKey | null = null;
  private certificates: CertificateKeeper | null = null;
  private readonly measures: Measures;
  private readonly listeners: Array<(held: HeldCertificate) => void> = [];
  private keyTimer: NodeJS.Timeout | undefined;
  private reportTimer: NodeJS.Timeout | undefined;
  private stopped = false;
  private keyFailureSaid = false;
  private reportFailureSaidAt: number | null = null;
  private reporting: Promise<void> | null = null;

  constructor(private readonly opts: IdentityOptions) {
    this.measures = new Measures({ dir: opts.dir, sampleMs: opts.sampleMs });
  }

  start(): void {
    this.takeKey();
    this.measures.start();
    this.reportTimer = setInterval(() => this.reportUnlessBusy(), this.opts.reportEveryMs ?? REPORT_EVERY_MS);
    this.reportTimer.unref();
  }

  /* Waits for a report on its way, so nothing of this still asks the app once it has stopped. */
  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.keyTimer);
    clearInterval(this.reportTimer);
    this.certificates?.stop();
    this.measures.stop();
    await this.reporting;
  }

  /* One report at a time: an app that is slow to answer never collects a pile of them. */
  private reportUnlessBusy(): void {
    if (this.reporting) return;
    this.reporting = this.report().finally(() => { this.reporting = null; });
  }

  machineKey(): MachineKey | null {
    return this.key;
  }

  certificate(): HeldCertificate | null {
    return this.certificates?.current() ?? null;
  }

  /* Asks for a new certificate now, whatever it holds. */
  renewNow(): void {
    this.certificates?.renewNow();
  }

  onCertificate(fn: (held: HeldCertificate) => void): void {
    this.listeners.push(fn);
  }

  /* A folder that cannot be written is said once and tried again, with the front door, the lease and the link running on. */
  private takeKey(): void {
    if (this.stopped) return;
    try {
      this.key = machineKey(this.opts.dir);
    } catch (err) {
      if (!this.keyFailureSaid) this.opts.log(`The keeper cannot keep this machine's key in ${this.opts.dir}: ${reasonOf(err)}. It tries again each minute; until then this machine has no certificate.`);
      this.keyFailureSaid = true;
      this.keyTimer = setTimeout(() => this.takeKey(), this.opts.keyRetryMs ?? KEY_RETRY_MS);
      this.keyTimer.unref();
      return;
    }
    this.certificates = new CertificateKeeper({ dir: this.opts.dir, key: this.key, ask: signKey => this.ask(signKey), log: this.opts.log });
    this.certificates.onChange(held => { for (const listener of this.listeners) listener(held); });
    this.certificates.start();
  }

  private async ask(signKey: string): Promise<HeldCertificate> {
    const res = await askApp(this.opts.app, 'POST', '/api/network/certificate', { signKey });
    if (!res.ok) throw new Error(`the app answered ${res.status}`);
    return res.json() as HeldCertificate;
  }

  /* Only where the app leads, since only there the measures are kept. A report that fails is said once an hour at most. */
  private async report(): Promise<void> {
    if (this.stopped || !this.opts.leading()) return;
    try {
      const { web, peer } = this.opts.published;
      const body = { ...this.measures.snapshot(), ...(this.opts.commit ? { commit: this.opts.commit.slice(0, 64) } : {}), ...(web ? { webPort: web } : {}), ...(peer ? { peerPort: peer } : {}) };
      const res = await askApp(this.opts.app, 'POST', '/api/network/report', body);
      if (!res.ok) throw new Error(`the app answered ${res.status}`);
    } catch (err) {
      const now = Date.now();
      if (this.reportFailureSaidAt !== null && now - this.reportFailureSaidAt < SAY_AGAIN_MS) return;
      this.reportFailureSaidAt = now;
      this.opts.log(`Could not report this machine's measures to the app: ${reasonOf(err)}`);
    }
  }
}
