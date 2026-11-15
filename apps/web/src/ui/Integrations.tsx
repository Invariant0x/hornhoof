import type { ComponentType } from 'react';
import { useT } from '../i18n';
import { GoogleSheetsCard } from './GoogleSheets';

/* Every outside tool Hornhoof connects, one entry each: the address whose answer says the person may manage it, and its
   card. A new tool is one more entry here. */
export type Integration = { id: string; probe: string; Card: ComponentType };

export const INTEGRATIONS: readonly Integration[] = [
  { id: 'google-sheets', probe: '/api/google-sheets', Card: GoogleSheetsCard },
];

/* The Integrations group: the cards of the tools the server lets this person manage, in the order of the list. */
export function Integrations({ reached }: { reached: ReadonlySet<string> }) {
  const t = useT();
  return (
    <div className="integrations">
      <p className="muted">{t.integrations.intro}</p>
      {INTEGRATIONS.filter(tool => reached.has(tool.probe)).map(({ id, Card }) => (
        <Card key={id} />
      ))}
    </div>
  );
}
