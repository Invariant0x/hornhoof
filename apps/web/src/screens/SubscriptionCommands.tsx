import { useT } from '../i18n';
import type { ShownCommand, SubView } from '../types';
import { CommandBox, CommandLifetime, liveCommand } from '../ui/CommandBox';
import { Edge } from '../ui/Edge';
import { subName } from '../ui/subscription';

/* During a rolling update an older server may not yet send the IDs; labels are only that compatibility fallback. */
export function commandForPlan(commands: ShownCommand[], sub: SubView, now: number): ShownCommand | null {
  return commands.find(c => c.kind === 'plans' && liveCommand(c, now) && (c.subscriptionIds ? c.subscriptionIds.includes(sub.id) : c.plans.includes(sub.label))) ?? null;
}

export function SubscriptionCommandBlocks({ subscriptions, commands, now, onDone }: {
  subscriptions: SubView[]; commands: ShownCommand[]; now: number; onDone: (command: ShownCommand, subscriptionId: string) => void;
}) {
  const t = useT();
  return <>{subscriptions.map(sub => {
    const command = commandForPlan(commands, sub, now);
    if (!command || command.dismissedSubscriptionIds?.includes(sub.id)) return null;
    const title = t.subs.commandHeading(subName(t, sub));
    return <section key={sub.id} aria-label={title}>
      <Edge className="panel" cut={12}>
        <h2>{title}</h2>
        <p className="muted">{t.subs.runThis}</p>
        <CommandBox command={command.command} />
        <CommandLifetime expiresAt={command.expiresAt} />
        <div className="actions"><button className="btn" type="button" onClick={() => onDone(command, sub.id)}>{t.common.done}</button></div>
      </Edge>
    </section>;
  })}</>;
}

/* Used by the expanded table row and by its card, including after its top block was closed. */
export function SubscriptionInstall({ command, sub, ownerId, onNew }: { sub: SubView; ownerId: string; command: ShownCommand | null | undefined; onNew: () => void }) {
  const t = useT();
  if (sub.kind !== 'personal' || sub.status !== 'waiting_machine' || sub.owner.id !== ownerId) return null;
  if (command === undefined) return <p className="muted">{t.common.loading}</p>;
  if (!command) return <button className="act" type="button" aria-label={t.subs.newCommandLabel(subName(t, sub))} onClick={onNew}>{t.subs.newCommand}</button>;
  return <div className="plan-command"><CommandBox command={command.command} /><CommandLifetime expiresAt={command.expiresAt} /></div>;
}
