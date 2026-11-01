import { TASK43_TRANSFER_V1, type Task43NodeMessage, type Task43Policy, type Task43Receipt } from '@hornhoof/protocol';
import type { Ctx } from '../../app.js';
import type { NodeConnectionRef } from '../nodes/hub.js';
import type { Task43AuthContext } from './auth.js';
import { task43Error } from './errors.js';

export class Task43Transfer {
  constructor(private readonly ctx: Ctx, readonly policy: Task43Policy = TASK43_TRANSFER_V1) {}

  async transfer(_auth: Task43AuthContext, _requestId: string, _signal: AbortSignal): Promise<Task43Receipt> {
    throw task43Error('unavailable', 'unsupported_node', 'The transfer relay is not available on this connection.');
  }

  fromNode(_connection: NodeConnectionRef, _message: Task43NodeMessage): void {}

  abortConnection(_connection: NodeConnectionRef): void {}

  stop(): void {}
}
