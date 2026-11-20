import type { DepartmentPipeline } from '@hornhoof/protocol/pipeline-report';
import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import { api } from './api';
import { useStream, type LiveMessage } from './live';
import { refetcher } from './refetch';
import { en } from './i18n/en';
import { deptLabel, useT, type Messages } from './i18n';
import type { DepartmentTree, Decisions, GoalView, Improvement, Org, Pipeline, TaskDepartments, TaskDetail, TaskLine, TaskLogLine, TaskPlace, TurnView, WaitCard } from './types';
import { everyVisible } from './guard';

const hasBody = <B,>(body: B | null | undefined, fresh: () => boolean): body is B => body !== null && body !== undefined && fresh();

/* Fetches the path, again whenever a stream message says it may have changed. undefined until the first answer. */
/* Whether the answer to ask n still counts, and if so it is the one on screen: its ask was not stopped, the path is still the
   one asked, and no newer answer is on screen. */
function freshness(control: AbortController, latest: MutableRefObject<string | null>, path: string, n: number, shown: MutableRefObject<number>) {
  return () => {
    if (control.signal.aborted || latest.current !== path || n < shown.current) return false;
    shown.current = n;
    return true;
  };
}

export function useLive<T>(path: string | null, pick: (body: never) => T, wanted: (m: LiveMessage) => boolean): { data: T | undefined; failure: unknown; load: () => void; cancel: () => void } {
  const [data, setData] = useState<T | undefined>(undefined);
  const [failure, setFailure] = useState<unknown>(null);
  const latest = useRef(path);
  latest.current = path;
  const pickRef = useRef(pick);
  pickRef.current = pick;
  /* Answers can come back out of order; one older than the answer on screen is dropped. */
  const asked = useRef(0);
  const shown = useRef(0);
  /* The last ask, which a load given up at its limit stops: its answer, or its failure, no longer counts. */
  const running = useRef<AbortController | null>(null);

  const ask = useCallback(() => {
    if (!path) return Promise.resolve();
    const n = ++asked.current;
    const control = new AbortController();
    running.current = control;
    const fresh = freshness(control, latest, path, n, shown);
    return api.get<never>(path, control.signal).then(
      body => {
        if (!hasBody(body, fresh)) return;
        setData(pickRef.current(body));
        setFailure(null);
      },
      err => fresh() && setFailure(err),
    );
  }, [path]);

  /* What the stream asks for again, a burst of it in a few requests. */
  const askNow = useRef(ask);
  askNow.current = ask;
  const [again] = useState(() => refetcher(() => askNow.current()));

  useEffect(() => {
    setData(undefined);
    void ask();
    return () => again.forget();
  }, [ask, again]);

  useStream(m => {
    if (path && (m.type === 'reconnected' || wanted(m))) again.run();
  });

  const load = useCallback(() => void ask(), [ask]);
  const cancel = useCallback(() => running.current?.abort(), []);

  return { data, failure, load, cancel };
}

/* department: any of the company's, or none for the work given to the orchestrator itself; left out, all the person reads. */
export type TaskFilter = { status: 'open' | 'closed' | 'all'; department?: string };

export const tasksPath = (f: TaskFilter) => `/api/tasks?status=${f.status}${f.department ? `&department=${f.department}` : ''}`;

const taskSource = (filter: TaskFilter, enabled: boolean): string | null => enabled ? tasksPath(filter) : null;

/* The task lines this tab has read, by id: a task's card opens with the title, the status and the facts its row showed,
   while the rest of the task comes. */
const knownLines = new Map<string, TaskLine>();

function known(lines: TaskLine[]): TaskLine[] {
  for (const line of lines) knownLines.set(line.id, line);
  return lines;
}

export const knownLine = (id: string): TaskLine | undefined => knownLines.get(id);

/* The subtasks of a task among the lines this tab has read. */
export const knownSubtasks = (id: string): TaskLine[] => [...knownLines.values()].filter(line => line.parentId === id);

/* Tasks the person reaches, as the tracker lists them. */
export function useTasks(filter: TaskFilter, enabled = true) {
  const { data, failure, load, cancel } = useLive(taskSource(filter, enabled), (b: { tasks: TaskLine[] }) => known(b.tasks), m => m.type === 'task');
  return { tasks: data, failure, load, cancel };
}

/* The departments whose tasks the person reads, which can change with their access. */
export function useTaskDepartments() {
  const { data, failure, load } = useLive('/api/task-departments', (b: TaskDepartments) => b, m => m.type === 'org');
  return { taskDepartments: data, failure, load };
}

/* One task with its gates, subtasks and log. */
export function useTask(id: string) {
  const { data, failure, load, cancel } = useLive(`/api/tasks/${id}`, (b: { task: TaskDetail }) => b.task, m => m.type === 'task' || m.type === 'requests');
  return { task: data, failure, load, cancel };
}

/* The company's goals with their progress, fetched again when a goal or a task changes, as tasks move a goal's progress. */
export function useGoals(enabled = true) {
  const { data, failure, load, cancel } = useLive(enabled ? '/api/goals' : null, (b: { goals: GoalView[] }) => b.goals, m => m.type === 'tracker' || m.type === 'task');
  return { goals: data, failure, load, cancel };
}

/* One goal with its history. */
export function useGoal(id: string) {
  const { data, failure, load } = useLive(`/api/goals/${id}`, (b: { goal: GoalView; log: TaskLogLine[] }) => b, m => m.type === 'tracker' || m.type === 'task');
  return { goal: data?.goal, log: data?.log, failure, load };
}

export function localPipeline<P extends Pipeline>(t: Messages, pipeline: P): P {
  const key = pipeline.catalogKey as keyof Messages['pipelineCatalog'] | null | undefined;
  if (!key || !Object.hasOwn(en.pipelineCatalog, key)) return pipeline;
  const english = en.pipelineCatalog[key];
  const local = t.pipelineCatalog[key];
  const labels: Readonly<Record<string, string>> = local.stages;
  return {
    ...pipeline,
    ...(pipeline.name === english.name ? { name: local.name, stockName: english.name } : {}),
    ...(pipeline.why === english.why ? { why: local.why, stockWhy: english.why } : {}),
    stages: pipeline.stages.map(stage => Object.hasOwn(labels, stage.name) ? { ...stage, name: labels[stage.name]!, stockName: stage.name } : stage),
  };
}

/* The pipelines of every department, with their stages in tree order. */
export function usePipelines(enabled = true) {
  const t = useT();
  const { data, failure, load } = useLive(enabled ? '/api/pipelines' : null, (b: { pipelines: Pipeline[] }) => b.pipelines, m => m.type === 'tracker');
  const pipelines = useMemo(() => data?.map(pipeline => localPipeline(t, pipeline)), [data, t]);
  return { pipelines, failure, load };
}

/* Everything that waits for people as this person may see it: what agents ask on the tasks they reach, the orchestrator's
   cards and his request for the computer, with the counts of all of it. Fetched again when any of them may have changed,
   and when people or access changed, as whose decision it is may move with them. */
export function useDecisions() {
  const { data, failure, load } = useLive('/api/requests', (b: Decisions) => b, m => m.type === 'requests' || m.type === 'org' || m.type === 'computer');
  return { decisions: data, failure, load };
}

/* The cards kept for this person, newest first, fetched again when what waits for people may have changed. */
export function useWaitCards() {
  const { data, failure, load } = useLive('/api/wait-cards', (b: { cards: WaitCard[] }) => b.cards, m => m.type === 'requests');
  return { cards: data, failure, load };
}

/* The person says they saw their card. It decides nothing. */
export const sawCard = (id: string) => api.post<{ ok: true }>(`/api/wait-cards/${id}/ack`);

/* What employees found to improve, for people who see the whole company; nothing is fetched for others. */
export function useImprovements(company: boolean) {
  const { data, failure, load } = useLive(company ? '/api/improvements' : null, (b: { improvements: Improvement[] }) => b.improvements, m => m.type === 'improvements');
  return { improvements: data, failure, load };
}

/* The turns of the company's departments: the last released ones and the open ones, in number order. */
export function useTurns(enabled = true) {
  const { data, failure, load } = useLive(enabled ? '/api/turns' : null, (b: { turns: TurnView[] }) => b.turns, m => m.type === 'org' || m.type === 'task');
  return { turns: data, failure, load };
}

/* A department by the name the person's screen gives it; a product, or a department the company no longer has, by its own. */
export function placeName(t: Messages, org: Org | null | undefined, place: TaskPlace): string {
  if (!place) return '';
  const dept = org?.departments.find(d => d.id === place.id);
  return dept ? deptLabel(t, dept) : place.name;
}

/* Only an open tree or Speed drawer keeps the department clock fresh. */
/* A department's report of a turn, by default the open one or else the last that ran. A closed turn's numbers stay, so only a running one is asked again. */
export function useDepartmentPipeline(departmentId: string, turn: number | null) {
  const path = `/api/departments/${departmentId}/pipeline${turn === null ? '' : `?turn=${turn}`}`;
  const result = useLive(path, (b: { report: DepartmentPipeline }) => b.report, () => false);
  const running = result.data?.turn.source === 'live';
  useEffect(() => {
    if (!running) return;
    return everyVisible(result.load, 60_000);
  }, [running, result.load]);
  return { report: result.data, failure: result.failure, load: result.load };
}

export function useDepartmentTree(departmentId: string, on: boolean) {
  const result = useLive(on ? `/api/departments/${departmentId}/tree` : null, (b: { tree: DepartmentTree }) => b.tree,
    m => m.type === 'task' && (m.spot?.departmentId === departmentId || m.spot?.parentId === departmentId));
  useEffect(() => {
    if (!on) return;
    return everyVisible(result.load, 60_000);
  }, [on, result.load]);
  return { tree: result.data, failure: result.failure, load: result.load };
}
