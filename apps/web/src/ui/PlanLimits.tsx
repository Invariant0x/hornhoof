import { modelGroup, type LimitGroup } from '@hornhoof/protocol';
import { Phrase, useLanguage, useT } from '../i18n';
import type { Limits, SubView } from '../types';
import { Bar, percent, Share } from './Bar';
import { Gauge, Part } from './Cards';
import { ResetTime, ResetWords, resetDurationAt } from './reset';
import { currentPlanLimits, limitState, MAIN_WINDOWS, unknownLimitData, windowParts } from './subscription';
import { keepUnits } from './units';

/* A window's name whole, in the direction of its own words, with its number and unit in one piece that reads left to right,
   so a page laid out right to left keeps «7 days, Opus» as it reads, and the number never wraps away from its unit. */
function WindowName({ name }: { name: string }) {
  const t = useT();
  const [piece, words] = windowParts(t, name);
  return <bdi>{piece && <bdi dir="ltr">{keepUnits(piece)}</bdi>}{words}</bdi>;
}

/* A window of a part of the plan's limits: the window, its used share where it is known, and when it resets. */
function windowUse(limits: Limits | null, name: string) {
  const w = limits?.windows.find(w => w.name === name);
  return { w, used: w?.utilization ?? null, at: w?.resetsAt ?? null };
}

/* What a window with no known share says: that the plan does not have it where the plan names every window it has, else
   what is known of its data. */
function NoShare({ sub, limits, named }: { sub: SubView; limits: Limits | null; named: boolean }) {
  const t = useT();
  const { language } = useLanguage();
  return <>{limits?.complete && !named ? t.subs.notOnPlan : unknownLimitData(t, language, sub)}</>;
}

function LimitGauge({ sub, name, limits, now, showBar }: { sub: SubView; name: string; limits: Limits | null; now: number; showBar: boolean }) {
  const t = useT();
  const { w, used } = windowUse(limits, name);
  const figure = used === null ? <NoShare sub={sub} limits={limits} named={Boolean(w)} /> : <bdi dir="ltr"><Share>{`${percent(used)}%`}</Share></bdi>;
  return <Gauge label={<WindowName name={name} />} figure={figure} unit={used === null ? undefined : t.cards.used} empty={used === null} used={showBar ? used : undefined} sub={w && <ResetTime at={w.resetsAt} now={now} />} />;
}

/* The gauges of the plan's limits as a whole, or of one group of its models. */
function Gauges({ sub, limits, now, barFor }: { sub: SubView; limits: Limits | null; now: number; barFor?: (name: string) => boolean }) {
  const t = useT();
  const state = limitState(limits, now);
  const names = [...MAIN_WINDOWS, ...(limits?.windows ?? []).filter(w => !MAIN_WINDOWS.includes(w.name) && w.utilization !== null).map(w => w.name)];
  return <div className="gauges" role="group" aria-label={state.reached ? t.subs.limitReached(resetDurationAt(t, state.resetsAt, now)) : t.subs.limits}>{names.map(name => <LimitGauge key={name} sub={sub} name={name} limits={limits} now={now} showBar={barFor?.(name) ?? true} />)}</div>;
}

/* A group's limits read as the plan's own: its windows, its state, and whether it names every window it has. */
const groupLimits = (group: LimitGroup): Limits => ({ status: group.status, windows: group.windows, ...(group.complete !== undefined ? { complete: group.complete } : {}) });

/* The groups of models the plan keeps its limits by, as its provider names them; none for a plan with one limit for all. */
const groupsOf = (limits: Limits | null): LimitGroup[] => limits?.groups ?? [];

/* The fullest current group speaks for each window. Among equal shares, prefer the reset shown by the plan as a whole. */
function mainGroups(limits: Limits | null) {
  const byWindow = new Map<string, { group: LimitGroup; used: number; matchesReset: boolean }>();
  const resetByWindow = new Map(limits?.windows.map(w => [w.name, w.resetsAt]));
  for (const group of groupsOf(limits)) {
    for (const { name, utilization: used, resetsAt } of group.windows) {
      if (used === null) continue;
      const previous = byWindow.get(name);
      const matchesReset = resetByWindow.get(name) === resetsAt;
      if (!previous || used > previous.used || (used === previous.used && matchesReset && !previous.matchesReset)) {
        byWindow.set(name, { group, used, matchesReset });
      }
    }
  }
  return byWindow;
}

/* The plan's limits on an employee's card: those of the group of its model where the plan keeps them by group, each
   group where its model is of none known, else the plan's. */
export function LimitMeters({ sub, now, model }: { sub: SubView; now: number; model?: string }) {
  const t = useT();
  if (sub.kind === 'api_key') return <p className="part-note">{t.subs.noPlanLimits}</p>;
  const limits = currentPlanLimits(sub, now);
  const groups = groupsOf(limits);
  if (!groups.length) return <Gauges sub={sub} limits={limits} now={now} />;
  const own = modelGroup(groups, model);
  return <GroupParts sub={sub} groups={own ? [own] : groups} now={now} />;
}

/* Each group's limits in a part of its own, under the group's name. */
function GroupParts({ sub, groups, now, main }: { sub: SubView; groups: LimitGroup[]; now: number; main?: ReturnType<typeof mainGroups> }) {
  const t = useT();
  return <>{groups.map(group => {
    const barFor = main && ((name: string) => main.get(name)?.group === group);
    return <Part key={group.name} title={t.subs.groupLimits(group.name)}><Gauges sub={sub} limits={groupLimits(group)} now={now} barFor={barFor} /></Part>;
  })}</>;
}

/* The plan card's limits: one part for each group of models the plan keeps its limits by, under the group's own name,
   else one for the plan. */
export function PlanLimitParts({ sub, now }: { sub: SubView; now: number }) {
  const t = useT();
  const limits = sub.kind === 'api_key' ? null : currentPlanLimits(sub, now);
  const groups = groupsOf(limits);
  if (!groups.length) return <Part title={t.subs.limits}><LimitMeters sub={sub} now={now} /></Part>;
  return <GroupParts sub={sub} groups={groups} now={now} main={mainGroups(limits)} />;
}

/* A window's used share, then when it resets, as one phrase of the dictionary, whole in the direction of its words: the
   separator stays by the share it follows. */
function UsedAndReset({ used, at, now }: { used: number; at: string | null; now: number }) {
  const t = useT();
  return <Phrase words={t.subs.usedAndReset} values={[<b><bdi dir="ltr">{`${percent(used)}%`}</bdi></b>, <ResetWords at={at} now={now} />]} />;
}

/* One window of the plan's limits in the list: its used share, then when it resets. */
function LimitLine({ sub, name, limits, now }: { sub: SubView; name: string; limits: Limits | null; now: number }) {
  const { w, used, at } = windowUse(limits, name);
  if (used === null) return <span className="cell-na"><NoShare sub={sub} limits={limits} named={Boolean(w)} /></span>;
  return <span className="cell-lim"><Bar used={used} /><span><bdi><UsedAndReset used={used} at={at} now={now} /></bdi></span></span>;
}

/* One window of a group of the plan's models in the list: the group's name, then its used share and reset. */
function GroupLine({ sub, name, limits, now, group, showBar }: { sub: SubView; name: string; limits: Limits; now: number; group: string; showBar: boolean }) {
  const t = useT();
  const { w, used, at } = windowUse(limits, name);
  const words = used === null ? <NoShare sub={sub} limits={limits} named={Boolean(w)} /> : <UsedAndReset used={used} at={at} now={now} />;
  return <span className="cell-lim">{showBar && used !== null && <Bar used={used} />}<span><bdi><Phrase words={t.subs.groupShare} values={[<bdi dir="auto">{group}</bdi>, words]} /></bdi></span></span>;
}

export function LimitCell({ sub, name, now }: { sub: SubView; name: string; now: number }) {
  const t = useT();
  if (sub.kind === 'api_key') return <span className="cell-na">{t.subs.noPlanLimits}</span>;
  const limits = currentPlanLimits(sub, now);
  const groups = groupsOf(limits);
  if (!groups.length) return <LimitLine sub={sub} name={name} limits={limits} now={now} />;
  const main = mainGroups(limits).get(name)?.group;
  return <ul className="where-list">{groups.map(group => <li key={group.name}><GroupLine sub={sub} name={name} limits={groupLimits(group)} now={now} group={group.name} showBar={group === main} /></li>)}</ul>;
}

