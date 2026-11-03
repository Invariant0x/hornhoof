import { useT } from '../i18n';
import type { SubView } from '../types';
import { Bar, percent } from './Bar';
import { Gauge } from './Cards';
import { ResetTime, resetDurationAt } from './reset';
import { limitState, MAIN_WINDOWS, windowName, windowUsage } from './subscription';

export function LimitMeters({ sub, now }: { sub: SubView; now: number }) {
  const t = useT();
  if (sub.kind === 'api_key') return <p className="part-note">{t.subs.noPlanLimits}</p>;
  const limits = sub.limits;
  const state = limitState(limits, now);
  const names = [...MAIN_WINDOWS, ...(limits?.windows ?? []).filter(w => !MAIN_WINDOWS.includes(w.name) && w.utilization !== null).map(w => w.name)];
  return <div className="gauges" role="group" aria-label={state.reached ? t.subs.limitReached(resetDurationAt(t, state.resetsAt, now)) : t.subs.limits}>{names.map(name => {
    const w = limits?.windows.find(w => w.name === name);
    const used = windowUsage(sub, name, now);
    return <Gauge key={name} label={windowName(t, name)} figure={used === null ? (limits?.complete && !w ? t.subs.notOnPlan : t.subs.noDataYet) : `${percent(used)}%`} unit={used === null ? undefined : t.cards.used} empty={used === null} used={used} sub={w && <ResetTime at={w.resetsAt} now={now} />} />;
  })}</div>;
}

export function LimitCell({ sub, name, now }: { sub: SubView; name: string; now: number }) {
  const t = useT();
  if (sub.kind === 'api_key') return <span className="cell-na">{t.subs.noPlanLimits}</span>;
  const w = sub.limits?.windows.find(w => w.name === name);
  const used = windowUsage(sub, name, now);
  if (used === null) return <span className="cell-na">{sub.limits?.complete && !w ? t.subs.notOnPlan : t.subs.noDataYet}</span>;
  return <span className="cell-lim"><Bar used={used} /><span><b>{percent(used)}%</b>, <ResetTime at={w?.resetsAt ?? null} now={now} /></span></span>;
}
