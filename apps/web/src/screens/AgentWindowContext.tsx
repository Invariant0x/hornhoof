import { createContext, useContext } from 'react';

type OpenAgent = (agentId: string) => void;

export const AgentWindowContext = createContext<OpenAgent>(() => {});

/* Every screen opens the single window owned by Shell. */
export function useOpenAgent(): OpenAgent {
  return useContext(AgentWindowContext);
}
