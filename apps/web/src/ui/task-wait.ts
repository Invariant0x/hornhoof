import type { Messages } from '../i18n';
import type { ExternalWait } from '../types';

export function taskWaitText(t: Messages, wait: ExternalWait, until: string): string {
  const L = t.dept.tree;
  if (wait.on?.kind === 'employee') return L.waitingOnEmployee(wait.on.name || L.waitEmployee, wait.reason, until);
  if (wait.on?.kind === 'external') return L.waitingOnEvent(L.waitEvents[wait.on.event], wait.reason, until);
  return L.externalWaiting(wait.reason, until);
}
