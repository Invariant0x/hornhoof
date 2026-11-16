import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useLanguage, useT, type Language, type Messages } from '../i18n';
import { ACCESS_HOURS, type AccessHours, type ComputerAccessView } from '../types';
import { cannotOpen, decidesAccess, isOpen, machineName, useAccess, type AccessAnswer, type AccessChoice } from './access';
import { CardBlock } from './Cards';
import { DecidedByNote } from './DecidedBy';
import { clock } from './subscription';

/* Computer access in a machine's card (#1115, Design #1102): closed, open to the orchestrator until a time, open in full
   to every agent of the company until a time, asked for by the orchestrator, or out of reach. Its owner opens it after
   choosing how long and for whom, every agent only after saying yes once more; whoever the server lets close it closes
   it with one press. What the server answers shows at once, and a change that failed stays beside its machine with a
   way to try again. */

type State = 'closed' | 'open' | 'full' | 'asks' | 'offline';
type Step = { kind: 'shown' } | { kind: 'choose'; hours: AccessHours } | { kind: 'confirm'; hours: AccessHours };
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

/* How long: one hour until another is pressed. */
function Durations({ t, hours, onPick }: { t: Messages; hours: AccessHours; onPick(hours: AccessHours): void }) {
  const c = t.machines.computer;
  return (
    <fieldset className="acc-dur">
      <legend>{c.duration}</legend>
      <div className="fgroup whole">
        {ACCESS_HOURS.map(h => (
          <button key={h} className="chipf" type="button" aria-pressed={h === hours} onClick={() => onPick(h)}>
            {c.hours[h]}
          </button>
        ))}
      </div>
      <p className="muted">{c.byDefault}</p>
    </fieldset>
  );
}

const leaveOnEscape = (cancel: () => void) => (e: KeyboardEvent) => {
  if (e.key === 'Escape') cancel();
};

/* For whom and for how long, in the card's flow. */
function Choose({ t, machine, hours, onHours, onPick, onCancel }: { t: Messages; machine: string; hours: AccessHours; onHours(h: AccessHours): void; onPick(scope: AccessChoice['scope']): void; onCancel(): void }) {
  const c = t.machines.computer;
  return (
    <div className="acc-step" role="group" aria-label={c.who} onKeyDown={leaveOnEscape(onCancel)}>
      <h5>{c.who}</h5>
      <Line>{c.whoText(machine)}</Line>
      <Durations t={t} hours={hours} onPick={onHours} />
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
function Confirm({ t, language, machine, hours, onOpen, onCancel }: { t: Messages; language: Language; machine: string; hours: AccessHours; onOpen(): void; onCancel(): void }) {
  const c = t.machines.computer;
  const until = clock(language, new Date(Date.now() + hours * 3_600_000).toISOString()) ?? '';
  return (
    <div className="acc-step" role="group" aria-label={c.confirm} onKeyDown={leaveOnEscape(onCancel)}>
      <h5>{c.confirm}</h5>
      <Line>{c.confirmText(machine)}</Line>
      <div className="acc-facts">
        <Line>{c.confirmMachine(machine)}</Line>
        <Line>{c.confirmWho}</Line>
        <Line>{c.confirmDuration(c.hours[hours])}</Line>
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
  /* What the server answered last, until the card brings a newer view. */
  const [answered, setAnswered] = useState<ComputerAccessView | null>(null);
  useEffect(() => setAnswered(null), [given]);
  const view = answered ?? given;
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
    const hours = step.kind === 'choose' ? step.hours : 1;
    actions = (
      <>
        {mayOpen && <Durations t={t} hours={hours} onPick={h => setStep({ kind: 'choose', hours: h })} />}
        <div className="entry-actions">
          {mayOpen && <button className="btn" type="button" onClick={() => act('open', { scope: 'orchestrator', hours })}>{c.openFor[hours]}</button>}
          <button className="act" type="button" onClick={() => act('decline')}>{t.window.computerNotNow}</button>
        </div>
      </>
    );
  } else if (state === 'closed' && mayOpen && step.kind === 'shown') {
    actions = (
      <div className="entry-actions">
        <button ref={opener} className="btn" type="button" onClick={() => setStep({ kind: 'choose', hours: 1 })}>{c.choose}</button>
      </div>
    );
  }

  const asking = state === 'closed' && mayOpen;
  return (
    <CardBlock title={t.machines.access}>
      <div className="acc">
        <p>
          <span className={`status acc-${state}`}>{WORD[state](t)}</span>
        </p>
        {state === 'closed' && <Line>{c.closedText}</Line>}
        {state === 'offline' && <Line>{c.offlineText}</Line>}
        {state === 'asks' && <Line>{c.asksText(view.asked!.reason)}</Line>}
        {(state === 'open' || state === 'full') && <OpenLines t={t} language={language} view={view} full={state === 'full'} />}
        {(state === 'closed' || state === 'asks') && view.canOpen && blocked && <Line className="muted">{blocked}</Line>}
        {(state === 'closed' || state === 'asks') && !view.canOpen && <DecidedByNote by={decidesAccess(view)} />}
        {asking && step.kind === 'choose' && (
          <Choose
            t={t}
            machine={machine}
            hours={step.hours}
            onHours={hours => setStep({ kind: 'choose', hours })}
            onPick={scope => (scope === 'all_agents' ? setStep({ kind: 'confirm', hours: step.hours }) : act('open', { scope, hours: step.hours }))}
            onCancel={cancel}
          />
        )}
        {asking && step.kind === 'confirm' && <Confirm t={t} language={language} machine={machine} hours={step.hours} onOpen={() => act('open', { scope: 'all_agents', hours: step.hours, confirm: true })} onCancel={cancel} />}
        {prompt ?? actions}
        {failed && (
          <div className="acc-failed" role="alert">
            <Line>{c.failed}</Line>
            <div className="entry-actions">
              <button className="act" type="button" onClick={() => act(failed.action, failed.choice)}>{c.retry}</button>
            </div>
          </div>
        )}
      </div>
    </CardBlock>
  );
}
