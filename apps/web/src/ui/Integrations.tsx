import type { ComponentType } from 'react';
import { GoogleSheetsCard } from './GoogleSheets';
import { RepoHostCard } from './RepoHost';

/* Every outside tool Hornhoof connects, one entry each: the address whose answer says the person may manage it, and its
   card. A new tool is one more entry here. */
type Integration = { id: string; probe: string; Card: ComponentType };

export const INTEGRATIONS: readonly Integration[] = [
  { id: 'google-sheets', probe: '/api/google-sheets', Card: GoogleSheetsCard },
  { id: 'github', probe: '/api/repo-host', Card: RepoHostCard },
];

/* The Integrations group: the cards of the tools the server lets this person manage, in the order of the list. */
export function Integrations({ reached }: { reached: ReadonlySet<string> }) {
  return (
    <div className="integrations">
      {INTEGRATIONS.filter(tool => reached.has(tool.probe)).map(({ id, Card }) => (
        <Card key={id} />
      ))}
    </div>
  );
}
