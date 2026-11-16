import { useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { api } from '../api';
import { errorText, useLanguage, useT } from '../i18n';
import { mapPeople, useOrg } from '../org';
import { useGoals, usePipelines } from '../tasks';
import { stagesInOrder } from '../tracker';
import type { Department, GoalView, Org, PersonRef, Pipeline, TaskDetail } from '../types';
import { BusyLabel } from './BusyLabel';
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

/* A form's work: one send at a time, its refusal kept in words, and done once the server took it. */
function useSend(onDone: () => void) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const sending = useRef(false);
  async function send(action: () => Promise<unknown>) {
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    setFailure(null);
    try {
      await action();
      onDone();
    } catch (err) {
      setFailure(err);
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }
  return { busy, failure, send };
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

/* What the tracker keeps of a task, changed by whoever acts on its work: only what changed goes, with the version read. A
   subtask serves the goal of its task, so it names none. */
export function TaskEdit({ task, onDone, onCancel }: { task: TaskDetail & { version: number }; onDone: () => void; onCancel: () => void }) {
  const t = useT();
  const words = t.tracker.form;
  const { org } = useOrg();
  const { goals } = useGoals();
  const { pipelines } = usePipelines();
  const [title, setTitle] = useState(task.title);
  const [brief, setBrief] = useState(task.brief);
  const [why, setWhy] = useState(task.why ?? '');
  const [goal, setGoal] = useState(task.goal?.id ?? '');
  const [responsible, setResponsible] = useState(task.responsible?.id ?? '');
  const [due, setDue] = useState(dayOf(task.dueAt));
  const [pipeline, setPipeline] = useState(task.pipelineId ?? '');
  const [stage, setStage] = useState(task.pipelineStageId ?? '');
  const { busy, failure, send } = useSend(onDone);
  const department = task.department?.id ?? null;
  const ours = (pipelines ?? []).filter(p => !p.archived && p.department.id === department);
  const stages = stagesInOrder(ours.find(p => p.id === pipeline)?.stages ?? []);
  const people = responsibleChoices(org, department, task.responsible);

  function save() {
    const change: Record<string, unknown> = {};
    if (title.trim() !== task.title) change.title = title.trim();
    if (brief.trim() !== task.brief) change.brief = brief.trim();
    if (why.trim() !== (task.why ?? '')) change.why = why.trim();
    if (!task.parentId && goal !== (task.goal?.id ?? '')) change.goal = goal || null;
    if (responsible && responsible !== task.responsible?.id) change.responsible = responsible;
    if (due !== dayOf(task.dueAt)) change.due = isoOf(due);
    if (pipeline !== (task.pipelineId ?? '')) change.pipeline = pipeline || null;
    if (pipeline && stage !== (task.pipelineStageId ?? '')) change.stage = stage || null;
    if (!Object.keys(change).length) return onCancel();
    void send(() => api.patch(`/api/tasks/${task.id}`, { version: task.version, ...change }));
  }

  return (
    <TrackerForm label={words.editTask} busy={busy} failure={failure} onSubmit={save} onCancel={onCancel}>
      <Field label={words.title}>{p => <input {...p} value={title} maxLength={120} required onChange={e => setTitle(e.target.value)} />}</Field>
      <Field label={words.brief}>{p => <input {...p} value={brief} maxLength={600} onChange={e => setBrief(e.target.value)} />}</Field>
      <Field label={words.why}>{p => <textarea {...p} rows={3} value={why} maxLength={300} onChange={e => setWhy(e.target.value)} />}</Field>
      {task.parentId ? (
        <p className="muted">{words.subtaskGoal}</p>
      ) : (
        <Field label={words.goal}>
          {p => (
            <select {...p} value={goal} onChange={e => setGoal(e.target.value)}>
              <option value="">{words.noGoal}</option>
              {(goals ?? []).filter(g => g.status === 'active' || g.id === goal).map(g => <option key={g.id} value={g.id}>{g.title}</option>)}
            </select>
          )}
        </Field>
      )}
      <Field label={words.responsible}>
        {p => (
          <select {...p} value={responsible} onChange={e => setResponsible(e.target.value)}>
            {!responsible && <option value="">{t.tracker.nobody}</option>}
            {people.map(person => <option key={person.id} value={person.id}>{person.name}</option>)}
          </select>
        )}
      </Field>
      <Field label={words.due}>{p => <input {...p} type="date" value={due} onChange={e => setDue(e.target.value)} />}</Field>
      {ours.length > 0 && (
        <Field label={words.pipeline}>
          {p => (
            <select {...p} value={pipeline} onChange={e => { setPipeline(e.target.value); setStage(''); }}>
              <option value="">{words.noPipeline}</option>
              {ours.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}
            </select>
          )}
        </Field>
      )}
      {pipeline && stages.length > 0 && (
        <Field label={words.stage}>
          {p => (
            <select {...p} value={stage} onChange={e => setStage(e.target.value)}>
              <option value="">{t.tracker.statuses.notStarted}</option>
              {stages.map(s => <option key={s.id} value={s.id}>{`${'· '.repeat(s.depth)}${s.name}`}</option>)}
            </select>
          )}
        </Field>
      )}
    </TrackerForm>
  );
}

/* A goal, new or changed: of a department, or of the whole company with none. A new one names only what was filled in; a
   change sends only what changed, with the version read. */
export function GoalForm({ goal, department, onDone, onCancel }: { goal?: GoalView; department: { id: string; name: string } | null; onDone: () => void; onCancel: () => void }) {
  const t = useT();
  const words = t.tracker.form;
  const { org } = useOrg();
  const { goals } = useGoals();
  const [title, setTitle] = useState(goal?.title ?? '');
  const [why, setWhy] = useState(goal?.why ?? '');
  const [parent, setParent] = useState(goal?.parentId ?? '');
  const [responsible, setResponsible] = useState(goal?.responsible.id ?? '');
  const [target, setTarget] = useState(goal?.target?.toString() ?? '');
  const [current, setCurrent] = useState(goal?.current?.toString() ?? '');
  const [unit, setUnit] = useState(goal?.unit ?? '');
  const [due, setDue] = useState(dayOf(goal?.dueAt));
  const { busy, failure, send } = useSend(onDone);
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

  function save() {
    const all = { title: title.trim(), why: why.trim(), parent: parent || null, responsible: responsible || undefined, target: number(target), current: number(current), unit: unit.trim(), due: isoOf(due) };
    if (!goal) {
      const given = Object.fromEntries(Object.entries(all).filter(([, v]) => v !== null && v !== undefined && v !== ''));
      return void send(() => api.post('/api/goals', { ...given, department: department?.id ?? null }));
    }
    const was = { title: goal.title, why: goal.why, parent: goal.parentId, responsible: goal.responsible.id, target: goal.target, current: goal.current, unit: goal.unit, due: goal.dueAt ? isoOf(dayOf(goal.dueAt)) : null };
    const change = Object.fromEntries(Object.entries(all).filter(([k, v]) => v !== undefined && v !== was[k as keyof typeof was]));
    if (!Object.keys(change).length) return onCancel();
    void send(() => api.patch(`/api/goals/${goal.id}`, { version: goal.version, ...change }));
  }

  return (
    <TrackerForm label={goal ? words.editGoal : words.newGoal} busy={busy} failure={failure} onSubmit={save} onCancel={onCancel}>
      <Field label={words.title}>{p => <input {...p} value={title} maxLength={120} required onChange={e => setTitle(e.target.value)} />}</Field>
      <Field label={words.why}>{p => <textarea {...p} rows={3} value={why} maxLength={300} onChange={e => setWhy(e.target.value)} />}</Field>
      <Field label={words.parentGoal}>
        {p => (
          <select {...p} value={parent} onChange={e => setParent(e.target.value)}>
            <option value="">{words.noParent}</option>
            {bigger.map(g => <option key={g.id} value={g.id}>{g.title}</option>)}
          </select>
        )}
      </Field>
      <Field label={words.responsible}>
        {p => (
          <select {...p} value={responsible} onChange={e => setResponsible(e.target.value)}>
            {!goal && <option value="">{words.byRule}</option>}
            {people.map(person => <option key={person.id} value={person.id}>{person.name}</option>)}
          </select>
        )}
      </Field>
      <Field label={words.target}>{p => <input {...p} type="number" min={0} step="any" inputMode="decimal" value={target} onChange={e => setTarget(e.target.value)} />}</Field>
      <Field label={words.current}>{p => <input {...p} type="number" min={0} step="any" inputMode="decimal" value={current} onChange={e => setCurrent(e.target.value)} />}</Field>
      <Field label={words.unit}>{p => <input {...p} value={unit} maxLength={40} onChange={e => setUnit(e.target.value)} />}</Field>
      <Field label={words.due}>{p => <input {...p} type="date" value={due} onChange={e => setDue(e.target.value)} />}</Field>
    </TrackerForm>
  );
}

type StageDraft = { key: string; id?: string; parent: string; name: string; ownerRole: string };

/* A department's pipeline, new or changed: its name, why, and its stages, each after the head or after another stage, each
   owned by a role of the department. Stages keep their ids, so the tasks on them stay. */
export function PipelineForm({ pipeline, department, onDone, onCancel }: { pipeline?: Pipeline; department: Department; onDone: () => void; onCancel: () => void }) {
  const t = useT();
  const words = t.tracker.form;
  const [name, setName] = useState(pipeline?.name ?? '');
  const [why, setWhy] = useState(pipeline?.why ?? '');
  const made = useRef(0);
  const key = () => `n${++made.current}`;
  const [stages, setStages] = useState<StageDraft[]>(() => stagesInOrder(pipeline?.stages ?? []).map(s => ({ key: s.id, id: s.id, parent: s.parentId ?? '', name: s.name, ownerRole: s.ownerRole ?? '' })));
  const { busy, failure, send } = useSend(onDone);
  const { language } = useLanguage();
  const roles = department.roles;
  const set = (i: number, change: Partial<StageDraft>) => setStages(list => list.map((s, j) => (j === i ? { ...s, ...change } : s)));
  /* A stage taken out takes the stages after it back to where it stood. */
  const remove = (i: number) => setStages(list => list.filter((_, j) => j !== i).map(s => (s.parent === list[i]!.key ? { ...s, parent: list[i]!.parent } : s)));

  function save() {
    const body = { name: name.trim(), why: why.trim(), stages: stages.filter(s => s.name.trim()).map(s => ({ key: s.key, ...(s.id ? { id: s.id } : {}), parent: s.parent || null, name: s.name.trim(), ...(s.ownerRole ? { ownerRole: s.ownerRole } : {}) })) };
    void send(() => (pipeline ? api.patch(`/api/pipelines/${pipeline.id}`, { version: pipeline.version, ...body }) : api.post('/api/pipelines', { department: department.id, ...body })));
  }

  return (
    <TrackerForm label={pipeline ? words.editPipeline : words.newPipeline} busy={busy} failure={failure} onSubmit={save} onCancel={onCancel}>
      <Field label={words.name}>{p => <input {...p} value={name} maxLength={80} required onChange={e => setName(e.target.value)} />}</Field>
      <Field label={words.why}>{p => <textarea {...p} rows={2} value={why} maxLength={300} onChange={e => setWhy(e.target.value)} />}</Field>
      <fieldset className="field-group tr-stages">
        <legend>{words.stages}</legend>
        <div className="field-group-body">
          {stages.map((s, i) => (
            <div key={s.key} className="tr-stage" role="group" aria-label={words.stageN(i + 1)}>
              <Field label={words.stageName}>{p => <input {...p} value={s.name} maxLength={60} onChange={e => set(i, { name: e.target.value })} />}</Field>
              <Field label={words.after}>
                {p => (
                  <select {...p} value={s.parent} onChange={e => set(i, { parent: e.target.value })}>
                    <option value="">{words.afterHead}</option>
                    {stages.slice(0, i).map(o => <option key={o.key} value={o.key}>{o.name || words.stageN(stages.indexOf(o) + 1)}</option>)}
                  </select>
                )}
              </Field>
              <Field label={words.owner}>
                {p => (
                  <select {...p} value={s.ownerRole} onChange={e => set(i, { ownerRole: e.target.value })}>
                    <option value="">{words.noOwner}</option>
                    {roles.map(r => <option key={r.id} value={r.id}>{r.title[language]}</option>)}
                  </select>
                )}
              </Field>
              <div className="entry-actions">
                <button className="btn ghost" type="button" onClick={() => remove(i)}>{words.removeStage}</button>
              </div>
            </div>
          ))}
          <div className="entry-actions">
            <button className="btn ghost" type="button" onClick={() => setStages(list => [...list, { key: key(), parent: list.at(-1)?.key ?? '', name: '', ownerRole: '' }])}>{words.addStage}</button>
          </div>
        </div>
      </fieldset>
    </TrackerForm>
  );
}

/* A task for a department, from a person who gives it work: it goes to the department's head. */
export function TrackerNewTask({ department, onCreated, onCancel }: { department: Department; onCreated: (task: TaskDetail) => void; onCancel: () => void }) {
  const t = useT();
  const head = department.employees.find(e => e.kind === 'head');
  if (!head) return <p className="muted">{t.dept.needsHead}</p>;
  return <NewTask department={department} head={head.name} onCreated={onCreated} onCancel={onCancel} />;
}
