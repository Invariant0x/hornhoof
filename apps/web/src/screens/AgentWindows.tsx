import { useCallback, useState } from 'react';
import type { Me, Org, WaitingRequest } from '../types';
import { AgentAccess } from '../ui/AgentAccess';
import { AgentWindow, type StaffAsk } from './AgentWindow';
import { GuardBoundary } from '../ui/GuardBoundary';

const ORCHESTRATOR = 'orchestrator';

type Open = { ids: string[]; shown: string | null };

/* The one place that knows which agents have a window, one each, and which of them is on the screen; every other stands as
   a strip at the edge until someone closes it. A hidden window stays mounted and so keeps what it showed: its terminal or
   log, its panels, its size. Nothing of this outlives a reload of the page. */
export function useAgentWindows(first: string | null) {
  const [{ ids, shown }, set] = useState<Open>({ ids: first ? [first] : [], shown: first });
  const open = useCallback((id: string) => set(w => ({ ids: w.ids.includes(id) ? w.ids : [...w.ids, id], shown: id })), []);
  const minimize = useCallback((id: string) => set(w => (w.shown === id ? { ...w, shown: null } : w)), []);
  const hide = useCallback(() => set(w => ({ ...w, shown: null })), []);
  const close = useCallback((id: string) => set(w => ({ ids: w.ids.filter(other => other !== id), shown: w.shown === id ? null : w.shown })), []);
  /* Lists may name the orchestrator by its id before the company has said which agent that is. */
  const nameOrchestrator = useCallback((id: string) => {
    const own = (other: string) => (other === id ? ORCHESTRATOR : other);
    set(w => ({ ids: [...new Set(w.ids.map(own))], shown: w.shown && own(w.shown) }));
  }, []);
  return { ids, shown, open, minimize, hide, close, nameOrchestrator };
}

type Props = {
  windows: ReturnType<typeof useAgentWindows>;
  /* Bringing a window to the screen is opening its agent. */
  onOpen(id: string): void;
  me: Me;
  org: Org | null;
  staff: StaffAsk | null;
  requests: WaitingRequest[];
  onRequestsChanged(): void;
};

/* Every open window, and the place at the edge where the hidden ones put their strips, in the order they were hidden. */
export function AgentWindows({ windows, onOpen, me, org, staff, requests, onRequestsChanged }: Props) {
  const [dock, setDock] = useState<HTMLElement | null>(null);
  return (
    <>
      {org &&
        windows.ids.map(id => (
          <AgentAccess key={id} agentId={id} org={org} onClose={() => windows.close(id)}>
            <GuardBoundary block="agent-window" float>
              <AgentWindow
                me={me}
                org={org}
                agentId={id}
                place={{ minimized: windows.shown !== id, dock, onMinimize: () => windows.minimize(id), onRestore: () => onOpen(id) }}
                requests={requests}
                onRequestsChanged={onRequestsChanged}
                staff={id === ORCHESTRATOR ? staff : null}
                onClose={() => windows.close(id)}
              />
            </GuardBoundary>
          </AgentAccess>
        ))}
      <div ref={setDock} className="agent-strips" />
    </>
  );
}
