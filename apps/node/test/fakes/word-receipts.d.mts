export const claudeQueue: (operation: string, text: string, extra?: Record<string, unknown>) => {
  type: string;
  operation: string;
  content: string;
} & Record<string, unknown>;
export const userMessage: (text: string, turnId?: string) => {
  type: string;
  payload: {
    type: string;
    turn_id: string;
    item: { type: string; content: { type: string; text: string }[] };
  };
};
export const kimiSteer: (type: string, text: string) => {
  type: string;
  agentId: string;
  turnId: string;
  input: { type: string; text: string }[];
  origin: { inTurn: boolean };
};
