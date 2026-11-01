import type { Task43FailureReason } from '@hornhoof/protocol';

export type Task43ErrorCode = 'unauthorized' | 'forbidden' | 'validation' | 'conflict' | 'unavailable';

export class Task43Error extends Error {
  constructor(readonly code: Task43ErrorCode, readonly reason: Task43FailureReason, message: string) {
    super(message.slice(0, 200));
  }
}

export const task43Error = (code: Task43ErrorCode, reason: Task43FailureReason, message: string) => new Task43Error(code, reason, message);
export const wrongContext = () => task43Error('forbidden', 'wrong_context', 'The current task does not allow this transfer.');
export const task43ErrorBody = (error: Task43Error) => ({ error: { code: error.code, reason: error.reason, message: error.message } });
