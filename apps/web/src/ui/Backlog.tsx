import { useEffect, useId, useRef, useState, type DragEvent, type FormEvent, type MouseEvent } from 'react';
import { addToBacklog, moved, orderBacklog, removeFromBacklog, scheduleBacklog, useBacklog } from '../backlog';
import { errorText, Phrase, useLanguage, useT } from '../i18n';
import type { BacklogItem } from '../types';
import { useConfirmAction } from './ConfirmAction';
import { Edge } from './Edge';
import { Field } from './Field';
import { useEntriesFit } from './SortTable';

const COLUMNS = 3;
/* A click on a control of a row does only what the control does, not open the row as well. */
const alone = (fn: () => void) => (e: MouseEvent) => {
  e.stopPropagation();
  fn();
};

/* A new item: its title and what to do. */
function AddForm({ onAdd, onCancel }: { onAdd: (item: { title: string; text: string }) => Promise<boolean>; onCancel: () => void }) {
  const t = useT();
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  async function add(e: FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    setBusy(true);
    if (await onAdd({ title: title.trim(), text: text.trim() })) {
      setTitle('');
      setText('');
    }
    setBusy(false);
  }
  return (
    <form className="new-task" onSubmit={e => void add(e)}>
      <Field label={t.common.title}>{p => <input {...p} value={title} onChange={e => setTitle(e.target.value)} maxLength={120} required autoFocus />}</Field>
      <Field label={t.backlog.text}>{p => <textarea {...p} rows={4} value={text} onChange={e => setText(e.target.value)} maxLength={20000} />}</Field>
      <div className="repo-actions">
        <button className="btn small" type="submit" disabled={busy || !title.trim()}>{t.backlog.save}</button>
        <button className="btn small ghost" type="button" onClick={onCancel}>{t.common.cancel}</button>
      </div>
    </form>
  );
}

type Drag = { id: string; over: number | null };
type RowProps = {
  item: BacklogItem; index: number; count: number; chosen: boolean; open: boolean; busy: boolean; drag: Drag | null;
  onChoose: () => void; onOpen: () => void; onMove: (to: number) => void; onRemove: () => void;
  onDrag: (drag: Drag | null) => void; onDrop: () => void;
};

/* One item: a box to choose it, its title, who put it there, and its buttons. The row is dragged by mouse to another place;
   the buttons move it one place up or down, which works on a phone as well. */
function ItemRow({ item, index, count, chosen, open, busy, drag, onChoose, onOpen, onMove, onRemove, onDrag, onDrop }: RowProps) {
  const t = useT();
  /* Where the dragged row would go: above this one, or below it from its lower half. Entering the row shows it at once. */
  const over = (e: DragEvent<HTMLTableRowElement>) => {
    if (!drag) return;
    e.preventDefault();
    const box = e.currentTarget.getBoundingClientRect();
    const place = index + (e.clientY > box.top + box.height / 2 ? 1 : 0);
    if (place !== drag.over) onDrag({ ...drag, over: place });
  };
  const mark = drag?.over === index ? ' drop-before' : drag?.over === index + 1 && index === count - 1 ? ' drop-after' : '';
  return (
    <>
      <tr
        className={`rm bl-row${open ? ' open' : ''}${drag?.id === item.id ? ' dragging' : ''}${mark}`}
        aria-label={item.title}
        draggable={!busy}
        onDragStart={e => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', item.id); onDrag({ id: item.id, over: null }); }}
        onDragEnter={over}
        onDragOver={over}
        onDrop={e => { e.preventDefault(); onDrop(); }}
        onDragEnd={() => onDrag(null)}
        onClick={() => { if (!window.getSelection()?.toString()) onOpen(); }}
      >
        <td className="k-name">
          <span className="bl-name">
            <input type="checkbox" checked={chosen} aria-label={t.backlog.choose(item.title)} onClick={e => e.stopPropagation()} onChange={onChoose} />
            <svg className="bl-grip" viewBox="0 0 12 12" aria-hidden="true"><title>{t.backlog.drag}</title><path d="M4 2h.01M8 2h.01M4 6h.01M8 6h.01M4 10h.01M8 10h.01" /></svg>
            <button className="rowbtn" type="button" aria-expanded={open} aria-label={t.tables.openCard(item.title)}>
              <svg className="chev" viewBox="0 0 12 12" aria-hidden="true"><path d="m4 2 4 4-4 4" /></svg>
              <span className="nm"><b dir="auto">{item.title}</b></span>
            </button>
          </span>
        </td>
        <td data-label={t.backlog.by}>{item.by.name}</td>
        <td className="row-actions">
          <div className="entry-actions">
            <button className="act" type="button" disabled={busy || index === 0} aria-label={t.backlog.up(item.title)} onClick={alone(() => onMove(index - 1))}>{t.backlog.upShort}</button>
            <button className="act" type="button" disabled={busy || index === count - 1} aria-label={t.backlog.down(item.title)} onClick={alone(() => onMove(index + 1))}>{t.backlog.downShort}</button>
            <button className="act danger" type="button" disabled={busy} aria-label={t.backlog.removeLabel(item.title)} onClick={alone(onRemove)}>{t.backlog.remove}</button>
          </div>
        </td>
      </tr>
      {open && <tr className="det"><td colSpan={COLUMNS}><div className="task-sum"><p className="bl-text" dir="auto">{item.text || t.backlog.noText}</p></div></td></tr>}
    </>
  );
}

/* A department's list of work kept for later turns: people add to it, put it in order, take out what is not needed and put
   the chosen items into the next turn, where they become its tasks. Nobody works on what is in it. */
async function removeBacklogItem(departmentId: string, id: string, onOrder: (items: BacklogItem[]) => void, onBusy: (busy: boolean) => void, onReload: () => void) {
  onBusy(true);
  try {
    onOrder((await removeFromBacklog(departmentId, id)).items);
  } catch (err) {
    onReload();
    throw err;
  } finally {
    onBusy(false);
  }
}

export function Backlog({ departmentId }: { departmentId: string }) {
  const t = useT();
  const heading = useId();
  const { items, failure, load } = useBacklog(departmentId);
  const [order, setOrder] = useState<BacklogItem[] | null>(null);
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<unknown>(null);
  const [said, setSaid] = useState<string | null>(null);
  const confirmation = useConfirmAction();
  /* A fresh list from the server replaces the order shown while a move was on its way, and forgets what is gone. */
  useEffect(() => {
    setOrder(null);
    setChosen(previous => new Set([...previous].filter(id => items?.some(i => i.id === id))));
  }, [items]);
  useEffect(() => {
    setChosen(new Set());
    setOpen(new Set());
    setAdding(false);
    setSaid(null);
    setProblem(null);
  }, [departmentId]);
  const list = order ?? items ?? [];
  /* As a sorting table does, the list stands as entries where it does not fit its frame by whole words. */
  const { language } = useLanguage();
  const frame = useRef<HTMLDivElement>(null);
  useEntriesFit(frame, `${language} ${list.map(i => i.id).join(' ')}`);

  async function act(fn: () => Promise<void>): Promise<boolean> {
    setBusy(true);
    setProblem(null);
    setSaid(null);
    try {
      await fn();
      return true;
    } catch (err) {
      setProblem(err);
      load();
      return false;
    } finally {
      setBusy(false);
    }
  }
  const toggle = (set: ReadonlySet<string>, id: string) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  };
  function move(from: number, to: number) {
    if (from === to || to < 0 || to >= list.length) return;
    const next = moved(list, from, to);
    setOrder(next);
    void act(async () => setOrder((await orderBacklog(departmentId, next.map(i => i.id))).items));
  }
  function drop() {
    const from = drag ? list.findIndex(i => i.id === drag.id) : -1;
    if (drag && drag.over !== null && from >= 0) move(from, drag.over > from ? drag.over - 1 : drag.over);
    setDrag(null);
  }
  const add = (item: { title: string; text: string }) => act(async () => { await addToBacklog(departmentId, item); load(); });
  const remove = (item: BacklogItem) => {
    setProblem(null);
    setSaid(null);
    confirmation.ask({
      ...t.backlog.confirm.remove,
      effect: <Phrase words={t.backlog.confirm.remove.effect} values={[<bdi>{item.title}</bdi>]} />,
      final: true,
      danger: true,
      onYes: () => removeBacklogItem(departmentId, item.id, setOrder, setBusy, load),
    });
  };
  const schedule = () => void act(async () => {
    const ids = list.filter(i => chosen.has(i.id)).map(i => i.id);
    const done = await scheduleBacklog(departmentId, ids);
    setOrder(list.filter(i => !chosen.has(i.id)));
    setChosen(new Set());
    load();
    setSaid(t.backlog.scheduled(done.tasks.map(x => `#${x.number}`).join(', ')));
  });

  return (
    <section className="backlog" aria-labelledby={heading}>
      <div className="backlog-head">
        <div>
          <h2 id={heading}>{t.backlog.heading}</h2>
          <p className="muted" dir="auto">{t.backlog.intro}</p>
        </div>
        {!adding && <button className="btn small ghost" type="button" onClick={() => setAdding(true)}>{t.backlog.add}</button>}
      </div>
      {adding && <AddForm onAdd={add} onCancel={() => setAdding(false)} />}
      {failure !== null && <p className="alert" role="alert" dir="auto">{errorText(t, failure)}</p>}
      {items && !list.length && <p className="muted" dir="auto">{t.backlog.empty}</p>}
      {list.length > 0 && (
        <Edge className="tbl-frame"><div className="tbl" ref={frame}>
          <table className="dt task-table bl-table" aria-label={t.backlog.heading}>
            <thead><tr>
              <th scope="col">{t.tasks.table.task}</th>
              <th scope="col">{t.backlog.by}</th>
              <th scope="col"><span className="sr">{t.backlog.actions}</span></th>
            </tr></thead>
            <tbody>
              {list.map((item, index) => (
                <ItemRow
                  key={item.id}
                  item={item}
                  index={index}
                  count={list.length}
                  chosen={chosen.has(item.id)}
                  open={open.has(item.id)}
                  busy={busy}
                  drag={drag}
                  onChoose={() => setChosen(previous => toggle(previous, item.id))}
                  onOpen={() => setOpen(previous => toggle(previous, item.id))}
                  onMove={to => move(index, to)}
                  onRemove={() => remove(item)}
                  onDrag={setDrag}
                  onDrop={drop}
                />
              ))}
            </tbody>
          </table>
        </div></Edge>
      )}
      {list.length > 0 && (
        <div className="entry-actions">
          <button className="btn small" type="button" disabled={busy || !chosen.size} onClick={schedule}>{t.backlog.schedule(chosen.size)}</button>
        </div>
      )}
      {said && <p className="muted" role="status" dir="auto">{said}</p>}
      {problem !== null && <p className="alert" role="alert" dir="auto">{errorText(t, problem)}</p>}
      {confirmation.question}
    </section>
  );
}
