import { useState, type FormEvent } from 'react';
import { api } from '../api';
import { errorText, useT } from '../i18n';
import { PLAN_PROVIDERS, PROVIDER_NAMES, type PlanProvider } from '../providers';
import { CommandBox } from './CommandBox';
import { Edge } from './Edge';

type Props = { onDone: () => void; onSkip?: () => void; skipLabel?: string };

/* Tick the plans, get one install command for all of them. */
export function ConnectPanel({ onDone, onSkip, skipLabel }: Props) {
  const t = useT();
  const [picked, setPicked] = useState<PlanProvider[]>([]);
  const [command, setCommand] = useState<string | null>(null);
  const [failure, setFailure] = useState('');
  const [busy, setBusy] = useState(false);

  const toggle = (p: PlanProvider) => setPicked(list => (list.includes(p) ? list.filter(x => x !== p) : [...list, p]));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setFailure('');
    try {
      const providers = PLAN_PROVIDERS.filter(p => picked.includes(p));
      const res = await api.post<{ command: string }>('/api/subscriptions/connect', { providers });
      setCommand(res.command);
    } catch (err) {
      setFailure(errorText(t, err));
    } finally {
      setBusy(false);
    }
  }

  if (command) {
    return (
      <Edge className="panel" cut={12}>
        <h2>{t.subs.connectHeading}</h2>
        <p className="muted">{t.subs.runThis}</p>
        <CommandBox command={command} />
        <p className="muted">{t.subs.joinOnce}</p>
        <div className="actions">
          <button className="btn" type="button" onClick={onDone}>{t.common.done}</button>
        </div>
      </Edge>
    );
  }

  return (
    <Edge className="panel" cut={12}>
      <h2>{t.subs.connectHeading}</h2>
      <p className="muted">{t.subs.connectIntro}</p>
      <form onSubmit={e => void submit(e)} className="connect-form">
        <fieldset className="plans">
          <legend className="sr">{t.subs.connectHeading}</legend>
          {PLAN_PROVIDERS.map(p => (
            <label key={p} className={picked.includes(p) ? 'plan on' : 'plan'}>
              <input type="checkbox" checked={picked.includes(p)} onChange={() => toggle(p)} aria-label={PROVIDER_NAMES[p]} aria-describedby={`plan-${p}`} />
              <b>{PROVIDER_NAMES[p]}</b>
              <span id={`plan-${p}`} className="muted">{t.subs.plans[p]}</span>
            </label>
          ))}
        </fieldset>
        {failure && <p className="alert" role="alert">{failure}</p>}
        <div className="actions">
          {onSkip && <button className="btn ghost" type="button" onClick={onSkip}>{skipLabel ?? t.subs.skip}</button>}
          <button className="btn" type="submit" disabled={busy || picked.length === 0}>{t.subs.getCommand}</button>
        </div>
      </form>
    </Edge>
  );
}
