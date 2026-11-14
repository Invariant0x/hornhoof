import { setTimeout as sleep } from 'node:timers/promises';
import type { Served } from '../tls/manager.js';
import { certInfo } from '../tls/x509.js';
import { freshState } from './state.js';

type ServedOptions = { dir: string; timeoutMs?: number; everyMs?: number; now?: () => number };

/* The keeper reads the link every 3 s and gives its word every second, so this leaves room for a busy machine. */
const TIMEOUT_MS = 20_000;
const EVERY_MS = 500;

/* The app's end of the keeper's listener. The certificate's manager moves the link to https only on what this says, so it
   goes by what the keeper's word says it holds, and never by what the app asked of it. The key stays out of it. */
export class KeeperServed implements Served {
  constructor(private readonly opts: ServedOptions) {}

  async use(host: string | null, cert: { certPem: string; keyPem: string } | null): Promise<void> {
    const fingerprint256 = cert ? certInfo(cert.certPem).fingerprint256 : null;
    const { timeoutMs = TIMEOUT_MS, everyMs = EVERY_MS } = this.opts;
    for (let waited = 0; waited < timeoutMs; waited += everyMs) {
      if (this.says(host, fingerprint256)) return;
      await sleep(everyMs);
    }
    throw new Error('The keeper does not serve this certificate yet.');
  }

  private says(host: string | null, fingerprint256: string | null): boolean {
    const link = freshState(this.opts.dir, (this.opts.now ?? Date.now)())?.link;
    return link?.host === host && link.fingerprint256 === fingerprint256;
  }
}
