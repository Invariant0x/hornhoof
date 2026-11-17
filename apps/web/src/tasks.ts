import type { DepartmentPipeline } from '@hornhoof/protocol/pipeline-report';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';
import { useStream, type LiveMessage } from './live';
import { refetcher } from './refetch';
import { deptLabel, type Messages } from './i18n';
import type { AgentRef, DepartmentTree, Decisions, GoalView, Improvement, Lang, Org, Pipeline, TaskDepartments, TaskDetail, TaskLine, TaskLogLine, TaskPlace, TurnView, WaitCard } from './types';
import { everyVisible } from './guard';

const hasBody = <B,>(body: B | null | undefined, fresh: () => boolean): body is B => body !== null && body !== undefined && fresh();

/* Fetches the path, again whenever a stream message says it may have changed. undefined until the first answer. */
export function useLive<T>(path: string | null, pick: (body: never) => T, wanted: (m: LiveMessage) => boolean): { data: T | undefined; failure: unknown; load: () => void } {
  const [data, setData] = useState<T | undefined>(undefined);
  const [failure, setFailure] = useState<unknown>(null);
  const latest = useRef(path);
  latest.current = path;
  const pickRef = useRef(pick);
  pickRef.current = pick;
  /* Answers can come back out of order; one older than the answer on screen is dropped. */
  const asked = useRef(0);
  const shown = useRef(0);

  const ask = useCallback(() => {
    if (!path) return Promise.resolve();
    const n = ++asked.current;
    const fresh = () => {
      if (latest.current !== path || n < shown.current) return false;
      shown.current = n;
      return true;
    };
    return api.get<never>(path).then(
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

  return { data, failure, load };
}

/* department: any of the company's, or none for the work given to the orchestrator itself; left out, all the person reads. */
export type TaskFilter = { status: 'open' | 'closed' | 'all'; department?: string };

export const tasksPath = (f: TaskFilter) => `/api/tasks?status=${f.status}${f.department ? `&department=${f.department}` : ''}`;

const taskSource = (filter: TaskFilter, enabled: boolean): string | null => enabled ? tasksPath(filter) : null;

/* Tasks the person reaches, as the tracker lists them. */
export function useTasks(filter: TaskFilter, enabled = true) {
  const { data, failure, load } = useLive(taskSource(filter, enabled), (b: { tasks: TaskLine[] }) => b.tasks, m => m.type === 'task');
  return { tasks: data, failure, load };
}

/* The departments whose tasks the person reads, which can change with their access. */
export function useTaskDepartments() {
  const { data, failure, load } = useLive('/api/task-departments', (b: TaskDepartments) => b, m => m.type === 'org');
  return { taskDepartments: data, failure, load };
}

/* One task with its gates, subtasks and log. */
export function useTask(id: string) {
  const { data, failure, load } = useLive(`/api/tasks/${id}`, (b: { task: TaskDetail }) => b.task, m => m.type === 'task' || m.type === 'requests');
  return { task: data, failure, load };
}

/* The company's goals with their progress, fetched again when a goal or a task changes, as tasks move a goal's progress. */
export function useGoals(enabled = true) {
  const { data, failure, load } = useLive(enabled ? '/api/goals' : null, (b: { goals: GoalView[] }) => b.goals, m => m.type === 'tracker' || m.type === 'task');
  return { goals: data, failure, load };
}

/* One goal with its history. */
export function useGoal(id: string) {
  const { data, failure, load } = useLive(`/api/goals/${id}`, (b: { goal: GoalView; log: TaskLogLine[] }) => b, m => m.type === 'tracker' || m.type === 'task');
  return { goal: data?.goal, log: data?.log, failure, load };
}

/* The pipelines of every department, with their stages in tree order. */
export function usePipelines(enabled = true) {
  const { data, failure, load } = useLive(enabled ? '/api/pipelines' : null, (b: { pipelines: Pipeline[] }) => b.pipelines, m => m.type === 'tracker');
  return { pipelines: data, failure, load };
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

/* ", role" after an agent's name, or nothing when it has none or is called after it. */
export function roleAfter(a: Pick<AgentRef, 'name' | 'role'>, language: keyof Lang): string {
  const role = a.role?.[language];
  return role && role !== a.name ? `, ${role}` : '';
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
