import { useLanguage, useT } from '../i18n';
import { taskWaits, type HumanStatus, type WaitTask } from '../task-board';
import { sinceSeconds, spanText, waitClass, waitLabel } from './tracker-words';

export const STATE_CLASS: Record<HumanStatus, string> = {
  notStarted: 'open', working: 'working', review: 'review', waiting: 'waiting', waitingYou: 'waiting', failure: 'failure',
  stopped: 'blocked', paused: 'blocked', done: 'done', cancelled: 'cancelled',
};

export function StateWord({ status }: { status: HumanStatus }) {
  const t = useT();
  return <span className={`tstate ${STATE_CLASS[status]}`}>{t.tracker.groups[status]}</span>;
}

export function WaitLine({ task, asksYou = false, questionAt }: { task: WaitTask; asksYou?: boolean; questionAt?: string }) {
  const t = useT();
  const { language } = useLanguage();
  const now = Date.now();
  const wait = taskWaits(task, now)[0];
  if (asksYou && !wait?.failure && (wait?.kind !== 'person' || wait.event === 'ceo')) {
    if (!questionAt) return <small className="tr-wait person">{t.tracker.groups.waitingYou}</small>;
    return <small className="tr-wait person">{t.tracker.wait.you(spanText(t, sinceSeconds(questionAt, now)))}</small>;
  }
  return wait ? <small className={`tr-wait ${waitClass(wait)}`} dir="auto">{waitLabel(t, task, wait, now, language, asksYou)}</small> : null;
}

export function QuestionButton({ onOpen }: { onOpen: () => void }) {
  const t = useT();
  return <button className="act" type="button" onClick={onOpen}>{t.tracker.wait.question}</button>;
}
