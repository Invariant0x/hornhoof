import { useId, useState } from 'react';
import { api } from '../api';
import { errorText, Phrase, useT, type Messages } from '../i18n';
import type { AgentCardView } from '../types';
import { useConfirmAction, type Question } from './ConfirmAction';
import { SecretInput } from './SecretInput';

type Bot = NonNullable<AgentCardView['telegram']>;
type Props = { agentId: string; agentName?: string; telegram: Bot | null; editable: boolean; onChange(telegram: Bot | null): void };

function disconnectTelegramQuestion(t: Messages, botName: string, agentName: string | undefined, onYes: () => Promise<void>): Question {
  const words = t.agent.confirm.disconnectTelegram;
  const bot = <bdi>{`@${botName}`}</bdi>;
  return {
    ...words,
    effect: agentName ? <Phrase words={words.effect} values={[bot, <bdi>{agentName}</bdi>]} /> : <Phrase words={words.effectUnnamed} values={[bot]} />,
    danger: true,
    onYes,
  };
}

/* The bot people write to a head or the orchestrator through in Telegram. Its token goes to the server once and never
   comes back: the card shows the bot by its name, and a person who runs the head's department, or one with the whole
   company, connects or removes one from their own screen. */
export function TelegramBot({ agentId, agentName, telegram, editable, onChange }: Props) {
  const t = useT();
  const id = useId();
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const confirmation = useConfirmAction();
  const path = `/api/agents/${agentId}/telegram`;

  async function connect() {
    setBusy(true);
    setFailure(null);
    try {
      onChange((await api.put<{ telegram: Bot }>(path, { token: token.trim() })).telegram);
      setToken('');
    } catch (err) {
      setFailure(err);
    } finally {
      setBusy(false);
    }
  }

  const askDisconnect = () => {
    if (!telegram) return;
    setFailure(null);
    confirmation.ask(disconnectTelegramQuestion(t, telegram.username, agentName, async () => {
      await api.del(path);
      onChange(null);
    }));
  };

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
      {telegram && editable && (
        <button className="act danger" type="button" disabled={busy} onClick={askDisconnect}>
          {t.agent.telegramRemove}
        </button>
      )}
      {confirmation.question}
    </section>
  );
}
