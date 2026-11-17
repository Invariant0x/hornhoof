import https from 'node:https';
import type { TLSSocket } from 'node:tls';
import { certInfo } from './x509.js';

type ProbeOptions = {
  tries?: number;
  everyMs?: number;
  timeoutMs?: number;
  deadlineMs?: number;
  /* Extra trust, for tests. */
  ca?: string;
};

const DEFAULTS = { tries: 20, everyMs: 3000, timeoutMs: 5000, deadlineMs: 60_000 };

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function fingerprintOf(certPem: string): string | null {
  try {
    return certInfo(certPem).fingerprint256;
  } catch {
    return null;
  }
}

/* One GET on a connection of its own, since the agent's would keep the certificate of the first answer. Any failure, and
   an answer that does not come in time, is a no. */
function answersWith(url: string, fingerprint: string, timeoutMs: number, ca?: string): Promise<boolean> {
  return new Promise(resolve => {
    const req = https.get(`${url}/api/health`, { agent: false, ca }, res => {
      const peer = (res.socket as TLSSocket).getPeerCertificate();
      resolve(res.statusCode === 200 && peer.fingerprint256 === fingerprint);
      req.destroy();
    });
    const timer = setTimeout(() => req.destroy(), timeoutMs);
    req.on('error', () => resolve(false));
    req.on('close', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

/* Whether the link really carries this certificate to this machine. The relay's own TLS would answer on the same address,
   so the answer counts only from the certificate itself, and it may take the tunnel some seconds to come up. */
export async function probe(url: string, certPem: string, opts: ProbeOptions = {}): Promise<boolean> {
  const { tries, everyMs, timeoutMs, deadlineMs, ca } = { ...DEFAULTS, ...opts };
  const fingerprint = fingerprintOf(certPem);
  if (fingerprint === null) return false;
  const deadline = Date.now() + deadlineMs;
  for (let left = tries; left > 0 && Date.now() < deadline; left--) {
    if (await answersWith(url, fingerprint, Math.min(timeoutMs, deadline - Date.now()), ca)) return true;
    if (left > 1) await pause(Math.min(everyMs, Math.max(0, deadline - Date.now())));
  }
  return false;
}
