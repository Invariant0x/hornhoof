import { useT } from '../i18n';
import type { UpdateStep } from '../types';

/* The four steps of an update, in the order the updater takes them. */
const STEPS: UpdateStep[] = ['backup', 'pull', 'install', 'health'];

type Props = { version: string; step: UpdateStep | null; starting?: boolean; offline?: boolean };

/* A turning ring and a bar of the four steps: the ones behind are filled, the one under way moves. */
export function UpdateProgress({ version, step, starting = false, offline = false }: Props) {
  const t = useT();
  const back = step === 'rollback';
  const at = starting || !step ? 0 : step === 'finished' ? STEPS.length : back ? STEPS.length - 1 : STEPS.indexOf(step);
  const label = offline
    ? t.updates.restarting
    : starting || !step
      ? t.updates.starting
      : step === 'finished'
        ? t.updates.steps.finished
        : back
          ? t.updates.steps.rollback
          : t.updates.stepOf(at + 1, STEPS.length, t.updates.steps[step]);
  return (
    <div className={`uprog${back ? ' back' : ''}`}>
      <span className="spinner" aria-hidden="true" />
      <b>{t.updates.running(version)}</b>
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
      <span className="uprog-text">{label}</span>
    </div>
  );
}
