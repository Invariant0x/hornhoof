import { useState, type FormEvent } from 'react';
import { api } from '../api';
import { errorText, useT } from '../i18n';
import type { SubView } from '../types';
import { PLAN_PROVIDERS, PROVIDER_NAMES, type PlanProvider } from '../providers';
import { BusyLabel } from './BusyLabel';
import { CommandBox, toActiveCommand, type ActiveCommand } from './CommandBox';
import { Edge } from './Edge';
import { ProviderMark } from './icons';

type Props = { onDone: () => void; onCommand?: (shown: ActiveCommand, subscriptions: SubView[]) => void; onSkip?: () => void; skipLabel?: string };

const applyConnected = (res: { id?: string; command: string; expiresAt?: string; subscriptions?: SubView[] }, onCommand: Props['onCommand'], setCommand: (c: string) => void) =>
  onCommand ? onCommand(toActiveCommand(res), res.subscriptions ?? []) : setCommand(res.command);

/* Tick the plans, get one install command for all of them. */
export function ConnectPanel({ onDone, onCommand, onSkip, skipLabel }: Props) {
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
      const res = await api.post<{ id?: string; command: string; expiresAt?: string; subscriptions: SubView[] }>('/api/subscriptions/connect', { providers });
      applyConnected(res, onCommand, setCommand);
    } catch (err) {
      setFailure(errorText(t, err));
    } finally {
      setBusy(false);
    }
  }

  if (command) {
    return (
      <Edge className="panel form-card" cut={12}>
        <div className="form-head">
          <h2 className="form-title">{t.subs.connectHeading}</h2>
        </div>
        <CommandBox command={command} run={t.subs.runThis} />
        <p className="muted">{t.subs.joinOnce}</p>
        <div className="form-foot">
          <button className="btn" type="button" onClick={onDone}>{t.common.done}</button>
        </div>
      </Edge>
    );
  }

  return (
    <Edge className="panel form-card" cut={12}>
      <div className="form-head">
        <h2 className="form-title">{t.subs.connectHeading}</h2>
        <p className="muted">{t.subs.connectIntro}</p>
      </div>
      <form onSubmit={e => void submit(e)} className="form-grid connect-form">
        <fieldset className="plans">
          <legend className="sr">{t.subs.connectHeading}</legend>
          {PLAN_PROVIDERS.map(p => (
            <label key={p} className={picked.includes(p) ? 'plan on' : 'plan'}>
              <input type="checkbox" checked={picked.includes(p)} onChange={() => toggle(p)} aria-label={PROVIDER_NAMES[p]} aria-describedby={`plan-${p}`} />
              <ProviderMark provider={p} />
              <b>{PROVIDER_NAMES[p]}</b>
              <span id={`plan-${p}`} className="muted">{t.subs.plans[p]}</span>
            </label>
          ))}
        </fieldset>
        {failure && <p className="alert" role="alert">{failure}</p>}
        <div className="form-foot">
          <button className="btn" type="submit" aria-busy={busy} disabled={busy || picked.length === 0}>
            <BusyLabel busy={busy} idle={t.subs.getCommand} working={t.subs.preparing} />
          </button>
          {onSkip && <button className="btn ghost" type="button" onClick={onSkip}>{skipLabel ?? t.subs.skip}</button>}
        </div>
      </form>
    </Edge>
  );
}
