import { useState } from 'react';
import { deptLabel, errorText, useT } from '../i18n';
import { mapPeople, useOrg } from '../org';
import { placeName, useTasks, useTurns } from '../tasks';
import type { Decisions, Org, ProposalDecision, TaskLine, TaskStatus, TurnView } from '../types';
import { ComputerCard } from '../ui/ComputerCard';
import { Field } from '../ui/Field';
import { Requests, wordsAnswer } from '../ui/Requests';
import { StaffCard } from '../ui/StaffCard';
import { StructureCard } from '../ui/StructureCard';
import { TaskRow } from '../ui/TaskRow';

type Props = {
  decisions: Decisions | undefined;
  onDecisionsChanged: () => void;
  /* Opened from a person's card: only that person's decisions show until the filter is taken off. */
  personId: string | null;
  onClearPerson: () => void;
  selected: string | null;
  onOpenTask: (id: string) => void;
  onOpenAgent: (id: string) => void;
  /* Only for people who see the whole company: they are the ones who write to him. */
  onOpenOrchestrator?: () => void;
};

const CLOSED: TaskStatus[] = ['done', 'cancelled'];

type Rows = { selected: string | null; onOpenTask: (id: string) => void; place: (task: TaskLine) => string };

/* Tasks under the task they serve, in the order they were laid out; a task whose parent is not listed stands at the top. */
function TaskTree({ tasks, rows, under = null }: { tasks: TaskLine[]; rows: Rows; under?: string | null }) {
  const ids = new Set(tasks.map(x => x.id));
  const level = tasks.filter(x => (under ? x.parentId === under : !x.parentId || !ids.has(x.parentId))).sort((a, b) => a.number - b.number);
  if (!level.length) return null;
  return (
    <ul className={under ? 'ttree sub' : 'ttree'}>
      {level.map(task => (
        <li key={task.id}>
          <TaskRow task={task} on={rows.selected === task.id} place={rows.place(task)} onOpen={rows.onOpenTask} showTurn={false} />
          <TaskTree tasks={tasks} rows={rows} under={task.id} />
        </li>
      ))}
    </ul>
  );
}

/* One turn: its number and state, the short title and main point, the words it came from on click, then its tasks. */
function Turn({ turn, tasks, rows }: { turn: TurnView; tasks: TaskLine[]; rows: Rows }) {
  const t = useT();
  const share = turn.tasks.total ? Math.round((turn.tasks.done / turn.tasks.total) * 100) : 0;
  const head = (
    <>
      <div className="turn-name">
        <span className="turn-no">
          <b>{t.tasks.turn(turn.number)}</b>
          <span className={`turn-state ${turn.status}`}>{t.tasks.turnStates[turn.status]}</span>
        </span>
        <h2>{turn.title}</h2>
        {turn.goal && turn.goal !== turn.title && <p>{turn.goal}</p>}
      </div>
      {turn.status === 'planned' ? (
        <small className="turn-wait">{t.tasks.plannedTasks(turn.tasks.total)}</small>
      ) : (
        <div className="turn-progress">
          <span className="turn-track" aria-hidden="true">
            <i style={{ width: `${share}%` }} />
          </span>
          <small>{t.tasks.turnProgress(turn.tasks.done, turn.tasks.total)}</small>
        </div>
      )}
    </>
  );
  const body = (
    <>
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
      <TaskTree tasks={tasks} rows={rows} />
    </>
  );
  if (turn.status === 'closed') {
    return (
      <details className="turn closed" aria-label={t.tasks.turn(turn.number)}>
        <summary className="turn-head">{head}</summary>
        {body}
      </details>
    );
  }
  return (
    <section className={`turn ${turn.status}`} aria-label={t.tasks.turn(turn.number)}>
      <header className="turn-head">{head}</header>
      {body}
    </section>
  );
}

type Waiting = Pick<Props, 'decisions' | 'onDecisionsChanged' | 'personId' | 'onClearPerson' | 'onOpenTask' | 'onOpenAgent' | 'onOpenOrchestrator'> & {
  org: Org | null;
  place: (p: TaskLine['department']) => string;
};

type Shown = Pick<Decisions, 'requests' | 'proposals' | 'computerAccess'>;

/* What of the decisions the screen lists: all of them, or one person's; nothing before the first answer. */
function shownOf(decisions: Decisions | undefined, personId: string | null): Shown {
  const theirs = <T extends { ownerPersonId: string }>(items: T[]) => (personId ? items.filter(i => i.ownerPersonId === personId) : items);
  const computer = decisions?.computerAccess ? theirs([decisions.computerAccess]) : [];
  return { requests: theirs(decisions?.requests ?? []), proposals: theirs(decisions?.proposals ?? []), computerAccess: computer[0] ?? null };
}

const shownNone = (s: Shown) => !s.requests.length && !s.proposals.length && !s.computerAccess;

/* The person whose decisions show, with a cross that shows everyone's again. */
function PersonFilter({ name, onClear }: { name: string; onClear: () => void }) {
  const t = useT();
  return (
    <p className="filter-chip">
      <span>{t.tasks.decisionsFor(name)}</span>
      <button className="zbtn" type="button" aria-label={t.tasks.showAll} title={t.tasks.showAll} onClick={onClear}>
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      </button>
    </p>
  );
}

const nothing = () => {};

/* An orchestrator's card as his window shows it: a structure to build, or people to hire into a department. Correcting it
   in words opens his window. */
function ProposalCard({ card, org, onCorrect = nothing, onDone }: { card: ProposalDecision; org: Org | null; onCorrect?: () => void; onDone: () => void }) {
  const t = useT();
  if (card.kind === 'structure') return <StructureCard proposal={{ id: card.id, brief: card.brief, items: card.items }} departments={org?.departments ?? []} onCorrect={onCorrect} onDone={onDone} />;
  if (!card.department) return null;
  const known = org?.departments.find(d => d.id === card.department!.id);
  const department = { id: card.department.id, name: known ? deptLabel(t, known) : card.department.name };
  return <StaffCard department={department} proposal={{ id: card.id, brief: card.brief, people: card.items }} onCorrect={onCorrect} onDone={onDone} />;
}

type Listed = Pick<Waiting, 'onDecisionsChanged' | 'onOpenTask' | 'onOpenAgent' | 'onOpenOrchestrator' | 'org' | 'place'> & { shown: Shown; onFailure: (err: unknown) => void };

/* Each decision with the buttons it already has elsewhere: requests, then the orchestrator's cards, then the computer. */
function DecisionList({ shown, onDecisionsChanged, onOpenTask, onOpenAgent, onOpenOrchestrator, org, place, onFailure }: Listed) {
  const t = useT();
  const { requests, proposals, computerAccess } = shown;
  return (
    <>
      {requests.length > 0 && <Requests requests={requests} onChanged={onDecisionsChanged} onOpenTask={onOpenTask} onOpenAgent={onOpenAgent} placeName={place} />}
      {wordsAnswer(requests) && <p className="muted">{t.tasks.answerElsewhere}</p>}
      {proposals.map(c => (
        <ProposalCard key={c.id} card={c} org={org} onCorrect={onOpenOrchestrator} onDone={onDecisionsChanged} />
      ))}
      {computerAccess && <ComputerCard view={computerAccess.view} onChange={onDecisionsChanged} onFailure={onFailure} />}
    </>
  );
}

/* What waits for the person: what agents ask, the orchestrator's cards and his request for the computer. Opened from a
   person's card, only theirs, with the filter in sight. */
function WaitingForYou({ decisions, personId, onClearPerson, ...rest }: Waiting) {
  const t = useT();
  const [failure, setFailure] = useState<unknown>(null);
  const shown = shownOf(decisions, personId);
  const name = mapPeople(rest.org).find(p => p.id === personId)?.name ?? t.tasks.someone;

  return (
    <section className="waiting" aria-label={t.tasks.waiting}>
      <h2>{t.tasks.waiting}</h2>
      {personId && <PersonFilter name={name} onClear={onClearPerson} />}
      <DecisionList shown={shown} onFailure={setFailure} {...rest} />
      {decisions && shownNone(shown) && <p className="muted">{personId ? t.tasks.nothingFor(name) : t.tasks.nothingWaiting}</p>}
      {failure !== null && <p className="alert" role="alert">{errorText(t, failure)}</p>}
    </section>
  );
}

/* The tracker shows the work and changes nothing by itself: what waits for the person, then the turns as the orchestrator
   laid them out, the running one first, the planned ones in order and the finished ones folded away. */
export function Tasks({ decisions, onDecisionsChanged, personId, onClearPerson, selected, onOpenTask, onOpenAgent, onOpenOrchestrator }: Props) {
  const t = useT();
  const { org } = useOrg();
  const [department, setDepartment] = useState<string | null>(null);
  const { tasks, failure } = useTasks({ status: 'all', department });
  const { turns, failure: turnsFailure } = useTurns();
  const place = (p: TaskLine['department']) => placeName(t, org, p);
  const rows: Rows = { selected, onOpenTask, place: task => [place(task.department), task.product?.name].filter(Boolean).join(' / ') };
  const of = (turn: TurnView) => tasks?.filter(x => x.turn === turn.number) ?? [];
  const running = turns?.filter(x => x.status === 'open') ?? [];
  const planned = turns?.filter(x => x.status === 'planned') ?? [];
  const finished = turns?.filter(x => x.status === 'closed').reverse() ?? [];
  const outside = tasks?.filter(x => x.turn === null && !CLOSED.includes(x.status)) ?? [];
  const outsideClosed = tasks?.filter(x => x.turn === null && CLOSED.includes(x.status)) ?? [];
  const broken = failure ?? turnsFailure;

  return (
    <section className="tasks">
      <header className="people-head">
        <div>
          <h1>{t.tasks.heading}</h1>
          <p className="muted">{t.tasks.intro}</p>
        </div>
        {onOpenOrchestrator && (
          <button className="btn" type="button" onClick={onOpenOrchestrator}>
            {t.tasks.writeOrchestrator}
          </button>
        )}
      </header>

      <WaitingForYou
        decisions={decisions}
        onDecisionsChanged={onDecisionsChanged}
        personId={personId}
        onClearPerson={onClearPerson}
        onOpenTask={onOpenTask}
        onOpenAgent={onOpenAgent}
        onOpenOrchestrator={onOpenOrchestrator}
        org={org}
        place={place}
      />

      {!!org?.departments.length && (
        <div className="task-filters">
          <Field label={t.tasks.department}>
            {p => (
              <select {...p} value={department ?? ''} onChange={e => setDepartment(e.target.value || null)}>
                <option value="">{t.tasks.allDepartments}</option>
                {org.departments.map(d => (
                  <option key={d.id} value={d.id}>
                    {deptLabel(t, d)}
                  </option>
                ))}
              </select>
            )}
          </Field>
        </div>
      )}

      {broken !== null && <p className="alert" role="alert">{errorText(t, broken)}</p>}
      {turns && !turns.length && !outside.length && <p className="muted">{t.tasks.noTurns}</p>}

      {running.map(turn => (
        <Turn key={turn.id} turn={turn} tasks={of(turn)} rows={rows} />
      ))}

      {planned.length > 0 && (
        <section className="turns" aria-label={t.tasks.nextTurns}>
          <h2>{t.tasks.nextTurns}</h2>
          {planned.map(turn => (
            <Turn key={turn.id} turn={turn} tasks={of(turn)} rows={rows} />
          ))}
        </section>
      )}

      {outside.length > 0 && (
        <section className="turns" aria-label={t.tasks.outsideTurns}>
          <h2>{t.tasks.outsideTurns}</h2>
          <TaskTree tasks={outside} rows={rows} />
        </section>
      )}

      {finished.length > 0 && (
        <section className="turns" aria-label={t.tasks.finishedTurns}>
          <h2>{t.tasks.finishedTurns}</h2>
          {finished.map(turn => (
            <Turn key={turn.id} turn={turn} tasks={of(turn)} rows={rows} />
          ))}
        </section>
      )}

      {outsideClosed.length > 0 && (
        <details className="turns folded">
          <summary>{t.tasks.closedOutside(outsideClosed.length)}</summary>
          <TaskTree tasks={outsideClosed} rows={rows} />
        </details>
      )}
    </section>
  );
}
