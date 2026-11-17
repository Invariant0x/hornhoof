import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { useLanguage, useT, type Language, type Messages } from '../i18n';
import { ACCESS_DURATIONS, DURATION_S, type AccessDuration, type ComputerAccessView } from '../types';
import { cannotOpen, decidesAccess, givesLines, isOpen, machineName, useAccess, type AccessAnswer, type AccessChoice } from './access';
import { DecidedByNote } from './DecidedBy';
import { clock } from './subscription';

/* Computer access in a machine's card (#1115, Design #1102), a part of its block of system and programs, named for
   whoever hears the screen: closed, open to the orchestrator until a time, open in full
   to every agent of the company until a time, asked for by the orchestrator, or out of reach. Its owner opens it after
   choosing how long and for whom, every agent only after saying yes once more; whoever the server lets close it closes
   it with one press. What the server answers shows at once, and a change that failed stays beside its machine with a
   way to try again. */

type State = 'closed' | 'open' | 'full' | 'asks' | 'offline';
type Step = { kind: 'shown' } | { kind: 'choose'; duration: AccessDuration } | { kind: 'confirm'; duration: AccessDuration };
type Attempt = { action: AccessAnswer; choice?: AccessChoice };

function stateOf(view: ComputerAccessView): State {
  if (isOpen(view)) return view.scope === 'all_agents' ? 'full' : 'open';
  if (view.asked) return 'asks';
  return view.reachable ? 'closed' : 'offline';
}

const WORD: Record<State, (t: Messages) => string> = {
  closed: t => t.machines.computer.closed,
  open: t => t.machines.computer.open,
  full: t => t.machines.computer.full,
  asks: t => t.machines.computer.asks,
  offline: t => t.machines.computer.offline,
};

/* Words in the screen's language keep their order in a page drawn right to left. */
const Line = ({ className, children }: { className?: string; children: ReactNode }) => (
  <p className={className}>
    <bdi dir="ltr">{children}</bdi>
  </p>
);

/* Who opened it: an opening the server names no person for is the orchestrator's, for the owner (#1119); an older
   server sends no scope and no opener. */
function Opener({ c, view }: { c: Messages['machines']['computer']; view: ComputerAccessView }) {
  if (view.openedBy) return <Line className="muted">{c.openedBy(view.openedBy.name)}</Line>;
  return view.scope ? <Line className="muted">{c.openedByOrchestrator}</Line> : null;
}

/* To whom it is open, until when, what that allows and who opened it. */
function OpenLines({ t, language, view, full }: { t: Messages; language: Language; view: ComputerAccessView; full: boolean }) {
  const c = t.machines.computer;
  return (
    <>
      <Line className="acc-who">{full ? c.forTeam : c.forOrchestrator}</Line>
      <Line>{c.until(clock(language, view.until) ?? '')}</Line>
      <Line className="muted">{full ? c.fullText : c.openText}</Line>
      <Opener c={c} view={view} />
      {view.machine.os === 'darwin' && <Line className="muted">{t.window.computerMac}</Line>}
    </>
  );
}

/* How long: the first duration until another is pressed. */
function Durations({ t, duration, onPick }: { t: Messages; duration: AccessDuration; onPick(duration: AccessDuration): void }) {
  const c = t.machines.computer;
  return (
    <fieldset className="acc-dur">
      <legend>{c.duration}</legend>
      <div className="fgroup whole">
        {ACCESS_DURATIONS.map(d => (
          <button key={d} className="chipf" type="button" aria-pressed={d === duration} onClick={() => onPick(d)}>
            {c.durations[d]}
          </button>
        ))}
      </div>
      <Line className="muted">{c.byDefault}</Line>
    </fieldset>
  );
}

const leaveOnEscape = (cancel: () => void) => (e: KeyboardEvent) => {
  if (e.key === 'Escape') cancel();
};

/* A step takes the focus from the button that opened it, which goes, so that the keyboard goes on from its heading. */
function StepHeading({ children }: { children: string }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);
  return (
    <h5 ref={heading} tabIndex={-1}>
      <bdi dir="ltr">{children}</bdi>
    </h5>
  );
}

/* For whom and for how long, in the card's flow, with what opening gives. */
function Choose({ t, machine, gives, duration, onDuration, onPick, onCancel }: { t: Messages; machine: string; gives: string[]; duration: AccessDuration; onDuration(d: AccessDuration): void; onPick(scope: AccessChoice['scope']): void; onCancel(): void }) {
  const c = t.machines.computer;
  return (
    <div className="acc-step" role="group" aria-label={c.who} onKeyDown={leaveOnEscape(onCancel)}>
      <StepHeading>{c.who}</StepHeading>
      <Line>{c.whoText(machine)}</Line>
      {gives.map(line => <Line key={line} className="muted">{line}</Line>)}
      <Durations t={t} duration={duration} onPick={onDuration} />
      <div className="acc-pick">
        <button className="act" type="button" onClick={() => onPick('orchestrator')}>{c.orchestrator}</button>
        <button className="act" type="button" onClick={() => onPick('all_agents')}>{c.team}</button>
      </div>
      <div className="entry-actions">
        <button className="act" type="button" onClick={onCancel}>{c.cancel}</button>
      </div>
    </div>
  );
}

/* Once more, before every agent of the company may change anything on the machine. */
function Confirm({ t, language, machine, duration, onOpen, onCancel }: { t: Messages; language: Language; machine: string; duration: AccessDuration; onOpen(): void; onCancel(): void }) {
  const c = t.machines.computer;
  const until = clock(language, new Date(Date.now() + DURATION_S[duration] * 1000).toISOString()) ?? '';
  return (
    <div className="acc-step" role="group" aria-label={c.confirm} onKeyDown={leaveOnEscape(onCancel)}>
      <StepHeading>{c.confirm}</StepHeading>
      <Line>{c.confirmText(machine)}</Line>
      <div className="acc-facts">
        <Line>{c.confirmMachine(machine)}</Line>
        <Line>{c.confirmWho}</Line>
        <Line>{c.confirmDuration(c.durations[duration])}</Line>
        <Line>{c.until(until)}</Line>
      </div>
      <Line className="muted">{c.confirmFoot}</Line>
      <div className="entry-actions">
        <button className="btn" type="button" onClick={onOpen}>{c.fullButton}</button>
        <button className="act" type="button" onClick={onCancel}>{c.cancel}</button>
      </div>
    </div>
  );
}

const SHOWN: Step = { kind: 'shown' };

/* Whether this person may open it now: theirs to open, and nothing in the way. */
const mayOpen = (t: Messages, view: ComputerAccessView) => view.canOpen && !cannotOpen(t, view);

/* What the server answered last, until the card brings a newer view. */
function useAnswered(given: ComputerAccessView): [ComputerAccessView, (next: ComputerAccessView) => void] {
  const [answered, setAnswered] = useState<ComputerAccessView | null>(null);
  useEffect(() => setAnswered(null), [given]);
  return [answered ?? given, setAnswered];
}

/* It closes by its own time, without waiting for the server to say so. */
function useClosesOnTime(view: ComputerAccessView) {
  const [, setExpired] = useState(0);
  useEffect(() => {
    if (!isOpen(view)) return;
    const timer = setTimeout(() => setExpired(n => n + 1), Date.parse(view.until!) - Date.now() + 1);
    return () => clearTimeout(timer);
  }, [view]);
}

/* Cancel or Escape gives the focus back to the button that opened the step. */
function useFocusBack(step: Step) {
  const opener = useRef<HTMLButtonElement>(null);
  const [back, setBack] = useState(false);
  useEffect(() => {
    if (back && step.kind === 'shown') opener.current?.focus();
    setBack(false);
  }, [back, step]);
  return { opener, back: () => setBack(true) };
}

type Flow = {
  step: Step;
  setStep(step: Step): void;
  busy: AccessAnswer | null;
  failed: Attempt | null;
  act(action: AccessAnswer, choice?: AccessChoice): void;
  cancel(): void;
  opener: RefObject<HTMLButtonElement | null>;
  prompt: ReactNode;
};

/* The step the owner is at, the change on its way, and the one that failed, kept to try again. */
function useAccessFlow(view: ComputerAccessView, setAnswered: (next: ComputerAccessView) => void, onChanged: () => void): Flow {
  const [step, setStep] = useState<Step>(SHOWN);
  const [busy, setBusy] = useState<AccessAnswer | null>(null);
  const [failed, setFailed] = useState<Attempt | null>(null);
  const attempt = useRef<Attempt | null>(null);
  const focus = useFocusBack(step);
  const { answer, prompt } = useAccess(
    next => {
      setBusy(null);
      setAnswered(next);
      onChanged();
    },
    () => {
      setBusy(null);
      setFailed(attempt.current);
    },
  );
  const act = (action: AccessAnswer, choice?: AccessChoice) => {
    attempt.current = { action, choice };
    setFailed(null);
    setStep(SHOWN);
    setBusy(action);
    void answer(view, action, choice).finally(() => setBusy(now => (now === action ? null : now)));
  };
  const cancel = () => {
    setStep(SHOWN);
    focus.back();
  };
  return { step, setStep, busy, failed, act, cancel, opener: focus.opener, prompt };
}

/* What the state means, under its framed word. */
function StateLines({ t, language, view, state }: { t: Messages; language: Language; view: ComputerAccessView; state: State }) {
  const c = t.machines.computer;
  switch (state) {
    case 'closed':
      return <Line>{c.closedText}</Line>;
    case 'offline':
      return <Line>{c.offlineText}</Line>;
    case 'asks':
      return <Line>{c.asksText(view.asked!.reason)}</Line>;
    case 'open':
    case 'full':
      return <OpenLines t={t} language={language} view={view} full={state === 'full'} />;
  }
}

/* Why this person cannot open it: someone else decides, or something stands in the way. */
function Standing({ t, view, state }: { t: Messages; view: ComputerAccessView; state: State }) {
  if (state !== 'closed' && state !== 'asks') return null;
  if (!view.canOpen) return <DecidedByNote by={decidesAccess(view)} />;
  const blocked = cannotOpen(t, view);
  return blocked ? <Line className="muted">{blocked}</Line> : null;
}

const Gives = ({ t, view }: { t: Messages; view: ComputerAccessView }) => (
  <>
    {givesLines(t, view).map(line => (
      <Line key={line} className="muted">
        {line}
      </Line>
    ))}
  </>
);

/* The orchestrator's request: open it for the time chosen here, or not now. */
function AnswerAsk({ t, view, flow }: ActionProps) {
  const c = t.machines.computer;
  const may = mayOpen(t, view);
  const duration = flow.step.kind === 'choose' ? flow.step.duration : ACCESS_DURATIONS[0];
  return (
    <>
      {may && <Gives t={t} view={view} />}
      {may && <Durations t={t} duration={duration} onPick={d => flow.setStep({ kind: 'choose', duration: d })} />}
      <div className="entry-actions">
        {may && (
          <button className="btn" type="button" onClick={() => flow.act('open', { scope: 'orchestrator', duration })}>
            {c.openFor[duration]}
          </button>
        )}
        <button className="act" type="button" onClick={() => flow.act('decline')}>
          {t.window.computerNotNow}
        </button>
      </div>
    </>
  );
}

/* A closed machine of theirs: its button, then for whom and for how long, then once more for every agent. */
function OpenSteps({ t, language, view, flow }: ActionProps) {
  const machine = machineName(t, view.machine);
  const { step } = flow;
  if (step.kind === 'choose') {
    return (
      <Choose
        t={t}
        machine={machine}
        gives={givesLines(t, view)}
        duration={step.duration}
        onDuration={duration => flow.setStep({ kind: 'choose', duration })}
        onPick={scope => (scope === 'all_agents' ? flow.setStep({ kind: 'confirm', duration: step.duration }) : flow.act('open', { scope, duration: step.duration }))}
        onCancel={flow.cancel}
      />
    );
  }
  if (step.kind === 'confirm') {
    return <Confirm t={t} language={language} machine={machine} duration={step.duration} onOpen={() => flow.act('open', { scope: 'all_agents', duration: step.duration, confirm: true })} onCancel={flow.cancel} />;
  }
  return (
    <div className="entry-actions">
      <button ref={flow.opener} className="btn" type="button" onClick={() => flow.setStep({ kind: 'choose', duration: ACCESS_DURATIONS[0] })}>
        {t.machines.computer.choose}
      </button>
    </div>
  );
}

type ActionProps = { t: Messages; language: Language; view: ComputerAccessView; flow: Flow };

/* Whoever the server lets close it closes it with one press, without a question. */
const CloseAccess = ({ t, view, flow }: ActionProps) =>
  view.canClose ? (
    <div className="entry-actions">
      <button className="act" type="button" onClick={() => flow.act('close')}>
        {t.window.computerClose}
      </button>
    </div>
  ) : null;

/* What this person can do in each state. */
const ACTIONS: Record<State, (props: ActionProps) => ReactNode> = {
  closed: props => (mayOpen(props.t, props.view) ? <OpenSteps {...props} /> : null),
  open: props => <CloseAccess {...props} />,
  full: props => <CloseAccess {...props} />,
  asks: props => (props.view.canOpen ? <AnswerAsk {...props} /> : null),
  offline: () => null,
};

/* The change on its way, or what this person can do. */
function Actions({ state, ...props }: ActionProps & { state: State }) {
  const c = props.t.machines.computer;
  if (!props.flow.busy) return ACTIONS[state](props);
  return (
    <div className="entry-actions">
      <button className="act" type="button" disabled>
        {props.flow.busy === 'close' ? c.closing : c.opening}
      </button>
    </div>
  );
}

/* A change that failed stays beside its machine, with the way to try it again. */
function Failed({ t, flow }: { t: Messages; flow: Flow }) {
  const { failed } = flow;
  if (!failed) return null;
  return (
    <div className="acc-failed" role="alert">
      <Line>{t.machines.computer.failed}</Line>
      <div className="entry-actions">
        <button className="act" type="button" onClick={() => flow.act(failed.action, failed.choice)}>
          {t.machines.computer.retry}
        </button>
      </div>
    </div>
  );
}

export function MachineAccessBlock({ view: given, onChanged }: { view: ComputerAccessView; onChanged(): void }) {
  const t = useT();
  const { language } = useLanguage();
  const heading = useId();
  const [view, setAnswered] = useAnswered(given);
  useClosesOnTime(view);
  const flow = useAccessFlow(view, setAnswered, onChanged);
  const state = stateOf(view);
  return (
    <section className="part acc" aria-labelledby={heading}>
      <h5 className="part-h" id={heading}>
        {t.machines.access}
      </h5>
      <p>
        <span className={`status acc-${state}`}>{WORD[state](t)}</span>
      </p>
      <StateLines t={t} language={language} view={view} state={state} />
      <Standing t={t} view={view} state={state} />
      {flow.prompt ?? <Actions t={t} language={language} view={view} state={state} flow={flow} />}
      <Failed t={t} flow={flow} />
    </section>
  );
}
