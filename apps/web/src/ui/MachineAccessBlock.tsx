import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
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

/* To whom it is open, until when, what that allows and who opened it. */
function OpenLines({ t, language, view, full }: { t: Messages; language: Language; view: ComputerAccessView; full: boolean }) {
  const c = t.machines.computer;
  return (
    <>
      <Line className="acc-who">{full ? c.forTeam : c.forOrchestrator}</Line>
      <Line>{c.until(clock(language, view.until) ?? '')}</Line>
      <Line className="muted">{full ? c.fullText : c.openText}</Line>
      {view.openedBy && <Line className="muted">{c.openedBy(view.openedBy.name)}</Line>}
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

export function MachineAccessBlock({ view: given, onChanged }: { view: ComputerAccessView; onChanged(): void }) {
  const t = useT();
  const { language } = useLanguage();
  const c = t.machines.computer;
  const heading = useId();
  /* What the server answered last, until the card brings a newer view. */
  const [answered, setAnswered] = useState<ComputerAccessView | null>(null);
  useEffect(() => setAnswered(null), [given]);
  const view = answered ?? given;
  /* It closes by its own time, without waiting for the server to say so. */
  const [, setExpired] = useState(0);
  useEffect(() => {
    if (!isOpen(view)) return;
    const left = Date.parse(view.until!) - Date.now();
    const timer = setTimeout(() => setExpired(n => n + 1), left + 1);
    return () => clearTimeout(timer);
  }, [view]);
  const [step, setStep] = useState<Step>({ kind: 'shown' });
  const [busy, setBusy] = useState<AccessAnswer | null>(null);
  const [failed, setFailed] = useState<Attempt | null>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const [backToOpener, setBackToOpener] = useState(false);
  useEffect(() => {
    if (backToOpener && step.kind === 'shown') opener.current?.focus();
    setBackToOpener(false);
  }, [backToOpener, step]);
  const attempt = useRef<Attempt | null>(null);
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
    setStep({ kind: 'shown' });
    setBusy(action);
    void answer(view, action, choice).finally(() => setBusy(now => (now === action ? null : now)));
  };
  const cancel = () => {
    setStep({ kind: 'shown' });
    setBackToOpener(true);
  };

  const machine = machineName(t, view.machine);
  const state = stateOf(view);
  const blocked = cannotOpen(t, view);
  const mayOpen = view.canOpen && !blocked;

  let actions: ReactNode = null;
  if (busy) {
    actions = (
      <div className="entry-actions">
        <button className="act" type="button" disabled>{busy === 'close' ? c.closing : c.opening}</button>
      </div>
    );
  } else if (state === 'open' || state === 'full') {
    actions = view.canClose && (
      <div className="entry-actions">
        <button className="act" type="button" onClick={() => act('close')}>{t.window.computerClose}</button>
      </div>
    );
  } else if (state === 'asks' && view.canOpen) {
    const duration = step.kind === 'choose' ? step.duration : ACCESS_DURATIONS[0];
    actions = (
      <>
        {mayOpen && <Durations t={t} duration={duration} onPick={d => setStep({ kind: 'choose', duration: d })} />}
        <div className="entry-actions">
          {mayOpen && <button className="btn" type="button" onClick={() => act('open', { scope: 'orchestrator', duration })}>{c.openFor[duration]}</button>}
          <button className="act" type="button" onClick={() => act('decline')}>{t.window.computerNotNow}</button>
        </div>
      </>
    );
  } else if (state === 'closed' && mayOpen && step.kind === 'shown') {
    actions = (
      <div className="entry-actions">
        <button ref={opener} className="btn" type="button" onClick={() => setStep({ kind: 'choose', duration: ACCESS_DURATIONS[0] })}>{c.choose}</button>
      </div>
    );
  }

  const asking = state === 'closed' && mayOpen;
  return (
    <section className="part acc" aria-labelledby={heading}>
      <h5 className="part-h" id={heading}>{t.machines.access}</h5>
      <p>
        <span className={`status acc-${state}`}>{WORD[state](t)}</span>
      </p>
      {state === 'closed' && <Line>{c.closedText}</Line>}
      {state === 'offline' && <Line>{c.offlineText}</Line>}
      {state === 'asks' && <Line>{c.asksText(view.asked!.reason)}</Line>}
      {state === 'asks' && mayOpen && givesLines(t, view).map(line => <Line key={line} className="muted">{line}</Line>)}
      {(state === 'open' || state === 'full') && <OpenLines t={t} language={language} view={view} full={state === 'full'} />}
      {(state === 'closed' || state === 'asks') && view.canOpen && blocked && <Line className="muted">{blocked}</Line>}
      {(state === 'closed' || state === 'asks') && !view.canOpen && <DecidedByNote by={decidesAccess(view)} />}
      {asking && step.kind === 'choose' && (
        <Choose
          t={t}
          machine={machine}
          gives={givesLines(t, view)}
          duration={step.duration}
          onDuration={duration => setStep({ kind: 'choose', duration })}
          onPick={scope => (scope === 'all_agents' ? setStep({ kind: 'confirm', duration: step.duration }) : act('open', { scope, duration: step.duration }))}
          onCancel={cancel}
        />
      )}
      {asking && step.kind === 'confirm' && <Confirm t={t} language={language} machine={machine} duration={step.duration} onOpen={() => act('open', { scope: 'all_agents', duration: step.duration, confirm: true })} onCancel={cancel} />}
      {prompt ?? actions}
      {failed && (
        <div className="acc-failed" role="alert">
          <Line>{c.failed}</Line>
          <div className="entry-actions">
            <button className="act" type="button" onClick={() => act(failed.action, failed.choice)}>{c.retry}</button>
          </div>
        </div>
      )}
    </section>
  );
}
