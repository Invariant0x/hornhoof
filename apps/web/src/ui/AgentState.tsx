import { QUIET_SIGN_MS } from '@hornhoof/protocol/map';
import { useEffect, useMemo, useState } from 'react';
import { useT, type Messages } from '../i18n';
import type { EmployeeStatus, ProgramView, TurnAlarm, TurnRetry } from '../types';

const MINUTE_MS = 60_000;
/* How often a running agent's line is drawn again so its minutes and quiet-sign count stay fresh. */
const TICK_MS = 15_000;

/* What the map knows of an agent's work: its running turn's program, the server's alarm, a waiting retry, a plan hold,
   and, where asked, the status that tells a turn waiting for a task or in the queue. */
export type AgentLive = {
  id: string;
  program: ProgramView | null;
  alarm: TurnAlarm | null;
  retry?: TurnRetry | null;
  status?: EmployeeStatus;
  held?: { reason: 'limit' | 'budget'; since: string; until: string } | null;
  /* Its turn waits for a place on a machine that runs as many turns at once as its limit takes. */
  slotWait?: boolean;
};
type Tone = 'alarm' | 'work' | 'person' | 'calm';
type Line = { tone: Tone; text: string };
const HELD_SHOWN_MS = 10 * MINUTE_MS;

const minutes = (now: number, at: number) => {
  const n = Math.floor((now - at) / MINUTE_MS);
  return n < 1 ? '<1' : String(n);
};

/* Clock time as 14:05 in this page's local clock. */
export function clockAt(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function heldLine(say: Messages['dept']['now'], held: NonNullable<AgentLive['held']>, now: number): Line | null {
  if (now - Date.parse(held.since) <= HELD_SHOWN_MS) return null;
  const at = clockAt(Date.parse(held.until));
  return { tone: 'calm', text: held.reason === 'budget' ? say.taskShareUntil(at) : say.planLimitUntil(at) };
}

/* The server's alarm first, in red with its cause; else a long plan hold; else what the program does; else a place on its
   machine; else Hornhoof's waiting retry; else what the turn waits for. */
function waitingLine(t: Messages, a: AgentLive): Line | null {
  const say = t.dept.now;
  if (a.slotWait) return { tone: 'calm', text: say.slotWait };
  if (a.retry) return { tone: 'calm', text: say.turnRetry(a.retry.attempt, a.retry.max, clockAt(a.retry.at), t.failures[a.retry.kind]) };
  if (a.status === 'idle') return { tone: 'calm', text: say.waitsForTask };
  return a.status === 'queued' ? { tone: 'calm', text: say.queued } : null;
}

function lineOf(t: Messages, a: AgentLive | null | undefined, now: number): Line | null {
  const say = t.dept.now;
  if (!a) return null;
  if (a.alarm) return { tone: 'alarm', text: say[a.alarm.reason](minutes(now, a.alarm.since)) };
  const held = a.held ? heldLine(say, a.held, now) : null;
  if (held) return held;
  return a.program ? programLine(say, a.program, now) : waitingLine(t, a);
}

function withQuietSign(say: Messages['dept']['now'], line: string, signAt: number | null, now: number): string {
  return signAt !== null && now - signAt > QUIET_SIGN_MS ? say.noSign(line, minutes(now, signAt)) : line;
}

function retryText(say: Messages['dept']['now'], retry: ProgramView['retry'] | undefined): string {
  if (!retry) return say.retrying;
  const next = retry.nextAt === null ? null : clockAt(retry.nextAt);
  return say.retryAttempt(retry.attempt, retry.max, next);
}

/* Historical segments keep only the program's state, age and tool; live reports also carry its retry and last sign. */
export function programLine(say: Messages['dept']['now'], p: Pick<ProgramView, 'state' | 'since' | 'tool'> & Partial<Pick<ProgramView, 'signAt' | 'retry'>>, now: number): Line {
  if (p.state === 'thinking') return { tone: 'work', text: withQuietSign(say, say.thinking(minutes(now, p.since)), p.signAt ?? null, now) };
  if (p.state === 'tool') return { tone: 'work', text: say.tool(p.tool ?? '', minutes(now, p.since)) };
  if (p.state === 'asking') return { tone: 'person', text: say.asking };
  if (p.state === 'retrying') {
    return { tone: 'work', text: withQuietSign(say, retryText(say, p.retry), p.signAt ?? null, now) };
  }
  if (p.state === 'gone') return { tone: 'calm', text: say.gone };
  return { tone: 'calm', text: say.idle };
}

/* The server's time now: its clock when the map was read, carried on by this page's steady clock, drawn again every tick
   while live. */
function useServerNow(serverNow: string | undefined, live: boolean): number {
  const anchor = useMemo(() => ({ server: serverNow ? Date.parse(serverNow) : Date.now(), steady: performance.now() }), [serverNow]);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!live) return;
    const timer = setTimeout(() => setTick(n => n + 1), TICK_MS);
    return () => clearTimeout(timer);
  }, [live, tick]);
  return anchor.server + performance.now() - anchor.steady;
}

const hasLiveState = (agent: AgentLive | null | undefined): boolean => !!(agent?.program || agent?.alarm || agent?.held);

/* What an agent does now, on its card on the map, in the tree and on its own card: red when its turn is in trouble. */
export function AgentState({ agent, serverNow }: { agent: AgentLive | null | undefined; serverNow: string | undefined }) {
  const t = useT();
  const now = useServerNow(serverNow, hasLiveState(agent));
  const line = lineOf(t, agent, now);
  return (
    line && (
      <span className={`ast ${line.tone}`} title={line.text}>
        {line.text}
      </span>
    )
  );
}
