import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';
import { useStream, type LiveMessage } from './live';
import { deptLabel, type Messages } from './i18n';
import type { AgentRef, DepartmentTree, Decisions, Improvement, Lang, Org, TaskDetail, TaskLine, TaskPlace, TurnView } from './types';

/* Fetches the path, again whenever a stream message says it may have changed. undefined until the first answer. */
function useLive<T>(path: string | null, pick: (body: never) => T, refresh: (m: LiveMessage) => boolean): { data: T | undefined; failure: unknown; load: () => void } {
  const [data, setData] = useState<T | undefined>(undefined);
  const [failure, setFailure] = useState<unknown>(null);
  const latest = useRef(path);
  latest.current = path;
  const pickRef = useRef(pick);
  pickRef.current = pick;
  /* Answers can come back out of order; one older than the answer on screen is dropped. */
  const asked = useRef(0);
  const shown = useRef(0);

  const load = useCallback(() => {
    if (!path) return;
    const n = ++asked.current;
    const fresh = () => {
      if (latest.current !== path || n < shown.current) return false;
      shown.current = n;
      return true;
    };
    api.get<never>(path).then(
      body => {
        if (!fresh()) return;
        setData(pickRef.current(body));
        setFailure(null);
      },
      err => fresh() && setFailure(err),
    );
  }, [path]);

  useEffect(() => {
    setData(undefined);
    load();
  }, [load]);

  useStream(m => {
    if (path && (m.type === 'reconnected' || refresh(m))) load();
  });

  return { data, failure, load };
}

export type TaskFilter = { status: 'open' | 'closed' | 'all'; department: string | null };

export const tasksPath = (f: TaskFilter) => `/api/tasks?status=${f.status}${f.department ? `&department=${f.department}` : ''}`;

/* Tasks the person reaches, as the tracker lists them. */
export function useTasks(filter: TaskFilter) {
  const { data, failure, load } = useLive(tasksPath(filter), (b: { tasks: TaskLine[] }) => b.tasks, m => m.type === 'task');
  return { tasks: data, failure, load };
}

/* One task with its gates, subtasks and log. */
export function useTask(id: string) {
  const { data, failure, load } = useLive(`/api/tasks/${id}`, (b: { task: TaskDetail }) => b.task, m => m.type === 'task' || m.type === 'requests');
  return { task: data, failure, load };
}

/* Everything that waits for people as this person may see it: what agents ask on the tasks they reach, the orchestrator's
   cards and his request for the computer, with the counts of all of it. Fetched again when any of them may have changed,
   and when people or access changed, as whose decision it is may move with them. */
export function useDecisions() {
  const { data, failure, load } = useLive('/api/requests', (b: Decisions) => b, m => m.type === 'requests' || m.type === 'org' || m.type === 'computer');
  return { decisions: data, failure, load };
}

/* What employees found to improve, for people who see the whole company; nothing is fetched for others. */
export function useImprovements(company: boolean) {
  const { data, failure, load } = useLive(company ? '/api/improvements' : null, (b: { improvements: Improvement[] }) => b.improvements, m => m.type === 'improvements');
  return { improvements: data, failure, load };
}

/* The company's turns: the last finished ones, the running one and the planned ones, in number order. */
export function useTurns() {
  const { data, failure, load } = useLive('/api/turns', (b: { turns: TurnView[] }) => b.turns, m => m.type === 'org' || m.type === 'task');
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
export function useDepartmentTree(departmentId: string, on: boolean) {
  const result = useLive(on ? `/api/departments/${departmentId}/tree` : null, (b: { tree: DepartmentTree }) => b.tree,
    m => m.type === 'task' && (m.spot?.departmentId === departmentId || m.spot?.parentId === departmentId));
  useEffect(() => {
    if (!on) return;
    const timer = setInterval(result.load, 60_000);
    return () => clearInterval(timer);
  }, [on, result.load]);
  return { tree: result.data, failure: result.failure, load: result.load };
}
