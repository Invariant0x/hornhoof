import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiFailure } from '../api';
import { errorText, useT, type Messages } from '../i18n';
import type { AccessView } from '../types';
import { accessText } from '../ui/AccessPicker';
import { Card } from '../ui/Card';
import { ConnectPanel } from '../ui/ConnectPanel';
import { Field } from '../ui/Field';

type Invite = { companyName: string; name: string; email: string; title: string; access: AccessView };

function explain(t: Messages, err: unknown): string {
  if (err instanceof ApiFailure && err.status === 410) return t.errors.invite_used;
  if (err instanceof ApiFailure && err.status === 404) return t.errors.invite_unknown;
  return errorText(t, err);
}

export function AcceptInvite({ token, onDone }: { token: string; onDone: (joined: boolean) => void }) {
  const t = useT();
  const [invite, setInvite] = useState<Invite | null>(null);
  const [dead, setDead] = useState<unknown>(null);
  const [password, setPassword] = useState('');
  const [problem, setProblem] = useState('');
  const [failure, setFailure] = useState('');
  const [busy, setBusy] = useState(false);
  const [joined, setJoined] = useState(false);

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
      setJoined(true);
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
        {/* Whoever joined with this link is signed in already or signs in there. */}
        <div className="actions">
          <button className="btn" type="button" onClick={() => onDone(false)}>{t.invite.toCompany}</button>
        </div>
      </Card>
    );
  }
  if (!invite) return <Card><p className="muted">{t.invite.opening}</p></Card>;
  /* Signed in now: connecting their own plans is the one thing left, and it can wait. */
  if (joined) {
    const enter = () => onDone(true);
    return (
      <Card>
        <div className="wizard-head">
          <h1>{t.invite.join(invite.companyName)}</h1>
          <p>{t.invite.connectNow}</p>
        </div>
        <ConnectPanel onDone={enter} onSkip={enter} />
      </Card>
    );
  }

  const role = [invite.title, accessText(t, invite.access, null)].filter(Boolean).join(', ');
  return (
    <Card>
      <div className="wizard-head">
        <h1>{t.invite.join(invite.companyName)}</h1>
        <p>{role}</p>
      </div>
      <p className="muted">{t.invite.hi(invite.name, invite.email)}</p>
      <form onSubmit={e => void submit(e)} noValidate>
        {/* The email the new password is for, so a browser saves the two together as this person's Hornhoof sign-in. */}
        <input type="email" name="username" autoComplete="username" value={invite.email} readOnly hidden />
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
