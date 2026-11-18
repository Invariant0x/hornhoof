import { useId, useState } from 'react';
import { useLanguage, useT, type Language, type Messages } from '../i18n';
import { mapPeople, useOrg } from '../org';
import { cutLine } from '../restarts';
import { matchesExternalWait, taskWaits } from '../task-tree';
import type { TaskDetail, TaskLogLine } from '../types';
import { HideSecret } from './HideSecret';
import { resetDuration } from './reset';
import { fullTextOf, LogParagraph } from './TaskAttachments';
import { localeOf, momentText, trackerLine, waitLabel } from './tracker-words';

const field = (data: unknown, key: string): unknown => (data && typeof data === 'object' && key in data ? (data as Record<string, unknown>)[key] : undefined);

/* Who wrote a log line; the orchestrator answering for a person says for whom. */
function authorOf(t: Messages, e: TaskLogLine): string {
  if (e.by?.for) return t.tasks.actedFor(t.window.orchestrator, e.by.for.name);
  return e.by?.name ?? t.window.hornhoof;
}

function eventKey(e: TaskLogLine): string {
  if (e.kind === 'verdict') return field(e.data, 'pass') ? 'passed' : 'sentBack';
  if (e.kind === 'report') return field(e.data, 'done') ? 'reported' : 'notDone';
  if (e.kind === 'call') return field(e.data, 'judge') ? 'judgeCall' : 'call';
  return e.kind;
}

/* A log line in words: who did what, with its text and, for work handed in, the evidence. */
function eventTitle(t: Messages, e: TaskLogLine): string {
  const by = authorOf(t, e);
  const ev = t.tasks.events as Record<string, ((who: string) => string) | undefined>;
  return ev[eventKey(e)]?.(by) ?? by;
}

/* Hornhoof's line about a turn a node restart cut off, in the person's language, from what it kept: where, when and why,
   then the retry, or who in Operations was called when the retry was cut off too. Its English text is for the agents. */
function cutText(t: Messages, data: unknown, when: (at: string) => string): string | null {
  const [job, cause, at, node] = [field(data, 'job'), field(data, 'cause'), field(data, 'at'), field(data, 'node')];
  if (typeof job !== 'string' || typeof cause !== 'string' || typeof at !== 'string') return null;
  const named = field(node, 'id') ? String(field(node, 'name')) : null;
  const [retry, called] = [field(data, 'retry'), field(data, 'called')];
  const then =
    field(data, 'first') !== undefined
      ? called
        ? t.restarts.called(String(field(called, 'name')))
        : t.restarts.nobody
      : retry
        ? t.restarts.retry(Number(field(retry, 'n')), Number(field(retry, 'of')))
        : t.restarts.notRetried;
  return `${cutLine(t, { node: named, cause, job }, when(at))} ${then}`;
}

/* Hornhoof's line about a turn whose machine it cannot reach, and about that machine coming back, in the person's
   language. Its English text is for the agents. */
function awayText(t: Messages, e: TaskLogLine, when: (at: string) => string): string | null {
  const [stage, host, since] = [field(e.data, 'stage'), field(e.data, 'host'), field(e.data, 'since')];
  const machine = typeof host === 'string' && host ? host : null;
  if (stage === 'back') return t.tasks.away.back(machine);
  if (stage === 'ended') return t.tasks.away.ended(machine);
  return stage === 'away' && typeof since === 'string' ? t.tasks.away.gone(machine, when(since)) : null;
}

/* How a one-shot call ended and how long it took, with its verdict when it gave one. */
function callText(t: Messages, e: TaskLogLine): string | null {
  const [n, judge, status, verdict] = [field(e.data, 'number'), field(e.data, 'judge'), field(e.data, 'status'), field(e.data, 'verdict')];
  if (typeof n !== 'number') return null;
  const [from, to] = [field(e.data, 'startedAt'), field(e.data, 'finishedAt')];
  const took = typeof from === 'string' && typeof to === 'string' ? resetDuration(t, Date.parse(to) - Date.parse(from)) : null;
  const done = status === 'done';
  const line = judge ? (done ? t.tasks.calls.judgeAnswered(took) : t.tasks.calls.judgeFailed(took)) : done ? t.tasks.calls.answered(n, took) : t.tasks.calls.failed(n, took);
  if (!verdict || typeof verdict !== 'object') return line;
  const reason = field(verdict, 'reason');
  return `${line} ${field(verdict, 'pass') ? t.tasks.calls.passed : t.tasks.calls.notPassed}${typeof reason === 'string' && reason ? ` ${reason}` : ''}`;
}

/* What a one-shot call was given and what it answered, as written. */
function CallParts({ data }: { data: unknown }) {
  const t = useT();
  const parts = [[t.tasks.calls.brief, field(data, 'brief')], [t.tasks.calls.input, field(data, 'input')], [t.tasks.calls.answer, field(data, 'result')]] as const;
  return (
    <>
      {parts.map(([name, text]) => (typeof text === 'string' && text ? <LogParagraph key={name} text={text} fullRef={null} prefix={`${name}: `} /> : null))}
    </>
  );
}

function skippedText(t: Messages, e: TaskLogLine): string {
  const wake = field(e.data, 'wake');
  if (typeof wake !== 'string') return e.text;
  const run = t.tasks.skippedRuns[wake] ?? t.tasks.skippedRuns.task!;
  const text = t.tasks.skippedRun(authorOf(t, e), run);
  const job = field(e.data, 'job');
  return typeof job === 'string' ? `${text} ${t.tasks.skippedJob(job)}` : text;
}

function obsoleteText(t: Messages, e: TaskLogLine): string {
  const wake = field(e.data, 'wake');
  if (typeof wake !== 'string') return e.text;
  const run = t.tasks.skippedRuns[wake] ?? t.tasks.skippedRuns.task!;
  return t.tasks.obsoleteRun(authorOf(t, e), run);
}

/* System log lines use the person's language; employees' own words stay as they wrote them. */
const systemText: Record<string, (t: Messages, e: TaskLogLine, when: (at: string) => string) => string | null> = {
  wake_skipped: skippedText,
  wake_obsolete: obsoleteText,
  interrupted: (t, e, when) => cutText(t, e.data, when),
  away: awayText,
  call: callText,
};
const lineText = (t: Messages, e: TaskLogLine, when: (at: string) => string): string => field(e.data, 'secretHidden') === true ? t.tasks.hideSecret.done : systemText[e.kind]?.(t, e, when) || e.text;

const evidenceOf = (data: unknown): string | null => {
  const raw = field(data, 'evidence');
  return typeof raw === 'string' && raw ? raw : null;
};

/* The words of the tracker's own lines: a status in the person's language, and a person's name by id. */
type Words = { states: Record<string, string>; names: (id: string) => string | undefined };

/* A log line in words: who did what, with its text and, for work handed in, the evidence. The tracker's own lines, a status
   change, an edit or work passed on to someone else, say it all in their title. */
function LogEntry({ entry, when, words, task, onChanged }: { entry: TaskLogLine; when: (at: string) => string; words: Words; task?: TaskDetail; onChanged?: () => void }) {
  const t = useT();
  const own = trackerLine(t, entry, authorOf(t, entry), words.states, words.names, 'task');
  const said = own !== null || entry.kind === 'created' ? null : lineText(t, entry, when) || null;
  const evidence = evidenceOf(entry.data);

  return (
    <li className={entry.kind}>
      <span className="tp-ev">
        {own ?? eventTitle(t, entry)} {entry.by?.byOrchestrator && <><small>{t.tasks.byOrchestrator}</small> </>}<time dateTime={entry.at}>{when(entry.at)}</time>
      </span>
      <LogParagraph text={said} fullRef={fullTextOf(entry.data, 'text')} />
      <LogParagraph text={evidence} fullRef={fullTextOf(entry.data, 'evidence')} prefix={`${t.tasks.evidence}: `} className="tp-evidence" />
      {task?.mayHideSecret && onChanged && (said || evidence) && <HideSecret taskId={task.id} onChanged={onChanged} />}
      {entry.kind === 'call' && <CallParts data={entry.data} />}
    </li>
  );
}

function useLogWords() {
  const t = useT();
  const { org } = useOrg();
  const people = mapPeople(org);
  return { states: t.tasks.states, names: (id: string) => people.find(p => p.id === id)?.name };
}

export function FullTaskLog({ task, onChanged }: { task: TaskDetail; onChanged: () => void }) {
  const t = useT();
  const { language } = useLanguage();
  const words = useLogWords();
  return (
    <ol className="tp-log" aria-label={t.tasks.fullLog}>
      {task.log.map((entry, i) => (
        <LogEntry key={i} entry={entry} when={at => momentText(language, at)} words={words} task={task} onChanged={onChanged} />
      ))}
    </ol>
  );
}

type Step = { at: string; title: string; note?: string };

const INTERNAL_STEPS = new Set(['wake_skipped', 'wake_obsolete', 'wait_card', 'wait_due', 'reminded', 'continued', 'call', 'away']);
const TITLE_ONLY_STEPS = new Set(['created', 'asked', 'stuck', 'interrupted']);
const RECENT_STEPS = 4;

/* Keep short notes whole. Lengthy reports, evidence and diagnostics are in the full log. */
function noteOf(text: string): string | undefined {
  const line = text.trim().split('\n', 1)[0];
  return line && line.length <= 160 ? line : undefined;
}

function recordedSteps(t: Messages, task: TaskDetail, words: Words, when: (at: string) => string): Step[] {
  return task.log.flatMap(entry => {
    if (INTERNAL_STEPS.has(entry.kind) || (entry.kind === 'updated' && field(entry.data, 'wait'))) return [];
    const external = task.externalWait;
    if (external && field(field(entry.data, 'externalWait'), 'since') === external.since) return [];
    const own = trackerLine(t, entry, authorOf(t, entry), words.states, words.names, 'task');
    const title = own ?? eventTitle(t, entry);
    const note = own || TITLE_ONLY_STEPS.has(entry.kind) ? undefined : noteOf(lineText(t, entry, when));
    const via = entry.by?.byOrchestrator ? ` ${t.tasks.byOrchestrator}` : '';
    return [{ at: entry.at, title: title + via, note }];
  });
}

function currentWaits(t: Messages, task: TaskDetail, language: Language, asksYou: boolean): Step[] {
  const now = Date.now();
  return taskWaits(task, now).map(wait => {
    const external = task.externalWait;
    const recorded = external && matchesExternalWait(wait, external) ? external : null;
    const setter = recorded && task.assignee?.name;
    const until = recorded && !wait.failure && wait.event !== 'time'
      ? new Date(recorded.until).toLocaleTimeString(localeOf(language), { hour: '2-digit', minute: '2-digit' })
      : null;
    const title = waitLabel(t, task, wait, now, language, asksYou && wait.event !== 'ceo');
    const reason = recorded && (wait.kind === 'run' || wait.kind === 'work') ? recorded.reason : null;
    const deadline = until && (setter ? t.tracker.wait.setBy(setter, until) : t.tracker.wait.until(until));
    return { at: wait.since, title: t.tasks.waitStep(wait.who?.name ?? (setter || t.window.hornhoof), title), note: [reason, deadline].filter(Boolean).join(' · ') };
  });
}

function currentHolds(t: Messages, task: TaskDetail, when: (at: string) => string): Step[] {
  const steps: Step[] = [];
  if (task.paused && !task.log.some(entry => field(field(entry.data, 'paused'), 'at') === task.paused?.at)) {
    steps.push({ at: task.paused.at, title: t.tasks.pausedLine(task.paused.reason) });
  }
  if (task.assigneeOffline) {
    const { hostname, since } = task.assigneeOffline;
    steps.push({ at: since ?? task.updatedAt, title: t.agent.offlineSince(hostname, since && when(since)) });
  }
  return steps;
}

export function ShortTaskLog({ task, asksYou }: { task: TaskDetail; asksYou: boolean }) {
  const t = useT();
  const { language } = useLanguage();
  const words = useLogWords();
  const id = useId();
  const [earlier, setEarlier] = useState(false);
  const when = (at: string) => momentText(language, at);
  const steps = [
    ...recordedSteps(t, task, words, when),
    ...currentWaits(t, task, language, asksYou),
    ...currentHolds(t, task, when),
  ].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  if (!steps.length) return null;
  const extra = Math.max(0, steps.length - RECENT_STEPS);

  return (
    <section className="tp-history" aria-label={t.tasks.log}>
      {extra > 0 && (
        <button className="t-link tp-disclosure" type="button" aria-controls={id} aria-expanded={earlier} onClick={() => setEarlier(!earlier)}>
          {earlier ? t.tasks.showLess : t.tasks.earlierSteps}
        </button>
      )}
      <ol className="tp-steps" id={id} aria-label={t.tasks.log}>
        {steps.slice(earlier ? 0 : extra).map((step, i) => (
          <li key={i}><time dateTime={step.at}>{when(step.at)}</time>{' '}<span dir="auto">{step.title}{step.note && `: ${step.note}`}</span></li>
        ))}
      </ol>
    </section>
  );
}
