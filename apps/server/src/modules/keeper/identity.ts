import type { Target } from '../../net/proxy.js';
import { keyPrint } from '../computer/owner-key.js';
import type { HostOs } from '../network/ids.js';
import { askApp } from './app-call.js';
import { CertificateKeeper, type HeldCertificate } from './certificate.js';
import { Hourly, machineKey, reasonOf, type MachineKey } from './machine-keys.js';
import { Measures, type Internet } from './measures.js';

const KEY_RETRY_MS = 60_000;
const REPORT_EVERY_MS = 20_000;
/* A host's name as the report takes it; one written another way is left out, and the report goes without it. */
const HOSTNAME = /^[A-Za-z0-9._-]{1,120}$/;

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
  /* What measures the machine's connection to the internet; none where a test gives none. */
  internet?: Internet;
  /* What measures the machine, when its keeper made it already to go by it too; else made here with sampleMs and
     internet. */
  measures?: Measures;
  /* Where the machine can be dialed on its local networks, and the name of its host, to report with the measures. */
  addresses?: () => string[];
  hostname?: string | null;
  /* The computer's system, when known, and the key of its owner that this keeper holds, when it holds one. */
  os?: HostOs | null;
  /* What the machine's updater learned of its system and its name, asked where the settings give neither. */
  found?: () => { os: HostOs | null; hostname: string | null };
  ownerKey?: string | null;
  /* What a test's keeper reports as its place in place of its own. */
  reportAs?: () => { addresses: string[]; peerPort: number; webPort: number };
  /* The machine's key for backups and the bundles it holds, once it has the key. */
  backups?: () => { ageKey: string; heldBackups: string[] } | null;
};

/* A port as compose gives it in the environment; null for anything that is no port. */
const portOf = (value: string | undefined): number | null => (/^[1-9]\d{0,4}$/.test(value ?? '') && Number(value) <= 65535 ? Number(value) : null);

/* The ports this machine publishes, from the names compose gives the keeper. */
export const publishedFrom = (env: NodeJS.ProcessEnv): Published => ({ web: portOf(env.HORNHOOF_PORT), peer: portOf(env.HORNHOOF_PEER_PORT) });


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
  private readonly hourly = new Hourly();
  private reporting: Promise<void> | null = null;
  /* Ends what the keeper has asked its app for when it stops. */
  private readonly stopping = new AbortController();

  constructor(private readonly opts: IdentityOptions) {
    this.measures = opts.measures ?? new Measures({ dir: opts.dir, sampleMs: opts.sampleMs, internet: opts.internet });
  }

  /* The fsync p99 of this machine's disk as measured so far, the same one the report carries. */
  fsyncP99(): number | null {
    return this.measures.fsyncP99();
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
    this.stopping.abort();
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
    const res = await askApp(this.opts.app, 'POST', '/api/network/certificate', { signKey }, this.stopping.signal);
    if (!res.ok) throw new Error(`the app answered ${res.status}`);
    return res.json() as HeldCertificate;
  }

  /* Only where the app leads, since only there the measures are kept. A report that fails is said once an hour at most. */
  private async report(): Promise<void> {
    if (this.stopped || !this.opts.leading()) return;
    try {
      const { web, peer } = this.opts.published;
      const place = this.opts.reportAs?.() ?? { addresses: this.opts.addresses?.() ?? [], ...(web ? { webPort: web } : {}), ...(peer ? { peerPort: peer } : {}) };
      const found = this.opts.os && this.opts.hostname ? null : (this.opts.found?.() ?? null);
      const [os, hostname] = [this.opts.os ?? found?.os ?? null, this.opts.hostname || found?.hostname || null];
      const told = { ...(os ? { os } : {}), pin: this.opts.ownerKey ? keyPrint(this.opts.ownerKey) : null };
      const body = { ...this.measures.snapshot(), ...(this.opts.commit ? { commit: this.opts.commit.slice(0, 64) } : {}), ...(HOSTNAME.test(hostname ?? '') ? { hostname } : {}), ...told, ...place };
      /* What only a newer app takes: the machine's key for backups with what it holds, and its way to the internet. */
      const network = this.measures.network();
      const backups = this.opts.backups?.() ?? null;
      /* An app of a build before, which runs for a while during an update, refuses words it does not know: the report
         goes again at once without the newest of them, then without any, so the machine's measures are not lost
         meanwhile. */
      const tries = [
        ...(Object.keys(network).length > 0 ? [{ ...body, ...backups, ...network }] : []),
        ...(backups ? [{ ...body, ...backups }] : []),
        body,
      ];
      let res = await askApp(this.opts.app, 'POST', '/api/network/report', tries[0]!, this.stopping.signal);
      for (const words of tries.slice(1)) {
        if (res.status !== 400) break;
        res = await askApp(this.opts.app, 'POST', '/api/network/report', words, this.stopping.signal);
      }
      if (!res.ok) throw new Error(`the app answered ${res.status}`);
    } catch (err) {
      if (this.stopped) return;
      if (this.hourly.due('report')) this.opts.log(`Could not report this machine's measures to the app: ${reasonOf(err)}`);
    }
  }
}
