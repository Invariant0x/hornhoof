import { useState, type FormEvent } from 'react';
import { api, ApiFailure } from '../api';
import { Card } from '../ui/Card';
import { Field } from '../ui/Field';

export function Login({ onDone }: { onDone: () => void }) {
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
      setFailure(err instanceof ApiFailure ? err.message : 'Something went wrong.');
      setBusy(false);
    }
  }

  return (
    <Card>
      <h1>Log in</h1>
      <form onSubmit={submit}>
        <Field label="Email">
          {p => <input {...p} type="email" value={email} onChange={e => setEmail(e.target.value)} autoComplete="email" autoFocus required />}
        </Field>
        <Field label="Password">
          {p => <input {...p} type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="current-password" required />}
        </Field>
        {failure && <p className="alert" role="alert">{failure}</p>}
        <div className="actions">
          <button className="btn" type="submit" disabled={busy || !email.trim() || !password}>Log in</button>
        </div>
      </form>
      <p className="muted">Forgot your password? Ask the CEO or a deputy to send you a new invite.</p>
    </Card>
  );
}
