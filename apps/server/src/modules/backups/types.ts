import type { Manifest, RecoveryLink } from './bundle.js';

/* The messages between keepers and the app about backups, which both sides read. */

/* The free disk a machine needs to take a bundle, in bundles: the app picks holders by it, and each machine checks it
   again before it takes one. */
export const ROOM = 3;
/* The link of a recovery file, in the control folder of a server that is being restored from one: the app writes it,
   and the keeper's link child goes by it while the database has no link. */
export const RECOVERY_LINK = 'recovery-link.json';
/* How many of the bundles a machine holds its report names, newest first. */
export const REPORTED_BUNDLES = 16;
/* A bundle of a database set aside before a merge is kept this long from when it was made, outside the usual
   rotation, on the data machine and on its holders. */
export const FORK_KEEP_MS = 30 * 86_400_000;
/* The most a machine reports: its newest REPORTED_BUNDLES, and every fork it holds besides. */
export const REPORT_MAX = 32;

/* What the leading app tells its own keeper to restore. attempt: new for each start, so the same bundle can be tried
   again. source: the keeper's own store, or what a holder or a browser sent it. identity: the recovery file's, held in
   memory only, when the keeper's own key does not open the bundle. expect: what the database recorded of the bundle,
   when there is a database. carry: whether to carry over who may get in now; false after a total loss. */
export type RestoreOrder = {
  attempt: string; id: string; dumpedAt: string; source: 'store' | 'incoming'; identity: string | null;
  expect: { sha256: string; size: number; signer: string } | null; company: string; authorityPem: string; carry: boolean;
};
/* start is written only once the databases are swapped for good. */
export type RestoreStep = 'fetch' | 'check' | 'open' | 'load' | 'swap' | 'start';
/* dumpedAt: from when the restored database is, as the order had it; an updater from before merges does not say. */
export type RestoreStatus = { attempt: string; id: string; state: 'running' | 'done' | 'failed'; step: RestoreStep; line: string; at: string; kept: string | null; dumpedAt?: string };

/* What the data machine's keeper hears: whom to seal to, what was made last, which machines hold what, and what to
   fetch or restore. */
export type MakerView = {
  company: string | null;
  recipients: string[];
  recovery: { id: string; recipient: string; link: RecoveryLink | null } | null;
  last: { id: string; madeAt: string; recovery: string | null } | null;
  holders: Record<string, string[]>;
  wanted: { id: string; from: string }[];
  order: RestoreOrder | null;
  /* A database set aside before a merge that is not saved as a bundle yet: the bundle's id and the database's name. */
  fork: { id: string; database: string } | null;
};
/* What a machine that may keep bundles hears. keeps: its owner's tick; false tells it to delete what it holds. hold: the
   bundles to keep. want: the ones the leader asks it to send. */
export type HolderView = { keeps: boolean; hold: Pick<Manifest, 'id' | 'size' | 'sha256'>[]; want: string[] };

/* Who may get in now, taken from the database a restore replaces at the moment it closes, and applied to the restored
   one: a restore never brings back a person who was disabled or removed, a machine that was disconnected or a key that was
   replaced since the bundle. */
export type Carry = {
  /* A carry from an older updater can omit the removal fields. */
  people: { id: string; status: 'active' | 'invited' | 'disabled'; passwordHash: string | null; removedAt?: string | null; removedName?: string | null; scopeKind: string; isOwner: boolean; isCeoDelegate: boolean; access: { departmentId: string | null; teamId: string | null }[] }[];
  /* The hashes of the invites open now. */
  invites: string[];
  /* role, dataLeftAt, uploadState: whether the machine holds the company's data now, and what one that stopped still
     owes. An updater of the build before says none of the three, and the restored row keeps its own. */
  machines: { id: string; revoked: boolean; lendsTests: boolean; keepsBackups: boolean; computerClosed?: boolean | null; role?: 'data' | 'worker' | null; dataLeftAt?: string | null; uploadState?: 'waiting' | 'received' | 'kept' | null }[];
  /* Older updaters carried names alone. Keep the list readable by older servers. */
  serials: string[];
  /* Live revocations from both the certificate rows and earlier restores. */
  revokedSerials?: { serial: string; until: string }[];
  recoveryKeys: { id: string; recipient: string; linkPrint: string | null; linkName: string | null; linkUrl: string | null; madeBy: string; madeAt: string; retiredAt: string | null }[];
  /* The company's link as the relay takes it now, each secret sealed as it is stored; null: it has none now. And the
     secrets of the peer services, sealed the same way. Left out by an updater of the build before, and then the
     restored database keeps what the bundle has. */
  link?: { name: string; url: string; hidden?: boolean; keyEnc: string; nextKeyEnc: string | null; tunnelEnc: string; createdAt: string } | null;
  peerSecrets?: { kind: string; secretEnc: string; createdAt?: string }[];
  /* The assistants' keys that open something now, each signing secret sealed as it is stored.
     If either list is absent, both kinds of key are cleared. */
  assistantKeys?: { personId: string; keyHash: string; keyCreatedAt: string; wakeSecretEnc: string }[];
  /* The nodes' keys that open something now. An empty list means none may be restored. */
  nodeKeys?: { id: string; keyHash: string }[];
  /* The key the company's files are sealed with, sealed as it is stored; none from a database before the store, or before
     its first file. */
  fileKeyEnc?: string | null;
};
