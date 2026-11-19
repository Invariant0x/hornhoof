import { modelGroup, type LimitGroup } from '@hornhoof/protocol';
import { Fragment } from 'react';
import { Phrase, useLanguage, useT } from '../i18n';
import type { Limits, SubView } from '../types';
import { Bar, percent, Share } from './Bar';
import { Gauge, Part } from './Cards';
import { ResetTime, ResetWords, resetDurationAt } from './reset';
import { currentPlanLimits, limitState, MAIN_WINDOWS, unknownLimitData, windowParts } from './subscription';

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
  const used = w?.utilization ?? null;
  const figure = used === null ? (limits?.complete && !w ? t.subs.notOnPlan : unknownLimitData(t, language, sub)) : <bdi dir="ltr"><Share>{`${percent(used)}%`}</Share></bdi>;
  return <Gauge label={<WindowName name={name} />} figure={figure} unit={used === null ? undefined : t.cards.used} empty={used === null} used={used} sub={w && <ResetTime at={w.resetsAt} now={now} />} />;
}

/* The gauges of the plan's limits as a whole, or of one group of its models. */
function Gauges({ sub, limits, now }: { sub: SubView; limits: Limits | null; now: number }) {
  const t = useT();
  const state = limitState(limits, now);
  const names = [...MAIN_WINDOWS, ...(limits?.windows ?? []).filter(w => !MAIN_WINDOWS.includes(w.name) && w.utilization !== null).map(w => w.name)];
  return <div className="gauges" role="group" aria-label={state.reached ? t.subs.limitReached(resetDurationAt(t, state.resetsAt, now)) : t.subs.limits}>{names.map(name => <LimitGauge key={name} sub={sub} name={name} limits={limits} now={now} />)}</div>;
}

/* A group's limits read as the plan's own: its windows, its state, and whether it names every window it has. */
const groupLimits = (group: LimitGroup): Limits => ({ status: group.status, windows: group.windows, ...(group.complete !== undefined ? { complete: group.complete } : {}) });

/* The groups of models the plan keeps its limits by, as its provider names them; none for a plan with one limit for all. */
const groupsOf = (limits: Limits | null): LimitGroup[] => limits?.groups ?? [];

/* The plan's limits on an employee's card: those of the group of its model where the plan keeps them by group, each
   group where its model is of none known, else the plan's. */
export function LimitMeters({ sub, now, model }: { sub: SubView; now: number; model?: string }) {
  const t = useT();
  if (sub.kind === 'api_key') return <p className="part-note">{t.subs.noPlanLimits}</p>;
  const limits = currentPlanLimits(sub, now);
  const groups = groupsOf(limits);
  if (!groups.length) return <Gauges sub={sub} limits={limits} now={now} />;
  const own = modelGroup(groups, model);
  return <>{(own ? [own] : groups).map(group => <Fragment key={group.name}><p className="part-note" dir="auto">{t.subs.groupLimits(group.name)}</p><Gauges sub={sub} limits={groupLimits(group)} now={now} /></Fragment>)}</>;
}

/* The plan card's limits: one part for each group of models the plan keeps its limits by, under the group's own name,
   else one for the plan. */
export function PlanLimitParts({ sub, now }: { sub: SubView; now: number }) {
  const t = useT();
  const groups = sub.kind === 'api_key' ? [] : groupsOf(currentPlanLimits(sub, now));
  if (!groups.length) return <Part title={t.subs.limits}><LimitMeters sub={sub} now={now} /></Part>;
  return <>{groups.map(group => <Part key={group.name} title={t.subs.groupLimits(group.name)}><Gauges sub={sub} limits={groupLimits(group)} now={now} /></Part>)}</>;
}

/* One window of a part of the plan's limits in the list: its used share, then when it resets. */
function LimitLine({ sub, name, limits, now, group }: { sub: SubView; name: string; limits: Limits | null; now: number; group?: string }) {
  const t = useT();
  const { language } = useLanguage();
  const w = limits?.windows.find(w => w.name === name);
  const used = w?.utilization ?? null;
  const unknown = used === null && (limits?.complete && !w ? t.subs.notOnPlan : unknownLimitData(t, language, sub));
  /* One phrase of the dictionary, whole in the direction of its words: the separator stays by the share it follows. */
  const share = <b><bdi dir="ltr">{used === null ? '' : `${percent(used)}%`}</bdi></b>;
  const words = used === null ? null : <Phrase words={t.subs.usedAndReset} values={[share, <ResetWords at={w?.resetsAt ?? null} now={now} />]} />;
  if (group === undefined) return used === null ? <span className="cell-na">{unknown}</span> : <span className="cell-lim"><Bar used={used} /><span><bdi>{words}</bdi></span></span>;
  return <span className="cell-lim">{used !== null && <Bar used={used} />}<span><bdi><Phrase words={t.subs.groupShare} values={[<bdi dir="auto">{group}</bdi>, words ?? unknown]} /></bdi></span></span>;
}

export function LimitCell({ sub, name, now }: { sub: SubView; name: string; now: number }) {
  const t = useT();
  if (sub.kind === 'api_key') return <span className="cell-na">{t.subs.noPlanLimits}</span>;
  const limits = currentPlanLimits(sub, now);
  const groups = groupsOf(limits);
  if (!groups.length) return <LimitLine sub={sub} name={name} limits={limits} now={now} />;
  return <ul className="where-list">{groups.map(group => <li key={group.name}><LimitLine sub={sub} name={name} limits={groupLimits(group)} now={now} group={group.name} /></li>)}</ul>;
}

