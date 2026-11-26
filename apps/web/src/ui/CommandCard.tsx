import { useT } from '../i18n';
import type { ShownCommand } from '../types';
import { CommandBox } from './CommandBox';

/* A machine command the orchestrator asked Hornhoof for. Only the CEO's screen gets it, in his window, so the code never
   reaches him. Done and the close button both dismiss the card. */
export function CommandCard({ shown, onDone }: { shown: ShownCommand; onDone(): void }) {
  const t = useT();
  const plans = shown.plans.join(', ');
  const host = shown.machine ?? '';
  const title = shown.kind === 'machine' ? t.window.commandMachine : shown.kind === 'core' ? t.machines.makeCore(host) : shown.kind === 'add' ? t.window.commandAdd(plans, host) : t.window.commandPlans(plans);
  const run = shown.kind === 'machine' ? t.machines.runThis : shown.kind === 'core' ? t.machines.coreRun(host) : shown.kind === 'add' ? t.machines.runOn(host) : t.subs.runThis;
  return (
    <section className="t-card" aria-label={title}>
      <header className="command-card-head">
        <h4>{title}</h4>
        <div className="entry-actions">
          <button className="btn ghost" type="button" aria-label={t.window.close} title={t.window.close} onClick={onDone}>
            <svg className="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7L7 17" /></svg>
          </button>
        </div>
      </header>
      <CommandBox command={shown.command} run={run} trust={shown.kind === 'machine' ? t.machines.trust : undefined} showComputerConsent={false} />
      <p className="t-card-brief">{t.window.commandOnly}</p>
      <div className="f">
        <button className="btn" type="button" onClick={onDone}>
          {t.common.done}
        </button>
      </div>
    </section>
  );
}
