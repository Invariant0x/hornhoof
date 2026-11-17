import type { Ctx } from '../../app.js';
import { decryptSecret, encryptSecret } from '../../crypto/secrets.js';
import type { Db } from '../../db/client.js';
import { linkTls, publicLinks } from '../../db/schema.js';
import { loggable } from '../../errors.js';
import type { Health } from '../link/relay.js';
import { AcmeAccount, AcmeError, newAccountKey } from './acme.js';
import { certId, renewalInfo, type RenewalWindow } from './ari.js';
import { probe } from './checks.js';
import { linkMode, mayRunHttps, saveTls, tlsOf, updateTls, type TlsRow } from './store.js';
import { certInfo, namesHost } from './x509.js';

const TICK_MS = 60_000;
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const SELF_CHECK_WAIT_MS = 5 * MINUTE_MS;
const FAILED_ORDER_WAIT_MS = HOUR_MS;
const ASK_WITHOUT_RENEWAL_INFO_MS = 6 * HOUR_MS;
const ASK_AFTER_ERROR_MS = HOUR_MS;
const HEALTH_OLD_MS = 10 * MINUTE_MS;
const HTTPS_BLOCK_MS = HOUR_MS;

export type Acme = Pick<AcmeAccount, 'account' | 'issue'>;
export type Served = { use(host: string | null, cert: { certPem: string; keyPem: string } | null): Promise<void> };
export type TlsView = { mode: 'http' | 'https'; certificate: boolean; expiresAt: string | null; failedAt: string | null };

type TunnelMode = TlsRow['mode'];
type Link = { companyId: string; name: string; url: string };
/* A certificate that is in, for the name of the link it was asked about. */
type Held = { certPem: string; keyEnc: string; notAfter: Date };
type OrderTry = { accountUrl: string | null; replaces: string | null };
type RenewalAnswer = RenewalWindow | null | 'error';
type ModeFacts = { rowMode: TunnelMode; canServe: boolean; health: Health | null; blockedUntil: Date | null };
type LinkTlsOptions = {
  acme?: (directory: string, accountKeyPem: string, accountUrl: string | null) => Acme;
  renewalInfo?: typeof renewalInfo;
  probe?: typeof probe;
  now?: () => number;
  random?: () => number;
};

const hasType = (err: AcmeError, ending: string): boolean => err.type?.endsWith(ending) ?? false;

/* What to order with after a refusal, or null to take it as the failure. Each answer gives up one of the two things tried
   with, so a refused order comes back at most twice. */
export function nextOrderTry(err: unknown, tried: OrderTry): OrderTry | null {
  if (!(err instanceof AcmeError) || err.kind !== 'refused') return null;
  if (hasType(err, 'accountDoesNotExist')) return tried.accountUrl === null ? null : { ...tried, accountUrl: null };
  return tried.replaces === null || hasType(err, 'rateLimited') ? null : { ...tried, replaces: null };
}

function renewAtIn(window: RenewalWindow, renewAt: Date | null, now: number, random: () => number): Date {
  const [start, end] = [window.start.getTime(), window.end.getTime()];
  if (renewAt && start <= renewAt.getTime() && renewAt.getTime() <= end) return renewAt;
  return end <= now ? new Date(now) : new Date(start + random() * (end - start));
}

const twoThirdsOf = ({ notBefore, notAfter }: { notBefore: Date; notAfter: Date }): Date => new Date(notBefore.getTime() + (2 / 3) * (notAfter.getTime() - notBefore.getTime()));

const clamp = (value: number, least: number, most: number): number => Math.min(most, Math.max(least, value));

/* When to renew and when to ask the CA again, after what it said about this certificate. */
export function renewalPlan(answer: RenewalAnswer, cert: { renewAt: Date | null; notBefore: Date; notAfter: Date }, now: number, random: () => number): { renewAt: Date; askAt: Date } {
  if (answer === null) return { renewAt: cert.renewAt ?? twoThirdsOf(cert), askAt: new Date(now + ASK_WITHOUT_RENEWAL_INFO_MS) };
  if (answer === 'error') return { renewAt: cert.renewAt ?? twoThirdsOf(cert), askAt: new Date(now + ASK_AFTER_ERROR_MS) };
  return { renewAt: renewAtIn(answer, cert.renewAt, now, random), askAt: new Date(now + clamp(answer.retryAfterS * 1000, HOUR_MS, DAY_MS)) };
}

/* Fails toward a working link: a certificate that cannot serve means http, and a relay nobody has heard from changes
   nothing, since dropping https on every hiccup of its health would make the link blink. */
export function wantedMode({ rowMode, canServe, health, blockedUntil }: ModeFacts, now: number): TunnelMode {
  if (!canServe) return 'http';
  if (!health?.up) return rowMode;
  const blocked = blockedUntil !== null && blockedUntil.getTime() > now;
  return health.passthrough && !blocked ? 'https' : 'http';
}

/* The wait after a failed order. A check of its own that failed costs nothing at the CA, so that one comes back soon. */
export function failureFields(failure: AcmeError, now: number): Pick<TlsRow, 'nextTryAt' | 'failure' | 'failedAt'> {
  const waitMs = failure.kind === 'not_ready' ? SELF_CHECK_WAIT_MS : Math.max(FAILED_ORDER_WAIT_MS, (failure.retryAfterS ?? 0) * 1000);
  return { nextTryAt: new Date(now + waitMs), failure: failure.type ?? failure.kind, failedAt: new Date(now) };
}

function certificateOf(row: TlsRow, link: Link): Held | null {
  const { name, certPem, certKeyEnc, notAfter } = row;
  return name === link.name && certPem && certKeyEnc && notAfter ? { certPem, keyEnc: certKeyEnc, notAfter } : null;
}

const isPast = (date: Date | null, now: number): boolean => date === null || date.getTime() <= now;

function dueToOrder(row: TlsRow, link: Link, now: number): boolean {
  const renewing = row.renewAt !== null && row.renewAt.getTime() <= now;
  return (certificateOf(row, link) === null || renewing) && isPast(row.nextTryAt, now);
}

/* Only a renewal of the same name at the same CA replaces anything: another CA does not know the old certificate. */
function replacesOf(row: TlsRow, link: Link): string | null {
  const held = certificateOf(row, link);
  return held && row.certDirectory === row.directory ? certId(held.certPem) : null;
}

const hostOf = (link: Link): string => new URL(link.url).hostname;

/* What the listener is to serve: the link's host, with its certificate once that is in. */
function servingOf(link: Link | null, row: TlsRow | null): { host: string | null; held: Held | null } {
  if (!link) return { host: null, held: null };
  return { host: hostOf(link), held: row && certificateOf(row, link) };
}

/* What the listener holds, to tell a change. Only public things go in. */
const servedKey = (host: string | null, certPem: string | null): string => JSON.stringify([host, certPem]);

/* The link a certificate is ordered for: the one people open. A hidden name serves no page, so the authority could
   never check it and nobody would ever see its certificate. */
async function linkOfCompany(db: Db): Promise<Link | null> {
  const [link] = await db.select({ companyId: publicLinks.companyId, name: publicLinks.name, url: publicLinks.url, hidden: publicLinks.hidden }).from(publicLinks).limit(1);
  return link && !link.hidden ? { companyId: link.companyId, name: link.name, url: link.url } : null;
}

/* The certificate of the company's link: it decides when to order, renew and back off, and which mode the tunnel runs in.
   One pass at a time, so what the last ACME answer said is the failed step's, and only one writer moves the mode. */
export class LinkTls {
  private readonly acme: NonNullable<LinkTlsOptions['acme']>;
  private readonly renewalInfo: typeof renewalInfo;
  private readonly probe: typeof probe;
  private readonly now: () => number;
  private readonly random: () => number;
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private stopped = false;
  private firstPass = true;
  private listener: Served | null = null;
  private given: string | null = null;
  private health: { answer: Health; at: number } | null = null;
  private unwritten = false;

  constructor(
    private readonly ctx: Ctx,
    opts: LinkTlsOptions = {},
  ) {
    this.acme = opts.acme ?? ((directory, accountKeyPem, accountUrl) => new AcmeAccount(directory, accountKeyPem, accountUrl));
    this.renewalInfo = opts.renewalInfo ?? renewalInfo;
    this.probe = opts.probe ?? probe;
    this.now = opts.now ?? Date.now;
    this.random = opts.random ?? Math.random;
  }

  /* Not awaited by anyone who starts it: a pass may take minutes. */
  start(): void {
    if (this.ctx.config.acmeDirectory === null || this.timer) return;
    this.stopped = false;
    this.firstPass = true;
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref();
    void this.tick();
  }

  /* A pass under way still ends the order it began, but a machine that stopped leading moves no mode and writes no tunnel. */
  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  tick(): Promise<void> {
    const directory = this.ctx.config.acmeDirectory;
    if (directory === null || this.stopped) return Promise.resolve();
    this.running ??= this.pass(directory).finally(() => {
      this.running = null;
    });
    return this.running;
  }

  kick(): void {
    if (this.timer) void this.tick();
  }

  async serveOn(listener: Served): Promise<void> {
    this.listener = listener;
    this.given = null;
    const link = await linkOfCompany(this.ctx.db);
    const on = this.ctx.config.acmeDirectory !== null;
    await this.giveListener(link, link && on ? await tlsOf(this.ctx.db, link.companyId) : null);
  }

  async view(): Promise<TlsView | null> {
    const { db, config } = this.ctx;
    const link = await linkOfCompany(db);
    if (!link) return null;
    const row = config.acmeDirectory === null ? null : await tlsOf(db, link.companyId);
    const held = row && certificateOf(row, link);
    return { mode: await linkMode(db, config), certificate: held !== null, expiresAt: held?.notAfter.toISOString() ?? null, failedAt: row?.failedAt?.toISOString() ?? null };
  }

  /* Never throws, so the timer and whoever kicked it have nothing to catch; the next pass starts over from the database. */
  private async pass(directory: string): Promise<void> {
    try {
      const link = await linkOfCompany(this.ctx.db);
      const row = link ? await this.withLink(link, directory) : await this.withoutLink();
      await this.giveListener(link, row);
      await this.settleMode(link, row);
    } catch (err) {
      this.ctx.log.warn({ error: loggable(err) }, "A pass of the link's certificate failed.");
    }
  }

  private async withLink(link: Link, directory: string): Promise<TlsRow> {
    const row = await this.withAccount(link, directory);
    const ordered = await this.orderIfDue(link, row);
    const planned = await this.planRenewal(link, ordered);
    if (!this.health || this.now() - this.health.at >= HEALTH_OLD_MS) await this.askHealth();
    return planned;
  }

  /* The account stays when the link goes, and a removed link's certificate stops being offered. */
  private async withoutLink(): Promise<TlsRow | null> {
    const [row] = await this.ctx.db.select().from(linkTls).limit(1);
    if (!row?.certPem) return row ?? null;
    return this.changed(row, { name: null, certPem: null, certDirectory: null, certKeyEnc: null, notAfter: null, renewAt: null, askAt: null, mode: 'http' });
  }

  /* A certificate the row holds stays when the CA changes, and is renewed through the new account. */
  private async withAccount(link: Link, directory: string): Promise<TlsRow> {
    const { db, config } = this.ctx;
    const row = await tlsOf(db, link.companyId);
    if (row?.directory === directory) return row;
    await saveTls(db, link.companyId, { directory, accountKeyEnc: encryptSecret(await newAccountKey(), config.secret), accountUrl: null });
    return (await tlsOf(db, link.companyId))!;
  }

  private async changed(row: TlsRow, fields: Partial<Omit<TlsRow, 'companyId'>>): Promise<TlsRow> {
    await updateTls(this.ctx.db, row.companyId, fields);
    return { ...row, ...fields };
  }

  private async orderIfDue(link: Link, row: TlsRow): Promise<TlsRow> {
    if (!dueToOrder(row, link, this.now())) return row;
    try {
      return await this.order(link, row);
    } catch (err) {
      const failure = err instanceof AcmeError ? err : new AcmeError('invalid');
      /* Saved first: a row that went meanwhile is the pass's failure, and its one line, not this one's too. */
      const failed = await this.changed(row, failureFields(failure, this.now()));
      this.ctx.log.warn({ kind: failure.kind, type: failure.type }, "Could not get the link's certificate.");
      return failed;
    }
  }

  private async order(link: Link, row: TlsRow): Promise<TlsRow> {
    const host = hostOf(link);
    const { certPem, keyPem } = await this.issue(row, host, { accountUrl: row.accountUrl, replaces: replacesOf(row, link) });
    const info = certInfo(certPem);
    if (!namesHost(info, host)) throw new AcmeError('invalid', { detail: "the chain does not name the link's host" });
    return this.changed(row, {
      name: link.name,
      certPem,
      certDirectory: row.directory,
      certKeyEnc: encryptSecret(keyPem, this.ctx.config.secret),
      notAfter: info.notAfter,
      renewAt: null,
      askAt: new Date(this.now()),
      nextTryAt: null,
      failure: null,
      failedAt: null,
      /* A new name's first https goes through the mode's probe. */
      ...(row.name === link.name ? {} : { mode: 'http' as const }),
    });
  }

  private async issue(row: TlsRow, host: string, tried: OrderTry): Promise<Awaited<ReturnType<Acme['issue']>>> {
    const acme = this.acme(row.directory, decryptSecret(row.accountKeyEnc, this.ctx.config.secret), tried.accountUrl);
    if (tried.accountUrl === null) await updateTls(this.ctx.db, row.companyId, { accountUrl: await acme.account() });
    try {
      return await acme.issue(host, this.ctx.challenges, tried.replaces === null ? {} : { replaces: tried.replaces });
    } catch (err) {
      const next = nextOrderTry(err, tried);
      if (next === null) throw err;
      return this.issue(row, host, next);
    }
  }

  private async planRenewal(link: Link, row: TlsRow): Promise<TlsRow> {
    const held = certificateOf(row, link);
    if (!held || !isPast(row.askAt, this.now())) return row;
    const answer = await this.renewalInfo(row.directory, held.certPem).catch((): RenewalAnswer => 'error');
    const { notBefore, notAfter } = certInfo(held.certPem);
    return this.changed(row, renewalPlan(answer, { renewAt: row.renewAt, notBefore, notAfter }, this.now(), this.random));
  }

  private async askHealth(): Promise<Health> {
    const answer = await this.ctx.links.relay.health();
    this.health = { answer, at: this.now() };
    return answer;
  }

  /* A listener that refuses costs one line: the next pass gives it again, and until then the mode is http. */
  private async giveListener(link: Link | null, row: TlsRow | null): Promise<void> {
    const { host, held } = servingOf(link, row);
    const wanted = servedKey(host, held?.certPem ?? null);
    if (!this.listener || this.given === wanted) return;
    this.given = null;
    try {
      await this.listener.use(host, this.keyPair(held));
      this.given = wanted;
    } catch {
      this.ctx.log.warn("The link's listener did not take its certificate.");
    }
  }

  private keyPair(held: Held | null): { certPem: string; keyPem: string } | null {
    return held && { certPem: held.certPem, keyPem: decryptSecret(held.keyEnc, this.ctx.config.secret) };
  }

  private async settleMode(link: Link | null, row: TlsRow | null): Promise<void> {
    const first = this.firstPass;
    this.firstPass = false;
    if (this.stopped) return;
    if (this.unwritten) await this.writeTunnel();
    if (link && row) await this.moveMode(link, row, first);
  }

  private async moveMode(link: Link, row: TlsRow, first: boolean): Promise<void> {
    const held = certificateOf(row, link);
    if (held && this.wantsHttps(link, row, held)) return this.runHttps(link, row, held, first);
    if (row.mode === 'https') await this.saveMode(row, { mode: 'http' });
  }

  private wantsHttps(link: Link, row: TlsRow, held: Held): boolean {
    const now = this.now();
    const facts = {
      rowMode: row.mode,
      canServe: this.given === servedKey(hostOf(link), held.certPem) && this.mayServe(link, row, now),
      health: this.health?.answer ?? null,
      blockedUntil: row.httpsBlockedUntil,
    };
    return wantedMode(facts, now) === 'https';
  }

  /* The rule the tunnel's file is written by, asked as if the row were in https. What cannot be read cannot serve. */
  private mayServe(link: Link, row: TlsRow, now: number): boolean {
    try {
      return mayRunHttps({ ...row, mode: 'https' }, link, this.ctx.config.secret, new Date(now));
    } catch {
      return false;
    }
  }

  private async runHttps(link: Link, row: TlsRow, held: Held, first: boolean): Promise<void> {
    if (row.mode === 'https') {
      if (first) await this.checkCarried(link, row, held);
      return;
    }
    const health = await this.askHealth();
    if (this.stopped || !health.up || !health.passthrough) return;
    await this.saveMode(row, { mode: 'https' });
    await this.checkCarried(link, row, held);
  }

  /* A relay can say it passes TLS through and still not carry this name, which would take the link down. */
  private async checkCarried(link: Link, row: TlsRow, held: Held): Promise<void> {
    if ((await this.probe(link.url, held.certPem)) || this.stopped) return;
    await this.saveMode(row, { mode: 'http', httpsBlockedUntil: new Date(this.now() + HTTPS_BLOCK_MS) });
  }

  private async saveMode(row: TlsRow, fields: Pick<TlsRow, 'mode'> & Partial<Pick<TlsRow, 'httpsBlockedUntil'>>): Promise<void> {
    await updateTls(this.ctx.db, row.companyId, fields);
    await this.writeTunnel();
  }

  private async writeTunnel(): Promise<void> {
    this.unwritten = !(await this.ctx.links.sync());
  }
}
