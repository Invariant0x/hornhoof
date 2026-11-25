import { useId, useState } from 'react';
import { api } from '../api';
import { deptLabel, errorText, useT, type Messages } from '../i18n';
import { useTurns } from '../tasks';
import { ALL_DEPARTMENTS, byRelease, inDepartment, NO_DEPARTMENT, type Preparing, type Released } from '../releases';
import { taskTrees, type TaskTree } from '../task-tree';
import type { TaskDepartments, TaskLine, TurnView } from '../types';
import { Backlog } from './Backlog';
import { Field } from './Field';
import { Busy, Hold, useLoad, type LoadPart } from './Loading';
import { BoardSection, Fold, GoalRows, Progress, SplitGoals, type CardRows } from './TaskBoard';

type Choice = { id: string; label: string };

/* The departments to pick from: all of them, each department, and for people with the whole company the orchestrator's
   own work. */
function choicesOf(t: Messages, places: TaskDepartments | undefined): Choice[] {
  if (!places) return [];
  const departments = places.departments.map(d => ({ id: d.id, label: deptLabel(t, d) }));
  return [{ id: ALL_DEPARTMENTS, label: t.tasks.board.allDepartments }, ...departments, ...(places.whole ? [{ id: NO_DEPARTMENT, label: t.tasks.board.orchestrator }] : [])];
}

function DepartmentPicker({ choices, value, onChange }: { choices: Choice[]; value: string; onChange: (id: string) => void }) {
  const t = useT();
  return (
    <Field label={t.tasks.department}>
      {p => (
        <select {...p} value={value} onChange={e => onChange(e.target.value)}>
          {choices.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
        </select>
      )}
    </Field>
  );
}

/* What a turn is for and the words it came from on click. */
function TurnAbout({ turn }: { turn: TurnView }) {
  const t = useT();
  return (
    <div className="grp-head">
      <b className="grp-title" dir="auto">{turn.title}</b>
      {turn.goal && turn.goal !== turn.title && <span className="muted" dir="auto">{turn.goal}</span>}
      {turn.messages.length > 0 && (
        <details className="turn-words">
          <summary>{t.tasks.words(turn.messages.length)}</summary>
          {turn.messages.map((m, i) => (
            <blockquote key={`${i}-${m.at}`}>
              <cite dir="auto">{m.by}</cite>
              <p dir="auto">{m.text}</p>
            </blockquote>
          ))}
        </details>
      )}
    </div>
  );
}

/* Where the turn stands: it waits for a person to start it (the department stands, and whoever may starts it here), or its
   release branch was cut and the batch is frozen until the tag. */
function TurnState({ turn, reload }: { turn: TurnView; reload: () => void }) {
  const tt = useT();
  const t = tt.tasks.board;
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  async function start() {
    setBusy(true);
    setFailure(null);
    try {
      await api.post(`/api/turns/${turn.id}/start`);
      reload();
    } catch (err) {
      setFailure(err);
    } finally {
      setBusy(false);
    }
  }
  if (turn.waiting) {
    return (
      <div className="turn-hold" role="status">
        <b dir="auto">{t.turnWaiting(turn.number)}</b>
        <p className="muted" dir="auto">{t.turnWaitingWhy}</p>
        {turn.canStart && <button type="button" className="btn" disabled={busy} onClick={() => void start()}>{busy ? t.turnStarting : t.turnStartButton(turn.number)}</button>}
        {failure !== null && <p className="alert" role="alert" dir="auto">{errorText(tt, failure)}</p>}
      </div>
    );
  }
  return turn.cutAt ? <p className="turn-hold" role="status" dir="auto">{t.turnFrozen(turn.cutBranch ?? null)}</p> : null;
}

/* The next release of a department: what it is, how many of its goals are done, and its goals in short lines. Its version is
   set by the tag it comes out with, so until then it names the release it follows. */
function NextRelease({ next, rows, reload }: { next: Preparing; rows: CardRows; reload: () => void }) {
  const t = useT();
  const { turn, going, done } = next;
  const total = going.length + done.length;
  return (
    <BoardSection heading={t.tasks.board.preparing(turn.number, turn.baseVersion)}>
      <TurnState turn={turn} reload={reload} />
      <p className="muted" dir="auto">{t.tasks.board.nextWhy}</p>
      <TurnAbout turn={turn} />
      {total > 0 && <Progress done={done.length} total={total} label={t.tasks.board.goalsDone(done.length, total)} wide />}
      {total > 0 ? <GoalRows goals={[...going, ...done]} rows={rows} /> : <p className="muted" dir="auto">{t.tasks.board.noneInTurn}</p>}
    </BoardSection>
  );
}

/* A release out already, folded to one line with how many tasks went into it. */
function ReleasedTurn({ release, rows }: { release: Released; rows: CardRows }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const { turn, trees: went } = release;
  return (
    <div className="release-fold">
      <Fold open={open} onToggle={() => setOpen(!open)}>
        <b dir="auto">{t.tasks.board.released(turn.number, turn.version)}</b> <span className="muted" dir="auto">{t.tasks.board.relCount(went.length)}</span>
      </Fold>
      {open && <GoalRows goals={went} rows={rows} />}
    </div>
  );
}

const SHOWS = ['releases', 'outside'] as const;
type Show = (typeof SHOWS)[number];

/* Releases, or the work outside every release. */
function ShowPicker({ value, onChange }: { value: Show; onChange: (show: Show) => void }) {
  const t = useT();
  const name = useId();
  const label = { releases: t.tasks.board.showReleases, outside: t.tasks.board.showOutside };
  return (
    <fieldset className="segments rel-show">
      <legend>{t.tasks.board.show}</legend>
      {SHOWS.map(show => (
        <label key={show} className={show === value ? 'on' : ''}>
          <input type="radio" name={name} value={show} checked={show === value} onChange={() => onChange(show)} />
          {label[show]}
        </label>
      ))}
    </fieldset>
  );
}

/* The tasks waiting in a queue for a turn with a free slot, a batch for each turn ahead, each in its place in the queue. */
function queueBatches(tasks: TaskLine[]): { ahead: number; trees: TaskTree[] }[] {
  const waiting = tasks.filter(task => task.queue).sort((a, b) => a.queue!.position - b.queue!.position);
  const ahead = [...new Set(waiting.map(task => task.queue!.ahead))].sort((a, b) => a - b);
  return ahead.map(n => ({ ahead: n, trees: taskTrees(waiting.filter(task => task.queue!.ahead === n)) }));
}

/* What waits for a turn with a free slot: why, and a section for each turn ahead. */
function QueueSections({ tasks, rows }: { tasks: TaskLine[]; rows: CardRows }) {
  const t = useT();
  const queue = queueBatches(tasks);
  return (
    <>
      {queue.length > 0 && <p className="muted" dir="auto">{t.tasks.board.queueWhy}</p>}
      {queue.map(batch => (
        <BoardSection key={batch.ahead} heading={t.tasks.board.queueHeading(batch.ahead)}>
          <GoalRows goals={batch.trees} rows={rows} />
        </BoardSection>
      ))}
    </>
  );
}

/* Turns and releases: what a turn is, the next release of each department getting ready with its goals counted, and the
   releases out already, folded; or, on its own choice, the work outside every release. Then the list for later turns of a
   department of the person's own. */
function Releases({ tasks, turns, rows, department, places, reload }: { tasks: TaskLine[]; turns: TurnView[]; rows: CardRows; department: string; places: TaskDepartments | undefined; reload: () => void }) {
  const t = useT();
  const [show, setShow] = useState<Show>('releases');
  /* A task in the queue belongs to no turn yet: it is listed by the turn it waits for, never among the goals of the one getting ready. */
  const { preparing, outside, released } = byRelease(tasks.filter(task => !task.queue), turns, rows.asksYou);
  const mine = places?.departments.filter(d => d.mine) ?? [];
  return (
    <>
      <p className="muted" dir="auto">{t.tasks.board.relsWhy}</p>
      <ShowPicker value={show} onChange={setShow} />
      {show === 'outside' ? (
        <>
          <p className="muted" dir="auto">{t.tasks.board.outsideAbout}</p>
          <SplitGoals split={outside} rows={rows} empty={t.tasks.board.noneOutside} />
        </>
      ) : (
        <>
          {!preparing.length && !released.length && <p className="muted" dir="auto">{t.tasks.board.nothingYet}</p>}
          {preparing.map(next => <NextRelease key={next.turn.id} next={next} rows={rows} reload={reload} />)}
          <QueueSections tasks={tasks} rows={rows} />
          {released.length > 0 && (
            <BoardSection heading={t.tasks.board.closedReleases}>
              {released.map(release => <ReleasedTurn key={release.turn.id} release={release} rows={rows} />)}
            </BoardSection>
          )}
          {mine.some(d => d.id === department) ? <Backlog departmentId={department} /> : mine.length > 0 && <p className="muted" dir="auto">{t.tasks.board.pickDepartment}</p>}
        </>
      )}
    </>
  );
}

/* Turns and releases of the departments the person reads: one department of them, or all of them. */
/* The turns and their releases, once the tasks and the turns both came: until then their room holds the indicator. tasks: the
   tracker's tasks as a part of its load. */
export function TurnsAndReleases({ tasks: part, places, rows }: { tasks: LoadPart; places: TaskDepartments | undefined; rows: CardRows }) {
  const t = useT();
  const { turns, failure, load: loadTurns } = useTurns();
  const load = useLoad([part, { data: turns, failure, load: loadTurns }]);
  const tasks = part.data as TaskLine[] | undefined;
  const [picked, setPicked] = useState(ALL_DEPARTMENTS);
  const choices = choicesOf(t, places);
  const department = choices.some(c => c.id === picked) ? picked : ALL_DEPARTMENTS;
  const shown = inDepartment(tasks ?? [], department);
  const shownTurns = (turns ?? []).filter(turn => department === ALL_DEPARTMENTS || turn.departmentId === department);
  return (
    <section className="board tr-releases" aria-label={t.tracker.side.turns}>
      {choices.length > 1 && <div className="board-tools"><DepartmentPicker choices={choices} value={department} onChange={setPicked} /></div>}
      {turns && failure !== null && <p className="alert" role="alert" dir="auto">{errorText(t, failure)}</p>}
      <Hold load={load}>{load.phase === 'done' ? <Releases tasks={shown} turns={shownTurns} rows={rows} department={department} places={places} reload={loadTurns} /> : <Busy ring={load.ring} />}</Hold>
    </section>
  );
}
