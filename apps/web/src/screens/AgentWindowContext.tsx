import { createContext, useContext } from 'react';

type OpenAgent = (agentId: string) => void;

export const AgentWindowContext = createContext<OpenAgent>(() => {});

/* Every screen only asks for an agent; Shell owns the windows. */
export function useOpenAgent(): OpenAgent {
  return useContext(AgentWindowContext);
}

/* Opens a task in the task panel of the window it is asked from, and gives the focus back to the opener when it closes. None
   outside a window. */
type OpenTask = (taskId: string, opener: HTMLElement) => void;
export const WindowTaskContext = createContext<OpenTask | null>(null);

export function useOpenWindowTask(): OpenTask | null {
  return useContext(WindowTaskContext);
}
