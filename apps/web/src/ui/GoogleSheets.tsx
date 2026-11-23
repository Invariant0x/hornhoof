import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../api';
import { errorText, Phrase, useT } from '../i18n';
import type { GoogleSheetsConfig } from '../types';
import { useConfirmAction } from './ConfirmAction';
import { Field } from './Field';
import { Idents } from './Idents';
import { IntegrationCard } from './IntegrationCard';
import { NOT_A_LOGIN } from './SecretInput';

type Mode = 'view' | 'edit';
type Change = (action: () => Promise<GoogleSheetsConfig | null>) => void;

/* The key and the Google account new spreadsheets are shared with, as typed; an empty key keeps the saved one. */
function GoogleSheetsForm({ google, busy, change, onCancel }: { google: GoogleSheetsConfig | null; busy: boolean; change: Change; onCancel(): void }) {
  const t = useT();
  const [credentials, setCredentials] = useState('');
  const [shareEmail, setShareEmail] = useState(google?.shareEmail ?? '');

  function submitForm(e: FormEvent) {
    e.preventDefault();
    const payload = {
      ...(credentials.trim() ? { credentials: credentials.trim() } : {}),
      shareEmail: shareEmail.trim() || null,
    };
    change(async () => (await api.put<{ google: GoogleSheetsConfig }>('/api/google-sheets', payload)).google);
  }

  return (
    <form className="repo-form" onSubmit={submitForm}>
      <Field label={t.googleSheets.keyLabel} hint={google ? t.googleSheets.keyKeep : t.googleSheets.keyHint}>
        {p => (
          <textarea
            {...p}
            rows={4}
            value={credentials}
            onChange={e => setCredentials(e.target.value)}
            maxLength={32_000}
            spellCheck={false}
          />
        )}
      </Field>
      <Field label={t.googleSheets.shareLabel} hint={t.googleSheets.shareHint}>
        {p => (
          <input
            {...p}
            {...NOT_A_LOGIN}
            type="email"
            autoComplete="off"
            value={shareEmail}
            onChange={e => setShareEmail(e.target.value)}
            maxLength={254}
          />
        )}
      </Field>
      <div className="form-foot">
        <button className="btn" type="submit" disabled={busy || (!google && !credentials.trim())}>
          {t.common.save}
        </button>
        <button className="btn ghost" type="button" onClick={onCancel}>
          {t.common.cancel}
        </button>
      </div>
    </form>
  );
}

/* The buttons under the saved settings: Connect, the main button while nothing is connected; Change and the pink
   Disconnect once it is. */
function GoogleSheetsActions({ google, setMode, onDisconnect }: { google: GoogleSheetsConfig | null; setMode(mode: Mode): void; onDisconnect(account: string): void }) {
  const t = useT();
  if (!google) {
    return (
      <div className="repo-actions">
        <button className="btn small" type="button" onClick={() => setMode('edit')}>
          {t.googleSheets.connect}
        </button>
      </div>
    );
  }
  return (
    <div className="repo-actions">
      <button className="btn small ghost" type="button" onClick={() => setMode('edit')}>
        {t.googleSheets.change}
      </button>
      <button className="btn small ghost danger" type="button" onClick={() => onDisconnect(google.account)}>
        {t.googleSheets.remove}
      </button>
    </div>
  );
}

/* The company's Google settings as the server keeps them (undefined until they come), what the part shows, and changing them. */
function useGoogleSheets() {
  const [google, setGoogle] = useState<GoogleSheetsConfig | null | undefined>(undefined);
  const [mode, setMode] = useState<Mode>('view');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);

  useEffect(() => {
    api
      .get<{ google: GoogleSheetsConfig | null }>('/api/google-sheets')
      .then(found => setGoogle(found.google))
      .catch(setFailure);
  }, []);

  function pick(next: Mode) {
    setFailure(null);
    setMode(next);
  }

  async function applyChange(action: () => Promise<GoogleSheetsConfig | null>) {
    setBusy(true);
    setFailure(null);
    try {
      setGoogle(await action());
      setMode('view');
    } catch (err) {
      setFailure(err);
    } finally {
      setBusy(false);
    }
  }
  const change: Change = action => void applyChange(action);
  const disconnect = async () => {
    await api.del('/api/google-sheets');
    setGoogle(null);
    setMode('view');
  };

  return { google, mode, busy, failure, pick, change, disconnect };
}

/* The form while it is open, else what is saved and the buttons under it. */
function GoogleSheetsBody({ google, mode, busy, change, pick, onDisconnect }: { google: GoogleSheetsConfig | null | undefined; mode: Mode; busy: boolean; change: Change; pick(mode: Mode): void; onDisconnect(account: string): void }) {
  const t = useT();
  if (google === undefined) return null;
  if (mode === 'edit') return <GoogleSheetsForm google={google} busy={busy} change={change} onCancel={() => pick('view')} />;
  return (
    <div className="repo">
      <p>{google ? <Idents text={t.googleSheets.saved(google.account, google.keyLast4, google.shareEmail)} idents={[google.account, google.shareEmail]} /> : t.googleSheets.none}</p>
      <GoogleSheetsActions google={google} setMode={pick} onDisconnect={onDisconnect} />
    </div>
  );
}

/* Google Sheets as a card of the Integrations group: connected while a key is saved. */
export function GoogleSheetsCard() {
  const t = useT();
  const { google, mode, busy, failure, pick, change, disconnect } = useGoogleSheets();
  const confirmation = useConfirmAction();
  if (google === undefined && failure === null) return null;
  const askDisconnect = (account: string) => {
    confirmation.ask({
      ...t.googleSheets.confirm.disconnect,
      effect: <Phrase words={t.googleSheets.confirm.disconnect.effect} values={[<bdi>{account}</bdi>]} />,
      danger: true,
      onYes: disconnect,
    });
  };
  return (
    <IntegrationCard name={t.googleSheets.title} about={t.googleSheets.about} connected={Boolean(google)}>
      <GoogleSheetsBody google={google} mode={mode} busy={busy} change={change} pick={pick} onDisconnect={askDisconnect} />
      {failure !== null && (
        <p className="alert" role="alert">
          {errorText(t, failure)}
        </p>
      )}
      {confirmation.question}
    </IntegrationCard>
  );
}
