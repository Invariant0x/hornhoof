import { TASK_PRIORITIES, type TaskPriority } from '@hornhoof/protocol';
import { useState, type FormEvent } from 'react';
import { api } from '../api';
import { errorText, useT } from '../i18n';
import type { Department, TaskDetail } from '../types';
import { Field } from './Field';

type Props = {
  department: Department;
  pipelineId?: string | null;
  showPriority?: boolean;
  /* The head's name, or null when it is called after its role. */
  head: string | null;
  onCreated: (task: TaskDetail) => void;
  onCancel: () => void;
};

/* A task for a department from a person: it goes to the department's head, for one of its products or the whole department. */
export function NewTask({ department: d, pipelineId, showPriority = false, head, onCreated, onCancel }: Props) {
  const t = useT();
  const [title, setTitle] = useState('');
  const [brief, setBrief] = useState('');
  const [body, setBody] = useState('');
  const [priority, setPriority] = useState<TaskPriority>('normal');
  const [product, setProduct] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);

  async function create(e: FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    setBusy(true);
    setFailure(null);
    try {
      const { task } = await api.post<{ task: TaskDetail }>('/api/tasks', {
        title: title.trim(),
        brief: brief.trim(),
        body: body.trim(),
        department: d.id,
        ...(pipelineId !== undefined ? { pipeline: pipelineId } : {}),
        ...(priority === 'normal' ? {} : { priority }),
        ...(product ? { product } : {}),
      });
      onCreated(task);
    } catch (err) {
      setFailure(err);
      setBusy(false);
    }
  }

  return (
    <form className="new-task" onSubmit={e => void create(e)}>
      <p className="muted">{t.dept.goesTo(head)}</p>
      <Field label={t.common.title}>{p => <input {...p} value={title} onChange={e => setTitle(e.target.value)} maxLength={120} required autoFocus />}</Field>
      <Field label={t.dept.brief}>{p => <input {...p} value={brief} onChange={e => setBrief(e.target.value)} maxLength={600} />}</Field>
      <Field label={t.dept.details}>
        {p => <textarea {...p} rows={5} value={body} onChange={e => setBody(e.target.value)} maxLength={20000} placeholder={t.dept.detailsPlaceholder} />}
      </Field>
      {showPriority && <Field label={t.tracker.priority.label}>{p => (
        <select {...p} value={priority} onChange={e => setPriority(e.target.value as TaskPriority)}>
          {TASK_PRIORITIES.map(level => <option key={level} value={level}>{t.tracker.priority[level]}</option>)}
        </select>
      )}</Field>}
      {d.products.length > 0 && (
        <Field label={t.dept.product}>
          {p => (
            <select {...p} value={product} onChange={e => setProduct(e.target.value)}>
              <option value="">{t.dept.wholeDepartment}</option>
              {d.products.map(x => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </select>
          )}
        </Field>
      )}
      <div className="repo-actions">
        <button className="btn small" type="submit" disabled={busy || !title.trim()}>{t.dept.createTask}</button>
        <button className="btn small ghost" type="button" onClick={onCancel}>{t.common.cancel}</button>
      </div>
      {failure !== null && <p className="alert" role="alert">{errorText(t, failure)}</p>}
    </form>
  );
}
