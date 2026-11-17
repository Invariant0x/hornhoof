import { useLanguage, useT, type Language, type Messages } from '../i18n';
import { PROVIDER_NAMES } from '../providers';
import type { MachineDrain, NodeWait, ProviderId } from '../types';

/* Since when it waits, on the 24-hour clock, as a task's wait is shown. */
const clock = (language: Language, iso: string) => new Date(iso).toLocaleTimeString(language === 'ru' ? 'ru-RU' : 'en-GB', { hour: '2-digit', minute: '2-digit' });

function drainText(t: Messages, language: Language, drain: MachineDrain): string {
  if (drain.state === 'waiting') return t.machines.drainWaiting(drain.turnsLeft, drain.partsLeft, clock(language, drain.since));
  return t.machines.drainRestarting;
}

/* In words in a machine's card: waiting is not hanging, and a machine that restarts for an update is not a lost one. */
export function DrainLine({ drain }: { drain: MachineDrain }) {
  const t = useT();
  const { language } = useLanguage();
  return <span role="status">{drainText(t, language, drain)}</span>;
}

/* The mark of such a machine in its row and its card. */
export function DrainMark({ drain }: { drain: MachineDrain | null | undefined }) {
  const t = useT();
  const { language } = useLanguage();
  return drain ? <span className="badge old" title={drainText(t, language, drain)}>{t.machines.drainMark[drain.state]}</span> : null;
}

function nodeName(t: Messages, wait: NodeWait): string {
  if (!wait.hostname) return t.machines.builtin;
  if (!wait.provider) return wait.hostname;
  return t.updates.nodeOn(PROVIDER_NAMES[wait.provider as ProviderId] ?? wait.provider, wait.hostname);
}

const workText = (wait: NodeWait): string => wait.work.map(w => (w.task ? `${w.agent} (#${w.task})` : w.agent)).join(', ');

/* On the Versions screen, of each node: what it waits for and until when. A free one is being replaced by itself. */
export function NodeWaits({ waits }: { waits: NodeWait[] | undefined }) {
  const t = useT();
  const { language } = useLanguage();
  if (!waits?.length) return null;
  return (
    <section className="update-nodes">
      <h3>{t.updates.nodesTitle}</h3>
      <p>{t.updates.nodesNote}</p>
      <ul>
        {waits.map(wait => (
          <li key={wait.node}>
            <div>
              <b>{nodeName(t, wait)}</b>
              <DrainMark drain={wait.drain} />
            </div>
            <span role="status">{wait.drain.state === 'restarting' ? t.updates.nodeFree : drainText(t, language, wait.drain)}</span>
            {wait.work.length > 0 && <span className="muted">{t.updates.nodeWaitsFor(workText(wait))}</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}
