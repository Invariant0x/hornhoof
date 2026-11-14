import { useEffect, useId, useState, type FormEvent } from 'react';
import { api } from '../api';
import { errorText, useT } from '../i18n';
import type { GoogleSheetsConfig } from '../types';
import { Field } from './Field';

export function CompanyGoogleSheets() {
  const t = useT();
  const id = useId();
  const [google, setGoogle] = useState<GoogleSheetsConfig | null | undefined>(undefined);
  const [mode, setMode] = useState<'view' | 'edit' | 'remove'>('view');
  const [credentials, setCredentials] = useState('');
  const [shareEmail, setShareEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);

  useEffect(() => {
    api
      .get<{ google: GoogleSheetsConfig | null }>('/api/google-sheets')
      .then(found => setGoogle(found.google))
      .catch(setFailure);
  }, []);

  if (google === undefined && failure === null) return null;

  function openForm() {
    setCredentials('');
    setShareEmail(google?.shareEmail ?? '');
    setFailure(null);
    setMode('edit');
  }

  async function applyChange(action: () => Promise<GoogleSheetsConfig | null>) {
    setBusy(true);
    setFailure(null);
    try {
      const next = await action();
      setGoogle(next);
      setCredentials('');
      setMode('view');
    } catch (err) {
      setFailure(err);
    } finally {
      setBusy(false);
    }
  }

  function submitForm(e: FormEvent) {
    e.preventDefault();
    const payload = {
      ...(credentials.trim() ? { credentials: credentials.trim() } : {}),
      shareEmail: shareEmail.trim() || null,
    };
    void applyChange(async () => (await api.put<{ google: GoogleSheetsConfig }>('/api/google-sheets', payload)).google);
  }

  return (
    <section className="settings-part" aria-labelledby={`${id}-title`}>
      <h3 id={`${id}-title`}>{t.googleSheets.title}</h3>
      <p>{t.googleSheets.about}</p>
      {google !== undefined && mode === 'edit' && (
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
                type="email"
                autoComplete="off"
                value={shareEmail}
                onChange={e => setShareEmail(e.target.value)}
                maxLength={254}
              />
            )}
          </Field>
          <div className="repo-actions">
            <button className="btn small" type="submit" disabled={busy || (!google && !credentials.trim())}>
              {t.common.save}
            </button>
            <button className="btn small ghost" type="button" onClick={() => setMode('view')}>
              {t.common.cancel}
            </button>
          </div>
        </form>
      )}
      {google !== undefined && mode !== 'edit' && (
        <div className="repo">
          <p>{google ? t.googleSheets.saved(google.account, google.keyLast4, google.shareEmail) : t.googleSheets.none}</p>
          {mode === 'remove' ? (
            <div className="repo-actions">
              <span>{t.googleSheets.removeAsk}</span>
              <button
                className="btn small"
                type="button"
                disabled={busy}
                onClick={() => void applyChange(async () => (await api.del('/api/google-sheets'), null))}
              >
                {t.googleSheets.yesRemove}
              </button>
              <button className="btn small ghost" type="button" onClick={() => setMode('view')}>
                {t.googleSheets.keep}
              </button>
            </div>
          ) : google ? (
            <div className="repo-actions">
              <button className="btn small ghost" type="button" onClick={openForm}>
                {t.googleSheets.change}
              </button>
              <button className="btn small ghost" type="button" onClick={() => setMode('remove')}>
                {t.googleSheets.remove}
              </button>
            </div>
          ) : (
            <div className="repo-actions">
              <button className="btn small ghost" type="button" onClick={openForm}>
                {t.googleSheets.connect}
              </button>
            </div>
          )}
        </div>
      )}
      {failure !== null && (
        <p className="alert" role="alert">
          {errorText(t, failure)}
        </p>
      )}
    </section>
  );
}
