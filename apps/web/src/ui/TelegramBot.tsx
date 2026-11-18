import { useId, useState } from 'react';
import { api } from '../api';
import { errorText, useT } from '../i18n';
import type { AgentCardView } from '../types';
import { Ask } from './Ask';
import { SecretInput } from './SecretInput';

type Bot = NonNullable<AgentCardView['telegram']>;
type Props = { agentId: string; telegram: Bot | null; editable: boolean; onChange(telegram: Bot | null): void };

/* The bot people write to a head or the orchestrator through in Telegram. Its token goes to the server once and never
   comes back: the card shows the bot by its name, and a person who runs the head's department, or one with the whole
   company, connects or removes one from their own screen. */
export function TelegramBot({ agentId, telegram, editable, onChange }: Props) {
  const t = useT();
  const id = useId();
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const path = `/api/agents/${agentId}/telegram`;

  async function run(call: () => Promise<Bot | null>) {
    setAsking(false);
    setBusy(true);
    setFailure(null);
    try {
      onChange(await call());
      setToken('');
    } catch (err) {
      setFailure(err);
    } finally {
      setBusy(false);
    }
  }

  const connect = () => run(async () => (await api.put<{ telegram: Bot }>(path, { token: token.trim() })).telegram);
  const remove = () => run(async () => {
    await api.del(path);
    return null;
  });

  return (
    <section className="ac-telegram" aria-labelledby={`${id}-telegram`}>
      <h4 id={`${id}-telegram`}>{t.agent.telegram}</h4>
      <p className="muted">{t.agent.telegramAbout}</p>
      {telegram ? (
        <p>
          {t.agent.telegramAt}{' '}
          <a href={`https://t.me/${telegram.username}`} target="_blank" rel="noreferrer">
            @{telegram.username}
          </a>
        </p>
      ) : editable ? (
        <form
          onSubmit={e => {
            e.preventDefault();
            if (token.trim()) void connect();
          }}
        >
          <p className="muted">{t.agent.telegramHow}</p>
          <div className="field">
            <label htmlFor={`${id}-token`}>{t.agent.telegramToken}</label>
            <SecretInput id={`${id}-token`} value={token} onChange={e => setToken(e.target.value)} />
          </div>
          <button className="btn small" type="submit" disabled={busy || !token.trim()}>
            {t.agent.telegramConnect}
          </button>
        </form>
      ) : (
        <p className="muted">{t.agent.telegramNone}</p>
      )}
      {failure !== null && (
        <p className="alert" role="alert">
          {errorText(t, failure)}
        </p>
      )}
      {telegram && editable && (asking ? (
        <Ask text={t.agent.telegramRemoveAsk} yes={t.agent.yesRemove} onYes={() => void remove()} onNo={() => setAsking(false)} />
      ) : (
        <button className="act danger" type="button" disabled={busy} onClick={() => setAsking(true)}>
          {t.agent.telegramRemove}
        </button>
      ))}
    </section>
  );
}
