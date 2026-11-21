import { TASK_PRIORITIES, type TaskPriority } from '@hornhoof/protocol';
import { Fragment, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { api, ApiFailure } from '../api';
import { errorText, Phrase, useLanguage, useT } from '../i18n';
import { mapPeople, useOrg } from '../org';
import { useGoals, usePipelines } from '../tasks';
import { stagesInOrder } from '../tracker';
import type { Department, GoalView, Org, PersonRef, Pipeline, PipelineStage, TaskDetail } from '../types';
import { BusyLabel } from './BusyLabel';
import { useConfirmAction } from './ConfirmAction';
import { Field } from './Field';
import { NewTask } from './NewTask';

/* The people who may answer for work of a department, or of the whole company with none: those who reach it. The one named
   now stays a choice. */
export function responsibleChoices(org: Org | null, departmentId: string | null, current?: PersonRef | null): PersonRef[] {
  const reach = mapPeople(org).filter(p => !p.assistant && p.status === 'active' && (p.access.whole || (departmentId !== null && (p.home?.id === departmentId || p.access.departments.some(d => d.id === departmentId)))));
  const people = reach.map(p => ({ id: p.id, name: p.name }));
  return current && !people.some(p => p.id === current.id) ? [current, ...people] : people;
}

/* A date field's day as the server takes it, and back: midnight UTC of that day. */
const dayOf = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : '');
const isoOf = (day: string) => (day ? new Date(`${day}T00:00:00.000Z`).toISOString() : null);

/* A form's work: one send at a time, its refusal kept in words, and done once the server took it. onRefused: what else a
   refusal asks for. */
function useSend(onDone: () => void, onRefused?: (failure: unknown) => void) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const sending = useRef(false);
  async function submit(action: () => Promise<unknown>) {
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    setFailure(null);
    try {
      await action();
      onDone();
    } catch (err) {
      onRefused?.(err);
      throw err;
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }
  async function send(action: () => Promise<unknown>) {
    try {
      await submit(action);
    } catch (err) {
      setFailure(err);
    }
  }
  return { busy, failure, send, submit };
}

/* Refused because someone changed it after the form opened. */
const changedMeanwhile = (failure: unknown) => failure instanceof ApiFailure && (failure.reason === 'task_changed' || failure.reason === 'goal_changed' || failure.reason === 'pipeline_changed');

/* A form's fields over what it opened on. It compares with that and sends its version, not those of what came after, so a
   change made meanwhile is never sent back. Refused because the thing changed meanwhile, it starts again from what the
   thing is once read again, keeping what the person changed. revision: a second count a thing may keep beside its version,
   as a task keeps one for what the tracker keeps of it; a change of either is the thing read again. */
function useDraft<F extends Record<string, string>>(now: F, version: number, revision = 0) {
  const [base, setBase] = useState({ fields: now, version, revision });
  const [draft, setDraft] = useState(now);
  const [stale, setStale] = useState(false);
  if (stale && (version !== base.version || revision !== base.revision)) {
    setStale(false);
    setBase({ fields: now, version, revision });
    setDraft(Object.fromEntries(Object.entries(now).map(([k, v]) => [k, draft[k] !== base.fields[k] ? draft[k] : v])) as F);
  }
  const set = (change: Partial<F>) => setDraft(d => ({ ...d, ...change }));
  return { draft, set, was: base.fields, version: base.version, revision: base.revision, refused: () => setStale(true) };
}

/* A form in the grid of section 3 of the style book, its head, its refusal and its foot with Save and Cancel. */
function TrackerForm({ label, busy, failure, onSubmit, onCancel, children }: { label: string; busy: boolean; failure: unknown; onSubmit: () => void; onCancel: () => void; children: ReactNode }) {
  const t = useT();
  const id = useId();
  return (
    <form className="form-grid tr-form" aria-labelledby={id} onSubmit={(e: FormEvent) => { e.preventDefault(); onSubmit(); }}>
      <h4 id={id}>{label}</h4>
      {children}
      {failure !== null && <p className="alert" role="alert">{errorText(t, failure)}</p>}
      <div className="form-foot entry-actions" role="group" aria-label={label}>
        <button className="btn" type="submit" disabled={busy} aria-busy={busy}><BusyLabel busy={busy} idle={t.tracker.form.save} working={t.tracker.form.saving} /></button>
        <button className="btn ghost" type="button" onClick={onCancel}>{t.common.cancel}</button>
      </div>
    </form>
  );
}

const taskFields = (task: TaskDetail) => ({
  title: task.title, brief: task.brief, why: task.why ?? '', goal: task.goal?.id ?? '', responsible: task.responsible?.id ?? '', due: dayOf(task.dueAt), priority: task.priority ?? 'normal', pipeline: task.pipelineId ?? '', stage: task.pipelineStageId ?? '',
});

/* What the tracker keeps of a task, changed by whoever acts on its work: only what the person changed goes, with the version
   and the revision the form opened on. A subtask serves the goal of its task, so it names none; a task, a goal of the
   company or of its own department or product. onReload: reads the task again. */
export function TaskEdit({ task, onDone, onCancel, onReload }: { task: TaskDetail & { version: number; revision: number }; onDone: () => void; onCancel: () => void; onReload?: () => void }) {
  const t = useT();
  const words = t.tracker.form;
  const { org } = useOrg();
  const { goals } = useGoals();
  const { pipelines } = usePipelines();
  const { draft, set, was, version, revision, refused } = useDraft(taskFields(task), task.version, task.revision);
  const { title, brief, why, goal, responsible, due, priority, pipeline, stage } = draft;
  const { busy, failure, send } = useSend(onDone, err => {
    if (!changedMeanwhile(err)) return;
    refused();
    onReload?.();
  });
  const department = task.department?.id ?? null;
  const ours = (pipelines ?? []).filter(p => !p.archived && p.department.id === department);
  const stages = stagesInOrder(ours.find(p => p.id === pipeline)?.stages ?? []);
  const people = responsibleChoices(org, department, task.responsible);
  const places = new Set([department, task.product?.id ?? null].filter(Boolean));
  const served = (goals ?? []).filter(g => g.id === goal || (g.status === 'active' && (g.department === null || places.has(g.department.id))));

  function save() {
    const change: Record<string, unknown> = {};
    if (title.trim() !== was.title) change.title = title.trim();
    if (brief.trim() !== was.brief) change.brief = brief.trim();
    if (why.trim() !== was.why) change.why = why.trim();
    if (!task.parentId && goal !== was.goal) change.goal = goal || null;
    if (responsible && responsible !== was.responsible) change.responsible = responsible;
    if (priority !== was.priority) change.priority = priority;
    if (due !== was.due) change.due = isoOf(due);
    if (pipeline !== was.pipeline) change.pipeline = pipeline || null;
    if (pipeline && stage !== was.stage) change.stage = stage || null;
    if (!Object.keys(change).length) return onCancel();
    void send(() => api.patch(`/api/tasks/${task.id}`, { version, revision, ...change }));
  }

  return (
    <TrackerForm label={words.editTask} busy={busy} failure={failure} onSubmit={save} onCancel={onCancel}>
      <Field label={words.title}>{p => <input {...p} value={title} maxLength={120} required onChange={e => set({ title: e.target.value })} />}</Field>
      <Field label={words.brief}>{p => <input {...p} value={brief} maxLength={600} onChange={e => set({ brief: e.target.value })} />}</Field>
      <Field label={words.why}>{p => <textarea {...p} rows={3} value={why} maxLength={300} onChange={e => set({ why: e.target.value })} />}</Field>
      {task.parentId ? (
        <p className="muted">{words.subtaskGoal}</p>
      ) : (
        <Field label={words.goal}>
          {p => (
            <select {...p} value={goal} onChange={e => set({ goal: e.target.value })}>
              <option value="">{words.noGoal}</option>
              {served.map(g => <option key={g.id} value={g.id}>{g.title}</option>)}
            </select>
          )}
        </Field>
      )}
      <Field label={words.responsible}>
        {p => (
          <select {...p} value={responsible} onChange={e => set({ responsible: e.target.value })}>
            {!responsible && <option value="">{t.tracker.nobody}</option>}
            {people.map(person => <option key={person.id} value={person.id}>{person.name}</option>)}
          </select>
        )}
      </Field>
      <Field label={t.tracker.priority.label}>{p => (
        <select {...p} value={priority} onChange={e => set({ priority: e.target.value as TaskPriority })}>
          {TASK_PRIORITIES.map(level => <option key={level} value={level}>{t.tracker.priority[level]}</option>)}
        </select>
      )}</Field>
      <Field label={words.due}>{p => <input {...p} type="date" value={due} onChange={e => set({ due: e.target.value })} />}</Field>
      {ours.length > 0 && (
        <Field label={words.pipeline}>
          {p => (
            <select {...p} value={pipeline} onChange={e => set({ pipeline: e.target.value, stage: '' })}>
              <option value="">{words.noPipeline}</option>
              {ours.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}
            </select>
          )}
        </Field>
      )}
      {pipeline && stages.length > 0 && (
        <Field label={words.stage}>
          {p => (
            <select {...p} value={stage} onChange={e => set({ stage: e.target.value })}>
              <option value="">{t.tracker.statuses.notStarted}</option>
              {stages.map(s => <option key={s.id} value={s.id}>{`${'· '.repeat(s.depth)}${s.name}`}</option>)}
            </select>
          )}
        </Field>
      )}
    </TrackerForm>
  );
}

const goalFields = (goal: GoalView | undefined) => ({
  title: goal?.title ?? '', why: goal?.why ?? '', parent: goal?.parentId ?? '', responsible: goal?.responsible.id ?? '', target: goal?.target?.toString() ?? '', current: goal?.current?.toString() ?? '', unit: goal?.unit ?? '', due: dayOf(goal?.dueAt),
});

/* A goal, new or changed: of a department, or of the whole company with none. A new one names only what was filled in; a
   change sends only what the person changed, with the version the form opened on. onReload: reads the goal again. */
export function GoalForm({ goal, department, onDone, onCancel, onReload }: { goal?: GoalView; department: { id: string; name: string } | null; onDone: () => void; onCancel: () => void; onReload?: () => void }) {
  const t = useT();
  const words = t.tracker.form;
  const { org } = useOrg();
  const { goals } = useGoals();
  const { draft, set, was, version, refused } = useDraft(goalFields(goal), goal?.version ?? 0);
  const { title, why, parent, responsible, target, current, unit, due } = draft;
  const { busy, failure, send } = useSend(onDone, err => {
    if (!changedMeanwhile(err)) return;
    refused();
    onReload?.();
  });
  const place = goal ? goal.department : department;
  const people = responsibleChoices(org, place?.id ?? null, goal?.responsible);
  /* A goal is part of a company goal or of one of its own department, never of itself or of one under it. */
  const under = new Set<string>(goal ? [goal.id] : []);
  for (let grew = true; grew; ) {
    grew = false;
    for (const g of goals ?? []) if (g.parentId && under.has(g.parentId) && !under.has(g.id)) grew = !!under.add(g.id);
  }
  const bigger = (goals ?? []).filter(g => g.status === 'active' && !under.has(g.id) && (g.department === null || g.department.id === place?.id));
  const number = (text: string) => (text.trim() === '' ? null : Number(text));
  const sent = (f: typeof draft) => ({ title: f.title.trim(), why: f.why.trim(), parent: f.parent || null, responsible: f.responsible || undefined, target: number(f.target), current: number(f.current), unit: f.unit.trim(), due: isoOf(f.due) });

  function save() {
    const all = sent(draft);
    if (!goal) {
      const given = Object.fromEntries(Object.entries(all).filter(([, v]) => v !== null && v !== undefined && v !== ''));
      return void send(() => api.post('/api/goals', { ...given, department: department?.id ?? null }));
    }
    const before = sent(was);
    const change = Object.fromEntries(Object.entries(all).filter(([k, v]) => v !== undefined && v !== before[k as keyof typeof before]));
    if (!Object.keys(change).length) return onCancel();
    void send(() => api.patch(`/api/goals/${goal.id}`, { version, ...change }));
  }

  return (
    <TrackerForm label={goal ? words.editGoal : words.newGoal} busy={busy} failure={failure} onSubmit={save} onCancel={onCancel}>
      <Field label={words.title}>{p => <input {...p} value={title} maxLength={120} required onChange={e => set({ title: e.target.value })} />}</Field>
      <Field label={words.why}>{p => <textarea {...p} rows={3} value={why} maxLength={300} onChange={e => set({ why: e.target.value })} />}</Field>
      <Field label={words.parentGoal}>
        {p => (
          <select {...p} value={parent} onChange={e => set({ parent: e.target.value })}>
            <option value="">{words.noParent}</option>
            {bigger.map(g => <option key={g.id} value={g.id}>{g.title}</option>)}
          </select>
        )}
      </Field>
      <Field label={words.responsible}>
        {p => (
          <select {...p} value={responsible} onChange={e => set({ responsible: e.target.value })}>
            {!goal && <option value="">{words.byRule}</option>}
            {people.map(person => <option key={person.id} value={person.id}>{person.name}</option>)}
          </select>
        )}
      </Field>
      <Field label={words.target}>{p => <input {...p} type="number" min={0} step="any" inputMode="decimal" value={target} onChange={e => set({ target: e.target.value })} />}</Field>
      <Field label={words.current}>{p => <input {...p} type="number" min={0} step="any" inputMode="decimal" value={current} onChange={e => set({ current: e.target.value })} />}</Field>
      <Field label={words.unit}>{p => <input {...p} value={unit} maxLength={40} onChange={e => set({ unit: e.target.value })} />}</Field>
      <Field label={words.due}>{p => <input {...p} type="date" value={due} onChange={e => set({ due: e.target.value })} />}</Field>
    </TrackerForm>
  );
}

/* owner: who does the stage, a role as role:<id> or an employee as agent:<id>; none until the person chooses. */
type StageDraft = { key: string; id?: string; parent: string; name: string; owner: string };

const ownerOf = (stage: PipelineStage) => (stage.ownerRole ? `role:${stage.ownerRole}` : stage.owner ? `agent:${stage.owner.id}` : '');

type PipelineDraft = { name: string; why: string; stages: StageDraft[] };

const pipelineDraft = (pipeline?: Pipeline): PipelineDraft => ({
  name: pipeline?.name ?? '',
  why: pipeline?.why ?? '',
  stages: stagesInOrder(pipeline?.stages ?? []).map(s => ({ key: s.id, id: s.id, parent: s.parentId ?? '', name: s.name, owner: ownerOf(s) })),
});

/* The draft again over the pipeline as it is now: what the person changed stays, the rest comes as saved meanwhile. Stages
   the person changed stay theirs; one taken out meanwhile goes as a new stage. */
function rebased(draft: PipelineDraft, base: PipelineDraft, now: PipelineDraft): PipelineDraft {
  const kept = (field: 'name' | 'why') => (draft[field] !== base[field] ? draft[field] : now[field]);
  if (JSON.stringify(draft.stages) === JSON.stringify(base.stages)) return { name: kept('name'), why: kept('why'), stages: now.stages };
  const still = new Set(now.stages.map(s => s.id));
  return { name: kept('name'), why: kept('why'), stages: draft.stages.map(({ id, ...s }) => (id && still.has(id) ? { ...s, id } : s)) };
}

/* The pipeline form's draft over what it opened on, as useDraft keeps a task's or a goal's: it sends the version it opened
   on, and once refused it starts again from the pipeline as it is when that comes. */
function usePipelineDraft(pipeline?: Pipeline) {
  const now = pipelineDraft(pipeline);
  const version = pipeline?.version ?? 0;
  const [base, setBase] = useState({ draft: now, version });
  const [draft, setDraft] = useState(now);
  const [stale, setStale] = useState(false);
  if (stale && version !== base.version) {
    setStale(false);
    setBase({ draft: now, version });
    setDraft(rebased(draft, base.draft, now));
  }
  return { draft, setDraft, version: base.version, refused: () => setStale(true) };
}

function removedStageNames(removed: PipelineStage[]): ReactNode {
  return removed.map((stage, i) => <Fragment key={stage.id}>{i > 0 && ', '}<bdi>{stage.name}</bdi></Fragment>);
}

/* A department's pipeline, new or changed: its name, why, and its stages, each after the head or after another stage, each
   done by a role or an employee of the department. Each stage needs a name and the one who does it before it goes. Stages
   keep their ids, so the tasks on them stay. */
export function PipelineForm({ pipeline, department, onDone, onCancel }: { pipeline?: Pipeline; department: Department; onDone: () => void; onCancel: () => void }) {
  const t = useT();
  const words = t.tracker.form;
  const { draft, setDraft, version, refused } = usePipelineDraft(pipeline);
  const { name, why, stages } = draft;
  const setName = (value: string) => setDraft(d => ({ ...d, name: value }));
  const setWhy = (value: string) => setDraft(d => ({ ...d, why: value }));
  const setStages = (change: (list: StageDraft[]) => StageDraft[]) => setDraft(d => ({ ...d, stages: change(d.stages) }));
  const made = useRef(0);
  const key = () => `n${++made.current}`;
  const [tried, setTried] = useState(false);
  const confirmation = useConfirmAction();
  const { busy, failure, send, submit } = useSend(onDone, err => {
    if (changedMeanwhile(err)) refused();
  });
  const { language } = useLanguage();
  const roles = department.roles;
  /* The department's employees, and one who does a stage now though the department no longer lists them. */
  const employees = [...department.employees.map(e => ({ id: e.id, name: e.name })), ...(pipeline?.stages ?? []).flatMap(s => (s.owner && !department.employees.some(e => e.id === s.owner!.id) ? [s.owner] : []))];
  const set = (i: number, change: Partial<StageDraft>) => setStages(list => list.map((s, j) => (j === i ? { ...s, ...change } : s)));
  /* A stage taken out takes the stages after it back to where it stood. */
  const remove = (i: number) => setStages(list => list.filter((_, j) => j !== i).map(s => (s.parent === list[i]!.key ? { ...s, parent: list[i]!.parent } : s)));

  function save() {
    if (stages.some(s => !s.name.trim() || !s.owner)) return setTried(true);
    const owner = (s: StageDraft) => (s.owner.startsWith('role:') ? { ownerRole: s.owner.slice(5) } : { ownerAgentId: s.owner.slice(6) });
    const canonical = (value: string, shown?: string, stock?: string) => value.trim() === shown && stock !== undefined ? stock : value.trim();
    const body = {
      name: canonical(name, pipeline?.name, pipeline?.stockName),
      why: canonical(why, pipeline?.why, pipeline?.stockWhy),
      stages: stages.map(s => {
        const before = pipeline?.stages.find(stage => stage.id === s.id);
        return { key: s.key, ...(s.id ? { id: s.id } : {}), parent: s.parent || null, name: canonical(s.name, before?.name, before?.stockName), ...owner(s) };
      }),
    };
    if (!pipeline) return void send(() => api.post('/api/pipelines', { department: department.id, ...body }));
    const patch = () => api.patch(`/api/pipelines/${pipeline.id}`, { version, ...body });
    const removed = pipeline.stages.filter(s => !stages.some(d => d.id === s.id));
    if (!removed.length) return void send(patch);
    const confirm = t.tracker.confirm.removeStage;
    const many = removed.length > 1;
    confirmation.ask({
      title: many ? confirm.titleMany : confirm.title,
      effect: <Phrase words={many ? confirm.effectMany : confirm.effect} values={[removedStageNames(removed), <bdi>{pipeline.name}</bdi>]} />,
      yes: confirm.yes,
      working: confirm.working,
      final: true,
      danger: true,
      onYes: () => submit(patch),
    });
  }

  return (
    <>
      <TrackerForm label={pipeline ? words.editPipeline : words.newPipeline} busy={busy} failure={failure} onSubmit={save} onCancel={onCancel}>
        <Field label={words.name}>{p => <input {...p} value={name} maxLength={80} required onChange={e => setName(e.target.value)} />}</Field>
        <Field label={words.why}>{p => <textarea {...p} rows={2} value={why} maxLength={300} onChange={e => setWhy(e.target.value)} />}</Field>
        <fieldset className="field-group tr-stages">
          <legend>{words.stages}</legend>
          <div className="field-group-body">
            {stages.map((s, i) => (
              <div key={s.key} className="tr-stage" role="group" aria-label={words.stageN(i + 1)}>
                <Field label={words.stageName} problem={tried && !s.name.trim() ? words.stageNeedsName : undefined}>{p => <input {...p} value={s.name} maxLength={60} onChange={e => set(i, { name: e.target.value })} />}</Field>
                <Field label={words.after}>
                  {p => (
                    <select {...p} value={s.parent} onChange={e => set(i, { parent: e.target.value })}>
                      <option value="">{words.afterHead}</option>
                      {stages.slice(0, i).map(o => <option key={o.key} value={o.key}>{o.name || words.stageN(stages.indexOf(o) + 1)}</option>)}
                    </select>
                  )}
                </Field>
                <Field label={words.owner} problem={tried && !s.owner ? words.stageNeedsOwner : undefined}>
                  {p => (
                    <select {...p} value={s.owner} onChange={e => set(i, { owner: e.target.value })}>
                      {!s.owner && <option value="" disabled>{words.chooseOwner}</option>}
                      <optgroup label={words.roles}>{roles.map(r => <option key={r.id} value={`role:${r.id}`}>{r.title[language]}</option>)}</optgroup>
                      {employees.length > 0 && <optgroup label={words.employees}>{employees.map(e => <option key={e.id} value={`agent:${e.id}`}>{e.name}</option>)}</optgroup>}
                    </select>
                  )}
                </Field>
                <div className="entry-actions">
                  <button className="btn ghost" type="button" onClick={() => remove(i)}>{words.removeStage}</button>
                </div>
              </div>
            ))}
            <div className="entry-actions">
              <button className="btn ghost" type="button" onClick={() => setStages(list => [...list, { key: key(), parent: list.at(-1)?.key ?? '', name: '', owner: '' }])}>{words.addStage}</button>
            </div>
          </div>
        </fieldset>
      </TrackerForm>
      {confirmation.question}
    </>
  );
}

/* A task for a department, from a person who gives it work: it goes to the department's head, named unless it is called
   after its role. */
export function TrackerNewTask({ department, pipelineId, onCreated, onCancel, place }: { department: Department; pipelineId?: string | null; onCreated: (task: TaskDetail) => void; onCancel: () => void; place?: ReactNode }) {
  const { language } = useLanguage();
  const head = department.employees.find(e => e.kind === 'head');
  if (!head) return null;
  return <NewTask department={department} showPriority pipelineId={pipelineId} head={head.title?.[language] === head.name ? null : head.name} onCreated={onCreated} onCancel={onCancel} place={place} />;
}
