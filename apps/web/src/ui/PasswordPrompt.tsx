import { useCallback, useEffect, useState, type KeyboardEvent, type ReactNode } from 'react';
import { ApiFailure } from '../api';
import { useT } from '../i18n';
import { canMakeKey, deviceKey, makeKey, serverKey } from '../owner-key';
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

/* The public half of the viewer's key, for commands that carry it. A viewer without a key makes one with their password. */
export function useOwnerKey(): { publicKey(password?: string): Promise<string | null>; prompt: ReactNode } {
  const [mine, setMine] = useState<Asked | null>(null);

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

  if (!mine) return { publicKey, prompt: null };
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
  return { publicKey, prompt: <PasswordPrompt purpose="make" onPassword={onPassword} onCancel={() => answered(null)} /> };
}
