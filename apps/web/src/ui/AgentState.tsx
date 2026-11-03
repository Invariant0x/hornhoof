import { LOST_END_MS } from '@hornhoof/protocol/map';
import { useEffect, useMemo, useState } from 'react';
import { useT, type Messages } from '../i18n';
import type { EmployeeStatus, ProgramView, TurnAlarm } from '../types';

const MINUTE_MS = 60_000;
/* How often a running agent's line is drawn again: its minutes move, and a wait for input turns into a lost end. */
const TICK_MS = 15_000;

/* What the map knows of an agent's work: its running turn's program and the server's alarm, and, where asked, the status
   that tells a turn waiting for a task or in the queue. */
export type AgentLive = { id: string; program: ProgramView | null; alarm: TurnAlarm | null; status?: EmployeeStatus };
type Tone = 'alarm' | 'work' | 'person' | 'calm';
type Line = { tone: Tone; text: string };

const minutes = (now: number, at: number) => {
  const n = Math.floor((now - at) / MINUTE_MS);
  return n < 1 ? '<1' : String(n);
};

/* The server's alarm first, in red with its cause; else what the program does; else what the turn waits for. */
function lineOf(t: Messages, a: AgentLive | null | undefined, now: number): Line | null {
  const say = t.dept.now;
  if (!a) return null;
  if (a.alarm) return { tone: 'alarm', text: say[a.alarm.reason](minutes(now, a.alarm.since)) };
  if (a.program) return programLine(say, a.program, now);
  if (a.status === 'idle') return { tone: 'calm', text: say.waitsForTask };
  return a.status === 'queued' ? { tone: 'calm', text: say.queued } : null;
}

/* A program waiting for input in a running turn longer than its node waits before it closes the turn lost its end. */
export function programLine(say: Messages['dept']['now'], p: Pick<ProgramView, 'state' | 'since' | 'tool'>, now: number): Line {
  if (p.state === 'thinking') return { tone: 'work', text: say.thinking(minutes(now, p.since)) };
  if (p.state === 'tool') return { tone: 'work', text: say.tool(p.tool ?? '', minutes(now, p.since)) };
  if (p.state === 'asking') return { tone: 'person', text: say.asking };
  if (p.state === 'gone') return { tone: 'calm', text: say.gone };
  return now - p.since >= LOST_END_MS ? { tone: 'alarm', text: say.lostEnd } : { tone: 'calm', text: say.idle };
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

/* What an agent does now, on its card on the map, in the tree and on its own card: red when its turn is in trouble. */
export function AgentState({ agent, serverNow }: { agent: AgentLive | null | undefined; serverNow: string | undefined }) {
  const t = useT();
  const now = useServerNow(serverNow, !!(agent?.program || agent?.alarm));
  const line = lineOf(t, agent, now);
  return (
    line && (
      <span className={`ast ${line.tone}`} title={line.text}>
        {line.text}
      </span>
    )
  );
}
