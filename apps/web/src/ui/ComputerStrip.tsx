import { useState, type ReactNode } from 'react';
import { useLanguage, useT, type Language, type Messages } from '../i18n';
import type { ComputerView } from '../types';
import { answerComputer, isOpen, type ComputerAnswer } from './ComputerCard';
import { CEO_DECIDES, DecidedByNote } from './DecidedBy';
import { clock } from './subscription';

/* Access to the machines at the foot of the orchestrator's window, a thin line each so the terminal keeps its place. One
   line stays with a counter of the others, and the machine that waits for an answer comes first. The buttons name their
   machine; the server keeps access to the one it runs on, so answerComputer does not send it yet. */
type Answer = (action: ComputerAnswer, machine: string | null | undefined) => Promise<ComputerView>;
type Props = { machines: ComputerView[]; onChange(next: ComputerView): void; onFailure(err: unknown): void; answer?: Answer };

type Line = { key: string; view: ComputerView; asks: boolean; name: string; shortName: string; text: string; why: string[]; actions: { action: ComputerAnswer; label: string; ghost: boolean }[] };

function lineOf(t: Messages, language: Language, view: ComputerView): Line | null {
  const machine = view.machine ?? t.window.computerServer;
  const shared = { view, shortName: view.machine ?? t.window.computerServerName };
  if (isOpen(view)) {
    const at = clock(language, view.until)!;
    return { ...shared, key: `${machine} open`, asks: false, name: t.window.computerAccess(machine), text: t.window.computerUntil(at), why: [t.window.computerOpenUntil(machine, at)], actions: [{ action: 'close', label: t.window.computerClose, ghost: true }] };
  }
  if (!view.asked) return null;
  const { reason } = view.asked;
  return {
    ...shared,
    key: `${machine} asks`,
    asks: true,
    name: t.window.computerAsks(machine),
    text: reason,
    why: [reason, t.window.computerWhat(machine)],
    actions: [
      { action: 'open', label: t.window.computerOpen, ghost: false },
      { action: 'decline', label: t.window.computerNotNow, ghost: true },
    ],
  };
}

const AccessLine = ({ line, onAnswer, counter }: { line: Line; onAnswer(action: ComputerAnswer): void; counter: ReactNode }) => {
  const t = useT();
  const [more, setMore] = useState(false);
  /* An older server shows it to the CEO alone. */
  const decides = line.view.canAnswer ?? true;
  return (
    <section className={line.asks ? 't-access-line asks' : 't-access-line'} aria-label={line.name}>
      <div className="t-access-row">
        <strong title={line.name}>{line.shortName}</strong>
        <span className="t-access-text" title={line.text}>
          {line.text}
        </span>
        <button className="t-access-more" type="button" aria-label={t.window.computerMore(line.view.machine ?? t.window.computerServer)} aria-expanded={more} onClick={() => setMore(!more)}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="12" cy="12" r="9" />
            <path d="M12 11v5M12 8v.01" />
          </svg>
        </button>
        {decides ? (
          line.actions.map(a => (
            <button key={a.action} className={a.ghost ? 'btn ghost' : 'btn'} type="button" onClick={() => onAnswer(a.action)}>
              {a.label}
            </button>
          ))
        ) : (
          <DecidedByNote by={CEO_DECIDES} />
        )}
        {counter}
      </div>
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

export function ComputerStrip({ machines, onChange, onFailure, answer = answerComputer }: Props) {
  const t = useT();
  const { language } = useLanguage();
  const [all, setAll] = useState(false);
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
        <AccessLine key={line.key} line={line} counter={i === 0 && counter} onAnswer={action => void answer(action, line.view.machine).then(onChange, onFailure)} />
      ))}
    </div>
  );
}
