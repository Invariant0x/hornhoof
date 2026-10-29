import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiFailure } from '../api';
import { errorText, useT, type Messages } from '../i18n';
import { Card } from '../ui/Card';
import { Field } from '../ui/Field';

type Invite = { companyName: string; name: string; email: string; title: string; scopeName: string; scopeKind?: 'company' | 'department' | 'team' };

function explain(t: Messages, err: unknown): string {
  if (err instanceof ApiFailure && err.status === 410) return t.errors.invite_used;
  if (err instanceof ApiFailure && err.status === 404) return t.errors.invite_unknown;
  return errorText(t, err);
}

export function AcceptInvite({ token, onDone }: { token: string; onDone: () => void }) {
  const t = useT();
  const [invite, setInvite] = useState<Invite | null>(null);
  const [dead, setDead] = useState<unknown>(null);
  const [password, setPassword] = useState('');
  const [problem, setProblem] = useState('');
  const [failure, setFailure] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    api.get<Invite>(`/api/invites/${encodeURIComponent(token)}`).then(
      data => live && setInvite(data),
      err => live && setDead(err),
    );
    return () => {
      live = false;
    };
  }, [token]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (password.length < 10) return setProblem(t.common.useAtLeast10);
    setProblem('');
    setBusy(true);
    try {
      await api.post(`/api/invites/${encodeURIComponent(token)}/accept`, { password });
      onDone();
    } catch (err) {
      if (err instanceof ApiFailure && (err.status === 410 || err.status === 404)) setDead(err);
      else setFailure(explain(t, err));
      setBusy(false);
    }
  }

  if (dead !== null) {
    return (
      <Card>
        <h1>{t.invite.heading}</h1>
        <p className="alert" role="alert">{explain(t, dead)}</p>
      </Card>
    );
  }
  if (!invite) return <Card><p className="muted">{t.invite.opening}</p></Card>;

  const role = [invite.title, invite.scopeKind === 'company' ? t.people.wholeCompany : invite.scopeName].filter(Boolean).join(', ');
  return (
    <Card>
      <div className="wizard-head">
        <h1>{t.invite.join(invite.companyName)}</h1>
        <p>{role}</p>
      </div>
      <p className="muted">{t.invite.hi(invite.name, invite.email)}</p>
      <form onSubmit={submit} noValidate>
        <Field label={t.invite.choosePassword} problem={problem} hint={t.common.atLeast10}>
          {p => <input {...p} type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="new-password" autoFocus />}
        </Field>
        {failure && <p className="alert" role="alert">{failure}</p>}
        <div className="actions">
          <button className="btn" type="submit" disabled={busy || !password}>{t.invite.submit}</button>
        </div>
      </form>
    </Card>
  );
}
