import type { UpdaterStatus } from './types';

export function answeredUpdate(sent: { id: string } | null, status: UpdaterStatus | null | undefined): boolean {
  return sent !== null && status?.id === sent.id && status.state !== 'running';
}
