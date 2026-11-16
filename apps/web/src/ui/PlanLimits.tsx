import { Phrase, useLanguage, useT } from '../i18n';
import type { Limits, SubView } from '../types';
import { Bar, percent, Share } from './Bar';
import { Gauge } from './Cards';
import { ResetTime, ResetWords, resetDurationAt } from './reset';
import { currentPlanLimits, limitState, MAIN_WINDOWS, unknownLimitData, windowParts, windowUsage } from './subscription';

/* A window's name whole, in the direction of its own words, with its number and unit in one piece that reads left to right,
   so a page laid out right to left keeps «7 days, Opus» as it reads. */
function WindowName({ name }: { name: string }) {
  const t = useT();
  const [piece, words] = windowParts(t, name);
  return <bdi>{piece && <bdi dir="ltr">{piece}</bdi>}{words}</bdi>;
}

function LimitGauge({ sub, name, limits, now }: { sub: SubView; name: string; limits: Limits | null; now: number }) {
  const t = useT();
  const { language } = useLanguage();
  const w = limits?.windows.find(w => w.name === name);
  const used = windowUsage(sub, name, now);
  const figure = used === null ? (limits?.complete && !w ? t.subs.notOnPlan : unknownLimitData(t, language, sub)) : <bdi dir="ltr"><Share>{`${percent(used)}%`}</Share></bdi>;
  return <Gauge label={<WindowName name={name} />} figure={figure} unit={used === null ? undefined : t.cards.used} empty={used === null} used={used} sub={w && <ResetTime at={w.resetsAt} now={now} />} />;
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
  /* One phrase of the dictionary, whole in the direction of its words: the separator stays by the share it follows. */
  const share = <b><bdi dir="ltr">{percent(used)}%</bdi></b>;
  return <span className="cell-lim"><Bar used={used} /><span><bdi><Phrase words={t.subs.usedAndReset} values={[share, <ResetWords at={w?.resetsAt ?? null} now={now} />]} /></bdi></span></span>;
}
