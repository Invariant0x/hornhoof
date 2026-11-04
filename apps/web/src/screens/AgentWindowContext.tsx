import { createContext, useContext } from 'react';

type OpenAgent = (agentId: string) => void;

export const AgentWindowContext = createContext<OpenAgent>(() => {});

/* Every screen only asks for an agent; Shell owns the windows. */
export function useOpenAgent(): OpenAgent {
  return useContext(AgentWindowContext);
}
