import { useState, type ReactNode } from 'react';
import { useLanguage, useT, type Language, type Messages } from '../i18n';
import type { ComputerAccessView } from '../types';
import { cannotOpen, decidesAccess, givesLines, isOpen, machineName, useAccess, type AccessAnswer } from './access';
import { DecidedByNote } from './DecidedBy';
import { clock } from './subscription';

/* Access to the machines at the foot of the orchestrator's window, a thin line each so the terminal keeps its place. One
   line stays with a counter of the others, and the machine that waits for an answer comes first. Each line's buttons act
   on its own machine, and only for who may: its owner opens it, and its owner, the CEO or the delegate close it. */
type Props = { machines: ComputerAccessView[]; onChange(next: ComputerAccessView): void; onFailure(err: unknown): void };

/* decides: whether this person takes the line's decision. blocked: why they cannot open it now, in place of that button. */
type Line = { key: string; view: ComputerAccessView; machine: string; asks: boolean; name: string; shortName: string; text: string; why: string[]; decides: boolean; blocked: string | null; actions: { action: AccessAnswer; label: string; ghost: boolean }[] };

function lineOf(t: Messages, language: Language, view: ComputerAccessView): Line | null {
  const machine = machineName(t, view.machine);
  const shared = { view, machine, shortName: view.machine.hostname || (view.machine.data ? t.window.computerServerName : view.machine.name), blocked: null };
  if (isOpen(view)) {
    const at = clock(language, view.until)!;
    return { ...shared, key: `${view.machine.id} open`, asks: false, name: t.window.machineAccess(machine), text: t.window.computerUntil(at), why: [t.window.computerOpenUntil(machine, at)], decides: true, actions: view.canClose ? [{ action: 'close', label: t.window.computerClose, ghost: true }] : [] };
  }
  if (!view.asked) return null;
  const { reason } = view.asked;
  const blocked = cannotOpen(t, view);
  return {
    ...shared,
    key: `${view.machine.id} asks`,
    asks: true,
    name: t.window.computerAsks(machine),
    text: reason,
    why: [reason, t.window.computerWhat(machine), ...givesLines(t, view)],
    decides: view.canOpen,
    blocked,
    actions: [...(blocked ? [] : [{ action: 'open' as const, label: t.window.computerOpen, ghost: false }]), { action: 'decline', label: t.window.computerNotNow, ghost: true }],
  };
}

const AccessLine = ({ line, onAnswer, counter, prompt }: { line: Line; onAnswer(action: AccessAnswer): void; counter: ReactNode; prompt: ReactNode }) => {
  const t = useT();
  const [more, setMore] = useState(false);
  return (
    <section className={line.asks ? 't-access-line asks' : 't-access-line'} aria-label={line.name}>
      <div className="t-access-row">
        <strong title={line.name}>{line.shortName}</strong>
        <span className="t-access-text" title={line.text}>
          {line.text}
        </span>
        <button className="t-access-more" type="button" aria-label={t.window.computerMore(line.machine)} aria-expanded={more} onClick={() => setMore(!more)}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="12" cy="12" r="9" />
            <path d="M12 11v5M12 8v.01" />
          </svg>
        </button>
        {line.decides ? (
          line.actions.map(a => (
            <button key={a.action} className={a.ghost ? 'btn ghost' : 'btn'} type="button" onClick={() => onAnswer(a.action)}>
              {a.label}
            </button>
          ))
        ) : (
          <DecidedByNote by={decidesAccess(line.view)} />
        )}
        {counter}
      </div>
      {line.decides && line.blocked && <p className="muted t-access-why">{line.blocked}</p>}
      {prompt}
      {more && (
        <div className="t-access-why">
          {line.why.map(text => (
            <p key={text}>{text}</p>
          ))}
        </div>
      )}
    </section>
  );
};

export function ComputerStrip({ machines, onChange, onFailure }: Props) {
  const t = useT();
  const { language } = useLanguage();
  const [all, setAll] = useState(false);
  /* The machine whose owner is asked for the password, so the question shows under its own line. */
  const [asking, setAsking] = useState<string | null>(null);
  const { answer, prompt } = useAccess(onChange, onFailure);
  const known = machines.map(view => lineOf(t, language, view)).filter(line => line !== null);
  const lines = [...known.filter(line => line.asks), ...known.filter(line => !line.asks)];
  if (!lines.length) return null;
  const others = lines.length - 1;
  const counter = others > 0 && (
    <button className="t-access-count" type="button" aria-label={t.window.computerOthers(others)} aria-expanded={all} onClick={() => setAll(!all)}>
      {t.window.computerOthersCount(others)}
    </button>
  );
  return (
    <div className="t-access">
      {(all ? lines : lines.slice(0, 1)).map((line, i) => (
        <AccessLine
          key={line.key}
          line={line}
          counter={i === 0 && counter}
          prompt={asking === line.view.machine.id ? prompt : null}
          onAnswer={action => {
            setAsking(line.view.machine.id);
            void answer(line.view, action);
          }}
        />
      ))}
    </div>
  );
}
