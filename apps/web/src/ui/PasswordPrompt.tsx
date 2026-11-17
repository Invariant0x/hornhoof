import { useCallback, useEffect, useState, type KeyboardEvent, type ReactNode } from 'react';
import { ApiFailure } from '../api';
import { useT } from '../i18n';
import { canMakeKey, deviceKey, makeKey, serverKey, signGrant, unlockKey, type Grant, type StoredKey } from '../owner-key';
import { Field } from './Field';

/* Asks for the person's password: to make their own key with it, or to open that key on a device that does not keep it
   yet. onPassword answers false for a wrong password, which shows under the field; the person tries again or leaves
   it. */
export function PasswordPrompt({ purpose, onPassword, onCancel }: { purpose: 'make' | 'unlock'; onPassword(password: string): Promise<boolean>; onCancel(): void }) {
  const t = useT();
  const [password, setPassword] = useState('');
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState(false);

  async function send() {
    if (!password || busy) return;
    setBusy(true);
    setProblem('');
    try {
      if (!(await onPassword(password))) setProblem(t.subs.ownerKeyWrong);
    } catch {
      setProblem(t.common.somethingWrong);
    } finally {
      setBusy(false);
    }
  }

  /* Not a form of its own: the command it stands in for may sit inside one. */
  const onKey = (event: KeyboardEvent) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    void send();
  };

  return (
    <div className="owner-key">
      <p className="muted">{purpose === 'make' ? t.subs.ownerKeyMake : t.subs.ownerKeyUnlock}</p>
      <Field label={t.common.password} problem={problem || undefined}>
        {props => <input {...props} type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} onKeyDown={onKey} />}
      </Field>
      <div className="actions">
        <button className="btn" type="button" disabled={!password || busy} onClick={() => void send()}>{t.common.next}</button>
        <button className="btn ghost" type="button" onClick={onCancel}>{t.common.cancel}</button>
      </div>
    </div>
  );
}

/* One question on a page at a time: a second command that needs the key waits for the answer to the first. */
type Asked = { answer: Promise<string | null>; settle(key: string | null): void };
let open: Asked | null = null;

function ask(): Asked {
  let resolve!: (key: string | null) => void;
  const answer = new Promise<string | null>(done => { resolve = done; });
  const asked: Asked = {
    answer,
    settle: key => {
      if (open === asked) open = null;
      resolve(key);
    },
  };
  open = asked;
  return asked;
}

/* What publicKey answers where the person has no key and this page can make none. */
export const NO_KEY_HERE = '';

/* How long one opening lasts: what the owner signs says so, and the machine opens no longer. */
const GRANT_S = 24 * 3600;

/* The question for the password that opens the key on this device, and what its answer settles. */
type Unlocking = { server: StoredKey; settle(key: CryptoKey | null): void };

/* The public half of the viewer's key, for the commands that carry it. With none on the server yet it is made first:
   with the password given, or else asked for; null when the person leaves the question, and NO_KEY_HERE where the
   browser can make none. sign: the owner's word that opens a machine for a day, signed with their key; a device that
   does not keep the key asks for the password once and keeps it from then on. Null when the person leaves the
   question, has no key, or this page can sign nothing. The caller renders prompt. */
export function useOwnerKey(): { publicKey(password?: string): Promise<string | null>; sign(machine: string, seconds?: number): Promise<Grant | null>; prompt: ReactNode } {
  const [mine, setMine] = useState<Asked | null>(null);
  const [unlocking, setUnlocking] = useState<Unlocking | null>(null);

  const sign = useCallback(async (machine: string, seconds = GRANT_S): Promise<Grant | null> => {
    const server = await serverKey();
    if (!server || !canMakeKey()) return null;
    const key = (await deviceKey(server)) ?? (await new Promise<CryptoKey | null>(settle => setUnlocking({ server, settle })));
    if (!key) return null;
    const now = Math.floor(Date.now() / 1000);
    return signGrant(key, machine, now + seconds, now);
  }, []);

  /* A screen that goes away takes its question with it. */
  useEffect(() => () => unlocking?.settle(null), [unlocking]);

  const publicKey = useCallback(async (password?: string): Promise<string | null> => {
    const server = await serverKey();
    /* A key this device keeps for another one is dropped here. */
    await deviceKey(server);
    if (server) return server.publicKey;
    if (!canMakeKey()) return NO_KEY_HERE;
    if (password !== undefined) return (await makeKey(password)).publicKey;
    if (open) return open.answer;
    const asked = ask();
    setMine(asked);
    return asked.answer;
  }, []);

  /* A box that goes away takes its question with it, so nothing waits for an answer nobody can give. */
  useEffect(() => () => mine?.settle(null), [mine]);

  if (unlocking) {
    const unlocked = (key: CryptoKey | null) => {
      setUnlocking(null);
      unlocking.settle(key);
    };
    const onPassword = async (password: string): Promise<boolean> => {
      const key = await unlockKey(unlocking.server, password);
      if (key) unlocked(key);
      return key !== null;
    };
    return { publicKey, sign, prompt: <PasswordPrompt purpose="unlock" onPassword={onPassword} onCancel={() => unlocked(null)} /> };
  }
  if (!mine) return { publicKey, sign, prompt: null };
  const answered = (key: string | null) => {
    setMine(null);
    mine.settle(key);
  };
  const onPassword = async (password: string): Promise<boolean> => {
    try {
      answered((await makeKey(password)).publicKey);
      return true;
    } catch (err) {
      if (!(err instanceof ApiFailure)) throw err;
      if (err.reason === 'wrong_password') return false;
      /* Another window of theirs made the key meanwhile: that one is the person's key. */
      if (err.reason !== 'key_exists') throw err;
      answered((await serverKey())?.publicKey ?? null);
      return true;
    }
  };
  return { publicKey, sign, prompt: <PasswordPrompt purpose="make" onPassword={onPassword} onCancel={() => answered(null)} /> };
}
