export interface DeadlineContext { deadline: number; signal: AbortSignal }

export function deadlineDelay(deadline: number): number | undefined {
  return Number.isFinite(deadline) ? Math.max(1, deadline - Date.now()) : undefined;
}

export function deadlineTimer(deadline: number, expire: () => void): NodeJS.Timeout | undefined {
  const delay = deadlineDelay(deadline);
  return delay === undefined ? undefined : setTimeout(expire, delay);
}

export function deadlineSignal(signal: AbortSignal, deadline: number): AbortSignal {
  const delay = deadlineDelay(deadline);
  return delay === undefined ? signal : AbortSignal.any([signal, AbortSignal.timeout(delay)]);
}

export function checkDeadline(context: DeadlineContext, message: string): void {
  context.signal.throwIfAborted();
  if (Date.now() >= context.deadline) throw new Error(message);
}
