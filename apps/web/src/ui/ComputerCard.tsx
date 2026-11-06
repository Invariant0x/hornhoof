import { api } from '../api';
import { useLanguage, useT, type Language, type Messages } from '../i18n';
import type { ComputerView } from '../types';
import { CEO_DECIDES, DecidedByNote } from './DecidedBy';
import { hasExecutableText } from './RequestExplanation';
import { clock } from './subscription';

export type ComputerAnswer = 'open' | 'close' | 'decline';
export const answerComputer = (action: ComputerAnswer) => api.post<ComputerView>(`/api/computer/${action}`);

const recordOf = (v: unknown): Record<string, unknown> | null => (typeof v === 'object' ? (v as Record<string, unknown> | null) : null);
const isoOf = (v: unknown): string | null => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : null);

function askedUntil(asked: unknown, language: Language): string | null {
  const rec = recordOf(asked);
  const until = isoOf(recordOf(rec?.purpose)?.until) ?? isoOf(rec?.until);
  return clock(language, until);
}

function computerCopy(t: Messages, machine: string, rawReason: string, untilAt: string | null) {
  const reason = hasExecutableText(rawReason) ? t.tasks.plainExplanationPending : rawReason;
  if (!untilAt) return { reason, about: t.window.computerWhat(machine), openLabel: t.window.computerOpen };
  return {
    reason,
    about: t.window.computerWhatUntil(machine, untilAt),
    openLabel: t.window.computerOpenUntilTime(untilAt),
  };
}

function ComputerActions({ decides, openLabel, onAct }: { decides: boolean; openLabel: string; onAct: (action: ComputerAnswer) => void }) {
  const t = useT();
  if (!decides) return <DecidedByNote by={CEO_DECIDES} />;
  return (
    <div className="f">
      <button className="btn" type="button" onClick={() => onAct('open')}>
        {openLabel}
      </button>
      <button className="btn ghost" type="button" onClick={() => onAct('decline')}>
        {t.window.computerNotNow}
      </button>
    </div>
  );
}

/* The orchestrator's request for the computer the server runs on, among what waits for a person, with one click of the CEO
   or the delegate to open it until its classified expiry (or for a day on older servers). */
export function ComputerCard({ view, onChange, onFailure }: { view: ComputerView; onChange(next: ComputerView): void; onFailure(err: unknown): void }) {
  const t = useT();
  const { language } = useLanguage();
  if (!view.asked) return null;

  const machine = view.machine ?? t.window.computerServer;
  const copy = computerCopy(t, machine, view.asked.reason, askedUntil(view.asked, language));
  const act = (action: ComputerAnswer) => void answerComputer(action).then(onChange, onFailure);

  return (
    <section className="t-card" aria-label={t.window.computerAsks(machine)}>
      <h4>{t.window.computerAsks(machine)}</h4>
      <p className="t-card-brief">{copy.reason}</p>
      <p className="t-card-brief">{copy.about}</p>
      <ComputerActions decides={view.canAnswer ?? true} openLabel={copy.openLabel} onAct={act} />
    </section>
  );
}
