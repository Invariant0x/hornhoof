/* Records observed in Claude Code 2.1.317, Codex 0.162.1 and Kimi Code 2.4.1. */
export const claudeQueue = (operation, text, extra = {}) => ({ type: 'queue-operation', operation, content: text, ...extra });
export const userMessage = (text, turn_id = 'turn') => ({ type: 'event_msg', payload: { type: 'item_completed', turn_id, item: { type: 'UserMessage', content: [{ type: 'text', text }] } } });
export const kimiSteer = (type, text) => ({ type, agentId: 'main', turnId: 'turn', input: [{ type: 'text', text }], origin: { inTurn: true } });
