import { useLanguage, useT } from '../i18n';
import type { Limits, SubView } from '../types';
import { Bar, percent, Share } from './Bar';
import { Gauge } from './Cards';
import { ResetTime, resetDurationAt } from './reset';
import { currentPlanLimits, limitState, MAIN_WINDOWS, unknownLimitData, windowName, windowUsage } from './subscription';

function LimitGauge({ sub, name, limits, now }: { sub: SubView; name: string; limits: Limits | null; now: number }) {
  const t = useT();
  const { language } = useLanguage();
  const w = limits?.windows.find(w => w.name === name);
  const used = windowUsage(sub, name, now);
  const figure = used === null ? (limits?.complete && !w ? t.subs.notOnPlan : unknownLimitData(t, language, sub)) : <Share>{`${percent(used)}%`}</Share>;
  return <Gauge label={windowName(t, name)} figure={figure} unit={used === null ? undefined : t.cards.used} empty={used === null} used={used} sub={w && <ResetTime at={w.resetsAt} now={now} />} />;
}

export function LimitMeters({ sub, now }: { sub: SubView; now: number }) {
  const t = useT();
  if (sub.kind === 'api_key') return <p className="part-note">{t.subs.noPlanLimits}</p>;
  const limits = currentPlanLimits(sub, now);
  const state = limitState(limits, now);
  const names = [...MAIN_WINDOWS, ...(limits?.windows ?? []).filter(w => !MAIN_WINDOWS.includes(w.name) && w.utilization !== null).map(w => w.name)];
  return <div className="gauges" role="group" aria-label={state.reached ? t.subs.limitReached(resetDurationAt(t, state.resetsAt, now)) : t.subs.limits}>{names.map(name => <LimitGauge key={name} sub={sub} name={name} limits={limits} now={now} />)}</div>;
}

export function LimitCell({ sub, name, now }: { sub: SubView; name: string; now: number }) {
  const t = useT();
  const { language } = useLanguage();
  if (sub.kind === 'api_key') return <span className="cell-na">{t.subs.noPlanLimits}</span>;
  const limits = currentPlanLimits(sub, now);
  const w = limits?.windows.find(w => w.name === name);
  const used = windowUsage(sub, name, now);
  if (used === null) return <span className="cell-na">{limits?.complete && !w ? t.subs.notOnPlan : unknownLimitData(t, language, sub)}</span>;
  return <span className="cell-lim"><Bar used={used} /><span><b>{percent(used)}%</b>, <ResetTime at={w?.resetsAt ?? null} now={now} /></span></span>;
}
