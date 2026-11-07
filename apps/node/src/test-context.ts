export interface DeadlineContext { deadline: number; signal: AbortSignal }

export function checkDeadline(context: DeadlineContext, message: string): void {
  context.signal.throwIfAborted();
  if (Date.now() >= context.deadline) throw new Error(message);
}
