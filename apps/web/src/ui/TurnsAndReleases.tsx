import { useId, useState } from 'react';
import { deptLabel, errorText, useT, type Messages } from '../i18n';
import { useTurns } from '../tasks';
import { ALL_DEPARTMENTS, byRelease, inDepartment, NO_DEPARTMENT, type Preparing, type Released } from '../task-board';
import type { TaskDepartments, TaskLine, TurnView } from '../types';
import { Backlog } from './Backlog';
import { Field } from './Field';
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
      <b className="grp-title">{turn.title}</b>
      {turn.goal && turn.goal !== turn.title && <span className="muted">{turn.goal}</span>}
      {turn.messages.length > 0 && (
        <details className="turn-words">
          <summary>{t.tasks.words(turn.messages.length)}</summary>
          {turn.messages.map((m, i) => (
            <blockquote key={`${i}-${m.at}`}>
              <cite>{m.by}</cite>
              <p>{m.text}</p>
            </blockquote>
          ))}
        </details>
      )}
    </div>
  );
}

/* The next release of a department: what it is, how many of its goals are done, and its goals in short lines. Its version is
   set by the tag it comes out with, so until then it names the release it follows. */
function NextRelease({ next, rows }: { next: Preparing; rows: CardRows }) {
  const t = useT();
  const { turn, going, done } = next;
  const total = going.length + done.length;
  return (
    <BoardSection heading={t.tasks.board.preparing(turn.number, turn.baseVersion)}>
      <p className="muted">{t.tasks.board.nextWhy}</p>
      <TurnAbout turn={turn} />
      {total > 0 && <Progress done={done.length} total={total} label={t.tasks.board.goalsDone(done.length, total)} wide />}
      {total > 0 ? <GoalRows goals={[...going, ...done]} rows={rows} /> : <p className="muted">{t.tasks.board.noneInTurn}</p>}
    </BoardSection>
  );
}

/* A release out already, folded to one line with how many tasks went into it. */
function ReleasedTurn({ release, rows }: { release: Released; rows: CardRows }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const { turn, goals: went } = release;
  return (
    <div className="release-fold">
      <Fold open={open} onToggle={() => setOpen(!open)}>
        <b>{t.tasks.board.released(turn.number, turn.version)}</b> <span className="muted">{t.tasks.board.relCount(went.length)}</span>
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

/* Turns and releases: what a turn is, the next release of each department getting ready with its goals counted, and the
   releases out already, folded; or, on its own choice, the work outside every release. Then the list for later turns of a
   department of the person's own. */
function Releases({ tasks, turns, rows, department, places }: { tasks: TaskLine[]; turns: TurnView[]; rows: CardRows; department: string; places: TaskDepartments | undefined }) {
  const t = useT();
  const [show, setShow] = useState<Show>('releases');
  const { preparing, outside, released } = byRelease(tasks, turns, rows.asksYou);
  const mine = places?.departments.filter(d => d.mine) ?? [];
  return (
    <>
      <p className="muted">{t.tasks.board.relsWhy}</p>
      <ShowPicker value={show} onChange={setShow} />
      {show === 'outside' ? (
        <>
          <p className="muted">{t.tasks.board.outsideAbout}</p>
          <SplitGoals split={outside} rows={rows} empty={t.tasks.board.noneOutside} />
        </>
      ) : (
        <>
          {!preparing.length && !released.length && <p className="muted">{t.tasks.board.nothingYet}</p>}
          {preparing.map(next => <NextRelease key={next.turn.id} next={next} rows={rows} />)}
          {released.length > 0 && (
            <BoardSection heading={t.tasks.board.closedReleases}>
              {released.map(release => <ReleasedTurn key={release.turn.id} release={release} rows={rows} />)}
            </BoardSection>
          )}
          {mine.some(d => d.id === department) ? <Backlog departmentId={department} /> : mine.length > 0 && <p className="muted">{t.tasks.board.pickDepartment}</p>}
        </>
      )}
    </>
  );
}

/* Turns and releases of the departments the person reads: one department of them, or all of them. */
export function TurnsAndReleases({ tasks, places, rows }: { tasks: TaskLine[] | undefined; places: TaskDepartments | undefined; rows: CardRows }) {
  const t = useT();
  const { turns, failure } = useTurns();
  const [picked, setPicked] = useState(ALL_DEPARTMENTS);
  const choices = choicesOf(t, places);
  const department = choices.some(c => c.id === picked) ? picked : ALL_DEPARTMENTS;
  const shown = inDepartment(tasks ?? [], department);
  const shownTurns = (turns ?? []).filter(turn => department === ALL_DEPARTMENTS || turn.departmentId === department);
  return (
    <section className="board tr-releases" aria-label={t.tracker.side.turns}>
      {choices.length > 1 && <div className="board-tools"><DepartmentPicker choices={choices} value={department} onChange={setPicked} /></div>}
      {failure !== null && <p className="alert" role="alert">{errorText(t, failure)}</p>}
      {tasks && turns && <Releases tasks={shown} turns={shownTurns} rows={rows} department={department} places={places} />}
    </section>
  );
}
