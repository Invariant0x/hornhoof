/* Skeleton for the RED of #462: what the tests call, doing nothing. */
export const mayHoldTask = (_task: { urgent: boolean }, _holder: { urgentOnly: boolean }): boolean => true;
export const urgentOnlyAgents = async (..._args: unknown[]): Promise<ReadonlySet<string>> => new Set();
export const setUrgent = async (..._args: unknown[]): Promise<{ wakes: unknown[] }> => ({ wakes: [] });
