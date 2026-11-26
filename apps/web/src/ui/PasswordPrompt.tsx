import { useCallback, useState, type KeyboardEvent, type ReactNode } from 'react';
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
      <Field label={t.common.password} problem={problem || undefined}>
        {props => <input {...props} type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} onKeyDown={onKey} />}
      </Field>
      <p className="muted">{purpose === 'make' ? t.subs.ownerKeyMake : t.subs.ownerKeyUnlock}</p>
      <div className="actions">
        <button className="btn" type="button" disabled={!password || busy} onClick={() => void send()}>{t.common.next}</button>
        <button className="btn ghost" type="button" onClick={onCancel}>{t.common.cancel}</button>
      </div>
    </div>
  );
}

/* Cards for one shared install can each show a field. One answer supplies the key to all waiting commands. */
type KeyWaiters = { finish: Set<(key: string | null) => void>; prompts: number };
type Question = { cancel(): void; answer(key: string): void };
let open: KeyWaiters | null = null;

/* What publicKey answers where the person has no key and this page can make none. */
export const NO_KEY_HERE = '';

/* The public half of the viewer's key, for commands that carry it. A viewer without a key makes one with their password. */
export function useOwnerKey(promptPerCard: boolean): { publicKey(signal: AbortSignal, password?: string): Promise<string | null>; prompt: ReactNode } {
  const [mine, setMine] = useState<Question | null>(null);

  const publicKey = useCallback(async (signal: AbortSignal, password?: string): Promise<string | null> => {
    setMine(null);
    const server = await serverKey();
    /* A key this device keeps for another one is dropped here. */
    await deviceKey(server);
    if (signal.aborted) return null;
    if (server) return server.publicKey;
    if (!canMakeKey()) return NO_KEY_HERE;
    if (password !== undefined) return (await makeKey(password)).publicKey;
    const promptHere = promptPerCard || open === null;
    const waiters = open ??= { finish: new Set(), prompts: 0 };
    return new Promise(resolve => {
      const cancel = () => {
        finish(null);
        if (waiters.prompts === 0) for (const waiter of waiters.finish) waiter(null);
      };
      const question: Question = {
        cancel,
        answer: key => {
          if (!waiters.finish.has(finish)) return;
          for (const waiter of waiters.finish) waiter(key);
        },
      };
      function finish(key: string | null) {
        if (!waiters.finish.delete(finish)) return;
        signal.removeEventListener('abort', cancel);
        if (promptHere) {
          waiters.prompts--;
          if (!signal.aborted) setMine(current => current === question ? null : current);
        }
        if (waiters.finish.size === 0 && open === waiters) open = null;
        resolve(key);
      }
      waiters.finish.add(finish);
      signal.addEventListener('abort', cancel, { once: true });
      if (promptHere) {
        waiters.prompts++;
        setMine(question);
      }
    });
  }, [promptPerCard]);

  if (!mine) return { publicKey, prompt: null };
  const onPassword = async (password: string): Promise<boolean> => {
    try {
      mine.answer((await makeKey(password)).publicKey);
      return true;
    } catch (err) {
      if (!(err instanceof ApiFailure)) throw err;
      if (err.reason === 'wrong_password') return false;
      /* Another window of theirs made the key meanwhile: that one is the person's key. */
      if (err.reason !== 'key_exists') throw err;
      const key = await serverKey();
      if (key) mine.answer(key.publicKey);
      else mine.cancel();
      return true;
    }
  };
  return { publicKey, prompt: <PasswordPrompt purpose="make" onPassword={onPassword} onCancel={mine.cancel} /> };
}
