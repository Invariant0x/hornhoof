import { useT } from '../i18n';
import type { Messages } from '../i18n/en';
import type { UpdateStep } from '../types';

/* The five steps of an update, in the order the updater takes them. */
export const STEPS: UpdateStep[] = ['pull', 'promise', 'backup', 'install', 'health'];

type Props = { version: string; step: UpdateStep | null; starting?: boolean; offline?: boolean; maintenance?: boolean };

/* What the bar says: a failed poll first, then the step. */
function barLabel(t: Messages, p: { step: UpdateStep | null; starting: boolean; offline: boolean; maintenance: boolean }, at: number): string {
  if (p.maintenance) return t.updates.maintenance;
  if (p.offline) return t.updates.restarting;
  return stepLabel(t, p.step, p.starting, at);
}

/* What the bar says about the step: the first words while the update has not begun, then the step in order. */
function stepLabel(t: Messages, step: UpdateStep | null, starting: boolean, at: number): string {
  if (starting || !step) return t.updates.starting;
  if (step === 'finished' || step === 'rollback') return t.updates.steps[step];
  return t.updates.stepOf(at + 1, STEPS.length, t.updates.steps[step]);
}

/* A turning ring and a bar of the five steps: the ones behind are filled, the one under way moves. */
export function UpdateProgress({ version, step, starting = false, offline = false, maintenance = false }: Props) {
  const t = useT();
  const back = step === 'rollback';
  const at = starting || !step ? 0 : step === 'finished' ? STEPS.length : back ? STEPS.length - 1 : STEPS.indexOf(step);
  const label = barLabel(t, { step, starting, offline, maintenance }, at);
  return (
    <div className={`uprog${back ? ' back' : ''}`}>
      <span className="spinner" aria-hidden="true" />
      <b dir="auto">{t.updates.running(version)}</b>
      <span
        className="uprog-bar"
        role="progressbar"
        aria-label={t.updates.progress}
        aria-valuemin={0}
        aria-valuemax={STEPS.length}
        aria-valuenow={at}
        aria-valuetext={label}
      >
        {STEPS.map((s, i) => (
          <i key={s} className={i < at ? 'done' : i === at ? 'now' : ''} />
        ))}
      </span>
      <span className="uprog-text" dir="auto">{label}</span>
    </div>
  );
}
