import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiFailure } from '../api';
import { Card } from '../ui/Card';
import { Field } from '../ui/Field';

type Invite = { companyName: string; name: string; email: string; title: string; scopeName: string };

const EXPIRED = 'This invite link was already used or has expired. Ask for a new one.';
const UNKNOWN = 'This invite link is not valid. Check that you copied all of it, or ask for a new one.';

function explain(err: unknown): string {
  if (err instanceof ApiFailure && err.status === 410) return EXPIRED;
  if (err instanceof ApiFailure && err.status === 404) return UNKNOWN;
  return err instanceof Error ? err.message : 'Something went wrong.';
}

export function AcceptInvite({ token, onDone }: { token: string; onDone: () => void }) {
  const [invite, setInvite] = useState<Invite | null>(null);
  const [dead, setDead] = useState('');
  const [password, setPassword] = useState('');
  const [problem, setProblem] = useState('');
  const [failure, setFailure] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    api.get<Invite>(`/api/invites/${encodeURIComponent(token)}`).then(
      data => live && setInvite(data),
      err => live && setDead(explain(err)),
    );
    return () => {
      live = false;
    };
  }, [token]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (password.length < 10) return setProblem('Use at least 10 characters.');
    setProblem('');
    setBusy(true);
    try {
      await api.post(`/api/invites/${encodeURIComponent(token)}/accept`, { password });
      onDone();
    } catch (err) {
      if (err instanceof ApiFailure && (err.status === 410 || err.status === 404)) setDead(explain(err));
      else setFailure(explain(err));
      setBusy(false);
    }
  }

  if (dead) {
    return (
      <Card>
        <h1>Invite link</h1>
        <p className="alert" role="alert">{dead}</p>
      </Card>
    );
  }
  if (!invite) return <Card><p className="muted">Opening your invite</p></Card>;

  const role = [invite.title, invite.scopeName].filter(Boolean).join(', ');
  return (
    <Card>
      <div className="wizard-head">
        <h1>Join {invite.companyName}</h1>
        <p>{role}</p>
      </div>
      <p className="muted">Hi {invite.name}. You will sign in as {invite.email}.</p>
      <form onSubmit={submit} noValidate>
        <Field label="Choose a password" problem={problem} hint="At least 10 characters.">
          {p => <input {...p} type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="new-password" autoFocus />}
        </Field>
        {failure && <p className="alert" role="alert">{failure}</p>}
        <div className="actions">
          <button className="btn" type="submit" disabled={busy || !password}>Join</button>
        </div>
      </form>
    </Card>
  );
}
