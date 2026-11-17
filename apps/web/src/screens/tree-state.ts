import type { Messages } from '../i18n';
import type { TreeSegment } from '../types';
import { programLine } from '../ui/AgentState';
import { taskWaitText } from '../ui/task-wait';
import { treeClock } from './tree';

export function segmentText(t: Messages, segment: TreeSegment | undefined, now: string): string {
  const L = t.dept.tree;
  if (!segment) return L.noData;
  const at = treeClock(segment.from);
  if (segment.externalWait) return taskWaitText(t, segment.externalWait, treeClock(segment.externalWait.until));
  if (segment.waitsForAgent) return L.waitingFor(segment.waitsForAgent.name, at);
  if (segment.alarm) return L.historyAlarm[segment.alarm.reason](at);
  if (segment.kind === 'lost') return L.lostSince(at);
  if (segment.program) return programLine(t.dept.now, segment.program, Date.parse(now)).text;
  const labels = { work: L.st.work, after: L.tWait, person: t.dept.now.asking, stall: t.dept.now.waitsForTask,
    lost: L.lostSince(at), alarm: L.interruptedSince(at), queued: L.queuedSince(at), unknown: L.noData };
  return labels[segment.kind];
}
