import { useId, type ReactNode } from 'react';
import { useT } from '../i18n';

/* One outside tool of the Integrations group, on the same pattern for every tool: its name, what it gives, whether it
   is connected for the company, then what it holds and what to do with it. */
export function IntegrationCard({ name, about, connected, children }: { name: string; about: string; connected: boolean; children: ReactNode }) {
  const t = useT();
  const id = useId();
  return (
    <article className="integration" aria-labelledby={id}>
      <header className="integration-head">
        <h4 id={id}>{name}</h4>
        <span className="integration-state" data-connected={connected}>{connected ? t.integrations.connected : t.integrations.notConnected}</span>
      </header>
      <p>{about}</p>
      {children}
    </article>
  );
}
