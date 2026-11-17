import { useState, type FormEvent } from 'react';
import { api } from '../api';
import { errorText, useT } from '../i18n';
import { Card } from '../ui/Card';
import { Field } from '../ui/Field';

export function Login({ onDone }: { onDone: () => void }) {
  const t = useT();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [failure, setFailure] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setFailure('');
    try {
      await api.post('/api/auth/login', { email: email.trim(), password });
      onDone();
    } catch (err) {
      setFailure(errorText(t, err));
      setBusy(false);
    }
  }

  return (
    <Card>
      <h1>{t.login.heading}</h1>
      <form onSubmit={e => void submit(e)}>
        <Field label={t.common.email}>
          {p => <input {...p} type="email" value={email} onChange={e => setEmail(e.target.value)} autoComplete="username" autoFocus required />}
        </Field>
        <Field label={t.common.password}>
          {p => <input {...p} type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="current-password" required />}
        </Field>
        {failure && <p className="alert" role="alert">{failure}</p>}
        <div className="actions">
          <button className="btn" type="submit" disabled={busy || !email.trim() || !password}>{t.login.submit}</button>
        </div>
      </form>
      <p className="muted">{t.login.forgot}</p>
    </Card>
  );
}
